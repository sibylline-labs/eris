/**
 * `eris org github`, `eris org connect-github` and `eris org disconnect-github`: read, bind (after the App
 * shows up on the GitHub org) and unbind the org's GitHub App installation.
 *
 * The seam is the group handler (`runOrg`) with a loopback `Bun.serve` standing in for the gateway's
 * `/v1/github` routes, a sandbox HOME holding one signed-in org, and an injected `gh` runner standing in
 * for the GitHub CLI. The stand-in answers the server's documented body,
 * `{installation: {installation_id, bound_at} | null, app: {id, slug, install_url} | null}`. Time is
 * injected, so the wait costs no wall-clock. Tokens are assembled at runtime so no literal trips a secret
 * scanner. The live run against a real GitHub org is a separate, human step.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runOrg, type GhResult } from "../plugins/yak/org";
import { CliExit } from "../src/cli/ts-verb";

const REPO = resolve(import.meta.dir, "..");
const ORG = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const TOKEN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const GH_TOKEN = ["gho", "CallerOwnGithubToken0123456789"].join("_");
const APP = { id: 5595960, slug: "platform-app", install_url: "https://github.com/apps/platform-app/installations/new" };
const INSTALLATION = 178206119;

const problem = (status: number, code: string) =>
  new Response(JSON.stringify({ type: "urn:hera:error:" + code, title: code, status, code, detail: "d" }), { status, headers: { "content-type": "application/problem+json" } });

let sandbox: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let installation: { installation_id: number; bound_at: string } | null;
let bindAnswer: (body: unknown) => Response;
let unbindAnswer: () => Response;
const seen: { method: string; path: string; auth: string | null; body: string }[] = [];

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "connect-github-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = await req.text();
      seen.push({ method: req.method, path, auth: req.headers.get("authorization"), body });
      if (req.method === "GET" && path === "/v1/github") return Response.json({ installation, app: APP });
      if (req.method === "POST" && path === "/v1/github/installation") return bindAnswer(JSON.parse(body));
      if (req.method === "POST" && path === "/v1/github/installation/unbind") return unbindAnswer();
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
  installation = null;
  bindAnswer = (body) => {
    installation = { installation_id: (body as { installation_id: number }).installation_id, bound_at: "2026-11-18T21:00:00.000Z" };
    return Response.json({ installation, app: APP });
  };
  unbindAnswer = () => {
    installation = null;
    return Response.json({ installation: null, app: APP });
  };
});

/** A `gh` stand-in: the App appears on the org after `listsUntilInstalled` lists; every call is kept. */
function fakeGh(opts: { listsUntilInstalled?: number; listCode?: number; token?: string } = {}) {
  const calls: string[][] = [];
  let lists = 0;
  const run = async (args: readonly string[]): Promise<GhResult> => {
    calls.push([...args]);
    if (args[0] === "auth" && args[1] === "token") return { code: 0, stdout: `${opts.token ?? GH_TOKEN}\n`, stderr: "" };
    if (args[0] === "api") {
      if (opts.listCode !== undefined) return { code: opts.listCode, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
      lists++;
      return { code: 0, stdout: lists > (opts.listsUntilInstalled ?? 0) ? `${INSTALLATION}\n` : "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { run, calls };
}

async function run(args: string[], gh = fakeGh(), format: "text" | "json" = "text") {
  const out = { stdout: "", stderr: "" };
  const opened: string[] = [];
  let clock = Date.now();
  const ctx = {
    erisDir: REPO,
    env: { PATH: process.env.PATH, HOME: home },
    format,
    stdout: { write: (s: string) => ((out.stdout += s), true) },
    stderr: { write: (s: string) => ((out.stderr += s), true) },
  };
  let code: number;
  try {
    code = await runOrg(args, ctx, {
      cwd: sandbox,
      home,
      openBrowser: async (url) => void opened.push(url),
      sleep: async (ms) => void (clock += ms),
      now: () => clock,
      runGh: gh.run,
    });
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    code = e.code;
  }
  return { code, opened, gh: gh.calls, ...out };
}

describe("eris org connect-github", () => {
  it("opens the install page, waits for the App on the org, then binds with the caller's gh token", async () => {
    /** When the verb binds before the install, sends a guessed id, or proves with anything but the caller's own token, the org's bus never receives that org's events: observed in the POST body, the opened url and stdout. */
    const r = await run(["connect-github", "--account", "acme"], fakeGh({ listsUntilInstalled: 2 }));
    expect(r.code).toBe(0);
    expect(r.opened).toEqual([APP.install_url]);
    expect(r.stdout).toBe(`bound: installation ${INSTALLATION} since 2026-11-18T21:00:00.000Z\n`);
    expect(r.gh.filter((c) => c[0] === "api")).toHaveLength(3);
    expect(r.gh[0]).toEqual(["api", "--paginate", "orgs/acme/installations", "--jq", `.installations[] | select(.app_id == ${APP.id}) | .id`]);
    const bind = seen.find((s) => s.method === "POST");
    expect(JSON.parse(bind!.body)).toEqual({ installation_id: INSTALLATION, account: "acme", github_token: GH_TOKEN });
    for (const s of seen) expect(s.auth).toBe(`Bearer ${TOKEN}`);
    expect(r.stdout + r.stderr).not.toContain(GH_TOKEN);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it("binds at once, opening nothing, when the App is already installed on the org", async () => {
    /** When an installed App sends the admin through the install page again, they are asked to redo a step GitHub already has: observed as an opened url. */
    const r = await run(["connect-github", "--account", "acme"]);
    expect(r.code).toBe(0);
    expect(r.opened).toEqual([]);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /v1/github", "POST /v1/github/installation"]);
  });

  it("says already bound and runs no gh when the org has an installation", async () => {
    /** When a bound org is walked through the install again, the admin may bind a second org's installation over it: observed as a gh call or a POST. */
    installation = { installation_id: 1, bound_at: "2026-11-01T00:00:00.000Z" };
    const r = await run(["connect-github", "--account", "acme"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("already bound: installation 1 since 2026-11-01T00:00:00.000Z\n");
    expect(r.gh).toEqual([]);
    expect(seen.map((s) => s.method)).toEqual(["GET"]);
  });

  it("refuses before any browser hand-off when gh cannot list the org (not an owner, or not an org)", async () => {
    /** When a non-owner reaches the install page, they start an install the server will refuse to bind: observed in the slug and the opened urls. */
    const r = await run(["connect-github", "--account", "acme"], fakeGh({ listCode: 1 }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("slug: org-github-not-owner");
    expect(r.opened).toEqual([]);
    expect(seen.map((s) => s.method)).toEqual(["GET"]);
  });

  it("renders the server's proof refusal as org-github-unproven", async () => {
    /** When the server's 403 installation_unproven reads as a generic failure, the admin is not told to sign gh in as an org owner: observed in the slug. */
    bindAnswer = () => problem(403, "installation_unproven");
    const r = await run(["connect-github", "--account", "acme"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("slug: org-github-unproven");
    expect(r.stderr).not.toContain(GH_TOKEN);
  });

  it("refuses an account that is not a GitHub login before any request", async () => {
    /** When a path-shaped account reaches gh or the server, it names an endpoint the user never meant: observed as any request or gh call. */
    const r = await run(["connect-github", "--account", "acme/../users"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("slug: org-github-account-invalid");
    expect(seen).toEqual([]);
    expect(r.gh).toEqual([]);
  });

  it("gives up with org-github-timeout when the App never appears", async () => {
    /** When the wait has no end, an abandoned install leaves the command hanging forever: observed as the slug after the injected clock passes the limit. */
    const r = await run(["connect-github", "--account", "acme"], fakeGh({ listsUntilInstalled: Number.POSITIVE_INFINITY }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("slug: org-github-timeout");
    expect(seen.map((s) => s.method)).toEqual(["GET"]);
  });
});

describe("eris org github / disconnect-github", () => {
  it("reads the binding and unbinds it", async () => {
    /** When status or unbind reach the wrong route or misread the body, the admin cannot see or stop the org's GitHub events: observed in stdout and the request log. */
    installation = { installation_id: INSTALLATION, bound_at: "2026-11-18T21:00:00.000Z" };
    const status = await run(["github"]);
    expect(status.stdout).toBe(`bound: installation ${INSTALLATION} since 2026-11-18T21:00:00.000Z\n`);
    const unbound = await run(["disconnect-github"]);
    expect(unbound.code).toBe(0);
    expect(unbound.stdout).toBe("unbound\n");
    expect((await run(["github"])).stdout).toStartWith("no GitHub App installation is bound\n");
  });

  it("renders a member's 403 admin_required as org-admin-required", async () => {
    /** When the server's admin-only refusal reads as a generic failure, a member is not told who can unbind: observed in the slug. */
    unbindAnswer = () => problem(403, "admin_required");
    const r = await run(["disconnect-github"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("slug: org-admin-required");
    expect(r.stderr).toContain("eris org disconnect-github");
  });
});
