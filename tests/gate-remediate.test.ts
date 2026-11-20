/**
 * `@remediate` row judging in `eris gate check`: pure round folding (`stateOf`), actor separation
 * and head freshness (`independence`), surface-widening detection (`gitSurfaceBar` against real
 * git), and CLI-seam wiring through `gateHandler` over loopback HTTP.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatReviewReport, GATE_REVIEW_REPORT_SCHEMA, type GateReviewReport, type ListedReceipt, sha256Hex } from "eris/gates-contract";
import { gateHandler } from "../plugins/gate/gate";
import { liveGit } from "../plugins/gate/git";
import type { GateDefaults } from "../plugins/gate/index";
import {
  gitSurfaceBar,
  handOffStands,
  independence,
  REMEDIATE_GATE,
  remediateRow,
  remediationSpan,
  ROUND_EVIDENCE,
  type ReviewReportLike,
  type RoundRecord,
  stateOf,
  type SurfaceBar,
} from "../plugins/gate/remediate";
import { CliExit } from "../src/cli/ts-verb";

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, "..");
const ORG = "01JZ8K3M4N5P6Q7R8S9T0V1W2Z";
const LOGIN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const ISSUE = "ABC-9";
const H0 = "a".repeat(40);
const H1 = "b".repeat(40);
const H2 = "c".repeat(40);
const NOW = new Date("2026-11-18T12:00:00Z");

const noBar: SurfaceBar = { wider: async () => [] };

function report(head: string, reviewer: string, author: string, open: boolean): ReviewReportLike {
  return {
    target: { head_sha: head },
    reviewer: { actor: reviewer },
    author: { actor: author },
    findings: [
      { id: "finding-1", severity: "blocking", class: "secret-in-argv", file: "src/a.ts", line: 3, status: open ? "open" : "fixed" },
      { id: "finding-2", severity: "minor", class: "nit", file: "src/b.ts", line: 9, status: "open" },
    ],
  };
}

const baseReceipt = (gate: string, verdict: string, evidence: unknown[], extra: Record<string, unknown> = {}) => ({
  schema: "gate-receipt@v2",
  gate,
  issue: ISSUE,
  verdict,
  artifact: { _tag: "file", path: "plan.md", sha256: sha256Hex("# plan\n") },
  actor: "session:caller",
  evidence,
  recorded_at: "2026-11-18T00:00:00Z",
  ...extra,
});

const reviewPayload = (r: ReviewReportLike, issue = ISSUE) =>
  baseReceipt("adversarial-review", "BLOCKING", [{ kind: "review-report", report: r, sha256: "1".repeat(64) }], { issue });

const roundRec = (n: number, head: string, session: string, max = 2): RoundRecord => ({
  round: n,
  max_rounds: max,
  loop: "follow-up",
  runtime: n === 1 ? "opencode" : "claude",
  session,
  head,
  findings: ["finding-1"],
  report: "c0",
});

const launchPayload = (round: RoundRecord) =>
  baseReceipt(REMEDIATE_GATE, "AMENDED", [{ kind: "text", name: ROUND_EVIDENCE, content: JSON.stringify(round), sha256: sha256Hex(JSON.stringify(round)) }]);

function records(...payloads: unknown[]): ListedReceipt[] {
  return payloads.map((payload, i) => ({
    id: `c${i}`,
    createdAt: new Date(Date.UTC(2026, 10, 18, 0, 0, i)).toISOString(),
    version: "v2",
    payload,
  }));
}

describe("remediate: stateOf, independence, and remediateRow (pure)", () => {
  // admits: algorithmic: chronological receipt folding, evidence-kind discrimination (text vs log), issue filtering, and human-grant clearance rules.
  it("partitions rounds chronologically, ignores log-kind remediate-round and other issues, and clears a hand-off only on human-granted PASS", () => {
    const r0 = reviewPayload(report(H0, "session:rev1", "session:author", true));
    const otherIssue = reviewPayload(report(H0, "session:other", "session:other", true), "ABC-99");
    const forgedLog = baseReceipt(REMEDIATE_GATE, "AMENDED", [
      { kind: "log", name: ROUND_EVIDENCE, content: JSON.stringify(roundRec(1, H0, "ses_fake")), sha256: "3".repeat(64) },
    ]);
    const l1 = launchPayload(roundRec(1, H0, "ses_rem1"));
    const r1 = reviewPayload(report(H1, "session:rev2", "session:ses_rem1", false));

    // Deliberately pass out-of-order records to verify chronological sort.
    const chronological = records(r0, otherIssue, forgedLog, l1, r1);
    const shuffled = [chronological[4]!, chronological[2]!, chronological[0]!, chronological[3]!, chronological[1]!];
    const s = stateOf(ISSUE, shuffled);
    expect(s.any).toBe(true);
    expect(s.rounds.length).toBe(2);
    expect(s.rounds[0]!.reports.length).toBe(1);
    expect(s.rounds[1]!.reports.length).toBe(1);
    expect(s.rounds[1]!.launch?.record.session).toBe("ses_rem1");
    expect(remediationSpan(s)).toEqual({ base: H0, head: H1 });

    // Hand-off clearance: only human-granted PASS clears it.
    const hand = baseReceipt(REMEDIATE_GATE, "BLOCKING", []);
    const barePass = baseReceipt(REMEDIATE_GATE, "PASS", []);
    const doctrinePass = baseReceipt(REMEDIATE_GATE, "PASS", [], { authorized: "doctrine:lock-in" });
    const laterLaunch = launchPayload(roundRec(2, H1, "ses_forged"));
    for (const after of [barePass, doctrinePass, laterLaunch]) {
      expect(handOffStands(stateOf(ISSUE, records(r0, l1, hand, after)))).toBe(true);
    }
    const humanPass = baseReceipt(REMEDIATE_GATE, "PASS", [], { authorized: "alice asked: ship it" });
    expect(handOffStands(stateOf(ISSUE, records(r0, l1, hand, humanPass)))).toBe(false);
  });

  // admits: algorithmic: multi-round actor-set induction and fresh-head comparison across rounds 0, 1, and 2.
  it("flags self-review, prior-reviewer re-review, original-author remediation, cross-round author review, and reused launch head", () => {
    const r0 = reviewPayload(report(H0, "session:rev1", "session:author", true));
    const l1 = launchPayload(roundRec(1, H0, "ses_rem1"));

    expect(independence(stateOf(ISSUE, records(r0, l1, reviewPayload(report(H1, "session:rev2", "session:ses_rem1", false)))))).toEqual([]);
    expect(independence(stateOf(ISSUE, records(r0, l1, reviewPayload(report(H1, "session:ses_rem1", "session:ses_rem1", false)))))).toContain(
      "round 1: reviewer session:ses_rem1 authored round 1",
    );
    expect(independence(stateOf(ISSUE, records(r0, l1, reviewPayload(report(H1, "session:rev1", "session:ses_rem1", false)))))).toEqual([
      "round 1: reviewer session:rev1 already reviewed round 0",
    ]);
    expect(independence(stateOf(ISSUE, records(r0, l1, reviewPayload(report(H1, "session:rev2", "session:author", false)))))).toEqual([
      "round 1: the remediator session:author is the original author",
    ]);
    const reused = independence(stateOf(ISSUE, records(r0, l1, reviewPayload(report(H0, "session:rev2", "session:ses_rem1", false)))));
    expect(reused[0]).toContain("is bound to the launch head");

    // Round 2's reviewer may not be round 1's remediator.
    const l2 = launchPayload(roundRec(2, H1, "ses_rem2"));
    const r1 = reviewPayload(report(H1, "session:rev2", "session:ses_rem1", true));
    const r2 = reviewPayload(report(H2, "session:ses_rem1", "session:ses_rem2", false));
    expect(independence(stateOf(ISSUE, records(r0, l1, r1, l2, r2)))).toEqual(["round 2: reviewer session:ses_rem1 authored round 1"]);
  });

  // admits: algorithmic: state-to-row precedence across absent, pending, ok, violated (independence or surface widening), and hand-off.
  it("returns undefined without remediate receipts and ok/pending/violated/hand-off with exact round formatting", async () => {
    const r0 = reviewPayload(report(H0, "session:rev1", "session:author", true));
    const l1 = launchPayload(roundRec(1, H0, "ses_rem1"));

    expect(await remediateRow(stateOf(ISSUE, records(r0)), noBar)).toBeUndefined();
    expect(await remediateRow(stateOf(ISSUE, records(r0, l1)), noBar)).toEqual({ status: "pending", round: "round 1/2", why: [] });

    const good = records(r0, l1, reviewPayload(report(H1, "session:rev2", "session:ses_rem1", false)));
    expect(await remediateRow(stateOf(ISSUE, good), noBar)).toEqual({ status: "ok", round: "round 1/2", why: [] });

    const widened = await remediateRow(stateOf(ISSUE, good), { wider: async () => [".claude/surfaces.yml"] });
    expect(widened?.status).toBe("violated");
    expect(widened?.round).toBe("round 1/2");
    expect(widened?.why[0]).toContain(".claude/surfaces.yml");

    const hand = await remediateRow(stateOf(ISSUE, records(r0, l1, baseReceipt(REMEDIATE_GATE, "BLOCKING", []))), noBar);
    expect(hand?.status).toBe("hand-off");
    expect(hand?.round).toBe("round 1/2");
  });
});

// ---- real gitSurfaceBar + CLI seam over loopback HTTP ----

let sandbox: string;
let home: string;
let repoDir: string;
let server: ReturnType<typeof Bun.serve>;
let store: Record<string, Array<{ comment_id: string; created_at: string; marker_version: "v2"; payload: unknown }>>;
let clock: number;

function git(dir: string, args: string[]): string {
  const res = Bun.spawnSync(["git", "-C", dir, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
  return res.stdout.toString("utf8").trim();
}

function commitFile(dir: string, rel: string, content: string, msg: string): string {
  const full = join(dir, rel);
  mkdirSync(resolve(full, ".."), { recursive: true });
  writeFileSync(full, content);
  git(dir, ["add", rel]);
  git(dir, ["commit", "-q", "-m", msg]);
  return git(dir, ["rev-parse", "HEAD"]);
}

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "eris-gate-remediate-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/v1/gates/receipts") {
        const issue = url.searchParams.get("issue") ?? "";
        const receipts = (store[issue] ?? []).map((r) => ({ ...r, source: "olympus", record_sha256: null }));
        return Response.json({ issue, receipts, invalid: 0, contract_version: "gates-contract/v1" });
      }
      if (req.method === "POST" && url.pathname === "/v1/gates/receipts") {
        const body = (await req.json()) as { comment_id: string; issue: string; receipt: { gate: string } };
        const created_at = new Date(Date.UTC(2026, 10, 18, 12, 0, clock++)).toISOString();
        const row = { comment_id: body.comment_id, created_at, marker_version: "v2" as const, payload: body.receipt };
        (store[body.issue] ??= []).push(row);
        return Response.json(
          {
            comment_id: body.comment_id,
            issue: body.issue,
            gate: body.receipt.gate,
            created_at,
            record_sha256: sha256Hex(JSON.stringify(body.receipt)),
            contract_version: "gates-contract/v1",
          },
          { status: 201 },
        );
      }
      if (req.method === "GET" && url.pathname === "/v1/asks") return Response.json({ asks: [] });
      return Response.json({ status: 404, code: "not_found" }, { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(sandbox, "home-")));
  repoDir = realpathSync(mkdtempSync(join(sandbox, "repo-")));
  git(repoDir, ["init", "-q"]);
  commitFile(repoDir, "plan.md", "# plan\n", "init");
  store = {};
  clock = 0;
});

function put(payload: unknown): void {
  const id = `c${clock}`;
  const created_at = new Date(Date.UTC(2026, 10, 18, 12, 0, clock++)).toISOString();
  (store[ISSUE] ??= []).push({ comment_id: id, created_at, marker_version: "v2", payload });
}

async function runGate(args: string[], opts: { cwd?: string; defaults?: GateDefaults } = {}): Promise<{ rc: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const handler = gateHandler(opts.defaults ?? {}, { cwd: opts.cwd ?? repoDir, home, now: () => NOW, sleep: async () => undefined, jitter: () => 0 });
  let rc: number;
  try {
    rc = await handler(args, {
      erisDir: REPO,
      env: { PATH: process.env.PATH, HOME: home, GIT_CEILING_DIRECTORIES: sandbox, ERIS_YAKS_TOKEN: LOGIN, ERIS_YAKS_URL: `http://127.0.0.1:${server.port}` },
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

async function runCheck(): Promise<{ rc: number; stdout: string; stderr: string }> {
  return runGate(["check", "--issue", ISSUE, "--gates", "plan-review"]);
}

describe("remediate: gitSurfaceBar and gate check CLI wiring", () => {
  // admits: boundary-io: real git diff --name-only subprocess detects surface/review-skill edits and fails closed on unknown or flag-shaped SHAs.
  it("gitSurfaceBar allows normal edits, flags .claude/surfaces.yml and skills/*review*/, and fails closed on invalid or unknown SHAs", async () => {
    const bar = gitSurfaceBar(liveGit(process.env), repoDir);
    const sha0 = git(repoDir, ["rev-parse", "HEAD"]);
    const sha1 = commitFile(repoDir, "src/app.ts", "export const x = 1;\n", "normal edit");
    expect(await bar.wider({ base: sha0, head: sha1 })).toEqual([]);

    const sha2 = commitFile(repoDir, ".claude/surfaces.yml", "surfaces: {}\n", "touch surfaces");
    expect(await bar.wider({ base: sha0, head: sha2 })).toEqual([".claude/surfaces.yml"]);

    const sha3 = commitFile(repoDir, "skills/code-review/SKILL.md", "# review\n", "touch review skill");
    expect(await bar.wider({ base: sha2, head: sha3 })).toEqual(["skills/code-review/SKILL.md"]);

    const missing = await bar.wider({ base: "0".repeat(40), head: sha3 });
    expect(missing[0]).toContain("failed in");

    const flagInjection = await bar.wider({ base: "--no-index", head: sha3 });
    expect(flagInjection[0]).toContain("failed in");
  });

  // admits: integration: full gate check wiring from loopback receipt listing through stateOf + gitSurfaceBar + remediateRow to stdout, stderr, and exit code.
  it("prints @remediate ok, pending, violated (surface widening), and hand-off (cleared by human PASS) on gate check", async () => {
    const sha0 = git(repoDir, ["rev-parse", "HEAD"]);
    const shaClean = commitFile(repoDir, "src/fix.ts", "export const ok = true;\n", "fix finding");
    const planPass = baseReceipt("plan-review", "PASS", [], { artifact: { _tag: "file", path: join(repoDir, "plan.md"), sha256: sha256Hex("# plan\n") } });

    put(planPass);
    put(reviewPayload(report(sha0, "session:rev1", "session:author", true)));
    put(launchPayload(roundRec(1, sha0, "ses_rem1")));

    const pending = await runCheck();
    expect({ rc: pending.rc, stdout: pending.stdout }).toEqual({ rc: 0, stdout: "plan-review\tpass\tPASS\n@remediate\tpending\tround 1/2\n" });

    put(reviewPayload(report(shaClean, "session:rev2", "session:ses_rem1", false)));
    const okRun = await runCheck();
    expect({ rc: okRun.rc, stdout: okRun.stdout }).toEqual({ rc: 0, stdout: "plan-review\tpass\tPASS\n@remediate\tok\tround 1/2\n" });

    // A widening edit in round 2 flips @remediate to violated (exit 3).
    const shaWide = commitFile(repoDir, ".claude/surfaces.yml", "surfaces: {}\n", "widen surface");
    put(launchPayload(roundRec(2, shaClean, "ses_rem2")));
    put(reviewPayload(report(shaWide, "session:rev3", "session:ses_rem2", false)));
    const violated = await runCheck();
    expect({ rc: violated.rc, stdout: violated.stdout }).toEqual({ rc: 3, stdout: "plan-review\tpass\tPASS\n@remediate\tviolated\tround 2/2\n" });
    expect(violated.stderr).toContain("WARN @remediate: violated: the remediation diff widens a surface: .claude/surfaces.yml");

    // Hand-off overrides into hand-off (exit 3); human PASS clears hand-off (then surface violation still holds on that history).
    put(baseReceipt(REMEDIATE_GATE, "BLOCKING", []));
    const hand = await runCheck();
    expect({ rc: hand.rc, stdout: hand.stdout }).toEqual({ rc: 3, stdout: "plan-review\tpass\tPASS\n@remediate\thand-off\tround 2/2\n" });
    expect(hand.stderr).toContain("WARN @remediate: hand-off: max_rounds reached; a human signs off");
  });

  // admits: integration: recording review-report@1 receipts via gate record --review-report around a remediate launch must let gate check with gatePlugin({ reviews }) judge both the review gate and @remediate in one pass (and fail closed on the review gate without reviews).
  it("records review-report@1 receipts around a remediate launch and judges both the review gate (via reviews seam) and @remediate together", async () => {
    const hostedDir = realpathSync(mkdtempSync(join(sandbox, "hosted-")));
    git(hostedDir, ["init", "-q", "-b", "main"]);
    git(hostedDir, ["remote", "add", "origin", "https://github.com/o/r.git"]);
    const baseSha = commitFile(hostedDir, "plan.md", "# plan\n", "base");
    git(hostedDir, ["update-ref", "refs/remotes/origin/main", baseSha]);
    const diffSha = (head: string) => {
      const r = Bun.spawnSync(["git", "-C", hostedDir, "diff", "--no-ext-diff", "--no-color", baseSha, head]);
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
      return sha256Hex(r.stdout);
    };
    const skillSha = "d".repeat(64);
    const vocabSha = "e".repeat(64);
    const fullReport = (head: string, reviewer: string, author: string, open: boolean): GateReviewReport => ({
      schema: GATE_REVIEW_REPORT_SCHEMA,
      target: { repo: "o/r", pr: 7, head_sha: head, diff_sha256: diffSha(head) },
      surface: "secrets",
      effort: "high",
      reviewer: {
        actor: reviewer,
        model: "model-alpha",
        fresh_context: true,
        skill: { name: "code-quality-review", harness_sha: "f".repeat(40), sha256: skillSha },
        vocabulary: { path: "docs/vocabulary/secrets.md", sha256: vocabSha },
      },
      author: { actor: author },
      classes_checked: ["S1"],
      findings: [{ id: "finding-1", severity: "blocking", class: "S1", file: "src/app.ts", line: 1, status: open ? "open" : "fixed", evidence: "checked" }],
    });

    const sha0 = commitFile(hostedDir, "src/app.ts", "export const v = 0;\n", "initial change");
    const r0Path = join(home, "r0.md");
    writeFileSync(r0Path, formatReviewReport(fullReport(sha0, "session:rev1", "session:author", true), "Round 0 found a blocker.\n"));
    const rec0 = await runGate(["record", "adversarial-review", "--issue", ISSUE, "--review-report", r0Path, "--actor", "session:rev1"], { cwd: hostedDir });
    expect(rec0.rc).toBe(0);
    expect(rec0.stderr).toContain("recorded adversarial-review BLOCKING");

    put(launchPayload(roundRec(1, sha0, "ses_rem1")));

    const sha1 = commitFile(hostedDir, "src/app.ts", "export const v = 1;\n", "fix blocker");
    const r1Path = join(home, "r1.md");
    writeFileSync(r1Path, formatReviewReport(fullReport(sha1, "session:rev2", "session:ses_rem1", false), "Round 1 verified fix.\n"));
    const rec1 = await runGate(["record", "adversarial-review", "--issue", ISSUE, "--review-report", r1Path, "--actor", "session:rev2"], { cwd: hostedDir });
    expect(rec1.rc).toBe(0);
    expect(rec1.stderr).toContain("recorded adversarial-review PASS");

    const reviews: NonNullable<GateDefaults["reviews"]> = {
      skills: ["code-quality-review"],
      freshness: () => ({ main: { skill: { sha256: skillSha, mainSha: "f".repeat(40) }, vocabulary: { sha256: vocabSha } }, classes: ["S1"] }),
    };
    const judged = await runGate(["check", "--issue", ISSUE, "--gates", "adversarial-review"], { cwd: hostedDir, defaults: { reviews } });
    expect({ rc: judged.rc, stdout: judged.stdout }).toEqual({ rc: 0, stdout: "adversarial-review\tpass\tPASS\n@remediate\tok\tround 1/2\n" });

    // Without reviews (public default), the review gate still fails closed as blocking while @remediate reports ok.
    const defaultClosed = await runGate(["check", "--issue", ISSUE, "--gates", "adversarial-review"], { cwd: hostedDir });
    expect({ rc: defaultClosed.rc, stdout: defaultClosed.stdout }).toEqual({ rc: 3, stdout: "adversarial-review\tblocking\tPASS\n@remediate\tok\tround 1/2\n" });
  });
});
