/**
 * `eris login`, `eris logout` and `eris whoami` on a machine signed in to more
 * than one org: a login to a second org is added beside the default, logout
 * removes only the org the directory acts as, and whoami reports the org, why,
 * and where its token comes from, never the token.
 *
 * The seam is the verb handlers with a loopback `Bun.serve` standing in for the
 * device-login endpoints, a sandbox HOME and sandbox checkouts under .scratch/.
 * Bearers are assembled at runtime so no literal trips a secret scanner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runLogin, runLogout, type LoginDeps } from "../plugins/yak/login";
import { runWhoami } from "../plugins/yak/whoami";
import { CliExit } from "../src/cli/ts-verb";

const REPO = resolve(import.meta.dir, "..");
const B64 = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
const ORG_A = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const ORG_B = "01J0AAAAAAAAAAAAAAAAAAAAAB";
const ORG_C = "01J0CCCCCCCCCCCCCCCCCCCCCC";
const bearer = (org: string) => ["sib", org, B64].join("_");
const DEVICE_CODE = ["sibdc", "BCDFGHJK", B64].join("_");

let sandbox: string;
let home: string;
let root: string;
let server: ReturnType<typeof Bun.serve>;
let mint: string;
/** What `GET /v1/org/me` answers for the bearer it is sent: the org its prefix names, or a refusal. */
let meStatus = 200;
const ME_TAIL = {
  entitlements: { accounts: "active", yak: "trialing" },
  features: {},
  tier: "free",
  limits: {},
  linear: { status: "disconnected", cause: "oauth_revoked" },
  deletionScheduledAt: "2026-12-01T00:00:00.000Z",
  workspaceName: "Kilometre",
  trialEndsAt: null,
};

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "login-orgs-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/v1/device/code") {
        return Response.json({ device_code: DEVICE_CODE, user_code: "BCDF-GHJK", verification_uri: "https://dash.example.test/device", expires_in: 600, interval: 1 });
      }
      if (path === "/v1/org/me") {
        if (meStatus !== 200) return Response.json({ error: { code: "unauthorized" } }, { status: meStatus });
        const org = req.headers.get("authorization")?.split("_")[1] ?? "";
        return Response.json({ orgId: org, memberId: "mem_1", role: "admin", ...ME_TAIL });
      }
      if (path === "/v1/device/token") return Response.json({ access_token: mint, token_type: "Bearer", token_id: "tok_1", name: "laptop (eris)", scopes: [] });
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => {
  server.stop(true);
  rmSync(sandbox, { recursive: true, force: true });
});
beforeEach(() => {
  meStatus = 200;
  root = realpathSync(mkdtempSync(join(sandbox, "t-")));
  home = join(root, "home");
  mkdirSync(home);
});

const url = () => `http://127.0.0.1:${server.port}`;
const yaksJson = () => join(home, ".eris", "yaks.json");
const stored = () => JSON.parse(readFileSync(yaksJson(), "utf8")) as Record<string, unknown>;

function checkout(name: string, org?: string): string {
  const path = join(root, name);
  mkdirSync(join(path, ".git"), { recursive: true });
  writeFileSync(join(path, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(path, "eris.yaml"), org === undefined ? `service: ${name}\n` : `service: ${name}\nrepo:\n  org: ${org}\n`);
  return path;
}

interface Run {
  rc: number;
  stdout: string;
  stderr: string;
}

async function drive(
  handler: (args: string[], ctx: never, deps: never) => Promise<number>,
  args: string[],
  opts: { cwd: string; env?: Record<string, string | undefined>; format?: "text" | "json"; deps?: Partial<LoginDeps> },
): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const ctx = {
    erisDir: REPO,
    env: opts.env ?? { PATH: process.env.PATH, HOME: home },
    format: opts.format ?? "text",
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: (s: string) => ((stderr += s), true) },
  };
  const deps = { home, cwd: opts.cwd, hostname: () => "laptop", sleep: async () => {}, openBrowser: async () => {}, ...opts.deps };
  let rc: number;
  try {
    rc = await handler(args, ctx as never, deps as never);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    rc = e.code;
  }
  for (const secret of [B64, DEVICE_CODE]) {
    expect(stdout).not.toContain(secret);
    expect(stderr).not.toContain(secret);
  }
  return { rc, stdout, stderr };
}

async function login(org: string, cwd: string, deps: Partial<LoginDeps> = {}): Promise<Run> {
  mint = bearer(org);
  return drive(runLogin as never, ["--url", url(), "--no-browser"], { cwd, deps });
}

describe("eris login with a second org", () => {
  // admits: a second org's login replacing the first, which moves every repo on the machine to the new org; file state after real HTTP
  it("keeps the default org and adds the second beside it, at 0600", async () => {
    const a = checkout("a");
    expect((await login(ORG_A, a)).stdout).toBe(`logged in: token "laptop (eris)" written to ${yaksJson()}\n`);
    const second = await login(ORG_B, a);
    expect({ rc: second.rc, stdout: second.stdout }).toEqual({ rc: 0, stdout: `logged in to org ${ORG_B}: token "laptop (eris)" written to ${yaksJson()}\n` });
    expect(stored()).toEqual({ url: url(), token: bearer(ORG_A), orgs: { [ORG_B]: { url: url(), token: bearer(ORG_B) } } });
    expect(statSync(yaksJson()).mode & 0o777).toBe(0o600);
  });

  // admits: the read-modify-write losing an org written by a concurrent login; an interleaving only a run shows
  it("merges a login that finished while it waited, instead of losing it", async () => {
    const a = checkout("a");
    await login(ORG_A, a);
    let injected = false;
    const r = await login(ORG_B, a, {
      sleep: async () => {
        if (injected) return;
        injected = true;
        const now = stored();
        writeFileSync(yaksJson(), JSON.stringify({ ...now, orgs: { [ORG_C]: { url: url(), token: bearer(ORG_C) } } }), { mode: 0o600 });
      },
    });
    expect(r.rc).toBe(0);
    expect(Object.keys((stored().orgs ?? {}) as object).sort()).toEqual([ORG_B, ORG_C]);
    expect(stored().token).toBe(bearer(ORG_A));
  });

  // admits: a login in an org-B repo silently storing org A's token while B stays signed out; output over a real grant
  it("warns when the browser approved a different org from the one this repo selects", async () => {
    const a = checkout("a");
    await login(ORG_A, a);
    const b = checkout("b", ORG_B);
    const r = await login(ORG_A, b);
    expect(r.rc).toBe(0);
    expect(r.stderr).toContain("login-org-differs");
    expect(r.stderr).toContain(ORG_B);
  });
});

describe("eris whoami", () => {
  // admits: whoami disagreeing with what the clients send, or printing a token; it reads the same resolver end to end
  it("reports the default org in a repo with no selector and the selected org in a repo that names one", async () => {
    const a = checkout("a");
    const b = checkout("b", ORG_B);
    await login(ORG_A, a);
    await login(ORG_B, a);
    const ta = await drive(runWhoami as never, [], { cwd: a });
    expect(ta.stdout).toBe(
      [
        `org: ${ORG_A} (default)`,
        "why: this machine's default org",
        `token: ${yaksJson()}`,
        `url: ${url()}`,
        `signed in to: ${ORG_A} (default), ${ORG_B}`,
        "role: admin",
        "tier: free",
        "linear: disconnected (oauth_revoked)",
        "deletion: scheduled for 2026-12-01T00:00:00.000Z",
        "entitlements: accounts active, yak trialing",
        "",
      ].join("\n"),
    );
    const jb = await drive(runWhoami as never, [], { cwd: b, format: "json" });
    expect(JSON.parse(jb.stdout)).toEqual({ orgId: ORG_B, memberId: "mem_1", role: "admin", ...ME_TAIL });
  });

  // admits: whoami printing a guess when the org cannot be asked; the server's status is runtime
  it("exits 1 with the sign-in fix when the endpoint rejects the bearer, and prints nothing to stdout", async () => {
    const a = checkout("a");
    await login(ORG_A, a);
    meStatus = 401;
    const r = await drive(runWhoami as never, [], { cwd: a });
    expect({ rc: r.rc, stdout: r.stdout }).toEqual({ rc: 1, stdout: "" });
    expect(r.stderr).toContain("yak-unauthorized");
    expect(r.stderr).toContain("eris login");
  });

  // admits: the org-not-signed-in fix line not leading to a working state; round trip through the real verbs
  it("fails closed for an org this machine is not signed in to, and the fix it names works", async () => {
    const a = checkout("a");
    const c = checkout("c", ORG_C);
    await login(ORG_A, a);
    const before = await drive(runWhoami as never, [], { cwd: c });
    expect(before.rc).toBe(1);
    expect(before.stderr).toContain("org-not-signed-in");
    expect(before.stderr).toContain("eris login");
    await login(ORG_C, c);
    const after = await drive(runWhoami as never, [], { cwd: c });
    expect({ rc: after.rc, first: after.stdout.split("\n")[0] }).toEqual({ rc: 0, first: `org: ${ORG_C}` });
  });
});

describe("eris logout with several orgs", () => {
  // admits: logout in one org's repo signing every org out; file state after the verb
  it("removes only the org this directory acts as", async () => {
    const a = checkout("a");
    const b = checkout("b", ORG_B);
    await login(ORG_A, a);
    await login(ORG_B, a);
    const out = await drive(runLogout as never, [], { cwd: b });
    expect(out.stdout).toBe(`logged out of org ${ORG_B}: removed its token from ${yaksJson()}\n`);
    expect(stored()).toEqual({ url: url(), token: bearer(ORG_A) });
    const again = await drive(runLogout as never, [], { cwd: b });
    expect(again.stdout).toBe(`not logged in to org ${ORG_B}: no token for it in ${yaksJson()}\n`);
    await login(ORG_B, a);
    const def = await drive(runLogout as never, [], { cwd: a });
    expect(def.stdout).toBe(`logged out: removed the token from ${yaksJson()}\n`);
    expect(stored()).toEqual({ url: url(), orgs: { [ORG_B]: { url: url(), token: bearer(ORG_B) } } });
  });
});
