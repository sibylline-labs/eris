/**
 * `eris yak retry` and `eris events list|parked`.
 *
 * The seam is the `yak` and `events` group handlers with a loopback `Bun.serve` standing in
 * for the gateway's observation-retry and events routes, and a sandbox HOME holding the login.
 * Every request crosses real HTTP; the server records each one so a test can assert what was
 * sent. The bearer is assembled at runtime so no literal trips a secret scanner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runEvents } from "../plugins/yak/events";
import { runYakVerb } from "../plugins/yak/handlers";
import { CliExit } from "../src/cli/ts-verb";

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, "..");
const ORG = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const TOKEN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const OBS = "01J0AAAAAAAAAAAAAAAAAAAAAA";

let sandbox: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let answer: (req: Request) => Response;
const requests: { method: string; path: string; auth: string | null }[] = [];

const problem = (status: number, code: string) =>
  Response.json({ type: `urn:hera:error:${code}`, title: "refused", status, detail: "refused", code }, { status, headers: { "content-type": "application/problem+json" } });

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "yak-retry-events-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      requests.push({ method: req.method, path: u.pathname + u.search, auth: req.headers.get("authorization") });
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
  writeFileSync(join(home, ".eris", "yaks.json"), JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token: TOKEN }), { mode: 0o600 });
  requests.length = 0;
});

async function run(group: "yak" | "events", args: string[], format: "text" | "json" = "text") {
  let stdout = "";
  let stderr = "";
  let rc: number;
  const ctx = {
    erisDir: REPO,
    env: { PATH: process.env.PATH, HOME: home },
    format,
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: (s: string) => ((stderr += s), true) },
  };
  try {
    rc = group === "yak" ? await runYakVerb(args, ctx, { cwd: sandbox }) : await runEvents(args, ctx, { cwd: sandbox, home });
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    rc = e.code;
  }
  return { rc, stdout, stderr };
}

describe("eris yak retry", () => {
  it("posts to the observation's retry route and reports whether it was requeued", async () => {
    /** When retry is sent as GET, or a not-requeued answer is printed as success, the operator believes a stuck observation is back in the queue: observed in the recorded request and stdout. */
    answer = () => Response.json({ requeued: true, status: "pending" });
    const ok = await run("yak", ["retry", OBS]);
    expect(ok.rc).toBe(0);
    expect(ok.stdout).toBe(`requeued ${OBS}\n`);
    answer = () => Response.json({ requeued: false, status: "filed", ok: true });
    const no = await run("yak", ["retry", OBS], "json");
    expect(JSON.parse(no.stdout)).toEqual({ requeued: false, status: "filed", ok: true });
    expect((await run("yak", ["retry", OBS])).stdout).toContain("not requeued");
    expect(requests[0]).toEqual({ method: "POST", path: `/v1/yaks/observations/${OBS}/retry`, auth: `Bearer ${TOKEN}` });
  });

  it("maps the server's refusals and sends nothing for a bad id", async () => {
    /** When a 403 or 404 collapses into one 'unavailable', the operator retries a refusal only an admin or a right id fixes; when `../x` reaches fetch the POST lands on another route: observed in the slugs and the request log. */
    answer = () => problem(403, "admin_required");
    expect((await run("yak", ["retry", OBS])).stderr).toContain("slug: yak-retry-admin-required");
    answer = () => problem(404, "observation_not_found");
    expect((await run("yak", ["retry", OBS])).stderr).toContain("slug: yak-retry-not-found");
    requests.length = 0;
    expect((await run("yak", ["retry"])).stderr).toContain("slug: yak-retry-missing-id");
    expect((await run("yak", ["retry", "../x"])).stderr).toContain("slug: yak-retry-not-found");
    expect(requests).toEqual([]);
  });
});

describe("eris events", () => {
  it("lists a product's day with its query, a table, and the next cursor on stderr", async () => {
    /** When --product or --day is dropped from the query, or the cursor lands on stdout, the read answers the wrong day or breaks the payload-only stdout: observed in the recorded path and the two streams. */
    answer = () =>
      Response.json({
        events: [{ event_id: "01M7NZQDQQ66CFK54AKJV6AE9A", org_id: ORG, product: "yak", stream: "YakTenant/org:x", seq: 1, type: "yak.submitted@1", occurred_at: "2026-11-18T00:00:00.000Z", actor: { kind: "user", id: "m" }, payload: {} }],
        next_cursor: "abc:1",
        ok: true,
      });
    const r = await run("events", ["list", "--product", "yak", "--day", "2026-11-18", "--limit", "5"]);
    expect(r.rc).toBe(0);
    expect(requests[0]!.path).toBe("/v1/events?day=2026-11-18&limit=5&product=yak");
    expect(r.stdout).toMatch(/^event_id\s+type\s+occurred_at\s+stream\n01M7NZQDQQ66CFK54AKJV6AE9A\s+yak\.submitted@1/);
    expect(r.stderr).toContain("INFO next cursor: abc:1");
    const j = await run("events", ["list", "--product", "yak", "--day", "2026-11-18"], "json");
    expect(JSON.parse(j.stdout).ok).toBe(true);
  });

  it("reads parked lines, and reports the operator-only 404 as its own slug", async () => {
    /** When the 404 every non-operator org gets is shown as an empty list, the operator thinks nothing is parked: observed in the slug and the empty stdout. */
    answer = () => Response.json({ lines: [{ message_id: "m1", enqueued_at: "2026-11-18T01:00:00.000Z", attempts: 2, body: {} }], next_cursor: null });
    const ok = await run("events", ["parked", "--day", "2026-11-18"]);
    expect(ok.stdout).toMatch(/m1\s+2026-11-18T01:00:00\.000Z\s+2/);
    expect(requests[0]!.path).toBe("/v1/events/parked?day=2026-11-18");
    answer = () => problem(404, "not_found");
    const no = await run("events", ["parked", "--day", "2026-11-18"]);
    expect(no.rc).toBe(1);
    expect(no.stdout).toBe("");
    expect(no.stderr).toContain("slug: events-not-found");
  });

  it("refuses a bad product, day, limit or cursor before sending", async () => {
    /** When an impossible day or an over-cap limit is sent, the server's 400 is the only signal and `Feb-30` is read as a date by a lax parser: observed in the slug and an empty request log. */
    for (const args of [["list"], ["list", "--product", "Yak"], ["list", "--product", "yak", "--day", "2026-02-30"], ["list", "--product", "yak", "--limit", "501"], ["parked", "--day", "yesterday"], ["parked", "--cursor", "x".repeat(65)]]) {
      const r = await run("events", args);
      expect(r.rc).toBe(1);
      expect(r.stderr).toContain("slug: events-invalid");
    }
    expect(requests).toEqual([]);
  });
});
