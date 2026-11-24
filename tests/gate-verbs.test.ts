/**
 * `eris gate record | skip | check` at the verb seam: the gate handler driven with argv, a loopback
 * `Bun.serve` standing in for the gateway (an in-memory receipt store with the receipt, asset,
 * artifact and asks routes), a sandbox HOME holding the login, and real git checkouts under .scratch/.
 * Every request crosses real HTTP; the server records what it was sent. The bearer is assembled at
 * runtime so no literal trips a secret scanner, and rung names come from the contract's `RUNGS`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { RUNGS, sha256Hex } from "eris/gates-contract";
import { gateHandler, type GateDeps } from "../plugins/gate/gate";
import type { GateDefaults } from "../plugins/gate/index";
import { CliExit } from "../src/cli/ts-verb";

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, "..");
const ORG = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const LOGIN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const ASSET_HOST = ["uploads", "linear", "app"].join(".");
const ISSUE = "ABC-7";
const [HUMAN_BEFORE, HUMAN_AFTER, AUTO] = [RUNGS[0], RUNGS[1], RUNGS[2]];

interface StoredRow {
  comment_id: string;
  created_at: string;
  marker_version: "v1" | "v2";
  payload: unknown;
}

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: string;
}

let sandbox: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let store: Record<string, StoredRow[]>;
let seen: Seen[];
let clock: number;
let asks: unknown[];
let copies: Record<string, unknown>;
let override: Record<string, (s: Seen) => Response | undefined>;
let replyHeaders: Record<string, string>;

const problem = (status: number, code: string, headers: Record<string, string> = {}) => Response.json({ status, code }, { status, headers: { "content-type": "application/problem+json", ...headers } });
const at = () => new Date(Date.UTC(2026, 10, 17, 10, 0, clock++)).toISOString();

function route(s: Seen): Response {
  const custom = override[`${s.method} ${s.path}`]?.(s);
  if (custom !== undefined) return custom;
  if (s.method === "GET" && s.path === "/v1/gates/receipts") {
    const issue = s.query.get("issue") ?? "";
    const receipts = (store[issue] ?? []).map((r) => ({ ...r, source: "olympus", record_sha256: null, author: { kind: "app", name: null } }));
    return Response.json({ issue, receipts, invalid: 0, contract_version: "gates-contract/v1" }, { headers: replyHeaders });
  }
  if (s.method === "POST" && s.path === "/v1/gates/receipts") {
    const body = JSON.parse(s.body) as { comment_id: string; issue: string; receipt: { gate: string } };
    const row = { comment_id: body.comment_id, created_at: at(), marker_version: "v2" as const, payload: body.receipt };
    (store[body.issue] ??= []).push(row);
    return Response.json(
      { comment_id: body.comment_id, issue: body.issue, gate: body.receipt.gate, created_at: row.created_at, record_sha256: sha256Hex(JSON.stringify(body.receipt)), contract_version: "gates-contract/v1" },
      { status: 201, headers: replyHeaders },
    );
  }
  if (s.method === "GET" && s.path === "/v1/gates/assets/digest") return problem(404, "asset_not_found");
  if (s.method === "GET" && s.path.startsWith("/v1/gates/artifacts/")) {
    const copy = copies[s.path.slice("/v1/gates/artifacts/".length)];
    return copy === undefined ? problem(404, "artifact_not_found") : Response.json({ ...(copy as object), contract_version: "gates-contract/v1.2" });
  }
  if (s.method === "GET" && s.path === "/v1/asks") return Response.json({ asks: asks.filter((a) => (s.query.get("issue") === null ? true : (a as { binds: { issue: string } }).binds.issue === s.query.get("issue"))) });
  return problem(404, "not_found");
}

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "gate-verbs-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const s: Seen = { method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body: await req.text() };
      seen.push(s);
      return route(s);
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
  writeFileSync(join(home, ".eris", "yaks.json"), JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token: LOGIN }), { mode: 0o600 });
  store = {};
  seen = [];
  clock = 0;
  asks = [];
  copies = {};
  override = {};
  replyHeaders = {};
});

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd, env: { PATH: process.env.PATH, HOME: home } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** A checkout of `owner/name` whose HEAD is "pushed" (origin/main points at it), holding `files`. */
function checkout(slug: string, files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(sandbox, "repo-")));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "remote", "add", "origin", `https://github.com/${slug}.git`);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  return dir;
}

interface Ran {
  code: number;
  out: string;
  err: string;
}

async function gate(args: string[], opts: { cwd?: string; defaults?: GateDefaults; deps?: GateDeps; env?: Record<string, string> } = {}): Promise<Ran> {
  let out = "";
  let err = "";
  const ctx = {
    erisDir: REPO,
    env: { HOME: home, PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: sandbox, ...opts.env },
    stdout: { write: (s: string) => ((out += s), true) },
    stderr: { write: (s: string) => ((err += s), true) },
    format: "text" as const,
  };
  const deps: GateDeps = { home, cwd: opts.cwd ?? sandbox, now: () => new Date("2026-11-17T09:00:00.000Z"), sleep: async () => {}, jitter: () => 0, expectDelaysMs: [0, 0], ...opts.deps };
  try {
    return { code: await gateHandler(opts.defaults ?? {}, deps)(args, ctx), out, err };
  } catch (e) {
    if (e instanceof CliExit) return { code: e.code, out, err };
    throw e;
  }
}

const receipt = (over: Record<string, unknown> = {}) => ({
  schema: "gate-receipt@v2",
  gate: "plan-review",
  issue: ISSUE,
  verdict: "PASS",
  artifact: { _tag: "file", path: "/nowhere/plan.md", sha256: sha256Hex("plan") },
  actor: "someone@example.com",
  evidence: [],
  recorded_at: "2026-11-17T08:00:00.000Z",
  ...over,
});

const put = (payload: unknown, version: "v1" | "v2" = "v2", id = `c-${clock}`) => {
  (store[ISSUE] ??= []).push({ comment_id: id, created_at: at(), marker_version: version, payload });
  return id;
};

const artifactFile = () => {
  const file = join(home, "plan.md");
  writeFileSync(file, "plan");
  return file;
};

const posts = () => seen.filter((s) => s.method === "POST" && s.path === "/v1/gates/receipts").map((s) => JSON.parse(s.body) as { comment_id: string; receipt: Record<string, unknown>; prose: string });

describe("record and check round trip", () => {
  // admits: integration: a receipt this build records must read pass in its own check from another directory (the git locator), and a later byte change must read drift; observed at check's row and exit.
  it("records a git artifact with a carried copy, reads it back as pass, then as drift once the file changes", async () => {
    const dir = checkout("o/r", { "plan.md": "# plan\n" });
    const rec = await gate(["record", "plan-review", "--issue", ISSUE, "--verdict", "PASS", "--artifact", "plan.md", "--actor", "tester@example.com"], { cwd: dir });
    expect(rec.code).toBe(0);
    const [post] = posts();
    expect(rec.out).toBe(`${post!.comment_id}\n`);
    expect(post!.receipt.artifact).toMatchObject({ _tag: "git", repo: "o/r", ref: "main", path: "plan.md", sha256: sha256Hex("# plan\n"), copy: { encoding: "gzip+base64" } });
    expect(post!.prose).toContain("+++ Gate receipt — plan-review: PASS");

    const ok = await gate(["check", "--issue", ISSUE, "--gates", "plan-review", "--expect", post!.comment_id], { cwd: dir });
    expect({ code: ok.code, out: ok.out }).toEqual({ code: 0, out: "plan-review\tpass\tPASS\n" });

    writeFileSync(join(dir, "plan.md"), "# plan, edited\n");
    git(dir, "commit", "-qam", "edit");
    const drift = await gate(["check", "--issue", ISSUE, "--gates", "plan-review"], { cwd: dir });
    expect({ code: drift.code, out: drift.out }).toEqual({ code: 3, out: "plan-review\tdrift\tPASS\n" });
    expect(drift.err).toContain("slug: gate-check-failed");
  });

  // admits: boundary-io: an in-repo artifact that is not committed and pushed would record a locator no other checkout can resolve; record must refuse before anything is sent, observed at the slug and the empty POST log.
  it("refuses an uncommitted in-repo artifact before sending anything", async () => {
    const dir = checkout("o/r", { "plan.md": "# plan\n" });
    writeFileSync(join(dir, "plan.md"), "dirty\n");
    const r = await gate(["record", "plan-review", "--issue", ISSUE, "--verdict", "PASS", "--artifact", "plan.md", "--actor", "a@example.com"], { cwd: dir });
    expect(r.code).toBe(3);
    expect(r.err).toContain("slug: gate-artifact-uncommitted");
    expect(posts()).toEqual([]);
  });

  // admits: boundary-io: a login URL that is plain http off loopback would carry the bearer in cleartext, or print "run eris login" when the login is fine; observed at the slug and the empty request log.
  it("refuses a plain-http login URL under its own slug, sending nothing", async () => {
    writeFileSync(join(home, ".eris", "yaks.json"), JSON.stringify({ url: "http://example.invalid", token: LOGIN }), { mode: 0o600 });
    const r = await gate(["record", "plan-review", "--issue", ISSUE, "--verdict", "PASS", "--artifact", artifactFile(), "--actor", "a@example.com"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("slug: login-url-refused");
    expect(seen).toEqual([]);
  });

  // admits: boundary-io: a 429 on the write must be retried with the same comment id, or the gateway stores the receipt twice; observed at the two POST bodies.
  it("retries a rate-limited write under the same comment id", async () => {
    let refused = 0;
    override["POST /v1/gates/receipts"] = () => (refused++ === 0 ? problem(429, "rate_limited", { "retry-after": "0" }) : undefined);
    const r = await gate(["record", "plan-review", "--issue", ISSUE, "--verdict", "PASS", "--artifact", artifactFile(), "--actor", "a@example.com"]);
    expect(r.code).toBe(0);
    const ids = seen.filter((s) => s.method === "POST").map((s) => (JSON.parse(s.body) as { comment_id: string }).comment_id);
    expect(ids.length).toBe(2);
    expect(ids[0]).toBe(ids[1]!);
  });
});

describe("check statuses", () => {
  const sha = sha256Hex("plan");
  const copy = { encoding: "gzip+base64", content: gzipSync(Buffer.from("plan")).toString("base64"), bytes: 4 };
  const stamp = {
    id: "01HZX3K5Q8W2N4R6T8V0Y2B4D6",
    use_id: "01HZX3K5Q8W2N4R6T8V0Y2B4D7",
    root_id: "01HZX3K5Q8W2N4R6T8V0Y2B4D8",
    scope: "sr:us:mandate:gate:skip?gate=plan-review&issue=ABC-7",
    chain_digest: "A".repeat(43),
    attestation: "aa.bb.cc",
  };
  const report = {
    target: { repo: "o/r", pr: 1, head_sha: "a".repeat(40), diff_sha256: "b".repeat(64) },
    surface: "auth",
    effort: "high",
    reviewer: { actor: "someone@example.com", model: "m", fresh_context: true, skill: { name: "review", harness_sha: "c".repeat(40), sha256: "d".repeat(64) }, vocabulary: { path: "v.md", sha256: "e".repeat(64) } },
    author: { actor: "session:y" },
    classes_checked: ["authz"],
    findings: [],
  };

  // admits: algorithmic: each receipt shape maps to one status a loop branches on (and exit 0 only for pass/skipped); a wrong branch passes a gate that should block or blocks one that passed, observed at check's row and exit.
  it.each([
    ["no receipt", () => {}, "missing", "-", 3],
    ["BLOCKING", () => put(receipt({ verdict: "BLOCKING" })), "blocking", "BLOCKING", 3],
    ["SKIPPED on a human grant", () => put(receipt({ verdict: "SKIPPED", authorized: "someone asked: skip it", reason: "not needed here" })), "skipped", "SKIPPED", 0],
    ["SKIPPED with no grant", () => put(receipt({ verdict: "SKIPPED", reason: "not needed here" })), "unauthorized-skip", "SKIPPED", 3],
    ["SKIPPED stamped with a mandate", () => put(receipt({ schema: "gate-receipt@v3", verdict: "SKIPPED", reason: "not needed here", mandate: stamp })), "skipped", "SKIPPED", 0],
    ["a doctrine SKIPPED with no doctrine to bear it out", () => put(receipt({ verdict: "SKIPPED", authorized: "doctrine:fast", reason: "posture turns it off" })), "doctrine-stale", "SKIPPED", 3],
    ["inline evidence that no longer matches its sha256", () => put(receipt({ evidence: [{ kind: "text", content: "edited", sha256: sha256Hex("orig") }] })), "bad-digest", "PASS", 3],
    [
      "media evidence whose stored asset is gone",
      () => put(receipt({ evidence: [{ kind: "screenshot", name: "a.png", content_type: "image/png", bytes: 1, sha256: sha256Hex("x"), asset_url: `https://${ASSET_HOST}/a.png` }] })),
      "bad-digest",
      "PASS",
      3,
    ],
    ["a gone file artifact carrying a copy that re-hashes", () => put(receipt({ artifact: { _tag: "file", path: "/nowhere/plan.md", sha256: sha, copy } })), "pass", "PASS", 0],
    [
      "a gone file artifact whose copy does not re-hash",
      () => put(receipt({ artifact: { _tag: "file", path: "/nowhere/plan.md", sha256: sha, copy: { encoding: "gzip+base64", content: gzipSync(Buffer.from("othr")).toString("base64"), bytes: 4 } } })),
      "drift",
      "PASS",
      3,
    ],
    ["a git artifact with no checkout and no stored copy", () => put(receipt({ artifact: { _tag: "git", repo: "o/elsewhere", ref: "main", path: "plan.md", sha256: sha } })), "unresolved", "PASS", 3],
    [
      "a git artifact with no checkout whose copy the store holds",
      () => {
        copies[sha] = { sha256: sha, ...copy };
        put(receipt({ artifact: { _tag: "git", repo: "o/elsewhere", ref: "main", path: "plan.md", sha256: sha } }));
      },
      "pass",
      "PASS",
      0,
    ],
    ["review-report evidence whose digest does not hold", () => put(receipt({ evidence: [{ kind: "review-report", report, sha256: "0".repeat(64) }] })), "bad-digest", "PASS", 3],
  ] as const)("%s reads %s", async (_, seed, status, verdict, code) => {
    seed();
    const r = await gate(["check", "--issue", ISSUE, "--gates", "plan-review"]);
    expect({ code: r.code, out: r.out }).toEqual({ code, out: `plan-review\t${status}\t${verdict}\n` });
  });

  // admits: boundary-io: a review report this build cannot judge must fail closed as blocking (with its reason), never pass; observed at the row and the WARN line.
  it("reads a correctly digested review-report receipt as blocking and says why", async () => {
    const { reviewReportDigest } = await import("eris/gates-contract");
    put(receipt({ evidence: [{ kind: "review-report", report, sha256: reviewReportDigest(report as never) }] }));
    const r = await gate(["check", "--issue", ISSUE, "--gates", "plan-review"]);
    expect({ code: r.code, out: r.out }).toEqual({ code: 3, out: "plan-review\tblocking\tPASS\n" });
    expect(r.err).toContain("WARN plan-review: blocking: review-report evidence is judged only by an eris build that registers review skills");
  });

  // admits: algorithmic: the latest receipt by the store's created_at decides, ties to the later row; deciding by the first row would keep a superseded BLOCKING, observed at the row.
  it("judges a gate by its latest receipt", async () => {
    put(receipt({ verdict: "BLOCKING" }));
    put(receipt({ verdict: "SKIPPED", authorized: "someone asked: later", reason: "superseded the block" }));
    expect((await gate(["check", "--issue", ISSUE, "--gates", "plan-review"])).out).toBe("plan-review\tskipped\tSKIPPED\n");
  });

  // admits: boundary-io: the store's reads lag its writes; check must re-read until every --expect id is listed and fail closed when none is, observed at the re-read count and the slug.
  it("re-reads until the expected id is listed, and fails closed when it never is", async () => {
    let reads = 0;
    override["GET /v1/gates/receipts"] = () => (reads++ === 0 ? Response.json({ issue: ISSUE, receipts: [], invalid: 0, contract_version: "gates-contract/v1" }) : undefined);
    const id = put(receipt());
    put(receipt({ artifact: { _tag: "file", path: "/nowhere/plan.md", sha256: sha, copy } }));
    const r = await gate(["check", "--issue", ISSUE, "--gates", "plan-review", "--expect", id]);
    expect({ code: r.code, out: r.out, reads }).toEqual({ code: 0, out: "plan-review\tpass\tPASS\n", reads: 2 });
    const never = await gate(["check", "--issue", ISSUE, "--gates", "plan-review", "--expect", "not-there"]);
    expect(never.code).toBe(3);
    expect(never.err).toContain("slug: gate-receipt-unseen");
  });

  // admits: boundary-io: a soft-stale reply must reach the operator as one WARN naming the pull, however many reads ran; observed on stderr.
  it("warns once when the gateway marks this machine's policy stale", async () => {
    replyHeaders = { "x-gates-policy-stale": "soft", "x-gates-policy-sha": sha256Hex("live").slice(0, 12) };
    const r = await gate(["check", "--issue", ISSUE, "--gates", "plan-review"]);
    const warns = r.err.split("\n").filter((l) => l.includes("policy is not the live one"));
    expect(warns).toEqual([`WARN this machine's copy of the org's policy is not the live one (live bundle ${sha256Hex("live").slice(0, 12)}): run 'eris doctrine pull'`]);
  });
});

describe("profiles and doctrine", () => {
  const doctrine = (gates: string) => `active: fast\n\n## fast\n\nThe fast posture.\n\n\`\`\`yaml\npolicy:\n  gates:\n${gates}\n\`\`\`\n`;

  // admits: integration: an `off` gate under the active posture must be skipped by a doctrine receipt written through the store (and only observed under --dry-run), a once-at-end gate deferred; observed at the rows and the POST log.
  it("records a doctrine skip for an off gate, defers a once-at-end gate, and writes nothing under --dry-run", async () => {
    const file = join(home, "doctrine.md");
    writeFileSync(file, doctrine("    plan-review: off\n    sdk-check: once-at-end"));
    const profiles = join(home, "profiles.yaml");
    writeFileSync(profiles, "quick: [plan-review, sdk-check]\nguarded: { require: [plan-review], forbid: [remediate-launch] }\n");
    const dry = await gate(["check", "--issue", ISSUE, "--profile", "quick", "--profiles", profiles, "--doctrine", file, "--dry-run"]);
    expect({ code: dry.code, out: dry.out }).toEqual({ code: 0, out: "plan-review\tskipped\tdoctrine fast sets gates.plan-review: off\nsdk-check\tdeferred\t-\n" });
    expect(posts()).toEqual([]);

    const wet = await gate(["check", "--issue", ISSUE, "--profile", "quick", "--profiles", profiles, "--doctrine", file]);
    expect({ code: wet.code, out: wet.out }).toEqual({ code: 0, out: "plan-review\tskipped\tSKIPPED\nsdk-check\tdeferred\t-\n" });
    expect(posts().map((p) => [p.receipt.gate, p.receipt.authorized, p.receipt.actor])).toEqual([["plan-review", "doctrine:fast", expect.stringMatching(/^doctrine:fast@[0-9a-f]{12}$/)]]);
    expect(wet.err).toContain("doctrine: recorded plan-review SKIPPED as doctrine:fast@");

    // The posture turns the gate back on: the skip no longer holds.
    writeFileSync(file, doctrine("    plan-review: on"));
    const stale = await gate(["check", "--issue", ISSUE, "--gates", "plan-review", "--doctrine", file]);
    expect({ code: stale.code, out: stale.out }).toEqual({ code: 3, out: "plan-review\tdoctrine-stale\tSKIPPED\n" });

    // A forbidden gate: absent until a receipt for it exists.
    put(receipt({ gate: "plan-review", verdict: "SKIPPED", authorized: "someone asked: skip", reason: "not needed here" }));
    expect((await gate(["check", "--issue", ISSUE, "--profile", "guarded", "--profiles", profiles])).out).toBe("plan-review\tskipped\tSKIPPED\nremediate-launch\tabsent\t-\n");
    put(receipt({ gate: "remediate-launch" }));
    const forbidden = await gate(["check", "--issue", ISSUE, "--profile", "guarded", "--profiles", profiles]);
    expect({ code: forbidden.code, out: forbidden.out }).toEqual({ code: 3, out: "plan-review\tskipped\tSKIPPED\nremediate-launch\tforbidden\tPASS\n" });
  });

  // admits: boundary-io: a doctrine-shaped grant the doctrine does not bear out must be refused before anything is sent, and a human grant recorded as given; observed at the slug and the POST body.
  it("refuses a doctrine grant the posture does not bear out, and records a human grant", async () => {
    const file = join(home, "doctrine.md");
    writeFileSync(file, doctrine("    plan-review: on"));
    const plan = join(home, "plan.md");
    writeFileSync(plan, "plan");
    const refused = await gate(["skip", "plan-review", "--issue", ISSUE, "--reason", "the posture says so", "--authorized", "doctrine:fast", "--doctrine", file, "--artifact", plan, "--actor", "a@example.com"]);
    expect(refused.code).toBe(3);
    expect(refused.err).toContain("slug: gate-skip-unauthorized");
    expect(posts()).toEqual([]);
    const human = await gate(["skip", "plan-review", "--issue", ISSUE, "--reason", "covered elsewhere", "--authorized", "someone asked: skip it", "--artifact", plan, "--actor", "a@example.com"]);
    expect(human.code).toBe(0);
    expect(posts()[0]!.receipt).toMatchObject({ verdict: "SKIPPED", authorized: "someone asked: skip it", reason: "covered elsewhere" });
  });

  // admits: boundary-io: a skip whose --authorized is only invisible characters must be refused as blank before anything is sent; observed at the exit code, the stderr line and the empty POST log.
  it("refuses a skip whose grant is only invisible characters", async () => {
    const plan = join(home, "plan.md");
    writeFileSync(plan, "plan");
    const blank = await gate(["skip", "plan-review", "--issue", ISSUE, "--reason", "covered elsewhere", "--authorized", "\u200B\uFEFF", "--artifact", plan, "--actor", "a@example.com"]);
    expect(blank.code).toBe(2);
    expect(blank.err).toContain("--authorized is blank");
    expect(posts()).toEqual([]);
  });
});

describe("floor, door, remediate and asks rows", () => {
  const passing = (gate: string, over: Record<string, unknown> = {}) =>
    receipt({ gate, artifact: { _tag: "file", path: "/nowhere/plan.md", sha256: sha256Hex("plan"), copy: { encoding: "gzip+base64", content: gzipSync(Buffer.from("plan")).toString("base64"), bytes: 4 } }, ...over });

  // admits: integration: final-gates must print the class's requirement rows, @floor, @door (U0/U1 default to auto with no ladder) and @asks in that order; a row out of order or missing breaks cross-build parity, observed at stdout.
  it("prints the floor, door and asks rows for a terminal gate", async () => {
    put(passing("final-gates", { user_impact: "U1" }));
    put(passing("revert-path"));
    const r = await gate(["check", "--issue", ISSUE, "--gates", "final-gates"]);
    expect({ code: r.code, out: r.out }).toEqual({ code: 0, out: `final-gates\tpass\tPASS\nrevert-path\tpass\tPASS\n@floor\tpass\tU1\n@door\t${AUTO}\tU1\n@asks\tclear\t0\n` });
    expect(r.err).toContain(`door: U1 at ${AUTO} (auto); ladder states ${AUTO}`);
  });

  // admits: integration: an issue with no class fails closed as unclassified, and a ladder at the first rung fails without a human sign-off; observed at the rows and the failure what.
  it("fails an unclassified issue, and a human-before door with no human sign-off", async () => {
    put(passing("final-gates"));
    const none = await gate(["check", "--issue", ISSUE, "--gates", "final-gates"]);
    expect({ code: none.code, out: none.out }).toEqual({ code: 3, out: "final-gates\tpass\tPASS\n@floor\tunclassified\t-\n@asks\tclear\t0\n" });

    put(passing("understand-scope", { user_impact: "U0" }));
    const ladder = join(home, "ladder.yaml");
    writeFileSync(ladder, `classes:\n  U0: ${HUMAN_BEFORE}\n`);
    const door = await gate(["check", "--issue", ISSUE, "--gates", "final-gates", "--ladder", ladder]);
    expect({ code: door.code, out: door.out }).toEqual({ code: 3, out: `final-gates\tpass\tPASS\n@floor\tpass\tU0\n@door\t${HUMAN_BEFORE}\tU0\n@asks\tclear\t0\n` });
    expect(door.err).toContain(`door ${HUMAN_BEFORE} (U0): no passing door-signoff receipt with a human --authorized grant (missing)`);
  });

  // admits: integration: a remediation loop prints its @remediate row (pending on an open round, hand-off exit 3 on BLOCKING) rather than unsupported; observed at the row and exit.
  it("prints @remediate pending on an open launch and hand-off (exit 3) on a remediate BLOCKING receipt", async () => {
    put(passing("plan-review"));
    const round = { round: 1, max_rounds: 2, loop: "follow-up", runtime: "opencode", session: "ses_rem1", head: "a".repeat(40), findings: ["finding-1"], report: "c0" };
    put(receipt({ gate: "remediate", verdict: "AMENDED", evidence: [{ kind: "text", name: "remediate-round", content: JSON.stringify(round), sha256: sha256Hex(JSON.stringify(round)) }] }));
    const open = await gate(["check", "--issue", ISSUE, "--gates", "plan-review"]);
    expect({ code: open.code, out: open.out }).toEqual({ code: 0, out: "plan-review\tpass\tPASS\n@remediate\tpending\tround 1/2\n" });

    put(receipt({ gate: "remediate", verdict: "BLOCKING" }));
    const hand = await gate(["check", "--issue", ISSUE, "--gates", "plan-review"]);
    expect({ code: hand.code, out: hand.out }).toEqual({ code: 3, out: "plan-review\tpass\tPASS\n@remediate\thand-off\tround 1/2\n" });
  });

  // admits: boundary-io: an open blocking ask must hold the terminal gate, and a full asks page must fail closed (asks past it may be open); observed at the @asks row, the PR filter and the slug.
  it("fails on an open blocking ask, keeps PR-bound asks by binds.pr, and fails closed on a full page", async () => {
    const ask = (id: string, binds: Record<string, unknown>) => ({ id, question: "Ship it?", door: "one-way", blocking: true, state: "open", binds, schema: "ask@1" });
    put(passing("final-gates", { user_impact: "U0" }));
    asks = [ask("ask_1", { issue: ISSUE }), ask("ask_2", { issue: "ABC-8", pr: 12 }), ask("ask_3", { issue: "ABC-8", pr: 13 })];
    const r = await gate(["check", "--issue", ISSUE, "--gates", "final-gates", "--pr", "12"]);
    expect(r.code).toBe(3);
    expect(r.out.split("\n").at(-2)).toBe("@asks\topen\t2");
    expect(r.err).toContain('ask "ask_1" (one-way): "Ship it?"');
    expect(r.err).toContain('ask "ask_2" (one-way): "Ship it?"');
    expect(r.err).not.toContain("ask_3");

    asks = Array.from({ length: 100 }, (_, i) => ask(`ask_${i}`, { issue: ISSUE }));
    const full = await gate(["check", "--issue", ISSUE, "--gates", "final-gates"]);
    expect(full.code).toBe(3);
    expect(full.err).toContain("slug: asks-listing-truncated");
  });
});

describe("evidence shapes: merged is not live", () => {
  const text = (content: string) => ({ kind: "text", content, sha256: sha256Hex(content) });
  const passing = (gate: string, lines: string[] = [], over: Record<string, unknown> = {}) =>
    receipt({ gate, evidence: lines.map(text), artifact: { _tag: "file", path: "/nowhere/plan.md", sha256: sha256Hex("plan"), copy: { encoding: "gzip+base64", content: gzipSync(Buffer.from("plan")).toString("base64"), bytes: 4 } }, ...over });
  const rows = (out: string) => out.split("\n").filter((l) => l !== "");

  // admits: integration: a PASS zero-downtime that probes one skew direction (old caller, new callee) and names no enforcement passed the U2 floor and a deploy then broke the other direction; observed at the zero-downtime and @floor rows.
  it("holds zero-downtime to both skew directions and a named enforcement", async () => {
    put(passing("final-gates", [], { user_impact: "U2" }));
    put(passing("revert-path"));
    put(passing("e2e"));
    put(passing("zero-downtime", ["skew old->new: old caller to new callee over default fetch, 200"]));
    const one = await gate(["check", "--issue", ISSUE, "--gates", "final-gates"]);
    expect(one.code).toBe(3);
    expect(rows(one.out)).toContain("zero-downtime\tincomplete\tPASS");
    expect(rows(one.out)).toContain("@floor\tunmet\tU2");
    expect(one.err).toContain("no 'skew new->old:' line");
    expect(one.err).toContain("no 'enforced-by:' line");

    put(passing("zero-downtime", ["skew old->new: old caller to new callee, 200", "skew new->old: new caller to old callee refused by preflight", "enforced-by: preflight (deploy script refuses a missing entrypoint)"]));
    const both = await gate(["check", "--issue", ISSUE, "--gates", "final-gates"]);
    expect(rows(both.out)).toContain("zero-downtime\tpass\tPASS");
    expect(rows(both.out)).toContain("@floor\tpass\tU2");
  });

  // admits: integration: a change declaring a new public ingress closed on in-process fixtures with no real delivery accepted; observed at the first-contact and @floor rows.
  it("owes first-contact once any receipt declares an ingress, and passes on a shaped delivery", async () => {
    put(passing("understand-scope", ["ingress: github webhook receiver"], { user_impact: "U1" }));
    put(passing("final-gates"));
    put(passing("revert-path"));
    put(passing("e2e", ["in-process workerd run against hand-signed fixtures"]));
    const owed = await gate(["check", "--issue", ISSUE, "--gates", "final-gates"]);
    expect(owed.code).toBe(3);
    expect(rows(owed.out)).toContain("first-contact\tmissing\t-");
    expect(rows(owed.out)).toContain("@floor\tunmet\tU1");

    put(passing("first-contact", ["delivery: 7f3c-real-delivery", "status: 202", "log: accepted push event", "effect: bus frame appended"]));
    const met = await gate(["check", "--issue", ISSUE, "--gates", "final-gates"]);
    expect({ code: met.code, floor: rows(met.out).filter((l) => l.startsWith("first-contact") || l.startsWith("@floor")) }).toEqual({ code: 0, floor: ["first-contact\tpass\tPASS", "@floor\tpass\tU1"] });
  });

  // admits: integration: an issue read as done at merge while prod ran an older version; the deployed door must tie every version to the merge and a smoke; observed at the deployed row and exit code.
  it("passes the deployed door only on versions at the merge SHA plus a smoke pass", async () => {
    // SHA-shaped values are assembled at runtime so the scrub check reads no literal commit.
    const merge = "1a2b".repeat(3);
    const other = "9f".repeat(4);
    put(passing("deployed", [`merge: ${merge}`, `version: gateway ${merge}`, `version: dash ${other}`]));
    const skewed = await gate(["check", "--issue", ISSUE, "--gates", "deployed"]);
    expect({ code: skewed.code, out: skewed.out }).toEqual({ code: 3, out: "deployed\tincomplete\tPASS\n" });
    expect(skewed.err).toContain(`version dash ${other} is not the merge`);
    expect(skewed.err).toContain("no 'smoke: pass' line");

    put(passing("deployed", [`merge: ${merge}`, `version: gateway ${merge}`, `version: dash ${merge.slice(0, 7)}`, "smoke: pass (jwks 200, sign-in 302)"]));
    expect(await gate(["check", "--issue", ISSUE, "--gates", "deployed"])).toMatchObject({ code: 0, out: "deployed\tpass\tPASS\n" });

    put(passing("deployed", ["deploy: none (the repo has no deploy step)"]));
    expect(await gate(["check", "--issue", ISSUE, "--gates", "deployed"])).toMatchObject({ code: 0, out: "deployed\tpass\tPASS\n" });
  });
});

describe("burden", () => {
  const rubric = () => {
    const file = join(home, "rubric.yaml");
    writeFileSync(file, "surfaces:\n  api: [test-run]\n");
    return file;
  };

  // admits: integration: the changed paths since --base must resolve to the root eris.yaml's discover.paths claims and owe the rubric's kinds; a wrong resolution passes a change with no evidence, observed at the burden row.
  it("owes the rubric's kinds for the surfaces a change crosses, and passes when a passing receipt carries them", async () => {
    const dir = checkout("o/r", { "eris.yaml": "service: api\ndiscover:\n  language: typescript\n  paths: [src]\n", "src/a.ts": "1\n" });
    writeFileSync(join(dir, "src", "a.ts"), "2\n");
    const unmetRun = await gate(["check", "--issue", ISSUE, "--gates", "plan-review", "--burden", rubric(), "--base", "main"], { cwd: dir });
    expect({ code: unmetRun.code, out: unmetRun.out }).toEqual({ code: 3, out: "plan-review\tmissing\t-\nburden\tunmet\ttest-run\n" });
    put(
      receipt({
        artifact: { _tag: "file", path: join(dir, "src", "a.ts"), sha256: sha256Hex("2\n") },
        evidence: [{ kind: "test-run", name: "t.log", content: "ok", sha256: sha256Hex("ok") }],
      }),
    );
    const met = await gate(["check", "--issue", ISSUE, "--gates", "plan-review", "--burden", rubric(), "--base", "main"], { cwd: dir });
    expect({ code: met.code, out: met.out }).toEqual({ code: 0, out: "plan-review\tpass\tPASS\nburden\tpass\ttest-run\n" });
  });

  // admits: boundary-io: an estate with leaf manifests cannot be resolved from the root alone (a leaf's narrower claim would own its paths); it must refuse rather than guess, observed at the slug.
  it("refuses an estate with leaf eris.yaml files", async () => {
    const dir = checkout("o/r", { "eris.yaml": "service: api\ndiscover:\n  language: typescript\n  paths: [src]\n", "svc/eris.yaml": "service: svc\n", "src/a.ts": "1\n" });
    const r = await gate(["check", "--issue", ISSUE, "--gates", "plan-review", "--burden", rubric(), "--base", "main"], { cwd: dir });
    expect(r.code).toBe(3);
    expect(r.err).toContain("slug: gate-burden-unresolved");
    expect(seen).toEqual([]);
  });
});

describe("the pulled tree", () => {
  // admits: integration: with the org's policy pulled, check must read its profiles by default and send its bundle sha on the receipt routes; observed at the rows and the request header.
  it("reads profiles from the pulled tree and sends its bundle sha", async () => {
    const tree = join(home, "tree");
    mkdirSync(tree);
    writeFileSync(join(tree, "profiles.yaml"), "org-quick: [plan-review]\n");
    writeFileSync(join(tree, "doctrine.md"), "active: steady\n\n## steady\n\nThe steady posture.\n");
    const bundleSha = sha256Hex("bundle").slice(0, 12);
    const defaults: GateDefaults = { pulled: async () => ({ ok: true, value: { doctrineFile: join(tree, "doctrine.md"), profilesFile: join(tree, "profiles.yaml"), bundleSha } }) };
    const r = await gate(["check", "--issue", ISSUE, "--profile", "org-quick"], { defaults });
    expect(r.out).toBe("plan-review\tmissing\t-\n");
    expect(seen[0]!.headers.get("x-eris-policy-sha")).toBe(bundleSha);
  });

  // admits: boundary-io: an edited pulled tree must stop every gate verb before anything is sent; observed at the slug and the empty request log.
  it("stops on an edited tree before sending anything", async () => {
    const defaults: GateDefaults = {
      pulled: async () => ({ ok: false, failure: { slug: "doctrine-local-modified", what: "doctrine.md was edited", fix: "Run 'eris doctrine pull'.", docs: "docs/ERRORS.md#doctrine-local-modified", exit: 3 } }),
    };
    const r = await gate(["check", "--issue", ISSUE, "--gates", "plan-review"], { defaults });
    expect(r.code).toBe(3);
    expect(r.err).toContain("slug: doctrine-local-modified");
    expect(seen).toEqual([]);
  });
});

describe("a distribution's composition of the gate plugin through eris/sdk", () => {
  // admits: integration: when gatePlugin or its ladderFile default stops being reachable from eris/sdk, or the composed plugin stops handing the ladder to check, a distribution's @door row silently reads the default rung for every class; observed at the @door row of the example distribution's composed gate verb.
  it("reads the distribution's own ladder rung at @door, a rung the default ladder does not state", async () => {
    const { DISTRIBUTION_PLUGINS, LADDER_FILE } = await import("../examples/distribution/main");
    const plugin = DISTRIBUTION_PLUGINS.find((p) => p.name === "gate")!;
    put(receipt({ gate: "final-gates", artifact: { _tag: "file", path: "/nowhere/plan.md", sha256: sha256Hex("plan"), copy: { encoding: "gzip+base64", content: gzipSync(Buffer.from("plan")).toString("base64"), bytes: 4 } } }));
    put(receipt({ gate: "understand-scope", user_impact: "U0" }));
    let out = "";
    const ctx = { erisDir: REPO, env: { HOME: home, PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: sandbox }, stdout: { write: (s: string) => ((out += s), true) }, stderr: { write: () => true }, format: "text" as const };
    const handler = await plugin.handlers.gate!();
    const code = await handler(["check", "--issue", ISSUE, "--gates", "final-gates"], ctx).catch((e: unknown) => (e instanceof CliExit ? e.code : Promise.reject(e)));
    expect(LADDER_FILE).toEndWith("assets/ladder.yaml");
    expect(code).toBe(3);
    expect(out).toContain(`@door\t${HUMAN_BEFORE}\tU0\n`);
  });
});
