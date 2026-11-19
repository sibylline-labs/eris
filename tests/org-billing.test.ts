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

  // Hostile or buggy endpoint answers: a wrong scheme, host (a suffix lookalike, a lookalike prefix), port, userinfo,
  // or a control character (newline, ANSI CSI, a terminal hyperlink escape). Each must be refused with nothing on stdout.
  const REFUSED = [
    "https://evil.example/checkout",
    "http://checkout.stripe.com/x",
    "https://stripe.com.evil.example/x",
    "https://evilstripe.com/x",
    "https://checkout.stripe.com.evil.example/x",
    "https://checkout.stripe.com:8443/x",
    ["https://evil.example", "@checkout.stripe.com/c/pay/cs_1"].join(""),
    ["https://user:pw", "@checkout.stripe.com/c/pay/cs_1"].join(""),
    "https://checkout.stripe.com/c/pay/cs_1\nhttps://evil.example/phish",
    "https://checkout.stripe.com/\x1b[2K\rhttps://evil.example/phish",
    "https://checkout.stripe.com/\x1b]8;;https://evil.example\x07https://checkout.stripe.com/pay\x1b]8;;\x07",
    "https://checkout.stripe.com/c/pay/cs_1 ",
    "javascript:alert(1)",
    "not a url",
  ] as const;

  it.each(REFUSED)("a url that is not a plain https stripe.com page (%j) is never printed, in text or json", async (url) => {
    /** When the verb prints whatever the endpoint answers, or checks the host loosely (a suffix, a port, userinfo, a control character), a hostile or buggy endpoint sends a person to a phishing page or rewrites their terminal. */
    answer = () => Response.json({ url });
    for (const format of ["text", "json"] as const) {
      const r = await run(["billing", "checkout"], format);
      expect({ format, code: r.code, stdout: r.stdout }).toEqual({ format, code: 1, stdout: "" });
      expect(r.stderr).toContain("org-unavailable");
    }
  });

  it("prints only the parsed href: the canonical form of an accepted url, in text and json", async () => {
    /** When the raw server text is printed instead of the parsed href, a spelling the parser normalised (host case, a default port) reaches the terminal as the server wrote it. */
    answer = () => Response.json({ url: "HTTPS://Checkout.Stripe.COM:443/c/pay/cs_1?a=b#frag" });
    const text = await run(["billing", "checkout"]);
    expect(text.stdout).toBe("https://checkout.stripe.com/c/pay/cs_1?a=b#frag\n");
    const json = await run(["billing", "checkout"], "json");
    expect(JSON.parse(json.stdout)).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_1?a=b#frag" });
  });

  it.each([
    [409, "nothing_to_bill", "org-billing-nothing-to-bill", "eris org billing portal"],
    [503, "billing_invalid_config", "org-billing-unavailable", "tell the platform's operator"],
    [503, "connect_unconfigured", "org-connect-unconfigured", "Stripe's return links"],
    [404, "org_not_found", "org-unavailable", "eris whoami"],
    [404, "not_found", "org-billing-unavailable", "tell the platform's operator"],
  ] as const)("a %i %s refusal reads as %s and says what to do", async (status, code, slug, hint) => {
    /** When these fall through to a generic outage ('retry'), or a missing org reads as billing being off, the person retries what cannot work or tells the operator the wrong thing. */
    answer = () => problem(status, code);
    const r = await run(["billing", "checkout"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(slug);
    expect(r.stderr).toContain(hint);
    expect(r.stderr).not.toContain("install link");
  });

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
