/**
 * `eris yak reports`.
 *
 * The seam is the `yak` group handler (`runYakVerb`) with a loopback
 * `Bun.serve` standing in for the gateway's `GET /v1/yaks/vendor-reports` and a
 * sandbox HOME holding the login. Every request crosses real HTTP; the server
 * records each one so a test can assert what was sent. Secrets are assembled
 * at runtime so no literal trips a secret scanner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runYakVerb } from "../plugins/yak/handlers";
import { CliExit } from "../src/cli/ts-verb";

const REPO = resolve(import.meta.dir, "..");
const ORG_A = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const ORG_B = "01HZX3K5Q8W2N4R6T8V0Y2B4D7";
const bearer = (org: string, secret: string) => ["sib", org, secret].join("_");
const TOKEN_A = bearer(ORG_A, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE");
const TOKEN_B = bearer(ORG_B, "ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210-_ZyXwV");

let sandbox: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let answer: (req: Request) => Response;
const requests: { method: string; path: string; auth: string | null }[] = [];

const report = (over: Record<string, unknown> = {}) => ({
  id: "obs_1",
  summary: "eris yak fatal exits 1 on a fresh install",
  issue_identifier: "vr-12",
  issue_url: "https://tracker.example.com/issue/vr-12",
  state: { name: "In Progress", type: "started" },
  submitted_at: "2026-11-12T09:00:00.000Z",
  ...over,
});
const body = (reports: unknown[] = [report(), report({ id: "obs_2", issue_identifier: "vr-13", state: { name: "Unknown", type: "unknown" }, summary: "second report" })]) => ({ reports });
const problem = (status: number, code: string) =>
  Response.json({ type: `urn:hera:error:${code}`, title: "refused", status, detail: "refused", code }, { status, headers: { "content-type": "application/problem+json" } });

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "yak-reports-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      requests.push({ method: req.method, path: new URL(req.url).pathname, auth: req.headers.get("authorization") });
      return answer(req);
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(sandbox, "home-")));
  mkdirSync(join(home, ".eris"), { recursive: true, mode: 0o700 });
  const url = `http://127.0.0.1:${server.port}`;
  writeFileSync(join(home, ".eris", "yaks.json"), JSON.stringify({ url, token: TOKEN_A, orgs: { [ORG_B]: { url, token: TOKEN_B } } }), { mode: 0o600 });
  requests.length = 0;
  answer = () => Response.json(body());
});

async function reports(args: string[] = [], format: "text" | "json" = "text", env: Record<string, string> = {}) {
  let stdout = "";
  let stderr = "";
  let rc: number;
  try {
    rc = await runYakVerb(
      ["reports", ...args],
      {
        erisDir: REPO,
        env: { PATH: process.env.PATH, HOME: home, ...env },
        format,
        stdout: { write: (s: string) => ((stdout += s), true) },
        stderr: { write: (s: string) => ((stderr += s), true) },
      },
      { cwd: sandbox },
    );
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    rc = e.code;
  }
  return { rc, stdout, stderr };
}

describe("eris yak reports", () => {
  it("text: one row per report with its Linear state, and the request is a bearer GET of the bearer route", async () => {
    /** When the verb reads the portal route (session-only) or drops the state column, a CLI token gets a 401 or an org cannot see where its report stands: observed in the recorded request and on stdout. */
    const r = await reports();
    expect(r.rc).toBe(0);
    expect(r.stderr).toBe("");
    const lines = r.stdout.split("\n");
    expect(lines[0]).toMatch(/^issue\s+state\s+submitted\s+summary$/);
    expect(lines[1]).toMatch(/^vr-12\s+In Progress\s+2026-11-12T09:00:00.000Z\s+eris yak fatal exits 1 on a fresh install$/);
    expect(lines[2]).toMatch(/^vr-13\s+Unknown\s+/);
    expect(requests).toEqual([{ method: "GET", path: "/v1/yaks/vendor-reports", auth: `Bearer ${TOKEN_A}` }]);
  });

  it("json: the body bare, a key the contract does not name dropped, nothing on stderr", async () => {
    /** When json mode reshapes the list or echoes a field the server should not send (a body or evidence column), a machine caller's parse breaks or customer text leaks to stdout: observed on stdout. */
    answer = () => Response.json(body([report({ evidence: "the org's secret text", body: "more" })]));
    const r = await reports([], "json");
    expect(r).toEqual({ rc: 0, stdout: `${JSON.stringify(body([report()].slice(0, 1)))}\n`, stderr: "" });
  });

  it("an org with no reports prints nothing on stdout and says so on stderr", async () => {
    /** When the empty list prints a bare header, a script counting rows reads one report: observed on stdout. */
    answer = () => Response.json({ reports: [] });
    const r = await reports();
    expect(r.rc).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("no vendor reports yet");
  });

  it("a summary with a newline or control characters stays on one line", async () => {
    /** When the summary is printed raw, a report whose text holds a newline or an escape byte splits the table or rewrites the terminal: observed on stdout. */
    answer = () => Response.json(body([report({ summary: "line one\nline two\u001b[31m red", issue_identifier: "vr-1" })]));
    const r = await reports();
    expect(r.stdout.split("\n").filter((l) => l !== "")).toHaveLength(2);
    expect(r.stdout).not.toContain("\u001b");
    expect(r.stdout).toContain("line one line two [31m red");
  });

  it("sends the bearer of the org ERIS_ORG selects", async () => {
    /** When the verb ignores the org selection, an operator acting as org B lists org A's reports: observed in the Authorization header the server saw. */
    const r = await reports([], "text", { ERIS_ORG: ORG_B });
    expect(r.rc).toBe(0);
    expect(requests[0]?.auth).toBe(`Bearer ${TOKEN_B}`);
  });

  it("each refusal is its own slug on stderr with nothing on stdout, exit 1", async () => {
    /** When a refusal collapses into one slug or leaks to stdout, the operator cannot tell a dead login from an unset mirror: observed on both streams. */
    const cases: [number, string, string][] = [
      [401, "unauthorized", "yak-unauthorized"],
      [403, "forbidden", "yak-reports-forbidden"],
      [503, "vendor_unconfigured", "yak-reports-unconfigured"],
      [500, "boom", "yak-reports-unavailable"],
      [404, "not_found", "yak-reports-unavailable"],
    ];
    for (const [status, code, slug] of cases) {
      answer = () => problem(status, code);
      const r = await reports();
      expect({ status, rc: r.rc, stdout: r.stdout, slug: r.stderr.includes(`slug: ${slug}`) }).toEqual({ status, rc: 1, stdout: "", slug: true });
    }
  });

  it("the server's code is named on the block, and a code that is not a short snake_case word is not echoed", async () => {
    /** When the top-level problem code is dropped the block loses the server's reason, and when an unsanitised code is echoed a hostile endpoint writes control bytes to the terminal: observed on stderr. */
    answer = () => problem(404, "not_found");
    expect((await reports()).stderr).toContain("answered 404 not_found for");
    answer = () => problem(500, "Bad\u001b[31m code");
    const r = await reports();
    expect(r.stderr).toContain("slug: yak-reports-unavailable");
    expect(r.stderr).toContain("answered 500 for");
    expect(r.stderr).not.toContain("\u001b[31m");
  });

  it("a body that does not match the contract is refused, not printed", async () => {
    /** When a malformed 200 is rendered, the table shows undefined cells or the verb reads success on an unknown shape (fail closed): observed on both streams. */
    answer = () => Response.json({ reports: [{ id: 7 }] });
    const r = await reports();
    expect({ rc: r.rc, stdout: r.stdout, slug: r.stderr.includes("slug: yak-admin-unavailable") }).toEqual({ rc: 1, stdout: "", slug: true });
  });

  it("an unreachable endpoint is yak-admin-unavailable, never a stack trace", async () => {
    /** When a network failure escapes the request helper, the verb dies with an unhandled rejection instead of the failure block: observed on stderr. */
    writeFileSync(join(home, ".eris", "yaks.json"), JSON.stringify({ url: "http://127.0.0.1:1", token: TOKEN_A }), { mode: 0o600 });
    const r = await reports();
    expect({ rc: r.rc, stdout: r.stdout, slug: r.stderr.includes("slug: yak-admin-unavailable") }).toEqual({ rc: 1, stdout: "", slug: true });
  });
});
