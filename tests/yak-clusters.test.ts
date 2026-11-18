/**
 * `eris yak clusters` and `eris yak show`.
 *
 * The seam is the `yak` group handler (`runYakVerb`) with a loopback `Bun.serve`
 * standing in for the gateway's cluster and observation reads and a sandbox HOME
 * holding the login. Every request crosses real HTTP; the server records each one
 * so a test can assert what was sent. Secrets are assembled at runtime so no
 * literal trips a secret scanner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runYakVerb } from "../plugins/yak/handlers";
import { CliExit } from "../src/cli/ts-verb";

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, "..");
const ORG_A = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const TOKEN_A = ["sib", ORG_A, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");

let sandbox: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let answer: (req: Request) => Response;
const requests: { method: string; path: string; auth: string | null }[] = [];

const ranked = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  kind: "report",
  summary: "eris baseline lock hangs",
  recent_count: 7,
  total_count: 9,
  last_seen: "2026-11-13T05:49:39.857Z",
  issue_identifier: "vr-12",
  recent_by_status: { filed: 7, pending: 0, failed: 0 },
  ...over,
});
const ranking = (clusters: unknown[] = [ranked(), ranked({ id: "c2", summary: "second", recent_count: 5, issue_identifier: null })], days = 7) => ({ days, clusters });
const clusterDetail = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  kind: "report",
  canonical_summary: "eris baseline lock hangs",
  keywords: ["baseline"],
  observation_count: 1,
  first_seen: "2026-11-10T00:00:00.000Z",
  last_seen: "2026-11-13T00:00:00.000Z",
  current_issue_id: "uuid",
  current_issue_identifier: "vr-12",
  issue_history: [{ issue_id: "uuid", issue_identifier: "vr-12", linked_at: "2026-11-10T00:00:01.000Z", closed_observed_at: null }],
  observation_ids: ["o1"],
  observations: [{ id: "o1", verb: "issue", summary: "it hangs", source: "agent", received_at: "2026-11-10T00:00:00.000Z", status: "processed" }],
  ...over,
});
const observationDetail = (over: Record<string, unknown> = {}) => ({
  id: "o1",
  idempotency_key: "k",
  verb: "issue",
  route: "org",
  summary: "it hangs",
  source: "agent",
  received_at: "2026-11-10T00:00:00.000Z",
  status: "processed",
  cluster_id: "c1",
  delivered_at: "2026-11-10T00:00:05.000Z",
  attempts: 1,
  last_error: null,
  data: { summary: "it hangs", body: "line one\nline two", evidence: "log", repro: "eris baseline lock" },
  provenance: { secret: "not for stdout" },
  ...over,
});
const problem = (status: number, code: string) =>
  Response.json({ type: `urn:hera:error:${code}`, title: "refused", status, detail: "refused", code }, { status, headers: { "content-type": "application/problem+json" } });

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "yak-clusters-")));
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
  writeFileSync(join(home, ".eris", "yaks.json"), JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token: TOKEN_A }), { mode: 0o600 });
  requests.length = 0;
  answer = () => Response.json(ranking());
});

async function run(verb: string, args: string[] = [], format: "text" | "json" = "text") {
  let stdout = "";
  let stderr = "";
  let rc: number;
  try {
    rc = await runYakVerb(
      [verb, ...args],
      {
        erisDir: REPO,
        env: { PATH: process.env.PATH, HOME: home },
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

describe("eris yak clusters", () => {
  it("text: ranked rows under the issue|recent|total|last_seen|summary header, one bearer GET", async () => {
    /** When a column is dropped or reordered, a TPM reading the table misses which issue a hot cluster is on: observed on stdout and the recorded request. */
    const r = await run("clusters", ["--days", "7"]);
    expect(r.rc).toBe(0);
    expect(r.stderr).toBe("");
    const lines = r.stdout.split("\n");
    expect(lines[0]).toMatch(/^issue\s+recent\s+total\s+last_seen\s+summary$/);
    expect(lines[1]).toMatch(/^vr-12\s+7\s+9\s+2026-11-13T05:49:39.857Z\s+eris baseline lock hangs$/);
    expect(lines[2]).toMatch(/^-\s+5\s+/);
    expect(requests).toEqual([{ method: "GET", path: "/v1/yaks/clusters?days=7", auth: `Bearer ${TOKEN_A}` }]);
  });

  it("--min-sightings keeps recent_count >= n: n kept, n-1 dropped", async () => {
    /** When the comparison is > instead of >=, a cluster at exactly the threshold is missed by the hot-yak query: observed at the boundary. */
    const r = await run("clusters", ["--days", "7", "--min-sightings", "7"], "json");
    expect(JSON.parse(r.stdout).clusters.map((c: { id: string }) => c.id)).toEqual(["c1"]);
    const r6 = await run("clusters", ["--min-sightings", "5"], "json");
    expect(JSON.parse(r6.stdout).clusters.map((c: { id: string }) => c.id)).toEqual(["c1", "c2"]);
    const none = await run("clusters", ["--min-sightings", "8"], "json");
    expect(none).toEqual({ rc: 0, stdout: `${JSON.stringify({ days: 7, clusters: [] })}\n`, stderr: "" });
  });

  it("json: the body bare, a key the contract does not name dropped, nothing on stderr", async () => {
    /** When json mode echoes a field the server should not send, a machine caller's parse breaks or an internal column leaks: observed on stdout. */
    answer = () => Response.json(ranking([ranked({ evidence: "private text" })]));
    const r = await run("clusters", [], "json");
    expect(r).toEqual({ rc: 0, stdout: `${JSON.stringify(ranking([ranked()]))}\n`, stderr: "" });
  });

  it("control characters in a summary never reach the table", async () => {
    /** When a reporter's escape sequence is printed raw, it can rewrite the terminal or split a row: observed on stdout. */
    answer = () => Response.json(ranking([ranked({ summary: "bad\u001b[2Jsummary\nsecond line" })]));
    const r = await run("clusters");
    expect(r.stdout).not.toContain("\u001b");
    expect(r.stdout.split("\n").filter((l) => l !== "")).toHaveLength(2);
  });

  it("refuses an unsupported window or limit before any request, naming the accepted values", async () => {
    /** When --days 14 is forwarded, the server answers 400 and the caller sees an unhelpful status: observed as zero requests and a fix line. */
    for (const args of [["--days", "14"], ["--days", "1"], ["--limit", "0"], ["--limit", "51"], ["--limit", "x"], ["--min-sightings", "-1"]]) {
      const r = await run("clusters", args);
      expect(r.rc).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("slug: yak-clusters-invalid");
    }
    expect(requests).toEqual([]);
  });

  it("forwards --limit and --days, and a 401 is yak-unauthorized with nothing on stdout", async () => {
    /** When the query is dropped the ranking is the default one: observed in the recorded path. A 401 must point at login: observed on stderr. */
    await run("clusters", ["--days", "30", "--limit", "5"]);
    expect(requests[0]?.path).toBe("/v1/yaks/clusters?days=30&limit=5");
    answer = () => problem(401, "unauthorized");
    const r = await run("clusters");
    expect(r.rc).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("slug: yak-unauthorized");
  });

  it("a status eris has no remedy for is yak-clusters-unavailable", async () => {
    /** When a 503 is shown as success or as a raw body, a caller cannot tell an outage from an empty week: observed on stderr. */
    answer = () => problem(503, "yak_unavailable");
    const r = await run("clusters");
    expect(r.rc).toBe(1);
    expect(r.stderr).toContain("slug: yak-clusters-unavailable");
  });

  it("an empty window prints nothing on stdout and says so on stderr", async () => {
    /** When the empty list prints a bare header, a script counting rows reads one cluster: observed on stdout. */
    answer = () => Response.json(ranking([]));
    const r = await run("clusters");
    expect(r.rc).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("no clusters");
  });
});

describe("eris yak show", () => {
  it("a cluster id reads the cluster, keeping unknown keys out of json", async () => {
    /** When the cluster read adds a column nobody reviewed, it is printed to every caller: observed on stdout. */
    answer = () => Response.json(clusterDetail());
    const r = await run("show", ["c1"], "json");
    expect(r.rc).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.id).toBe("c1");
    expect(body.keywords).toBeUndefined();
    expect(body.observations).toHaveLength(1);
    expect(requests).toEqual([{ method: "GET", path: "/v1/yaks/clusters/c1", auth: `Bearer ${TOKEN_A}` }]);
  });

  it("a key the server omits when empty (no close time, no current issue) still parses", async () => {
    /** When the schema demands null where the server omits the key, every cluster with an open issue link answers a contract mismatch (the live endpoint omits closed_observed_at): observed in the exit code and stdout. */
    const bare = clusterDetail({ issue_history: [{ issue_id: "uuid", issue_identifier: "vr-12", linked_at: "2026-11-10T00:00:01.000Z" }] });
    delete (bare as Record<string, unknown>).current_issue_identifier;
    answer = () => Response.json(bare);
    const r = await run("show", ["c1"], "json");
    expect(r.rc).toBe(0);
    expect(JSON.parse(r.stdout).issue_history[0].closed_observed_at).toBeUndefined();
    expect((await run("show", ["c1"])).stdout).toMatch(/^issue:\s+-$/m);
  });

  it("text: the cluster header lines and its observations table", async () => {
    /** When the text view drops the issue or the observations, show answers less than the cluster endpoint: observed on stdout. */
    answer = () => Response.json(clusterDetail());
    const r = await run("show", ["c1"]);
    expect(r.stdout).toMatch(/^cluster:\s+c1$/m);
    expect(r.stdout).toMatch(/^issue:\s+vr-12$/m);
    expect(r.stdout).toMatch(/^o1\s+issue\s+processed\s+/m);
  });

  it("an id the cluster read does not know falls back to the observation detail", async () => {
    /** When a 404 on the cluster read is final, an observation id from a cluster listing cannot be opened: observed in the second request. */
    answer = (req) => (new URL(req.url).pathname.startsWith("/v1/yaks/clusters/") ? problem(404, "cluster_not_found") : Response.json(observationDetail()));
    const r = await run("show", ["o1"]);
    expect(r.rc).toBe(0);
    expect(requests.map((q) => q.path)).toEqual(["/v1/yaks/clusters/o1", "/v1/yaks/observations/o1?detail=1"]);
    expect(r.stdout).toMatch(/^observation:\s+o1$/m);
    expect(r.stdout).toContain("line one\nline two");
    expect(r.stdout).not.toContain("not for stdout");
  });

  it("observation json drops provenance and the idempotency key", async () => {
    /** When the detail read's provenance reaches stdout, an internal column leaks to every caller: observed on stdout. */
    answer = (req) => (new URL(req.url).pathname.startsWith("/v1/yaks/clusters/") ? problem(404, "cluster_not_found") : Response.json(observationDetail()));
    const body = JSON.parse((await run("show", ["o1"], "json")).stdout);
    expect(body.provenance).toBeUndefined();
    expect(body.idempotency_key).toBeUndefined();
    expect(body.data.body).toBe("line one\nline two");
  });

  it("an id neither read knows is yak-show-not-found; no id is yak-show-missing-id", async () => {
    /** When a double 404 is reported as an outage, a caller retries a typo: observed on stderr. */
    answer = () => problem(404, "cluster_not_found");
    const nf = await run("show", ["nope"]);
    expect(nf.rc).toBe(1);
    expect(nf.stderr).toContain("slug: yak-show-not-found");
    expect(nf.stdout).toBe("");
    const missing = await run("show", []);
    expect(missing.stderr).toContain("slug: yak-show-missing-id");
  });

  it("a malformed id is refused before any request", async () => {
    /** When an id with a slash or query is spliced into the path, show reads a route the caller did not name: observed as zero requests. */
    const r = await run("show", ["a/../b?x=1"]);
    expect(r.rc).toBe(1);
    expect(requests).toEqual([]);
  });

  it("a non-404 refusal on the cluster read is not retried as an observation", async () => {
    /** When every failure falls through to the second read, a 503 is hidden behind a misleading 404: observed in the request count. */
    answer = () => problem(503, "yak_unavailable");
    const r = await run("show", ["c1"]);
    expect(r.stderr).toContain("slug: yak-show-unavailable");
    expect(requests).toHaveLength(1);
  });
});
