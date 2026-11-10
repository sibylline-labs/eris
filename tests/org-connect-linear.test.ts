/**
 * `eris org connect-linear`: mint an org-bound install link, hand it to the browser, and poll
 * `GET /v1/org/me` until the org's Linear connection reads `connected`.
 *
 * The seam is the group handler (`runOrg`) with a loopback `Bun.serve` standing in for the
 * gateway's `/v1/org/*` routes, and a sandbox HOME holding one signed-in org. The stand-in plays
 * the browser's part itself: the org turns `connected` a few polls after the link is minted.
 * Time is injected (`sleep`, `now`), so a timeout costs no wall-clock. Bearers are assembled at
 * runtime so no literal trips a secret scanner. The live run against a real workspace is a
 * separate, human step.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runOrg } from "../plugins/yak/org";
import { CliExit } from "../src/cli/ts-verb";

const REPO = resolve(import.meta.dir, "..");
const ORG = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const TOKEN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const SECRET = "s3cr3tlinkvalue";

const problem = (status: number, code: string) =>
  new Response(JSON.stringify({ type: "urn:hera:error:" + code, title: code, status, code, detail: "d" }), { status, headers: { "content-type": "application/problem+json" } });

let sandbox: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let linear: { status: string; cause?: string };
/** Polls of `me` left before the stand-in browser has finished the install; Infinity never finishes. */
let pollsUntilConnected: number;
let minted: boolean;
let mint: () => Response;
const seen: { method: string; path: string; auth: string | null }[] = [];

const link = () => `http://127.0.0.1:${server.port}/auth/linear/connect?link=${ORG}.${SECRET}`;
const me = () => ({ orgId: ORG, memberId: "01J0AAAAAAAAAAAAAAAAAAAAAA", role: "admin", tier: "pro", linear });

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "connect-linear-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push({ method: req.method, path, auth: req.headers.get("authorization") });
      if (req.method === "GET" && path === "/v1/org/me") {
        if (minted && linear.status !== "connected" && --pollsUntilConnected <= 0) linear = { status: "connected" };
        return Response.json(me());
      }
      if (req.method === "POST" && path === "/v1/org/linear/connect") {
        const answer = mint();
        if (answer.ok) minted = true;
        return answer;
      }
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
  linear = { status: "disconnected", cause: "oauth_revoked" };
  pollsUntilConnected = 3;
  minted = false;
  mint = () => Response.json({ url: link(), expires_at: new Date(Date.now() + 600_000).toISOString() }, { status: 201 });
});

async function run(args: string[], format: "text" | "json" = "text") {
  const out = { stdout: "", stderr: "" };
  const opened: string[] = [];
  let clock = Date.now();
  const sleeps: number[] = [];
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
      sleep: async (ms) => void (sleeps.push(ms), (clock += ms)),
      now: () => clock,
    });
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    code = e.code;
  }
  return { code, opened, sleeps, ...out };
}

describe("eris org connect-linear", () => {
  it("mints a link, opens it, and ends connected once the org reads connected", async () => {
    /** When the verb stops polling, opens the wrong url, or sends the wrong bearer, a disconnected org never reaches `connected` from the CLI: observed in the request log, the opened url and stdout. */
    const r = await run(["connect-linear"]);
    expect(r.code).toBe(0);
    expect(r.opened).toEqual([link()]);
    expect(r.stdout).toBe("connected\n");
    expect(r.stderr).not.toContain(TOKEN);
    const order = seen.map((s) => `${s.method} ${s.path}`);
    expect(order.slice(0, 2)).toEqual(["GET /v1/org/me", "POST /v1/org/linear/connect"]);
    expect(order.filter((o) => o === "GET /v1/org/me").length).toBeGreaterThanOrEqual(4);
    for (const s of seen) expect(s.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("says already connected and mints nothing when the org is connected", async () => {
    /** When a connected org is sent through the install again, the admin is walked through a needless OAuth round: observed as a mint request or an opened url. */
    linear = { status: "connected" };
    const r = await run(["connect-linear"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("already connected\n");
    expect(r.opened).toEqual([]);
    expect(seen.map((s) => s.method)).toEqual(["GET"]);
  });

  it("refuses a member before any browser hand-off", async () => {
    /** When a non-admin reaches the browser, the install is started for a role that cannot finish it: observed in the opened urls and the slug. */
    mint = () => problem(403, "admin_required");
    const r = await run(["connect-linear"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("slug: org-admin-required");
    expect(r.opened).toEqual([]);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /v1/org/me", "POST /v1/org/linear/connect"]);
  });

  it("prints the link and opens nothing under --no-browser, then still waits for connected", async () => {
    /** When --no-browser still opens a browser, a headless box tries to launch one; when it drops the link, the admin has nowhere to go: observed in `opened` and stderr. */
    const r = await run(["connect-linear", "--no-browser"]);
    expect(r.code).toBe(0);
    expect(r.opened).toEqual([]);
    expect(r.stderr).toContain(link());
    expect(r.stdout).toBe("connected\n");
  });

  it("times out when the org never connects, naming the slug", async () => {
    /** When the poll has no end, the command hangs on an abandoned install: observed in the exit code, the slug and the bounded number of polls. */
    pollsUntilConnected = Infinity;
    const r = await run(["connect-linear"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("slug: org-connect-timeout");
    expect(r.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(660_000);
    expect(seen.length).toBeLessThan(400);
  });

  it("refuses a server whose accounts env has no dash origin", async () => {
    /** When a 503 connect_unconfigured is reported as a generic failure, the operator is not told the platform, not their machine, is misconfigured: observed in the slug. */
    mint = () => problem(503, "connect_unconfigured");
    const r = await run(["connect-linear"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("slug: org-connect-unconfigured");
    expect(r.opened).toEqual([]);
  });

  it("never opens a url that is not http(s)", async () => {
    /** When a hostile or broken mint answer is handed to the OS opener, `open` runs a file:// or custom-scheme handler: observed in `opened`. */
    mint = () => Response.json({ url: "file:///etc/passwd", expires_at: new Date(Date.now() + 600_000).toISOString() }, { status: 201 });
    const r = await run(["connect-linear"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("slug: org-unavailable");
    expect(r.opened).toEqual([]);
  });

  it("prints the org's own body bare under --output json", async () => {
    /** When json mode wraps or reshapes the body, a script reading `.linear.status` breaks: observed in the parsed stdout. */
    const r = await run(["connect-linear"], "json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ...me(), linear: { status: "connected" } });
  });
});
