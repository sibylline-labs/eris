/**
 * `eris gate skip --mandate` and `ERIS_MANDATE` at the CLI verb seam against a loopback gateway
 * that spends one mandate use and stamps `gate-receipt@v3` atomically on `POST /v1/gates/receipts`.
 *
 * Every request crosses real HTTP. Tokens and handles are assembled at runtime so no literal trips
 * a secret scanner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  canonicalMandateScope,
  extractReviewEndorseFinding,
  formatReviewReport,
  GATE_RECEIPT_SCHEMA_V3,
  GATE_REVIEW_REPORT_SCHEMA,
  type GateReviewFinding,
  type GateReviewReport,
  isGateReviewReportEvidence,
  sha256Hex,
  skillDigest,
} from "eris/gates-contract";
import type { GateReviews } from "eris/sdk";
import { gateHandler } from "../plugins/gate/gate";
import type { GateDefaults } from "../plugins/gate/index";
import { CliExit } from "../src/cli/ts-verb";

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, "..");
const ORG = "01JZ8K3M4N5P6Q7R8S9T0V1W2Z";
const OTHER_ORG = "01JZ8K3M4N5P6Q7R8S9T0V1W2Y";
const LOGIN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const HANDLE_A = ["mnd", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const HANDLE_ROOT = ["mnd", ORG, "R0oT1234567890AbCdEfGhIjKlMnOpQrStUvWxYz-_A"].join("_");
const HANDLE_CHILD = ["mnd", ORG, "Ch1Ld234567890AbCdEfGhIjKlMnOpQrStUvWxYz-_B"].join("_");
const HANDLE_WRONG_FINDING = ["mnd", ORG, "Wr0Ng234567890AbCdEfGhIjKlMnOpQrStUvWxYz-_C"].join("_");
const HANDLE_UNKNOWN = ["mnd", ORG, "A".repeat(43)].join("_");
const HANDLE_OTHER_ORG = ["mnd", OTHER_ORG, "B".repeat(43)].join("_");
const ISSUE = "ABC-9";
const OTHER_ISSUE = "ABC-10";
const SESSION = "session:ses_mnd_a";
const OTHER_SESSION = "session:ses_mnd_b";
const SCOPE = `sr:us:mandate:gate:skip?gate=e2e&work_ref=linear:${ISSUE}`;
const ENDORSE_SCOPE = `sr:us:mandate:review:endorse?finding=item-1&work_ref=linear:${ISSUE}`;
const NOW = new Date("2026-11-18T12:00:00Z");
const SKILL_NAME = "code-quality-review";
const VOCAB_PATH = "docs/vocabulary/secrets.md";
const VOCAB_SHA = sha256Hex("# Secrets\n## S1 — Secret\n");
const SKILL_SHA = skillDigest([{ path: "SKILL.md", bytes: Buffer.from("# Review\n", "utf8") }]);
const HARNESS_SHA = "c".repeat(40);

interface MandateEntry {
  readonly id: string;
  readonly rootId: string;
  readonly org: string;
  readonly session: string;
  readonly scopes: readonly string[];
  maxUses: number;
  usesSpent: number;
  revoked: boolean;
}

interface StoredRow {
  comment_id: string;
  created_at: string;
  marker_version: "v2";
  payload: Record<string, unknown>;
  record_sha256: string;
  prose: string;
}

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  body: string;
}

let sandbox: string;
let home: string;
let workdir: string;
let server: ReturnType<typeof Bun.serve>;
let store: Record<string, StoredRow[]>;
let mandates: Map<string, MandateEntry>;
let uses: Array<{ readonly session: string; readonly scope: string }>;
let seen: Seen[];
let clock: number;
let ignoreMandateHandle: boolean;
let omitRecordSha: boolean;
let mandateUnavailable: boolean;
let rateLimitRemaining: number;
let mandateActive: boolean | undefined;
let allowDelegatedStamp: boolean;

const problem = (status: number, code: string) =>
  Response.json({ type: "about:blank", status, code }, { status, headers: { "content-type": "application/problem+json" } });
const at = () => new Date(Date.UTC(2026, 10, 18, 12, 0, clock++)).toISOString();

function resolveGatewayScope(body: { issue: string; receipt: Record<string, unknown> }): { scope: string; directRootOnly: boolean } | null {
  const verdict = body.receipt.verdict;
  if (verdict === "SKIPPED") {
    const scope = canonicalMandateScope(`sr:us:mandate:gate:skip?gate=${String(body.receipt.gate)}&work_ref=linear:${body.issue}`);
    return scope === null ? null : { scope, directRootOnly: false };
  }
  if (verdict === "PASS" || verdict === "AMENDED") {
    const evidence = Array.isArray(body.receipt.evidence) ? body.receipt.evidence : [];
    const reports = evidence.flatMap((e) => (isGateReviewReportEvidence(e as never) ? [(e as { report: GateReviewReport }).report] : []));
    const extracted = extractReviewEndorseFinding(reports, body.issue);
    return extracted.ok ? { scope: extracted.scope, directRootOnly: true } : null;
  }
  return null;
}

function handleReceiptPost(body: { comment_id: string; issue: string; receipt: Record<string, unknown>; prose: string; mandate_handle?: string }): Response {
  if (rateLimitRemaining > 0) {
    rateLimitRemaining--;
    return problem(429, "rate_limited");
  }
  const existing = (store[body.issue] ?? []).find((r) => r.comment_id === body.comment_id);
  if (existing !== undefined) {
    return Response.json(
      {
        comment_id: existing.comment_id,
        issue: body.issue,
        gate: String(body.receipt.gate),
        created_at: existing.created_at,
        ...(omitRecordSha ? {} : { record_sha256: existing.record_sha256 }),
        contract_version: "gates-contract/v1",
      },
      { status: 201 },
    );
  }
  let payload: Record<string, unknown> = body.receipt;
  if (body.mandate_handle !== undefined && !ignoreMandateHandle) {
    if (mandateUnavailable) return problem(503, "mandate_unavailable");
    if (body.receipt.mandate !== undefined) return problem(422, "mandate_client_supplied");
    if (/(?:mnd|mct)_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}/.test(JSON.stringify(body.receipt) + body.prose)) {
      return problem(422, "handle_in_receipt");
    }
    const entry = mandates.get(body.mandate_handle);
    if (entry === undefined) {
      const handleOrg = body.mandate_handle.split("_")[1];
      if (handleOrg !== undefined && handleOrg !== ORG) return problem(401, "org_mismatch");
      return problem(404, "unknown_mandate");
    }
    if (entry.org !== ORG) return problem(401, "org_mismatch");
    if (entry.revoked) return problem(401, "revoked");
    const actor = String(body.receipt.actor ?? "");
    if (!actor.startsWith("session:")) return problem(422, "mandate_session_required");
    if (actor !== entry.session) return problem(403, "mandate_out_of_path");
    const resolved = resolveGatewayScope(body);
    if (resolved === null) return problem(422, "mandate_act_unsupported");
    if (!entry.scopes.includes(resolved.scope)) return problem(403, "not_covered");
    if (resolved.directRootOnly && !allowDelegatedStamp && entry.id !== entry.rootId) return problem(403, "not_covered");
    if (entry.usesSpent >= entry.maxUses) return problem(403, "exhausted");
    entry.usesSpent++;
    uses.push({ session: actor, scope: resolved.scope });
    payload = {
      ...body.receipt,
      schema: GATE_RECEIPT_SCHEMA_V3,
      mandate: {
        id: entry.id,
        use_id: `01JZ8K3M4N5P6Q7R8S9T0V1W${String(entry.usesSpent).padStart(2, "0")}`,
        root_id: entry.rootId,
        scope: resolved.scope,
        chain_digest: "A".repeat(43),
        attestation: "aa.bb.cc",
      },
    };
  }
  const sha = sha256Hex(JSON.stringify(payload));
  const row: StoredRow = { comment_id: body.comment_id, created_at: at(), marker_version: "v2", payload, record_sha256: sha, prose: body.prose };
  (store[body.issue] ??= []).push(row);
  return Response.json(
    {
      comment_id: row.comment_id,
      issue: body.issue,
      gate: String(body.receipt.gate),
      created_at: row.created_at,
      ...(omitRecordSha ? {} : { record_sha256: sha }),
      contract_version: "gates-contract/v1",
    },
    { status: 201 },
  );
}

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "eris-gate-mandate-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const s: Seen = { method: req.method, path: url.pathname, query: url.searchParams, body: await req.text() };
      seen.push(s);
      if (s.method === "GET" && s.path === "/v1/gates/receipts") {
        const issue = s.query.get("issue") ?? "";
        const receipts = (store[issue] ?? []).map((r) => ({ comment_id: r.comment_id, created_at: r.created_at, marker_version: r.marker_version, payload: r.payload, source: "olympus", record_sha256: r.record_sha256 }));
        return Response.json({
          issue,
          receipts,
          invalid: 0,
          ...(mandateActive !== undefined ? { mandate_active: mandateActive } : {}),
          contract_version: "gates-contract/v1",
        });
      }
      if (s.method === "POST" && s.path === "/v1/gates/receipts") {
        return handleReceiptPost(JSON.parse(s.body));
      }
      if (s.method === "GET" && s.path === "/v1/asks") return Response.json({ asks: [] });
      return problem(404, "not_found");
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(sandbox, "home-")));
  workdir = realpathSync(mkdtempSync(join(sandbox, "work-")));
  writeFileSync(join(workdir, "plan.md"), "# plan\n");
  store = {};
  mandates = new Map([
    [
      HANDLE_A,
      {
        id: "01JZ8K3M4N5P6Q7R8S9T0V1W3A",
        rootId: "01JZ8K3M4N5P6Q7R8S9T0V1W3R",
        org: ORG,
        session: SESSION,
        scopes: [SCOPE],
        maxUses: 1,
        usesSpent: 0,
        revoked: false,
      },
    ],
    [
      HANDLE_ROOT,
      {
        id: "01JZ8K3M4N5P6Q7R8S9T0V1W4R",
        rootId: "01JZ8K3M4N5P6Q7R8S9T0V1W4R",
        org: ORG,
        session: SESSION,
        scopes: [ENDORSE_SCOPE],
        maxUses: 1,
        usesSpent: 0,
        revoked: false,
      },
    ],
    [
      HANDLE_CHILD,
      {
        id: "01JZ8K3M4N5P6Q7R8S9T0V1W4C",
        rootId: "01JZ8K3M4N5P6Q7R8S9T0V1W4R",
        org: ORG,
        session: SESSION,
        scopes: [ENDORSE_SCOPE],
        maxUses: 1,
        usesSpent: 0,
        revoked: false,
      },
    ],
    [
      HANDLE_WRONG_FINDING,
      {
        id: "01JZ8K3M4N5P6Q7R8S9T0V1W5R",
        rootId: "01JZ8K3M4N5P6Q7R8S9T0V1W5R",
        org: ORG,
        session: SESSION,
        scopes: [`sr:us:mandate:review:endorse?finding=item-2&work_ref=linear:${ISSUE}`],
        maxUses: 1,
        usesSpent: 0,
        revoked: false,
      },
    ],
  ]);
  uses = [];
  seen = [];
  clock = 0;
  ignoreMandateHandle = false;
  omitRecordSha = false;
  mandateUnavailable = false;
  rateLimitRemaining = 0;
  mandateActive = undefined;
  allowDelegatedStamp = false;
});

interface Run {
  rc: number;
  stdout: string;
  stderr: string;
}

const freshReviews: GateReviews = {
  skills: [SKILL_NAME],
  freshness: () => ({
    main: { skill: { sha256: SKILL_SHA, mainSha: HARNESS_SHA }, vocabulary: { sha256: VOCAB_SHA } },
    classes: ["S1"],
    notes: [],
  }),
};

async function run(args: string[], env: Record<string, string | undefined> = {}, withLogin = true, defaults: GateDefaults = {}): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const handler = gateHandler(defaults, { cwd: workdir, home, now: () => NOW, sleep: async () => undefined, jitter: () => 0 });
  const baseEnv: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: home,
    ...(withLogin ? { ERIS_YAKS_TOKEN: LOGIN, ERIS_YAKS_URL: `http://127.0.0.1:${server.port}` } : {}),
    ...env,
  };
  let rc: number;
  try {
    rc = await handler(args, {
      erisDir: REPO,
      env: baseEnv,
      stdout: { write: (s: string) => ((stdout += s), true) },
      stderr: { write: (s: string) => ((stderr += s), true) },
      format: "text",
    });
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    rc = e.code;
  }
  return { rc, stdout, stderr };
}

const skipArgs = (extra: string[], actor = SESSION, gate = "e2e") => [
  "skip",
  gate,
  "--issue",
  ISSUE,
  "--reason",
  "covered by the parent run on this issue",
  "--artifact",
  "plan.md",
  "--actor",
  actor,
  ...extra,
];

const everything = (runs: Run[]) =>
  [...runs.flatMap((r) => [r.stdout, r.stderr]), ...Object.values(store).flat().map((r) => `${r.prose}\n${JSON.stringify(r.payload)}`)].join("\n");

describe("eris gate skip --mandate", () => {
  // admits: integration: end-to-end skip -> POST -> v3 stamp -> GET -> check flow across gate, mandate, record, check, and loopback HTTP; verifies single spend and zero handle leakage.
  it("spends one use at the store, stores gate-receipt@v3, and check reads it as a granted skip without ever printing the handle", async () => {
    const r = await run(skipArgs(["--mandate", HANDLE_A]));
    expect(r.rc).toBe(0);
    const stored = store[ISSUE]!;
    expect(stored.length).toBe(1);
    expect(r.stdout).toBe(`${stored[0]!.comment_id}\n`);
    expect(r.stderr).toContain(`mandate stamped, record ${stored[0]!.record_sha256.slice(0, 12)}`);
    expect(stored[0]!.payload.schema).toBe(GATE_RECEIPT_SCHEMA_V3);
    expect(stored[0]!.payload.authorized).toBeUndefined();
    expect(stored[0]!.payload.mandate).toMatchObject({ id: "01JZ8K3M4N5P6Q7R8S9T0V1W3A", scope: SCOPE });
    expect(uses).toEqual([{ session: SESSION, scope: SCOPE }]);

    const c = await run(["check", "--issue", ISSUE, "--gates", "e2e"]);
    expect({ rc: c.rc, stdout: c.stdout }).toEqual({ rc: 0, stdout: "e2e\tskipped\tSKIPPED\n" });
    expect(everything([r, c])).not.toContain(HANDLE_A);
  });

  // admits: boundary-io: CLI verb exit code, slug rendering, and never-echoed handle invariant across real HTTP error responses for each gateway refusal code.
  it("refuses gateway mandate rejections with exit 3, exact slug, nothing stored, and never echoing the handle", async () => {
    mandates.get(HANDLE_A)!.maxUses = 2;
    const first = await run(skipArgs(["--mandate", HANDLE_A]));
    expect(first.rc).toBe(0);

    const outOfPath = await run(skipArgs(["--mandate", HANDLE_A], OTHER_SESSION));
    expect(outOfPath.rc).toBe(3);
    expect(outOfPath.stderr).toContain("slug: mandate-out-of-path");
    expect(outOfPath.stdout).toBe("");

    const notCovered = await run(skipArgs(["--mandate", HANDLE_A], SESSION, "sdk-check"));
    expect(notCovered.rc).toBe(3);
    expect(notCovered.stderr).toContain("slug: mandate-not-covered");

    const unknown = await run(skipArgs(["--mandate", HANDLE_UNKNOWN]));
    expect(unknown.rc).toBe(3);
    expect(unknown.stderr).toContain("slug: mandate-unknown-mandate");

    const wrongOrg = await run(skipArgs(["--mandate", HANDLE_OTHER_ORG]));
    expect(wrongOrg.rc).toBe(3);
    expect(wrongOrg.stderr).toContain("slug: mandate-org-mismatch");
    expect(wrongOrg.stderr).not.toContain("eris-login-required");

    mandates.get(HANDLE_A)!.usesSpent = 2;
    const exhausted = await run(skipArgs(["--mandate", HANDLE_A]));
    expect(exhausted.rc).toBe(3);
    expect(exhausted.stderr).toContain("slug: mandate-exhausted");

    mandates.get(HANDLE_A)!.revoked = true;
    const revoked = await run(skipArgs(["--mandate", HANDLE_A]));
    expect(revoked.rc).toBe(3);
    expect(revoked.stderr).toContain("slug: mandate-revoked");
    expect(revoked.stderr).not.toContain("eris-login-required");

    mandateUnavailable = true;
    const down = await run(skipArgs(["--mandate", HANDLE_A]));
    expect(down.rc).toBe(3);
    expect(down.stderr).toContain("slug: mandate-unavailable");

    expect(store[ISSUE]!.length).toBe(1);
    const dump = everything([first, outOfPath, notCovered, unknown, wrongOrg, exhausted, revoked, down]);
    expect(dump).not.toContain(HANDLE_A);
    expect(dump).not.toContain(HANDLE_UNKNOWN);
    expect(dump).not.toContain(HANDLE_OTHER_ORG);
  });

  // admits: integration: local validation ordering must fail before login/endpoint/network calls and never echo malformed values.
  it("refuses locally with zero HTTP requests (even with no login) on malformed handle, empty --mandate, non-session actor, or invalid scope", async () => {
    const badSecret = "mnd_not-a-handle-secret-value";
    const bad = await run(skipArgs(["--mandate", badSecret]), {}, false);
    expect(bad.rc).toBe(3);
    expect(bad.stderr).toContain("slug: mandate-handle-malformed");
    expect(bad.stderr).not.toContain("not-a-handle-secret-value");

    const empty = await run(skipArgs(["--mandate", ""]), {}, false);
    expect(empty.rc).toBe(1);

    const blank = await run(skipArgs(["--mandate", "   "]), {}, false);
    expect(blank.rc).toBe(3);
    expect(blank.stderr).toContain("slug: mandate-handle-malformed");

    const human = await run(skipArgs(["--mandate", HANDLE_A], "op@example.test"), {}, false);
    expect(human.rc).toBe(3);
    expect(human.stderr).toContain("slug: mandate-session-required");

    const badScope = await run(skipArgs(["--mandate", HANDLE_A], SESSION, "e2e&extra=1"), {}, false);
    expect(badScope.rc).toBe(3);
    expect(badScope.stderr).toContain("slug: mandate-act-unsupported");

    expect(seen).toEqual([]);
    expect(uses).toEqual([]);
    expect(everything([bad, empty, blank, human, badScope])).not.toContain(HANDLE_A);
  });

  // admits: algorithmic: four-way precedence matrix between --mandate, ERIS_MANDATE, and --authorized.
  it("reads ERIS_MANDATE when --authorized is absent, ignores it beside --authorized, treats blank env as unset, and keeps --authorized beside --mandate as context", async () => {
    mandates.get(HANDLE_A)!.maxUses = 3;
    const viaEnv = await run(skipArgs([]), { ERIS_MANDATE: HANDLE_A });
    expect(viaEnv.rc).toBe(0);
    expect(store[ISSUE]![0]!.payload.schema).toBe(GATE_RECEIPT_SCHEMA_V3);

    const humanOverridesEnv = await run(skipArgs(["--authorized", "alice asked: skip e2e on this slice"]), { ERIS_MANDATE: HANDLE_A });
    expect(humanOverridesEnv.rc).toBe(0);
    expect(store[ISSUE]![1]!.payload).toMatchObject({ schema: "gate-receipt@v2", authorized: "alice asked: skip e2e on this slice" });
    expect(store[ISSUE]![1]!.payload.mandate).toBeUndefined();
    expect(uses.length).toBe(1);

    const blankEnv = await run(skipArgs([]), { ERIS_MANDATE: "   " });
    expect(blankEnv.rc).toBe(2);
    expect(blankEnv.stderr).toContain("missing --authorized");

    // Beside --mandate, even a doctrine-shaped --authorized is context, not judged against --doctrine.
    const withContext = await run(skipArgs(["--mandate", HANDLE_A, "--authorized", "doctrine:ignored-as-context"]));
    expect(withContext.rc).toBe(0);
    expect(store[ISSUE]![2]!.payload).toMatchObject({ schema: GATE_RECEIPT_SCHEMA_V3, authorized: "doctrine:ignored-as-context" });
    expect(uses.length).toBe(2);
    expect(everything([viaEnv, humanOverridesEnv, blankEnv, withContext])).not.toContain(HANDLE_A);
  });

  // admits: boundary-io: post-write v2-vs-v3 sha256 verification against a legacy gateway response (same hash or omitted record_sha256) with and without prose --authorized.
  it("exits 3 mandate-not-stamped when the store keeps v2 unstamped or omits record_sha256, naming the prose grant accurately", async () => {
    ignoreMandateHandle = true;
    const noProse = await run(skipArgs(["--mandate", HANDLE_A]));
    expect(noProse.rc).toBe(3);
    expect(noProse.stderr).toContain("slug: mandate-not-stamped");
    expect(noProse.stderr).toContain("unauthorized-skip");
    const c1 = await run(["check", "--issue", ISSUE, "--gates", "e2e"]);
    expect(c1.rc).toBe(3);
    expect(c1.stdout).toContain("e2e\tunauthorized-skip\tSKIPPED");

    const withProse = await run(skipArgs(["--mandate", HANDLE_A, "--authorized", "alice asked: skip e2e on this slice"]));
    expect(withProse.rc).toBe(3);
    expect(withProse.stderr).toContain("slug: mandate-not-stamped");
    expect(withProse.stderr).toContain("judges it by its --authorized grant alone");
    expect(withProse.stderr).not.toContain("unauthorized-skip");
    const c2 = await run(["check", "--issue", ISSUE, "--gates", "e2e"]);
    expect({ rc: c2.rc, stdout: c2.stdout }).toEqual({ rc: 0, stdout: "e2e\tskipped\tSKIPPED\n" });

    ignoreMandateHandle = false;
    omitRecordSha = true;
    const noSha = await run(skipArgs(["--mandate", HANDLE_A]));
    expect(noSha.rc).toBe(3);
    expect(noSha.stderr).toContain("slug: mandate-not-stamped");
  });

  // admits: boundary-io: idempotent retry loop under HTTP 429 must resend the same comment_id so the gateway spends only one use.
  it("retries a 429 on POST /v1/gates/receipts with the same comment_id and spends one use", async () => {
    rateLimitRemaining = 1;
    const r = await run(skipArgs(["--mandate", HANDLE_A]));
    expect(r.rc).toBe(0);
    const posts = seen.filter((s) => s.method === "POST" && s.path === "/v1/gates/receipts");
    expect(posts.length).toBe(2);
    expect(JSON.parse(posts[0]!.body).comment_id).toBe(JSON.parse(posts[1]!.body).comment_id);
    expect(mandates.get(HANDLE_A)!.usesSpent).toBe(1);
  });
});

function makeEndorseFinding(over: Partial<GateReviewFinding> = {}): GateReviewFinding {
  return {
    id: "item-1",
    severity: "major",
    class: "S1",
    file: "src/secret.ts",
    line: 12,
    status: "refuted",
    evidence: "token logged verbatim",
    ...over,
  };
}

function makeEndorseReport(over: Partial<GateReviewReport> = {}): GateReviewReport {
  return {
    schema: GATE_REVIEW_REPORT_SCHEMA,
    target: { repo: "example-org/example-repo", pr: 17, head_sha: "a".repeat(40), diff_sha256: "b".repeat(64) },
    surface: "secrets",
    effort: "high",
    reviewer: {
      actor: SESSION,
      model: "model-alpha",
      fresh_context: true,
      skill: { name: SKILL_NAME, harness_sha: HARNESS_SHA, sha256: SKILL_SHA },
      vocabulary: { path: VOCAB_PATH, sha256: VOCAB_SHA },
    },
    author: { actor: "author@example.com" },
    classes_checked: ["S1"],
    findings: [makeEndorseFinding()],
    ...over,
  };
}

function writeReport(name: string, report: GateReviewReport, body = "Reviewed refutation."): string {
  const path = join(workdir, name);
  writeFileSync(path, formatReviewReport(report, body));
  return path;
}

describe("eris gate record --review-report --mandate", () => {
  // admits: integration: end-to-end gate record --review-report --mandate -> POST -> v3 stamp -> GET -> gate check flow across gate, mandate, record, check, and loopback HTTP; verifies omitted --verdict derivation, single spend, and zero handle leakage.
  it("stamps gate-receipt@v3 on record --review-report --mandate, derives PASS, passes check under mandate_active, and never echoes the handle", async () => {
    mandateActive = true;
    const reportPath = writeReport("refuted.md", makeEndorseReport());
    const r = await run(["record", "adversarial-review", "--issue", ISSUE, "--review-report", reportPath, "--actor", SESSION, "--mandate", HANDLE_ROOT]);
    expect(r.rc).toBe(0);
    const stored = store[ISSUE]!;
    expect(stored).toHaveLength(1);
    expect(r.stdout).toBe(`${stored[0]!.comment_id}\n`);
    expect(r.stderr).toContain(`mandate stamped, record ${stored[0]!.record_sha256.slice(0, 12)}`);
    expect(stored[0]!.payload.schema).toBe(GATE_RECEIPT_SCHEMA_V3);
    expect(stored[0]!.payload.verdict).toBe("PASS");
    expect(stored[0]!.payload.mandate).toMatchObject({
      id: "01JZ8K3M4N5P6Q7R8S9T0V1W4R",
      root_id: "01JZ8K3M4N5P6Q7R8S9T0V1W4R",
      scope: ENDORSE_SCOPE,
    });
    expect(uses).toEqual([{ session: SESSION, scope: ENDORSE_SCOPE }]);

    const c = await run(
      ["check", "--issue", ISSUE, "--gates", "adversarial-review", "--head-sha", "a".repeat(40), "--diff-sha256", "b".repeat(64)],
      {},
      true,
      { reviews: freshReviews },
    );
    expect({ rc: c.rc, stdout: c.stdout, stderr: c.stderr }).toEqual({ rc: 0, stdout: "adversarial-review\tpass\tPASS\n", stderr: "" });
    expect(everything([r, c])).not.toContain(HANDLE_ROOT);
  });

  // admits: boundary-io: local validation ordering for explicit --mandate on gate record must fail closed with zero HTTP calls (even with no login) and never echo malformed values.
  it("refuses locally with zero HTTP requests on malformed handle, non-session actor, BLOCKING verdict, missing report, bad finding cardinality, smuggled scope, or non-independent reviewer", async () => {
    const refutedPath = writeReport("refuted.md", makeEndorseReport());
    const openPath = writeReport("open.md", makeEndorseReport({ findings: [makeEndorseFinding(), makeEndorseFinding({ id: "item-2", status: "open" })] }));
    const cleanPath = writeReport("clean.md", makeEndorseReport({ findings: [] }));
    const multiPath = writeReport("multi.md", makeEndorseReport({ findings: [makeEndorseFinding({ id: "item-1" }), makeEndorseFinding({ id: "item-2" })] }));
    const smuggledPath = writeReport("smuggled.md", makeEndorseReport({ findings: [makeEndorseFinding({ id: "item-1&extra=1" })] }));
    const selfReviewPath = writeReport("self.md", makeEndorseReport({ author: { actor: SESSION } }));

    const badSecret = "mnd_not-a-handle-secret-value";
    const bad = await run(["record", "adversarial-review", "--issue", ISSUE, "--review-report", refutedPath, "--actor", SESSION, "--mandate", badSecret], {}, false);
    expect(bad.rc).toBe(3);
    expect(bad.stderr).toContain("slug: mandate-handle-malformed");
    expect(bad.stderr).not.toContain("not-a-handle-secret-value");

    const blank = await run(["record", "adversarial-review", "--issue", ISSUE, "--review-report", refutedPath, "--actor", SESSION, "--mandate", "   "], {}, false);
    expect(blank.rc).toBe(3);
    expect(blank.stderr).toContain("slug: mandate-handle-malformed");

    const human = await run(["record", "adversarial-review", "--issue", ISSUE, "--review-report", refutedPath, "--actor", "op@example.test", "--mandate", HANDLE_ROOT], {}, false);
    expect(human.rc).toBe(3);
    expect(human.stderr).toContain("slug: mandate-session-required");

    const blocking = await run(
      ["record", "adversarial-review", "--issue", ISSUE, "--verdict", "BLOCKING", "--review-report", refutedPath, "--actor", SESSION, "--mandate", HANDLE_ROOT],
      {},
      false,
    );
    expect(blocking.rc).toBe(3);
    expect(blocking.stderr).toContain("slug: mandate-act-unsupported");

    const noReport = await run(
      ["record", "plan-review", "--issue", ISSUE, "--verdict", "PASS", "--artifact", "plan.md", "--actor", SESSION, "--mandate", HANDLE_ROOT],
      {},
      false,
    );
    expect(noReport.rc).toBe(3);
    expect(noReport.stderr).toContain("slug: mandate-act-unsupported");

    for (const reportFile of [openPath, cleanPath, multiPath, smuggledPath, selfReviewPath]) {
      const res = await run(["record", "adversarial-review", "--issue", ISSUE, "--review-report", reportFile, "--actor", SESSION, "--mandate", HANDLE_ROOT], {}, false);
      expect(res.rc).toBe(3);
      expect(res.stderr).toContain("slug: mandate-act-unsupported");
      expect(res.stderr).not.toContain(HANDLE_ROOT);
    }

    expect(seen).toEqual([]);
    expect(uses).toEqual([]);
    expect(everything([bad, blank, human, blocking, noReport])).not.toContain(HANDLE_ROOT);
  });

  // admits: algorithmic: ERIS_MANDATE precedence and non-hijack matrix across clean reports, non-report records, --authorized override, and already-endorsed second-reviewer reports.
  it("uses ERIS_MANDATE only for an unendorsed single refuted high finding when --authorized is absent, and never hijacks clean, non-report, or second-reviewer records", async () => {
    mandates.get(HANDLE_ROOT)!.maxUses = 4;
    const refutedPath = writeReport("refuted.md", makeEndorseReport());
    const cleanPath = writeReport("clean.md", makeEndorseReport({ findings: [] }));

    // 1. Clean report with ERIS_MANDATE: records v2 PASS, spends 0 uses.
    const clean = await run(["record", "adversarial-review", "--issue", ISSUE, "--review-report", cleanPath, "--actor", SESSION], { ERIS_MANDATE: HANDLE_ROOT });
    expect(clean.rc).toBe(0);
    expect(store[ISSUE]![0]!.payload.schema).toBe("gate-receipt@v2");
    expect(uses).toHaveLength(0);

    // 2. Non-report gate record with ERIS_MANDATE: records v2 PASS, spends 0 uses.
    const nonReport = await run(["record", "plan-review", "--issue", ISSUE, "--verdict", "PASS", "--artifact", "plan.md", "--actor", SESSION], { ERIS_MANDATE: HANDLE_ROOT });
    expect(nonReport.rc).toBe(0);
    expect(store[ISSUE]![1]!.payload.schema).toBe("gate-receipt@v2");
    expect(uses).toHaveLength(0);

    // 3. --authorized overrides ERIS_MANDATE (context only when explicit --mandate is passed).
    const authOverrides = await run(
      ["record", "adversarial-review", "--issue", ISSUE, "--verdict", "PASS", "--review-report", refutedPath, "--actor", SESSION, "--authorized", "alice asked: record note"],
      { ERIS_MANDATE: HANDLE_ROOT },
    );
    expect(authOverrides.rc).toBe(0);
    expect(store[ISSUE]![2]!.payload).toMatchObject({ schema: "gate-receipt@v2", authorized: "alice asked: record note" });
    expect(uses).toHaveLength(0);

    // 4. Unendorsed refuted finding with ERIS_MANDATE and no --authorized: spends 1 use and stamps v3.
    const viaEnv = await run(["record", "adversarial-review", "--issue", ISSUE, "--review-report", refutedPath, "--actor", SESSION], { ERIS_MANDATE: HANDLE_ROOT });
    expect(viaEnv.rc).toBe(0);
    expect(store[ISSUE]![3]!.payload.schema).toBe(GATE_RECEIPT_SCHEMA_V3);
    expect(uses).toHaveLength(1);

    // 5. Second independent reviewer endorsing an open finding raised by reviewer-1 must NOT spend ERIS_MANDATE.
    store = {};
    const openFinding = makeEndorseFinding({ status: "open" });
    const round1Path = writeReport("round1.md", makeEndorseReport({ reviewer: { ...makeEndorseReport().reviewer, actor: OTHER_SESSION }, findings: [openFinding] }));
    const r1 = await run(["record", "adversarial-review", "--issue", ISSUE, "--review-report", round1Path, "--actor", OTHER_SESSION]);
    expect(r1.rc).toBe(0);
    const round2Path = writeReport(
      "round2.md",
      makeEndorseReport({
        reviewer: { ...makeEndorseReport().reviewer, actor: SESSION },
        findings: [{ ...openFinding, status: "refuted", raised_by: OTHER_SESSION, refuted_by: SESSION }],
      }),
    );
    const r2 = await run(["record", "adversarial-review", "--issue", ISSUE, "--review-report", round2Path, "--actor", SESSION], { ERIS_MANDATE: HANDLE_ROOT });
    expect(r2.rc).toBe(0);
    expect(store[ISSUE]![1]!.payload).toMatchObject({ schema: "gate-receipt@v2", verdict: "PASS" });
    expect(uses).toHaveLength(1);
    expect(everything([clean, nonReport, authOverrides, viaEnv, r1, r2])).not.toContain(HANDLE_ROOT);
  });

  // admits: boundary-io: real HTTP gateway refusal codes, record-specific mandate-not-stamped messaging, and 429 idempotent comment_id replay on review:endorse.
  it("maps gateway refusals to exact mandate-* slugs at exit 3, reports record-specific mandate-not-stamped, and replays 429 with one spend", async () => {
    const reportPath = writeReport("refuted.md", makeEndorseReport());

    const delegated = await run(["record", "adversarial-review", "--issue", ISSUE, "--review-report", reportPath, "--actor", SESSION, "--mandate", HANDLE_CHILD]);
    expect(delegated.rc).toBe(3);
    expect(delegated.stderr).toContain("slug: mandate-not-covered");

    const wrongFinding = await run(["record", "adversarial-review", "--issue", ISSUE, "--review-report", reportPath, "--actor", SESSION, "--mandate", HANDLE_WRONG_FINDING]);
    expect(wrongFinding.rc).toBe(3);
    expect(wrongFinding.stderr).toContain("slug: mandate-not-covered");

    const wrongSession = await run(
      ["record", "adversarial-review", "--issue", ISSUE, "--review-report", writeReport("other-sess.md", makeEndorseReport({ reviewer: { ...makeEndorseReport().reviewer, actor: OTHER_SESSION } })), "--actor", OTHER_SESSION, "--mandate", HANDLE_ROOT],
    );
    expect(wrongSession.rc).toBe(3);
    expect(wrongSession.stderr).toContain("slug: mandate-out-of-path");

    const unknown = await run(["record", "adversarial-review", "--issue", ISSUE, "--review-report", reportPath, "--actor", SESSION, "--mandate", HANDLE_UNKNOWN]);
    expect(unknown.rc).toBe(3);
    expect(unknown.stderr).toContain("slug: mandate-unknown-mandate");

    const wrongOrg = await run(["record", "adversarial-review", "--issue", ISSUE, "--review-report", reportPath, "--actor", SESSION, "--mandate", HANDLE_OTHER_ORG]);
    expect(wrongOrg.rc).toBe(3);
    expect(wrongOrg.stderr).toContain("slug: mandate-org-mismatch");

    const handleInEvidence = await run([
      "record",
      "adversarial-review",
      "--issue",
      ISSUE,
      "--review-report",
      reportPath,
      "--actor",
      SESSION,
      "--evidence",
      `leaked ${HANDLE_ROOT}`,
      "--mandate",
      HANDLE_ROOT,
    ]);
    expect(handleInEvidence.rc).toBe(3);
    expect(handleInEvidence.stderr).toContain("slug: mandate-handle-in-receipt");

    mandateUnavailable = true;
    const down = await run(["record", "adversarial-review", "--issue", ISSUE, "--review-report", reportPath, "--actor", SESSION, "--mandate", HANDLE_ROOT]);
    expect(down.rc).toBe(3);
    expect(down.stderr).toContain("slug: mandate-unavailable");
    mandateUnavailable = false;

    expect(store[ISSUE]).toBeUndefined();

    // Legacy gateway keeps v2 unstamped -> exit 3 mandate-not-stamped with review-report wording (not unauthorized-skip).
    ignoreMandateHandle = true;
    const unstamped = await run(["record", "adversarial-review", "--issue", ISSUE, "--review-report", reportPath, "--actor", SESSION, "--mandate", HANDLE_ROOT]);
    expect(unstamped.rc).toBe(3);
    expect(unstamped.stderr).toContain("slug: mandate-not-stamped");
    expect(unstamped.stderr).toContain("review:endorse mandate granted nothing");
    expect(unstamped.stderr).not.toContain("unauthorized-skip");
    ignoreMandateHandle = false;
    store = {};

    // 429 retry resends identical comment_id and spends exactly 1 use.
    rateLimitRemaining = 1;
    seen = [];
    const retried = await run(["record", "adversarial-review", "--issue", ISSUE, "--review-report", reportPath, "--actor", SESSION, "--mandate", HANDLE_ROOT]);
    expect(retried.rc).toBe(0);
    const posts = seen.filter((s) => s.method === "POST" && s.path === "/v1/gates/receipts");
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[0]!.body).comment_id).toBe(JSON.parse(posts[1]!.body).comment_id);
    expect(mandates.get(HANDLE_ROOT)!.usesSpent).toBe(1);

    // Exhausted & revoked refusals after single spend.
    const exhausted = await run(["record", "adversarial-review", "--issue", ISSUE, "--review-report", reportPath, "--actor", SESSION, "--mandate", HANDLE_ROOT]);
    expect(exhausted.rc).toBe(3);
    expect(exhausted.stderr).toContain("slug: mandate-exhausted");

    mandates.get(HANDLE_ROOT)!.revoked = true;
    const revoked = await run(["record", "adversarial-review", "--issue", ISSUE, "--review-report", reportPath, "--actor", SESSION, "--mandate", HANDLE_ROOT]);
    expect(revoked.rc).toBe(3);
    expect(revoked.stderr).toContain("slug: mandate-revoked");

    const dump = everything([delegated, wrongFinding, wrongSession, unknown, wrongOrg, down, unstamped, retried, exhausted, revoked]);
    expect(dump).not.toContain(HANDLE_ROOT);
    expect(dump).not.toContain(HANDLE_CHILD);
    expect(dump).not.toContain(HANDLE_WRONG_FINDING);
  });

  // admits: integration: gate check over loopback GET /v1/gates/receipts with mandate_active: true must fail closed on un-stamped human grants, delegated child stamps (defense-in-depth), wrong finding/issue, and row swaps, while accepting direct-root review:endorse stamps.
  it("fails closed in gate check under mandate_active: true for un-stamped human names, delegated child stamps, and cross-issue/row mismatches", async () => {
    const checkArgs = ["check", "--issue", ISSUE, "--gates", "adversarial-review", "--head-sha", "a".repeat(40), "--diff-sha256", "b".repeat(64)];
    const checkOpts = { reviews: freshReviews };

    // 1. Un-stamped human grant receipt + agreed_by: passes when mandate_active is false, fails closed when mandate_active is true.
    const humanGrant = await run([
      "record",
      "plan-review",
      "--issue",
      ISSUE,
      "--verdict",
      "PASS",
      "--artifact",
      "plan.md",
      "--actor",
      "human@example.com",
      "--authorized",
      "alice asked: endorse refutation",
    ]);
    expect(humanGrant.rc).toBe(0);
    const humanReportPath = writeReport("human-refuted.md", makeEndorseReport({ findings: [makeEndorseFinding({ agreed_by: ["human@example.com"] })] }));
    const humanRec = await run(["record", "adversarial-review", "--issue", ISSUE, "--verdict", "PASS", "--review-report", humanReportPath, "--actor", SESSION]);
    expect(humanRec.rc).toBe(0);

    mandateActive = false;
    const legacyOk = await run(checkArgs, {}, true, checkOpts);
    expect({ rc: legacyOk.rc, stdout: legacyOk.stdout }).toEqual({ rc: 0, stdout: "adversarial-review\tpass\tPASS\n" });

    mandateActive = true;
    const underMandate = await run(checkArgs, {}, true, checkOpts);
    expect(underMandate.rc).toBe(3);
    expect(underMandate.stdout).toBe("adversarial-review\tblocking\tPASS\n");
    expect(underMandate.stderr).toContain("direct-root review:endorse mandate stamp");

    // 2. Delegated child stamp (id !== root_id) stored by a buggy/compromised gateway: gate check still refuses it!
    store = {};
    allowDelegatedStamp = true;
    const childPath = writeReport("child.md", makeEndorseReport());
    const childRec = await run(["record", "adversarial-review", "--issue", ISSUE, "--review-report", childPath, "--actor", SESSION, "--mandate", HANDLE_CHILD]);
    expect(childRec.rc).toBe(0);
    allowDelegatedStamp = false;
    const childCheck = await run(checkArgs, {}, true, checkOpts);
    expect(childCheck.rc).toBe(3);
    expect(childCheck.stdout).toBe("adversarial-review\tblocking\tPASS\n");

    // 3. Direct-root stamp on OTHER_ISSUE does not carry over to ISSUE, nor across a finding-row swap on the same gate.
    store = {};
    mandates.get(HANDLE_ROOT)!.maxUses = 2;
    const rootPath = writeReport("root.md", makeEndorseReport());
    const stampedRec = await run(["record", "adversarial-review", "--issue", ISSUE, "--review-report", rootPath, "--actor", SESSION, "--mandate", HANDLE_ROOT]);
    expect(stampedRec.rc).toBe(0);

    // Tamper stored stamp's scope to OTHER_ISSUE -> check fails closed.
    const row = store[ISSUE]![0]!;
    const origStamp = row.payload.mandate as Record<string, unknown>;
    row.payload = { ...row.payload, mandate: { ...origStamp, scope: `sr:us:mandate:review:endorse?finding=item-1&work_ref=linear:${OTHER_ISSUE}` } };
    const wrongIssueCheck = await run(checkArgs, {}, true, checkOpts);
    expect(wrongIssueCheck.rc).toBe(3);
    expect(wrongIssueCheck.stdout).toBe("adversarial-review\tblocking\tPASS\n");

    // Restore valid direct-root stamp on receipt 1, then record a newer receipt 2 with a swapped finding row (same id, different line) -> fails closed!
    row.payload = { ...row.payload, mandate: origStamp };
    const swappedPath = writeReport("swapped.md", makeEndorseReport({ findings: [makeEndorseFinding({ line: 99 })] }));
    const swappedRec = await run(["record", "adversarial-review", "--issue", ISSUE, "--verdict", "PASS", "--review-report", swappedPath, "--actor", SESSION]);
    expect(swappedRec.rc).toBe(0);
    const swappedCheck = await run(checkArgs, {}, true, checkOpts);
    expect(swappedCheck.rc).toBe(3);
    expect(swappedCheck.stdout).toBe("adversarial-review\tblocking\tPASS\n");
  });
});
