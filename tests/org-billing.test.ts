/**
 * `eris org billing checkout` and `eris org billing portal`: print the Stripe URL the org's bearer routes
 * (`POST /v1/org/billing/checkout|portal`) answer.
 *
 * The seam is the group handler (`runOrg`) with a loopback `Bun.serve` standing in for the gateway's
 * billing routes, and a sandbox HOME holding one signed-in org. The stand-in answers the server's
 * documented body, `{url}`. Tokens are assembled at runtime so no literal trips a secret scanner. The live
 * run against a real org in Stripe test mode is a separate step.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runOrg } from "../plugins/yak/org";
import { CliExit } from "../src/cli/ts-verb";

const REPO = resolve(import.meta.dir, "..");
const ORG = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const TOKEN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_test_example";
const PORTAL_URL = "https://billing.stripe.com/p/session/test_example";

const problem = (status: number, code: string) =>
  new Response(JSON.stringify({ type: "urn:hera:error:" + code, title: code, status, code, detail: "d" }), { status, headers: { "content-type": "application/problem+json" } });

let sandbox: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let answer: (kind: string) => Response;
const seen: { method: string; path: string; auth: string | null; body: string }[] = [];

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "org-billing-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push({ method: req.method, path, auth: req.headers.get("authorization"), body: await req.text() });
      const m = /^\/v1\/org\/billing\/(checkout|portal)$/.exec(path);
      if (req.method === "POST" && m !== null) return answer(m[1]!);
      return problem(404, "not_found");
    },
  });
  home = join(sandbox, "home");
  mkdirSync(join(home, ".eris"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".eris", "yaks.json"), JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token: TOKEN }), { mode: 0o600 });
});
afterAll(() => {
  server.stop(true);
  rmSync(sandbox, { recursive: true, force: true });
});
beforeEach(() => {
  seen.length = 0;
  answer = (kind) => Response.json({ url: kind === "checkout" ? CHECKOUT_URL : PORTAL_URL });
});

async function run(args: string[], format: "text" | "json" = "text") {
  const out = { stdout: "", stderr: "" };
  const ctx = {
    erisDir: REPO,
    env: { PATH: process.env.PATH, HOME: home },
    format,
    stdout: { write: (s: string) => ((out.stdout += s), true) },
    stderr: { write: (s: string) => ((out.stderr += s), true) },
  };
  let code: number;
  try {
    code = await runOrg(args, ctx, { cwd: sandbox, home });
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    code = e.code;
  }
  return { code, ...out };
}

describe("eris org billing", () => {
  it.each([
    ["checkout", CHECKOUT_URL],
    ["portal", PORTAL_URL],
  ] as const)("%s prints the Stripe URL alone on stdout, sending the org's bearer and no body", async (kind, url) => {
    /** When the verb prints anything but the URL on stdout, an agent piping it breaks; when it sends a body or another credential, the server reads a payload eris must never carry. */
    const r = await run(["billing", kind]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${url}\n`);
    expect(r.stderr).toContain("never takes card details");
    expect(seen).toEqual([{ method: "POST", path: `/v1/org/billing/${kind}`, auth: `Bearer ${TOKEN}`, body: "" }]);
  });

  it("--output json prints the server's body, unknown fields included", async () => {
    /** When json mode reshapes the body, a caller loses the fields a newer server adds. */
    answer = () => Response.json({ url: CHECKOUT_URL, extra: 1 });
    const r = await run(["billing", "checkout"], "json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ url: CHECKOUT_URL, extra: 1 });
  });

  it("a member is refused with org-admin-required and exits 1", async () => {
    /** When a refusal exits 0 or prints a URL, a member believes billing opened */
    answer = () => problem(403, "admin_required");
    const r = await run(["billing", "checkout"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("org-admin-required");
    expect(r.stderr).toContain("only an admin of this org can open Stripe billing");
  });

  it.each([
    [404, "not_found"],
    [503, "billing_unconfigured"],
  ] as const)("a platform answering %i %s is org-billing-unavailable", async (status, code) => {
    /** When billing-off reads as a generic outage, the person retries instead of telling the operator. */
    answer = () => problem(status, code);
    const r = await run(["billing", "portal"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("org-billing-unavailable");
  });

  it.each(["https://evil.example/checkout", "http://checkout.stripe.com/x", "https://stripe.com.evil.example/x", "javascript:alert(1)", "not a url"])(
    "a url that is not a https stripe.com page (%s) is never printed",
    async (url) => {
      /** When the verb prints whatever the endpoint answers, a hostile or buggy endpoint sends a person to a phishing page. */
      answer = () => Response.json({ url });
      const r = await run(["billing", "checkout"]);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("org-unavailable");
    },
  );

  it("a bare 'billing' and an unknown sub print usage or refuse, sending nothing", async () => {
    /** When a typo reaches the network, the wrong route is called with the org's bearer. */
    const bare = await run(["billing"]);
    expect(bare.code).toBe(0);
    expect(bare.stdout).toContain("eris org billing checkout | portal");
    const typo = await run(["billing", "chekout"]);
    expect(typo.code).toBe(1);
    expect(typo.stderr).toContain("org-unknown-verb");
    expect(seen).toEqual([]);
  });
});
