/**
 * `eris org webhooks logfire [revoke]`: print the org's Logfire alert webhook URL, or replace it.
 *
 * The seam is the group handler (`runOrg`) with a loopback `Bun.serve` standing in for the gateway's
 * `/v1/org/webhooks/logfire` routes and a sandbox HOME holding one signed-in org. The stand-in answers
 * the server's documented body, `{path, generation}` (`LogfireUrlViewSchema` in the platform's
 * `packages/contracts/src/logfire-url.ts`), and its refusals as problem+json. Tokens are assembled at
 * runtime so no literal trips a secret scanner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runOrg } from "../plugins/yak/org";
import { CliExit } from "../src/cli/ts-verb";

const REPO = resolve(import.meta.dir, "..");
const ORG = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const TOKEN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const pathAt = (generation: number) => `/v1/webhooks/logfire/${ORG}/${"T".repeat(42)}${generation}`;

const problem = (status: number, code: string) =>
  new Response(JSON.stringify({ type: "urn:hera:error:" + code, title: code, status, code, detail: "d" }), { status, headers: { "content-type": "application/problem+json" } });

let sandbox: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let generation: number;
let answer: ((method: string, path: string) => Response) | null;
const seen: { method: string; path: string; auth: string | null }[] = [];

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "org-webhooks-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push({ method: req.method, path, auth: req.headers.get("authorization") });
      if (answer !== null) return answer(req.method, path);
      if (req.method === "GET" && path === "/v1/org/webhooks/logfire") return Response.json({ path: pathAt(generation), generation });
      if (req.method === "POST" && path === "/v1/org/webhooks/logfire/revoke") {
        generation++;
        return Response.json({ path: pathAt(generation), generation });
      }
      return problem(404, "not_found");
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  home = join(sandbox, "home");
  mkdirSync(join(home, ".eris"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".eris", "yaks.json"), JSON.stringify({ url: `${base}/`, token: TOKEN }), { mode: 0o600 });
});
afterAll(() => {
  server.stop(true);
  rmSync(sandbox, { recursive: true, force: true });
});
beforeEach(() => {
  seen.length = 0;
  generation = 0;
  answer = null;
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

describe("eris org webhooks logfire", () => {
  // admits: boundary-io: the printed address must be the configured url (its trailing slash dropped) joined to the server's path, or the alert channel posts nowhere: observed on stdout, with the bearer sent and never printed.
  it("prints the org's url joined to the server's path, and --output json adds it as url", async () => {
    const text = await run(["webhooks", "logfire"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toBe(`${base}${pathAt(0)}\n`);
    const json = await run(["webhooks", "logfire"], "json");
    expect(JSON.parse(json.stdout)).toEqual({ url: `${base}${pathAt(0)}`, path: pathAt(0), generation: 0 });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /v1/org/webhooks/logfire", "GET /v1/org/me", "GET /v1/org/webhooks/logfire", "GET /v1/org/me"]);
    for (const s of seen) expect(s.auth).toBe(`Bearer ${TOKEN}`);
    expect(text.stdout + text.stderr + json.stdout + json.stderr).not.toContain(TOKEN);
  });

  // admits: integration: a revoke that reads instead of posting, or prints the old URL, leaves a leaked credential live while the admin believes it dead: observed as the POST, the new generation's URL and the stderr warning.
  it("revoke posts once and prints the new URL, warning that the old one stopped working", async () => {
    const r = await run(["webhooks", "logfire", "revoke"]);
    expect(r.code).toBe(0);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /v1/org/webhooks/logfire/revoke"]);
    expect(r.stdout).toBe(`${base}${pathAt(1)}\n`);
    expect(r.stderr).toContain("previous URL no longer works");
  });

  // admits: algorithmic: each refusal must name its own fix (ask an admin, reactivate bus, log in); a generic failure hides which: observed in the slug.
  it.each([
    [403, "admin_required", "org-admin-required"],
    [402, "entitlement_lapsed", "org-bus-lapsed"],
    [401, "invalid_token", "org-unauthorized"],
  ])("a %i %s renders %s, nothing on stdout, exit 1", async (status, code, slug) => {
    answer = () => problem(status, code);
    for (const args of [["webhooks", "logfire"], ["webhooks", "logfire", "revoke"]]) {
      const r = await run(args);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`slug: ${slug}`);
      expect(r.stdout).toBe("");
    }
  });

  // admits: boundary-io: a body whose path is not the webhook route (an absolute url, another route) would print an address the platform never issued: observed as org-unavailable and an empty stdout.
  it("refuses a path outside the webhook route rather than print it as an address", async () => {
    for (const path of [
      "https://elsewhere.example/hook",
      "/v1/org/members",
      "/v1/webhooks/logfire/",
      `/v1/webhooks/logfire/${ORG}/`,
      "/v1/webhooks/logfire/../../v1/org/members",
      `/v1/webhooks/logfire/${ORG}/${"T".repeat(40)}?a=1`,
      `/v1/webhooks/logfire/${ORG}/${"T".repeat(42)}\n`,
      `/v1/webhooks/logfire/${ORG}/${"T".repeat(43)}/x`,
      `/v1/webhooks/logfire/${ORG.toLowerCase()}/${"T".repeat(43)}`,
    ]) {
      answer = () => Response.json({ path, generation: 0 });
      const r = await run(["webhooks", "logfire"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("slug: org-unavailable");
      expect(r.stdout).toBe("");
    }
  });

  // admits: algorithmic: a typo must not reach the server as some other call (a revoke above all): observed as the slug and no request.
  it("refuses an unknown source or action before any request", async () => {
    for (const args of [["webhooks", "github"], ["webhooks", "logfire", "rotate"]]) {
      const r = await run(args);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("slug: org-unknown-verb");
    }
    expect(seen).toEqual([]);
  });

  // admits: boundary-io: the body passes through (`passthrough`), so a server `url` field spread after the joined address
  // would replace it and print a host the org never configured; the joined address must win.
  it("a url field in the server's body never replaces the address joined to the org's url", async () => {
    answer = () => Response.json({ path: pathAt(0), generation: 0, url: "https://evil.example/hijacked" });
    const r = await run(["webhooks", "logfire"], "json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).url).toBe(`${base}${pathAt(0)}`);
  });

  // admits: algorithmic: the bus refusal is shared with the GitHub verbs (their row is verified for bus), so its text must
  // name the action refused, not a webhook URL the caller never asked for.
  it("a 402 on a GitHub verb names that verb, not a webhook URL", async () => {
    answer = () => problem(402, "entitlement_lapsed");
    const github = await run(["github"]);
    expect(github.stderr).toContain("slug: org-bus-lapsed");
    expect(github.stderr).toContain("cannot connect GitHub");
    expect(github.stderr).not.toContain("webhook URL");
    const revoke = await run(["webhooks", "logfire", "revoke"]);
    expect(revoke.stderr).toContain("no new webhook URL is issued");
  });

  const ME = (bus: string) => Response.json({ orgId: ORG, memberId: "mem_1", role: "admin", entitlements: { accounts: "active", bus } });
  const urlWith = (bus: string) => (method: string, path: string) =>
    path === "/v1/org/me" ? ME(bus) : Response.json({ path: pathAt(0), generation: 0 });

  // admits: integration: a URL printed for an org without bus looks live and delivers nothing (402); the user sees the cause only if the verb says it: observed as the stderr WARN naming the product and the next step, with stdout still the bare URL.
  it("warns on stderr, never stdout, when the org's bus product is not active", async () => {
    answer = urlWith("none");
    const r = await run(["webhooks", "logfire"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${base}${pathAt(0)}\n`);
    expect(r.stderr).toContain("bus product is none");
    expect(r.stderr).toContain("eris org billing checkout");
    expect(r.stderr).toContain("answer 402");
  });

  // admits: integration: a warning on a healthy org trains users to ignore it: observed as no stderr when bus is active.
  it("says nothing extra when bus is active", async () => {
    answer = urlWith("active");
    const r = await run(["webhooks", "logfire"]);
    expect(r.stderr).toBe("");
  });

  // admits: algorithmic: the scope_denied and 402 fixes on a missing bus product must name the product and the billing verb, never `eris login` (a second login cannot add a product) or the dashboard: observed in each fix line.
  it.each([
    [["github"], 403, "scope_denied"],
    [["disconnect-github"], 403, "scope_denied"],
    [["github"], 402, "entitlement_lapsed"],
    [["webhooks", "logfire", "revoke"], 402, "entitlement_lapsed"],
  ])("%j refused %i %s names bus and billing checkout, never eris login or the dashboard", async (args, status, code) => {
    answer = () => problem(status, code);
    const r = await run(args);
    expect(r.code).toBe(1);
    const fix = r.stderr.split("\n").find((l) => l.startsWith("fix:")) ?? "";
    expect(r.stderr).toContain("bus");
    expect(fix).toContain("eris org billing checkout");
    expect(r.stderr).not.toContain("eris login");
    expect(r.stderr).not.toContain("dashboard");
  });
});
