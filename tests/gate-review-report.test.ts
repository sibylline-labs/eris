/**
 * `review-report@1` end-to-end: pure frontmatter parsing, canonical digest, pass/staleness
 * derivation, `eris gate record --review-report`, `eris gate check` (public fail-closed default vs
 * `gatePlugin({ reviews })` composed through `eris/sdk`), target head/diff resolution in real git
 * checkouts under `.scratch/`, and `eris gate ci` unlock judging.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  classIds,
  computeGatesBundleSha,
  decodeReviewReport,
  deriveReviewPass,
  effortMeets,
  formatReviewReport,
  GATE_REVIEW_REPORT_SCHEMA,
  type GateReviewFinding,
  type GateReviewReport,
  type GatesOrgBundle,
  type GatesSettings,
  headMatches,
  parseReviewReport,
  reviewReportDigest,
  sameActor,
  sha256Hex,
  skillDigest,
  staleness,
  vocabularyClasses,
} from "eris/gates-contract";
import { composeCli, gatePlugin, type GateReviews, HANDLERS, main, PLUGINS, REGISTRY, type ReviewFreshness } from "eris/sdk";
import { gateHandler, type GateDeps } from "../plugins/gate/gate";
import type { GateDefaults } from "../plugins/gate/index";
import { liveGit, memoReads } from "../plugins/gate/git";
import { checkUnlock } from "../plugins/gate/unlock";
import { CliExit } from "../src/cli/ts-verb";

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, "..");
const ORG = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const LOGIN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const ISSUE = "ABC-42";
const LEDGER = "ABC-99";
const SKILL_NAME = "code-quality-review";
const VOCAB_PATH = "docs/vocabulary/secrets.md";
const VOCAB_MD = [
  "# Secrets vocabulary",
  "",
  "## S1 — Secret leak",
  "Details.",
  "",
  "```markdown",
  "## S99 — Fenced example must not count",
  "```",
  "",
  "## Class S2 — Missing redaction",
  "Details.",
  "",
  "## S3: Weak token scope",
  "Details.",
  "",
].join("\n");
const VOCAB_SHA = sha256Hex(VOCAB_MD);
const SKILL_SHA = skillDigest([{ path: "SKILL.md", bytes: Buffer.from("# Review skill\n", "utf8") }]);
const HARNESS_SHA = "c".repeat(40);

function makeReport(over: Partial<GateReviewReport> = {}): GateReviewReport {
  return {
    schema: GATE_REVIEW_REPORT_SCHEMA,
    target: { repo: "example-org/example-repo", pr: 17, head_sha: "a".repeat(40), diff_sha256: "b".repeat(64) },
    surface: "secrets",
    effort: "high",
    reviewer: {
      actor: "session:reviewer-1",
      model: "model-alpha",
      fresh_context: true,
      skill: { name: SKILL_NAME, harness_sha: HARNESS_SHA, sha256: SKILL_SHA },
      vocabulary: { path: VOCAB_PATH, sha256: VOCAB_SHA },
    },
    author: { actor: "author@example.com" },
    classes_checked: ["S1", "S2", "S3"],
    findings: [],
    ...over,
  };
}

function makeFinding(over: Partial<GateReviewFinding> = {}): GateReviewFinding {
  return {
    id: "item-1",
    severity: "major",
    class: "S1",
    file: "src/secret.ts",
    line: 12,
    status: "open",
    evidence: "token logged verbatim",
    ...over,
  };
}

describe("pure review-report@1 parsing, digest, and derivation", () => {
  // admits: boundary-io: untrusted YAML frontmatter (BOM, CRLF, bare YAML, unclosed fences, non-map YAML, unknown keys, and any verdict key including null/empty) must parse or fail closed with gate-review-report-invalid before any write.
  it("parses valid frontmatter (BOM + CRLF + body, bare YAML) and refuses invalid or verdict-bearing reports", () => {
    const report = makeReport();
    const body = "## Summary\n\nClean review.";
    const crlf = `\uFEFF${formatReviewReport(report, body).replace(/\n/g, "\r\n")}`;
    const parsed = parseReviewReport(crlf, "--review-report r.md");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.report).toEqual(report);
    expect(parsed.value.body).toBe(body.replace(/\n/g, "\r\n"));
    expect(reviewReportDigest(parsed.value.report, parsed.value.body)).toBe(reviewReportDigest(report, body.replace(/\n/g, "\r\n")));

    const bare = parseReviewReport(JSON.stringify(report), "bare.json");
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.value.body).toBe("");

    for (const bad of [
      "---\nschema: review-report@1\nno closing fence",
      "---\n- list\n- not-a-map\n---\n",
      "---\n: bad: yaml: [\n---\n",
      formatReviewReport(report).replace("effort: high", "effort: high\nextra_field: nope"),
      formatReviewReport(report).replace("effort: high", "effort: high\nverdict: PASS"),
      formatReviewReport(report).replace("effort: high", "effort: high\nverdict: null"),
      formatReviewReport(report).replace("effort: high", "effort: high\nverdict:"),
    ]) {
      const res = parseReviewReport(bad, "bad.md");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.failure.slug).toBe("gate-review-report-invalid");
        expect(res.failure.exit).toBe(3);
      }
    }
    expect(decodeReviewReport({ ...report, verdict: undefined })._tag).toBe("Failure");
  });

  // admits: algorithmic: multi-branch derivation across open findings, NFKC/zero-width actor matching, exact-row refutation endorsement, independence, class coverage, effort ordering, and head/diff source labels has no type or schema check.
  it("derives pass/blocking/drift across findings, refutations, independence, classes, effort, and head/diff", () => {
    const base = makeReport();
    expect(deriveReviewPass(base)).toEqual({ pass: true, verdict: "PASS" });

    // Open minor/nit or fixed blocking pass; open major fails.
    expect(deriveReviewPass(makeReport({ findings: [makeFinding({ severity: "minor" }), makeFinding({ id: "item-2", severity: "blocking", status: "fixed" })] })).pass).toBe(true);
    const openMajor = deriveReviewPass(makeReport({ findings: [makeFinding()] }));
    expect(openMajor).toMatchObject({ pass: false, status: "blocking", reason: "open-findings" });

    // Self-refuted and author-refuted (including zero-width / case tricks) fail; vouched second reviewer or human passes.
    const raised = makeFinding({ status: "open" });
    const refutedByRaiser = makeFinding({ status: "refuted", refuted_by: "session:REVIEWER-1\u200B" });
    expect(deriveReviewPass(makeReport({ findings: [refutedByRaiser] }))).toMatchObject({ pass: false, status: "blocking", reason: "self-refuted" });

    const refutedByAuthor = makeFinding({ status: "refuted", refuted_by: "AUTHOR@example.com" });
    expect(deriveReviewPass(makeReport({ findings: [refutedByAuthor] }))).toMatchObject({ pass: false, status: "blocking", reason: "self-refuted" });

    // Unvouched stranger named in agreed_by or raised_by does not count.
    const forged = makeFinding({ status: "refuted", raised_by: "session:stranger", agreed_by: ["session:other-stranger"] });
    expect(deriveReviewPass(makeReport({ findings: [forged] }))).toMatchObject({ pass: false, status: "blocking", reason: "self-refuted" });

    // Second reviewer's own report refuting a prior recorded finding row passes; mismatched finding row fails.
    const secondReport = makeReport({
      reviewer: { ...base.reviewer, actor: "session:reviewer-2" },
      findings: [{ ...raised, status: "refuted", raised_by: "session:reviewer-1", refuted_by: "session:reviewer-2" }],
    });
    expect(deriveReviewPass(secondReport, { known: { reviewed: [{ actor: "session:reviewer-1", findings: [raised] }], humans: [] } })).toEqual({ pass: true, verdict: "PASS" });
    expect(
      deriveReviewPass(secondReport, {
        known: { reviewed: [{ actor: "session:reviewer-1", findings: [{ ...raised, line: 99 }] }], humans: [] },
      }),
    ).toMatchObject({ pass: false, status: "blocking", reason: "self-refuted" });

    // Human-grant receipt actor endorsing a refutation passes.
    const humanEndorsed = makeReport({ findings: [{ ...raised, status: "refuted", agreed_by: ["human@example.com"] }] });
    expect(deriveReviewPass(humanEndorsed, { known: { reviewed: [], humans: ["human@example.com"] } })).toEqual({ pass: true, verdict: "PASS" });

    // Independence & fresh context.
    expect(sameActor("Author@Example.com", "author@example.com\u200B")).toBe(true);
    expect(deriveReviewPass(makeReport({ reviewer: { ...base.reviewer, actor: "AUTHOR@example.com" } }))).toMatchObject({ pass: false, status: "blocking", reason: "not-independent" });
    expect(deriveReviewPass(makeReport({ reviewer: { ...base.reviewer, fresh_context: false } }))).toMatchObject({ pass: false, status: "blocking", reason: "not-fresh" });

    // Vocabulary classes & effort.
    expect(deriveReviewPass(base, { vocabularyClasses: ["S1", "S2", "S3", "S4"] })).toMatchObject({ pass: false, status: "blocking", reason: "missing-classes" });
    expect(effortMeets("high", "medium")).toBe(true);
    expect(effortMeets("medium", "high")).toBe(false);
    expect(deriveReviewPass(base, { requiredEffort: "max" })).toMatchObject({ pass: false, status: "blocking", reason: "insufficient-effort" });

    // Head and diff drift + short/empty sha fail-closed.
    expect(headMatches("a".repeat(40), "a".repeat(7))).toBe(true);
    expect(headMatches("a".repeat(40), "")).toBe(false);
    expect(headMatches("a".repeat(40), "aaaaaa")).toBe(false);
    expect(deriveReviewPass(base, { headSha: "d".repeat(40), headSource: "--head-sha" })).toMatchObject({
      pass: false,
      status: "drift",
      reason: "head-mismatch",
      why: `review-report target.head_sha ${"a".repeat(12)} does not match PR head (--head-sha) ${"d".repeat(12)}`,
    });
    expect(deriveReviewPass(base, { headSha: "a".repeat(40), diffSha256: "", headSource: "--head-sha" })).toMatchObject({
      pass: false,
      status: "drift",
      reason: "diff-mismatch",
      why: `review-report target.diff_sha256 ${"b".repeat(12)} does not match PR diff (--head-sha) (commit ${"a".repeat(12)} not in checkout)`,
    });
    expect(deriveReviewPass(base, { diffSha256: "e".repeat(64), diffSource: "--diff-sha256" })).toMatchObject({
      pass: false,
      status: "drift",
      reason: "diff-mismatch",
      why: `review-report target.diff_sha256 ${"b".repeat(12)} does not match PR diff (--diff-sha256) ${"e".repeat(12)}`,
    });
  });

  // admits: algorithmic: fenced-block exclusion, class heading formats, sorted NUL-delimited skill hashing, and staleness comparisons govern cross-build digest and staleness parity.
  it("extracts vocabulary classes outside fences, computes order-independent skillDigest, and reports staleness", () => {
    const dup = `${VOCAB_MD}\n## S1 - Duplicate\n`;
    expect(classIds(dup)).toEqual(["S1", "S2", "S3", "S1"]);
    expect(vocabularyClasses(dup)).toEqual(["S1", "S2", "S3"]);

    const a = { path: "SKILL.md", bytes: Buffer.from("one", "utf8") };
    const b = { path: "ref/check.md", bytes: Buffer.from("two", "utf8") };
    expect(skillDigest([a, b])).toBe(skillDigest([b, a]));
    expect(skillDigest([a, b])).not.toBe(skillDigest([a, { path: "ref/check.md", bytes: Buffer.from("three", "utf8") }]));

    const report = makeReport();
    expect(staleness(report, { skill: { sha256: SKILL_SHA, mainSha: HARNESS_SHA }, vocabulary: { sha256: VOCAB_SHA } })).toEqual([]);
    const moved = staleness(report, { skill: { sha256: "1".repeat(64), mainSha: "e".repeat(40) }, vocabulary: { sha256: "2".repeat(64) } });
    expect(moved).toHaveLength(2);
    expect(moved[0]).toContain("is behind main@eeeeeeeeeeee");
    expect(moved[1]).toContain("is behind main@222222222222");

    const unreadable = staleness(report, { skill: { why: "no harness clone" }, vocabulary: { why: "missing on main" } });
    expect(unreadable).toEqual([
      `cannot verify review skill ${SKILL_NAME}@${HARNESS_SHA.slice(0, 12)}: no harness clone`,
      `cannot verify review vocabulary ${VOCAB_PATH}: missing on main`,
    ]);
  });
});

describe("gate record --review-report, gate check, and gatePlugin({ reviews }) seam", () => {
  interface StoredRow {
    comment_id: string;
    created_at: string;
    marker_version: "v2";
    payload: unknown;
    prose?: string;
  }

  let sandbox: string;
  let home: string;
  let server: ReturnType<typeof Bun.serve>;
  let store: Record<string, StoredRow[]>;
  let seen: Array<{ method: string; path: string; body: string }>;
  let clock: number;
  let bundle: GatesOrgBundle;
  let settings: GatesSettings;

  beforeAll(() => {
    mkdirSync(join(REPO, ".scratch"), { recursive: true });
    sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "gate-review-")));
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        const body = await req.text();
        seen.push({ method: req.method, path: url.pathname, body });
        const sha = await computeGatesBundleSha(bundle, settings);
        if (req.method === "GET" && url.pathname === "/v1/gates/policy") return Response.json({ contract: "gates-contract/v1.5", bundle, bundle_sha: sha });
        if (req.method === "GET" && url.pathname === "/v1/gates/settings") return Response.json({ contract: "gates-contract/v1.5", settings, bundle_sha: sha });
        if (req.method === "GET" && url.pathname === "/v1/gates/receipts") {
          const issue = url.searchParams.get("issue") ?? "";
          return Response.json({ issue, receipts: store[issue] ?? [], invalid: 0, contract_version: "gates-contract/v1" });
        }
        if (req.method === "POST" && url.pathname === "/v1/gates/receipts") {
          const parsed = JSON.parse(body) as { comment_id: string; issue: string; receipt: { gate: string }; prose?: string };
          const row: StoredRow = {
            comment_id: parsed.comment_id,
            created_at: new Date(Date.UTC(2026, 10, 20, 10, 0, clock++)).toISOString(),
            marker_version: "v2",
            payload: parsed.receipt,
            prose: parsed.prose,
          };
          (store[parsed.issue] ??= []).push(row);
          return Response.json(
            { comment_id: parsed.comment_id, issue: parsed.issue, gate: parsed.receipt.gate, created_at: row.created_at, record_sha256: sha256Hex(JSON.stringify(parsed.receipt)), contract_version: "gates-contract/v1" },
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
    mkdirSync(join(home, ".eris"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".eris", "yaks.json"), JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token: LOGIN }), { mode: 0o600 });
    store = {};
    seen = [];
    clock = 0;
    bundle = {
      active: "ci",
      postures: {
        ci: { name: "CI", bullets: ["CI posture."], policy: { profile_default: "ci", signoff: { "one-way": "human", "two-way": "self" } } },
      },
      profiles: { ci: ["adversarial-review"] },
      loops: {},
    };
    settings = { staleness: "soft", ci: { check_profile_in_ci: "on", untracked_prs: "block", bot_allowlist: [] } };
  });

  function git(cwd: string, ...args: string[]): string {
    const r = Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd, env: { PATH: process.env.PATH, HOME: home } });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  }

  function write(dir: string, rel: string, text: string): void {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }

  function makeRepo(slug: string, files: Record<string, string>): { dir: string; baseSha: string } {
    const dir = realpathSync(mkdtempSync(join(sandbox, "repo-")));
    git(dir, "init", "-q", "-b", "main");
    git(dir, "remote", "add", "origin", `https://github.com/${slug}.git`);
    for (const [rel, body] of Object.entries(files)) write(dir, rel, body);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
    const baseSha = git(dir, "rev-parse", "HEAD");
    git(dir, "update-ref", "refs/remotes/origin/main", baseSha);
    return { dir, baseSha };
  }

  function diffDigest(dir: string, base: string, head: string): string {
    const r = Bun.spawnSync(["git", "diff", "--no-ext-diff", "--no-color", base, head], { cwd: dir, env: { PATH: process.env.PATH, HOME: home } });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return sha256Hex(r.stdout);
  }

  async function runGate(args: string[], opts: { cwd?: string; defaults?: GateDefaults; env?: Record<string, string> } = {}): Promise<{ code: number; out: string; err: string }> {
    let out = "";
    let err = "";
    const ctx = {
      erisDir: REPO,
      env: { HOME: home, PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: sandbox, ...opts.env },
      stdout: { write: (s: string) => ((out += s), true) },
      stderr: { write: (s: string) => ((err += s), true) },
      format: "text" as const,
    };
    const deps: GateDeps = { home, cwd: opts.cwd ?? sandbox, now: () => new Date("2026-11-20T10:00:00.000Z"), sleep: async () => {}, jitter: () => 0, expectDelaysMs: [0] };
    try {
      return { code: await gateHandler(opts.defaults ?? {}, deps)(args, ctx), out, err };
    } catch (e) {
      if (e instanceof CliExit) return { code: e.code, out, err };
      throw e;
    }
  }

  const freshReviews = (over: Partial<ReviewFreshness> = {}, skills?: GateReviews["skills"]): GateReviews => ({
    ...(skills !== undefined ? { skills } : {}),
    freshness: () => ({
      main: { skill: { sha256: SKILL_SHA, mainSha: HARNESS_SHA }, vocabulary: { sha256: VOCAB_SHA } },
      classes: ["S1", "S2", "S3"],
      notes: [],
      ...over,
    }),
  });

  // admits: integration: record --review-report must refuse bad reports before any HTTP call, default --artifact, derive PASS/BLOCKING using exactly one GET listing, store canonical sha256, and render summary/findings/prose.
  it("records --review-report with derived verdict from one listing, canonical digest, rich prose, and fails invalid reports before sending", async () => {
    const dir = mkdtempSync(join(sandbox, "rec-"));
    const badPath = join(dir, "bad.md");
    writeFileSync(badPath, formatReviewReport(makeReport()).replace("effort: high", "effort: high\nverdict: PASS"));
    const badRes = await runGate(["record", "adversarial-review", "--issue", ISSUE, "--review-report", badPath, "--actor", "session:reviewer-1"]);
    expect(badRes.code).toBe(3);
    expect(badRes.err).toContain("slug: gate-review-report-invalid");
    expect(seen).toHaveLength(0);

    // Clean report with >20-line prose: derives PASS, defaults --artifact, sends only 1 GET listing.
    const cleanReport = makeReport({ findings: [makeFinding({ severity: "minor", status: "open" })] });
    const longBody = Array.from({ length: 24 }, (_, i) => `Line ${i + 1} of review prose.`).join("\n");
    const cleanPath = join(dir, "clean.md");
    writeFileSync(cleanPath, formatReviewReport(cleanReport, longBody));
    const okRes = await runGate(["record", "adversarial-review", "--issue", ISSUE, "--review-report", cleanPath, "--actor", "session:reviewer-1"]);
    expect(okRes.code).toBe(0);
    expect(seen.filter((s) => s.method === "GET" && s.path === "/v1/gates/receipts")).toHaveLength(1);
    const stored = store[ISSUE]![0]!;
    const rec = stored.payload as { verdict: string; evidence: Array<{ kind: string; sha256: string; body?: string }> };
    expect(rec.verdict).toBe("PASS");
    expect(rec.evidence[0]!.kind).toBe("review-report");
    expect(rec.evidence[0]!.sha256).toBe(reviewReportDigest(cleanReport, longBody));
    expect(stored.prose).toContain("Findings: 0 open blocking/major (1 total)");
    expect(stored.prose).toContain("Line 1 of review prose.");
    expect(stored.prose).toContain("… 4 more line(s) in the stored record");

    // Recording actor != reviewer.actor derives BLOCKING.
    const wrongActor = await runGate(["record", "adversarial-review", "--issue", ISSUE, "--review-report", cleanPath, "--actor", "session:someone-else"]);
    expect(wrongActor.code).toBe(0);
    expect((store[ISSUE]![1]!.payload as { verdict: string }).verdict).toBe("BLOCKING");

    // Open major finding derives BLOCKING; second reviewer refuting the exact finding row derives PASS.
    const openFinding = makeFinding({ status: "open" });
    const round1Path = join(dir, "round1.md");
    writeFileSync(round1Path, formatReviewReport(makeReport({ findings: [openFinding] })));
    await runGate(["record", "adversarial-review", "--issue", ISSUE, "--review-report", round1Path, "--actor", "session:reviewer-1"]);
    expect((store[ISSUE]![2]!.payload as { verdict: string }).verdict).toBe("BLOCKING");

    const round2Path = join(dir, "round2.md");
    writeFileSync(
      round2Path,
      formatReviewReport(
        makeReport({
          reviewer: { ...makeReport().reviewer, actor: "session:reviewer-2" },
          findings: [{ ...openFinding, status: "refuted", raised_by: "session:reviewer-1", refuted_by: "session:reviewer-2" }],
        }),
      ),
    );
    await runGate(["record", "adversarial-review", "--issue", ISSUE, "--review-report", round2Path, "--actor", "session:reviewer-2"]);
    expect((store[ISSUE]![3]!.payload as { verdict: string }).verdict).toBe("PASS");
  });

  // admits: integration: public default (no reviews seam) must fail closed as blocking; composed via eris/sdk with gatePlugin({ reviews }) must judge skill allowlists, unbound reviewer, effort, head/diff, staleness, and human-grant acceptance.
  it("fails closed under public default and judges review-report evidence when composed with gatePlugin({ reviews }) via eris/sdk", async () => {
    const dir = mkdtempSync(join(sandbox, "chk-"));
    const reportPath = join(dir, "report.md");
    writeFileSync(reportPath, formatReviewReport(makeReport(), "Clean review."));
    const rec = await runGate(["record", "adversarial-review", "--issue", ISSUE, "--review-report", reportPath, "--actor", "session:reviewer-1"]);
    expect(rec.code).toBe(0);

    // Public default (no reviews seam): fails closed as blocking.
    const pubCheck = await runGate(["check", "--issue", ISSUE, "--gates", "adversarial-review"]);
    expect(pubCheck.code).toBe(3);
    expect(pubCheck.out).toBe("adversarial-review\tblocking\tPASS\n");
    expect(pubCheck.err).toContain("review-report evidence is judged only by an eris build that registers review skills");

    // Composed via eris/sdk `gatePlugin({ reviews })` through `composeCli` + `main`: passes!
    let skillCalls = 0;
    const distGate = gatePlugin({
      reviews: freshReviews({}, async () => {
        skillCalls += 1;
        return [SKILL_NAME];
      }),
    });
    const distCli = composeCli(REGISTRY, HANDLERS, [...PLUGINS.filter((p) => p.name !== "gate"), distGate]);
    let sdkOut = "";
    let sdkErr = "";
    const sdkRc = await main(
      ["gate", "check", "--issue", ISSUE, "--gates", "adversarial-review", "--effort", "high", "--head-sha", "a".repeat(40), "--diff-sha256", "b".repeat(64)],
      { HOME: home, PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: sandbox },
      { cli: distCli, stdout: { write: (s: string) => ((sdkOut += s), true) }, stderr: { write: (s: string) => ((sdkErr += s), true) } },
    );
    expect({ rc: sdkRc, out: sdkOut, err: sdkErr, skillCalls }).toEqual({ rc: 0, out: "adversarial-review\tpass\tPASS\n", err: "", skillCalls: 1 });

    // Empty or mismatched distribution `reviews.skills` fails closed as blocking.
    const emptySkills = await runGate(["check", "--issue", ISSUE, "--gates", "adversarial-review"], { defaults: { reviews: freshReviews({}, []) } });
    expect(emptySkills.code).toBe(3);
    expect(emptySkills.out).toBe("adversarial-review\tblocking\tPASS\n");
    expect(emptySkills.err).toContain(`review skill ${SKILL_NAME} is not a registered review skill (registered: none)`);

    // Invalid --effort exits 2 with gate-usage; higher --effort fails blocking; mismatched --head-sha/--diff-sha256 fails drift.
    const badEffort = await runGate(["check", "--issue", ISSUE, "--gates", "adversarial-review", "--effort", "extreme"], { defaults: { reviews: freshReviews() } });
    expect(badEffort.code).toBe(2);
    expect(badEffort.err).toContain("slug: gate-usage");

    const lowEffort = await runGate(["check", "--issue", ISSUE, "--gates", "adversarial-review", "--effort", "max"], { defaults: { reviews: freshReviews() } });
    expect(lowEffort.code).toBe(3);
    expect(lowEffort.out).toBe("adversarial-review\tblocking\tPASS\n");
    expect(lowEffort.err).toContain("effort high is below required max");

    const badHead = await runGate(["check", "--issue", ISSUE, "--gates", "adversarial-review", "--head-sha", "f".repeat(40)], { defaults: { reviews: freshReviews() } });
    expect(badHead.code).toBe(3);
    expect(badHead.out).toBe("adversarial-review\tdrift\tPASS\n");

    // Stale skill/vocabulary fails review-stale and prints freshness notes; human grant accepts it with WARN, doctrine grant does not.
    const staleReviews = freshReviews({
      main: { skill: { sha256: "9".repeat(64), mainSha: "e".repeat(40) }, vocabulary: { sha256: VOCAB_SHA } },
      notes: ["WARN harness fetch failed; judging against local origin/main"],
    });
    const staleCheck = await runGate(["check", "--issue", ISSUE, "--gates", "adversarial-review"], { defaults: { reviews: staleReviews } });
    expect(staleCheck.code).toBe(3);
    expect(staleCheck.out).toBe("adversarial-review\treview-stale\tPASS\n");
    expect(staleCheck.err).toContain("WARN harness fetch failed");
    expect(staleCheck.err).toContain("needs human approval");

    // Re-record with a doctrine grant: still review-stale.
    await runGate(["record", "adversarial-review", "--issue", ISSUE, "--review-report", reportPath, "--actor", "session:reviewer-1", "--authorized", "doctrine:ci"]);
    const docGrant = await runGate(["check", "--issue", ISSUE, "--gates", "adversarial-review"], { defaults: { reviews: staleReviews } });
    expect(docGrant.code).toBe(3);
    expect(docGrant.out).toBe("adversarial-review\treview-stale\tPASS\n");

    // Re-record with a human grant: passes with acceptance WARN.
    await runGate(["record", "adversarial-review", "--issue", ISSUE, "--review-report", reportPath, "--actor", "session:reviewer-1", "--authorized", "alice asked: accept stale skill"]);
    const humanGrant = await runGate(["check", "--issue", ISSUE, "--gates", "adversarial-review"], { defaults: { reviews: staleReviews } });
    expect(humanGrant.code).toBe(0);
    expect(humanGrant.out).toBe("adversarial-review\tpass\tPASS\n");
    expect(humanGrant.err).toContain('accepted by human grant "alice asked: accept stale skill"');

    // Unbound reviewer (receipt actor != reviewer.actor) fails blocking even with explicit --verdict PASS.
    await runGate(["record", "adversarial-review", "--issue", ISSUE, "--verdict", "PASS", "--review-report", reportPath, "--actor", "session:impostor"]);
    const unbound = await runGate(["check", "--issue", ISSUE, "--gates", "adversarial-review"], { defaults: { reviews: freshReviews() } });
    expect(unbound.code).toBe(3);
    expect(unbound.out).toBe("adversarial-review\tblocking\tPASS\n");
    expect(unbound.err).toContain("is not the recording actor session:impostor");
  });

  // admits: boundary-io: real git checkout target head/diff resolution must keep thoughts/-only post-review commits bound, honour recorded merged-PR base, and fail closed as drift when explicit --head-sha cannot be diffed.
  it("resolves target head/diff in real git (thoughts/-only commit, merged-PR context base, and explicit --head-sha fail-closed)", async () => {
    const slug = "example-org/git-target";
    const { dir, baseSha } = makeRepo(slug, { "src/app.ts": "export const v = 1;\n", [VOCAB_PATH]: VOCAB_MD });
    git(dir, "checkout", "-q", "-b", "feat/work");
    write(dir, "src/app.ts", "export const v = 2;\n");
    git(dir, "add", "src/app.ts");
    git(dir, "commit", "-q", "-m", "code change");
    const reviewedSha = git(dir, "rev-parse", "HEAD");
    const prDiffSha = diffDigest(dir, baseSha, reviewedSha);

    const report = makeReport({
      target: { repo: slug, pr: 55, head_sha: reviewedSha, diff_sha256: prDiffSha },
    });
    const reportPath = join(home, "git-report.md");
    writeFileSync(reportPath, formatReviewReport(report, "Verified code change."));
    const rec = await runGate(["record", "adversarial-review", "--issue", ISSUE, "--review-report", reportPath, "--actor", "session:reviewer-1"], { cwd: dir });
    expect({ code: rec.code, err: rec.err }).toEqual({ code: 0, err: expect.stringContaining("recorded adversarial-review PASS") });

    // A thoughts/-only commit after review keeps the report bound to reviewedSha and passes.
    write(dir, "thoughts/notes.md", "# note\n");
    git(dir, "add", "thoughts/notes.md");
    git(dir, "commit", "-q", "-m", "add note");
    const afterNoteSha = git(dir, "rev-parse", "HEAD");
    const bound = await runGate(["check", "--issue", ISSUE, "--gates", "adversarial-review", "--head-sha", afterNoteSha], {
      cwd: dir,
      defaults: { reviews: freshReviews() },
    });
    expect({ code: bound.code, out: bound.out, err: bound.err }).toEqual({ code: 0, out: "adversarial-review\tpass\tPASS\n", err: "" });

    // Once origin/main advances past reviewedSha (merged PR), recorded context.json base reproduces the PR diff.
    git(dir, "update-ref", "refs/remotes/origin/main", afterNoteSha);
    const gitDir = git(dir, "rev-parse", "--absolute-git-dir");
    mkdirSync(join(gitDir, "eris", "review-55"), { recursive: true });
    writeFileSync(join(gitDir, "eris", "review-55", "context.json"), JSON.stringify({ base: baseSha }));
    const merged = await runGate(["check", "--issue", ISSUE, "--gates", "adversarial-review", "--head-sha", afterNoteSha], {
      cwd: dir,
      defaults: { reviews: freshReviews() },
    });
    expect(merged.code).toBe(0);

    // Explicit --head-sha not present in checkout (or option-shaped) fails closed as drift.
    const missingCommit = await runGate(["check", "--issue", ISSUE, "--gates", "adversarial-review", "--head-sha", "f".repeat(40)], {
      cwd: dir,
      defaults: { reviews: freshReviews() },
    });
    expect(missingCommit.code).toBe(3);
    expect(missingCommit.out).toBe("adversarial-review\tdrift\tPASS\n");

    const optShaped = await runGate(["check", "--issue", ISSUE, "--gates", "adversarial-review", "--head-sha=--all"], {
      cwd: dir,
      defaults: { reviews: freshReviews() },
    });
    expect(optShaped.code).toBe(3);
    expect(optShaped.out).toBe("adversarial-review\tdrift\tPASS\n");

    // Code commit after review drifts.
    write(dir, "src/app.ts", "export const v = 3;\n");
    git(dir, "add", "src/app.ts");
    git(dir, "commit", "-q", "-m", "more code");
    const drifted = await runGate(["check", "--issue", ISSUE, "--gates", "adversarial-review"], {
      cwd: dir,
      defaults: { reviews: freshReviews() },
    });
    expect(drifted.code).toBe(3);
    expect(drifted.out).toBe("adversarial-review\tdrift\tPASS\n");
  });

  // admits: integration: gate ci unlock leg with gatePlugin({ reviews }) must enforce merge-base review_skills, effort qualifier, surface/vocabulary match (wrong-surface), GET-only invariant, and fail closed under default plugin.
  it("judges review-report bar gates in gate ci unlock with gatePlugin({ reviews }) and stays GET-only", async () => {
    const slug = "example-org/ci-reviews";
    const surfacesYaml = [
      "surfaces:",
      "  secrets:",
      "    paths:",
      "      - src/secrets/**",
      `    class_taxonomy: ${VOCAB_PATH}`,
      "    one_way_unlock:",
      "      merge: [adversarial-review:high]",
      `    ledger: ${LEDGER}`,
      "    change_budget: 2",
      "review_skills:",
      `  ${SKILL_NAME}:`,
      "    checklist: SKILL.md",
      "",
    ].join("\n");
    const { dir, baseSha } = makeRepo(slug, {
      ".claude/surfaces.yml": surfacesYaml,
      [VOCAB_PATH]: VOCAB_MD,
      "src/secrets/token.ts": "export const k = 1;\n",
    });
    git(dir, "checkout", "-q", "-b", `dev/${ISSUE.toLowerCase()}-review`);
    write(dir, "src/secrets/token.ts", "export const k = 2;\n");
    git(dir, "add", "src/secrets/token.ts");
    git(dir, "commit", "-q", "-m", "touch secrets");
    const headSha = git(dir, "rev-parse", "HEAD");
    git(dir, "update-ref", `refs/remotes/origin/dev/${ISSUE.toLowerCase()}-review`, headSha);
    const prDiffSha = diffDigest(dir, baseSha, headSha);

    // Seed passing posture-check, ledger audit-surfaces baseline, and unlocked-merge announcement at headSha.
    const noteSha = sha256Hex("export const k = 2;\n");
    const gitArtifact = { _tag: "git", repo: slug, ref: `dev/${ISSUE.toLowerCase()}-review`, commit: headSha, path: "src/secrets/token.ts", sha256: noteSha };
    const seed = (issue: string, payload: Record<string, unknown>) => {
      (store[issue] ??= []).push({
        comment_id: `c-${clock}`,
        created_at: new Date(Date.UTC(2026, 10, 20, 9, 0, clock++)).toISOString(),
        marker_version: "v2",
        payload: {
          schema: "gate-receipt@v2",
          issue,
          verdict: "PASS",
          artifact: gitArtifact,
          actor: "session:reviewer-1",
          evidence: [],
          recorded_at: "2026-11-20T09:00:00.000Z",
          ...payload,
        },
      });
    };
    seed(LEDGER, { gate: "audit-surfaces", artifact: { _tag: "git", repo: slug, ref: "main", commit: baseSha, path: ".claude/surfaces.yml", sha256: sha256Hex(surfacesYaml) } });
    seed(LEDGER, { gate: "unlocked-merge", evidence: [{ kind: "text", content: `issue: ${ISSUE} head: ${headSha}`, sha256: sha256Hex(`issue: ${ISSUE} head: ${headSha}`) }] });
    seed(ISSUE, { gate: "posture-check" });

    const report = makeReport({ target: { repo: slug, pr: 9, head_sha: headSha, diff_sha256: prDiffSha } });
    seed(ISSUE, {
      gate: "adversarial-review",
      evidence: [{ kind: "review-report", name: "review.md", report, sha256: reviewReportDigest(report) }],
    });

    const eventPath = join(sandbox, "event.json");
    writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: {
          number: 9,
          title: `${ISSUE}: review test`,
          user: { login: "alice" },
          head: { ref: `dev/${ISSUE.toLowerCase()}-review`, sha: headSha },
          base: { ref: "main", sha: baseSha },
        },
      }),
    );

    // Public default fails closed as blocking on the review report.
    seen = [];
    const pubCi = await runGate(["ci", "--event", eventPath], { cwd: dir });
    expect(pubCi.code).toBe(3);
    expect(pubCi.out).toContain("@unlock\thuman\tmerge");
    expect(seen.every((s) => s.method === "GET")).toBe(true);

    // With gatePlugin({ reviews }): bar gate passes (and door-signoff human-signs), stays GET-only.
    seed(ISSUE, {
      gate: "door-signoff",
      authorized: "alice asked: ship it",
      evidence: [{ kind: "text", content: "door: merge", sha256: sha256Hex("door: merge") }],
    });
    seen = [];
    let targetRootSeen = "" as string | null;
    const distReviews: GateReviews = {
      freshness: async (req) => {
        targetRootSeen = await req.targetRoot();
        return {
          main: { skill: { sha256: SKILL_SHA, mainSha: HARNESS_SHA }, vocabulary: { sha256: VOCAB_SHA } },
          classes: ["S1", "S2", "S3"],
        };
      },
    };
    const okCi = await runGate(["ci", "--event", eventPath], { cwd: dir, defaults: { reviews: distReviews } });
    expect(okCi.code).toBe(0);
    expect(okCi.out).toContain("adversarial-review:high\tpass\tPASS");
    expect(okCi.out).toContain("@unlock\thuman-signed\tmerge");
    expect(targetRootSeen).toBe(dir);
    expect(seen.every((s) => s.method === "GET")).toBe(true);

    // Direct checkUnlock with signoff.unlock: on unlocks automatically once the review-report bar gate passes.
    const { gatesEndpoint, readDoctrine } = await import("eris/gates-contract");
    const ep = gatesEndpoint(`http://127.0.0.1:${server.port}`, LOGIN);
    expect(ep.ok).toBe(true);
    if (!ep.ok) return;
    const unlockOut: string[] = [];
    const unlocked = await checkUnlock({
      ep: ep.value,
      issue: ISSUE,
      action: "merge",
      base: baseSha,
      headSha,
      registry: ".claude/surfaces.yml",
      cwd: dir,
      g: memoReads(liveGit({ HOME: home, PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: sandbox })),
      doctrine: { file: "doctrine.md", read: readDoctrine("active: auto\n\n## auto\n\nAuto posture.\n\n```yaml\npolicy:\n  signoff:\n    unlock: on\n```\n") },
      reviews: distReviews,
      now: new Date("2026-11-20T10:00:00.000Z"),
      readRetry: { delaysMs: [], maxWaitMs: 0, sleep: async () => {}, jitter: () => 0 },
      out: (l) => unlockOut.push(l),
      warn: () => {},
    });
    expect(unlocked).toBe("unlocked");
    expect(unlockOut).toContain("adversarial-review:high\tpass\tPASS");
    expect(unlockOut).toContain("@unlock\tunlocked\tmerge");

    // Wrong surface/vocabulary on the report fails as wrong-surface (remove door-signoff so unlock fails visibly).
    store[ISSUE] = store[ISSUE]!.filter((r) => (r.payload as { gate: string }).gate !== "door-signoff");
    const wrongSurf = makeReport({ target: { repo: slug, pr: 9, head_sha: headSha, diff_sha256: prDiffSha }, surface: "other" });
    seed(ISSUE, {
      gate: "adversarial-review",
      evidence: [{ kind: "review-report", name: "wrong.md", report: wrongSurf, sha256: reviewReportDigest(wrongSurf) }],
    });
    const wrongCi = await runGate(["ci", "--event", eventPath], { cwd: dir, defaults: { reviews: distReviews } });
    expect(wrongCi.code).toBe(3);
    expect(wrongCi.out).toContain("adversarial-review:high\twrong-surface\tPASS");

    // Unregistered skill (not in merge-base review_skills) fails as blocking.
    const unknownSkill = makeReport({
      target: { repo: slug, pr: 9, head_sha: headSha, diff_sha256: prDiffSha },
      reviewer: { ...report.reviewer, skill: { name: "unregistered-skill", harness_sha: HARNESS_SHA, sha256: SKILL_SHA } },
    });
    seed(ISSUE, {
      gate: "adversarial-review",
      evidence: [{ kind: "review-report", name: "unreg.md", report: unknownSkill, sha256: reviewReportDigest(unknownSkill) }],
    });
    const unregCi = await runGate(["ci", "--event", eventPath], { cwd: dir, defaults: { reviews: distReviews } });
    expect(unregCi.code).toBe(3);
    expect(unregCi.out).toContain("adversarial-review:high\tblocking\tPASS");
    expect(unregCi.err).toContain("is not a registered review skill (review_skills at the merge-base:");
  });
});
