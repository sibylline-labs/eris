/**
 * `eris yak status <id>` and `eris yak checkpoint`: one vendor report's state and checkpoints, read and
 * written.
 *
 * The seam is the `yak` group handler with a loopback `Bun.serve` standing in for the gateway's
 * vendor-report routes, and a sandbox HOME holding the login. Every request crosses real HTTP; the
 * server records each one, body included, so a test can assert what was sent. The bearer is assembled
 * at runtime so no literal trips a secret scanner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runYakVerb } from "../plugins/yak/handlers";
import { CliExit } from "../src/cli/ts-verb";

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, "..");
const ORG = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const TOKEN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const REPORT = "01J0AAAAAAAAAAAAAAAAAAAAAA";

let sandbox: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let answer: (req: Request) => Response;
const requests: { method: string; path: string; auth: string | null; body: string }[] = [];

const problem = (status: number, code: string) =>
  Response.json({ type: `urn:error:${code}`, title: "refused", status, detail: "refused", code }, { status, headers: { "content-type": "application/problem+json" } });

const checkpoint = (stage: string, extra: Record<string, string> = {}) => ({ id: `cp-${stage}`, stage, note: `note ${stage}`, created_at: `2026-11-1${stage.length % 9}T00:00:00.000Z`, ...extra });

const report = (checkpoints: unknown[]) => ({
  id: REPORT,
  summary: "a hook blocks a legal edit",
  issue_identifier: "vr-12",
  issue_url: "https://tracker.example/issue/vr-12",
  state: { name: "In Progress", type: "started" },
  submitted_at: "2026-11-10T00:00:00.000Z",
  checkpoints,
  extra_key: "dropped",
});

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "yak-vendor-status-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      requests.push({ method: req.method, path: u.pathname + u.search, auth: req.headers.get("authorization"), body: await req.text() });
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

async function run(args: string[], format: "text" | "json" = "text") {
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
    rc = await runYakVerb(args, ctx, { cwd: sandbox });
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    rc = e.code;
  }
  return { rc, stdout, stderr };
}

describe("eris yak status <id>", () => {
  // admits: integration: an id that is dropped, or a fixed report whose release and command go unprinted, leaves the filer unable to pick up the fix; a type cannot see what the handler routes or renders.
  it("reads the one report and prints its checkpoints, ending with the fix to run", async () => {
    answer = () => Response.json(report([checkpoint("triaged"), checkpoint("fixed", { release: "0.42.0", command: "eris update" })]));
    const r = await run(["status", REPORT]);
    expect(r.rc).toBe(0);
    expect(requests[0]).toMatchObject({ method: "GET", path: `/v1/yaks/vendor-reports/${REPORT}`, auth: `Bearer ${TOKEN}` });
    expect(r.stdout).toContain("a hook blocks a legal edit");
    expect(r.stdout).toContain("vr-12");
    expect(r.stdout).toContain("In Progress");
    expect(r.stdout).toMatch(/2026-11-17T00:00:00\.000Z\s+triaged\s+note triaged\n/);
    expect(r.stdout.endsWith("fixed in 0.42.0 — run: eris update\n")).toBe(true);

    answer = () => Response.json({ ...report([checkpoint("wont-fix", { reason: "works as designed" })]), issue_identifier: null, issue_url: null });
    const w = await run(["status", REPORT]);
    expect(w.stdout).toContain("not filed yet");
    expect(w.stdout.endsWith("won't fix: works as designed\n")).toBe(true);

    const j = await run(["status", REPORT], "json");
    expect(JSON.parse(j.stdout)).not.toHaveProperty("extra_key");
    expect(JSON.parse(j.stdout).checkpoints[0].reason).toBe("works as designed");
  });

  // admits: boundary-io: a 404 shown as 'unavailable', or a dot-segment id reaching fetch, sends the filer to retry a report that does not exist or onto another route; observed in the slug and the request log.
  it("maps the server's not-found to its own slug and sends nothing for a malformed id", async () => {
    answer = () => problem(404, "vendor_report_not_found");
    const r = await run(["status", REPORT]);
    expect(r.rc).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("slug: vendor-report-not-found");
    requests.length = 0;
    expect((await run(["status", ".."])).stderr).toContain("slug: vendor-report-not-found");
    expect(requests).toEqual([]);
  });
});

describe("eris yak checkpoint", () => {
  // admits: boundary-io: a body carrying an absent key as null, or a flag sent under the wrong name, is refused or misread by the server; observed in the recorded request body.
  it("posts exactly the keys it was given and reports a replay as already recorded", async () => {
    answer = () => Response.json({ checkpoint: checkpoint("fixed", { release: "0.42.0", command: "eris update" }), replay: false });
    const r = await run(["checkpoint", REPORT, "--stage", "fixed", "--note", "shipped", "--release", "0.42.0", "--command", "eris update"]);
    expect(r.rc).toBe(0);
    expect(requests[0]).toMatchObject({ method: "POST", path: `/v1/yaks/vendor-reports/${REPORT}/checkpoints`, auth: `Bearer ${TOKEN}` });
    expect(JSON.parse(requests[0]!.body)).toEqual({ stage: "fixed", note: "shipped", release: "0.42.0", command: "eris update" });
    expect(r.stdout).toBe("recorded checkpoint cp-fixed (fixed)\n");

    answer = () => Response.json({ checkpoint: checkpoint("triaged"), replay: true });
    const again = await run(["checkpoint", REPORT, "--stage", "triaged", "--note", "seen"]);
    expect(JSON.parse(requests[1]!.body)).toEqual({ stage: "triaged", note: "seen" });
    expect(again.stdout).toBe("already recorded checkpoint cp-triaged (triaged)\n");
  });

  // admits: algorithmic: a fixed checkpoint without its release and command, or a won't-fix without a reason, tells the filer nothing they can act on; observed as a refusal and an empty request log.
  it("refuses an incomplete or out-of-range checkpoint before sending", async () => {
    for (const args of [
      ["checkpoint", REPORT, "--stage", "fixed", "--note", "shipped", "--command", "eris update"],
      ["checkpoint", REPORT, "--stage", "fixed", "--note", "shipped", "--release", "0.42.0"],
      ["checkpoint", REPORT, "--stage", "wont-fix", "--note", "no"],
      ["checkpoint", REPORT, "--stage", "done", "--note", "x"],
      ["checkpoint", REPORT, "--stage", "triaged", "--note", "x".repeat(501)],
      ["checkpoint", REPORT, "--stage", "fixed", "--note", "x", "--release", "v".repeat(81), "--command", "c"],
      ["checkpoint", "--stage", "triaged", "--note", "x"],
    ]) {
      const r = await run(args);
      expect({ args, rc: r.rc }).toEqual({ args, rc: 1 });
      expect(r.stderr).toContain("slug: yak-checkpoint-invalid");
    }
    expect(requests).toEqual([]);
  });

  // admits: boundary-io: a 403 collapsed into 'unavailable' sends a non-vendor org to retry a refusal only the vendor can clear; observed in the slug and exit code.
  it("maps the server's refusals to their own slugs", async () => {
    for (const [status, code, slug] of [
      [403, "vendor_operator_required", "vendor-operator-required"],
      [404, "vendor_report_not_found", "vendor-report-not-found"],
      [422, "checkpoint_invalid", "yak-checkpoint-invalid"],
    ] as const) {
      answer = () => problem(status, code);
      const r = await run(["checkpoint", REPORT, "--stage", "triaged", "--note", "seen"]);
      expect(r.rc).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(`slug: ${slug}`);
    }
  });
});
