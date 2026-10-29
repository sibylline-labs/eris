/**
 * `eris login` / `eris logout`: the RFC 8628 device-code client that puts a
 * bearer into ~/.eris/yaks.json, the file `eris yak` reads.
 *
 * The seam is the verb handler with a loopback `Bun.serve` standing in for the
 * gateway's `/v1/device/code` and `/v1/device/token`, and a sandbox HOME. The
 * clock and the sleep are injected so a ten-second `slow_down` costs nothing;
 * every request still crosses real HTTP. The token and device code are
 * assembled at runtime so no literal trips a secret scanner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { YAKS_CONTRACT_VERSION } from "eris/yak-contract";
import { runYakVerb } from "../plugins/yak/handlers";
import { runLogin, runLogout, type LoginDeps } from "../plugins/yak/login";
import { CliExit } from "../src/cli/ts-verb";

const REPO = resolve(import.meta.dir, "..");

const B64 = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"; // 43 base64url characters
const TOKEN = ["sib", "01HZX3K5Q8W2N4R6T8V0Y2B4D6", B64].join("_");
const DEVICE_CODE = ["sibdc", "BCDFGHJK", B64].join("_");
const USER_CODE = "BCDF-GHJK";

type Handler = (req: Request, body: Record<string, string>) => Response | Promise<Response>;

let sandbox: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let start: Handler;
let polls: Handler[];
const requests: { path: string; contentType: string; body: Record<string, string>; auth: string | null }[] = [];

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "login-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const contentType = req.headers.get("content-type") ?? "";
      const text = await req.text();
      const body: Record<string, string> = contentType.startsWith("application/json")
        ? (JSON.parse(text) as Record<string, string>)
        : Object.fromEntries(new URLSearchParams(text));
      requests.push({ path, contentType, body, auth: req.headers.get("authorization") });
      if (path === "/v1/device/code") return start(req, body);
      if (path === "/v1/device/token") {
        const next = polls.shift();
        if (next === undefined) throw new Error("the client polled past the scripted responses");
        return next(req, body);
      }
      if (path === "/v1/yaks") {
        const parsed = body as unknown as { idempotency_key: string };
        if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ error: { code: "unauthorized", message: "bad bearer" } }, { status: 401 });
        return Response.json({ id: "obs-1", idempotency_key: parsed.idempotency_key, replay: false, contract_version: YAKS_CONTRACT_VERSION });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(sandbox, "home-")));
  requests.length = 0;
  start = () => started();
  polls = [];
});

const url = () => `http://127.0.0.1:${server.port}`;
const yaksJson = () => join(home, ".eris", "yaks.json");

function started(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    device_code: DEVICE_CODE,
    user_code: USER_CODE,
    verification_uri: "https://dash.example.test/device",
    verification_uri_complete: `https://dash.example.test/device?code=${USER_CODE}`,
    expires_in: 600,
    interval: 5,
    ...overrides,
  });
}
const oauth = (error: string, extra: Record<string, unknown> = {}) => () => Response.json({ error, ...extra }, { status: 400 });
const minted = () => () => Response.json({ access_token: TOKEN, token_type: "Bearer", token_id: "tok_1", name: "laptop (eris)", scopes: ["yaks:write"] });

interface Run {
  rc: number;
  stdout: string;
  stderr: string;
  sleeps: number[];
  opened: string[];
}

async function drive(
  handler: typeof runLogin,
  args: string[],
  opts: { env?: Record<string, string | undefined>; deps?: Partial<LoginDeps> } = {},
): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const sleeps: number[] = [];
  const opened: string[] = [];
  let clock = 1_000_000;
  const ctx = {
    erisDir: REPO,
    env: opts.env ?? { PATH: process.env.PATH, HOME: home },
    format: "text" as const,
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: (s: string) => ((stderr += s), true) },
  };
  const deps: LoginDeps = {
    home,
    hostname: () => "laptop",
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    openBrowser: async (u) => {
      opened.push(u);
    },
    ...opts.deps,
  };
  let rc: number;
  try {
    rc = await handler(args, ctx, deps);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    rc = e.code;
  }
  return { rc, stdout, stderr, sleeps, opened };
}

/** Neither the bearer nor the device code may reach a terminal, a scrollback or a CI log. */
function expectNoSecret(r: Run): void {
  for (const secret of [TOKEN, DEVICE_CODE, B64]) {
    expect(r.stdout).not.toContain(secret);
    expect(r.stderr).not.toContain(secret);
  }
}

describe("eris login — the device-code grant", () => {
  it("pending → slow_down → approved writes {url, token} at 0600, and `eris yak` then authenticates with it", async () => {
    /** When the client ignores slow_down, polls a form the gateway refuses, or writes the bearer anywhere `eris yak` does not read (or readably), login "succeeds" and every yak after it fails or leaks — observed at the stub's requests, yaks.json and the next `eris yak`. */
    polls = [oauth("authorization_pending"), oauth("slow_down", { interval: 10 }), minted()];
    const r = await drive(runLogin, ["--url", url()]);

    expect({ rc: r.rc, stdout: r.stdout }).toEqual({ rc: 0, stdout: `logged in: token "laptop (eris)" written to ${yaksJson()}\n` });
    expect(r.stderr).toContain(USER_CODE);
    expect(r.stderr).toContain(`https://dash.example.test/device?code=${USER_CODE}`);
    expectNoSecret(r);
    expect(r.opened).toEqual([`https://dash.example.test/device?code=${USER_CODE}`]);
    // The advertised interval, again after a pending, then the raised one slow_down carried.
    expect(r.sleeps).toEqual([5000, 5000, 10000]);

    expect(requests[0]).toMatchObject({ path: "/v1/device/code", body: { device: "laptop (eris)" } });
    expect(requests.slice(1).map((q) => [q.path, q.contentType, q.body])).toEqual(
      Array(3).fill(["/v1/device/token", "application/x-www-form-urlencoded", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: DEVICE_CODE }]),
    );

    expect(JSON.parse(readFileSync(yaksJson(), "utf8"))).toEqual({ url: url(), token: TOKEN });
    expect(statSync(yaksJson()).mode & 0o777).toBe(0o600);

    // `eris yak` with nothing in the environment reads what login wrote.
    let yakOut = "";
    let yakErr = "";
    const yakRc = await runYakVerb(
      ["issue", "--summary", "s", "--body", "b"],
      {
        erisDir: REPO,
        env: { PATH: process.env.PATH, HOME: home },
        format: "text",
        stdout: { write: (s: string) => ((yakOut += s), true) },
        stderr: { write: (s: string) => ((yakErr += s), true) },
      },
      { cwd: sandbox, ppid: 1 },
    );
    expect({ rc: yakRc, stdout: yakOut, stderr: yakErr }).toEqual({ rc: 0, stdout: "recorded: obs-1\n", stderr: "" });
    expect(requests.find((r) => r.path === "/v1/yaks")).toMatchObject({ path: "/v1/yaks", auth: `Bearer ${TOKEN}` });
  });

  it.each([
    ["access_denied", "login-denied"],
    ["expired_token", "login-expired"],
  ])("a %s poll exits 1 with %s and leaves yaks.json byte-identical", async (error, slug) => {
    /** When a refused or lapsed code still writes (or clears) the credential file, a denied login silently signs the machine out — or in — observed at yaks.json and the exit code. */
    mkdirSync(join(home, ".eris"), { recursive: true });
    const before = `{"url": "${url()}", "token": "previous"}\n`;
    writeFileSync(yaksJson(), before, { mode: 0o600 });
    polls = [oauth("authorization_pending"), oauth(error)];

    const r = await drive(runLogin, []);
    expect({ rc: r.rc, stdout: r.stdout }).toEqual({ rc: 1, stdout: "" });
    expect(r.stderr).toContain(`slug: ${slug}`);
    expectNoSecret(r);
    expect(readFileSync(yaksJson(), "utf8")).toBe(before);
  });

  it("a code the server keeps pending past expires_in ends locally as login-expired, writing nothing", async () => {
    /** When the client trusts the server alone to end the grant, a code that is never approved polls forever — observed at the exit code and the number of polls. */
    start = () => started({ expires_in: 12, interval: 5 });
    polls = [oauth("authorization_pending"), oauth("authorization_pending"), oauth("authorization_pending")];
    const r = await drive(runLogin, ["--url", url()]);
    expect(r.rc).toBe(1);
    expect(r.stderr).toContain("slug: login-expired");
    expect(requests.filter((q) => q.path === "/v1/device/token").length).toBe(2);
    expect(existsSync(yaksJson())).toBe(false);
  });

  it("reads both error shapes: RFC {error} on a 400, the gateway's {error:{code}} on a 503, and waits out a 429", async () => {
    /** When the client reads only one error shape, a misconfigured scope or a rate limit surfaces as "unknown error" (or kills an approved login) — observed at stderr and the outcome. */
    start = () => Response.json({ error: "invalid_device" }, { status: 400 });
    const bad = await drive(runLogin, ["--url", url()]);
    expect(bad.rc).toBe(1);
    expect(bad.stderr).toContain("slug: login-refused");
    expect(bad.stderr).toContain("invalid_device");

    start = () => Response.json({ error: { code: "device_unconfigured", message: "device login is not configured in this scope" } }, { status: 503 });
    const off = await drive(runLogin, ["--url", url()]);
    expect(off.rc).toBe(1);
    expect(off.stderr).toContain("slug: login-refused");
    expect(off.stderr).toContain("device_unconfigured");

    start = () => started();
    const limited = () => new Response(JSON.stringify({ error: { code: "rate_limited", message: "retry after 30s" } }), { status: 429, headers: { "retry-after": "30", "content-type": "application/json" } });
    polls = [limited, minted()];
    const ok = await drive(runLogin, ["--url", url()]);
    expect(ok.rc).toBe(0);
    expect(ok.sleeps).toEqual([5000, 30000]);
    expect(JSON.parse(readFileSync(yaksJson(), "utf8")).token).toBe(TOKEN);
  });

  it("--no-browser prints the code without opening anything, and an ERIS_YAKS_TOKEN in the environment is called out", async () => {
    /** When a headless login spawns a browser, or the env token silently keeps winning over the one just written, the user believes they switched identity and did not — observed at the opener and stderr. */
    polls = [minted()];
    const r = await drive(runLogin, ["--url", url(), "--no-browser"], { env: { PATH: process.env.PATH, HOME: home, ERIS_YAKS_TOKEN: "env-token" } });
    expect(r.rc).toBe(0);
    expect(r.opened).toEqual([]);
    expect(r.stderr).toContain("slug: login-env-token-overrides");
  });
});

describe("eris logout", () => {
  it("removes the token, keeps the url at 0600, and `eris yak` then has no bearer", async () => {
    /** When logout leaves the bearer on disk (or deletes the url with it), the machine stays signed in — or cannot sign back in without re-typing the endpoint — observed at yaks.json. */
    mkdirSync(join(home, ".eris"), { recursive: true });
    writeFileSync(yaksJson(), JSON.stringify({ url: url(), token: TOKEN }), { mode: 0o600 });
    const r = await drive(runLogout, []);
    expect(r.rc).toBe(0);
    expectNoSecret(r);
    expect(JSON.parse(readFileSync(yaksJson(), "utf8"))).toEqual({ url: url() });
    expect(statSync(yaksJson()).mode & 0o777).toBe(0o600);

    const again = await drive(runLogout, []);
    expect({ rc: again.rc, stdout: again.stdout }).toEqual({ rc: 0, stdout: "not logged in: no token in " + yaksJson() + "\n" });
  });
});
