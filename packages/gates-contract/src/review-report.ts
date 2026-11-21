/**
 * review-report.ts — the `review-report@1` evidence a gate receipt may carry: the machine-readable
 * frontmatter of a code review, its prose body, the canonical digest, strict YAML frontmatter
 * parsing, and the pure pass/staleness derivations `eris gate check` and `eris gate record` share.
 *
 * Invariants:
 *  - A report never declares its own verdict: any `verdict` key, whatever its value, fails decode
 *    under the stripped and strict decoders alike. Pass is derived (`deriveReviewPass`).
 *  - The digest is sha256 over the canonical document `formatReviewReport` writes (YAML frontmatter
 *    with `schema` first, then the trimmed body), so any build that recorded the report reproduces it.
 *  - `deriveReviewPass` checks in fixed order: open blocking/major findings, unendorsed refutations,
 *    reviewer independence and fresh context, vocabulary class coverage, minimum effort, head drift,
 *    and diff drift. Skill and vocabulary staleness (`staleness`) run after it in `gate check`.
 */

import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { type DecodeResult, decodeResultStrict } from "./decode";
import { type ContractFailure, fail, type Outcome, succeed } from "./failure";
import type { GateMandateStamp } from "./receipt";

export const GATE_REVIEW_REPORT_SCHEMA = "review-report@1";
/** The evidence `kind` a review report rides under. */
export const GATE_REVIEW_REPORT_KIND = "review-report";
/** The authority verb for direct-root passkey endorsement of a refuted blocking/major finding. */
export const REVIEW_ENDORSE_VERB = "review:endorse";

const ENDORSE_ISSUE_KEY = /^[A-Z][A-Z0-9]*-[0-9]+$/;
const ENDORSE_FINDING_VALUE = /^[A-Za-z0-9._:/-]+$/;
const ENDORSE_BEARER_RE = /(?:mnd|mct)_/i;
const ENDORSE_SCOPE_MAX_LENGTH = 512;

export const GATE_REVIEW_EFFORTS = ["low", "medium", "high", "max"] as const;
export const GateReviewEffort = Schema.Literals(GATE_REVIEW_EFFORTS);
export type GateReviewEffort = typeof GateReviewEffort.Type;

export const GATE_FINDING_SEVERITIES = ["blocking", "major", "minor", "nit"] as const;
export const GateFindingSeverity = Schema.Literals(GATE_FINDING_SEVERITIES);
export type GateFindingSeverity = typeof GateFindingSeverity.Type;

/** The severities an `open` or unendorsed-`refuted` finding fails the derived pass at. */
export const GATE_BLOCKING_SEVERITIES = ["blocking", "major"] as const satisfies readonly GateFindingSeverity[];

export const GATE_FINDING_STATUSES = ["open", "fixed", "refuted"] as const;
export const GateFindingStatus = Schema.Literals(GATE_FINDING_STATUSES);
export type GateFindingStatus = typeof GateFindingStatus.Type;

/** A string with at least one non-whitespace character. */
const NonEmptyText = Schema.String.check(Schema.isPattern(/\S/));
/** An integer ≥ 1 (a PR number, a line number). */
const PositiveInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
/** A lowercase hex git object id, abbreviated (7) up to sha-256 (64). */
const GitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{7,64}$/));
/** A lowercase hex sha-256 digest. */
const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
/** An actor id (`act_<ULID>`) or a session, email or handle string: any non-blank text. */
const ReportActor = NonEmptyText;

const ReviewTarget = Schema.Struct({ repo: NonEmptyText, pr: PositiveInt, head_sha: GitSha, diff_sha256: Sha256Hex });
const ReviewSkillRef = Schema.Struct({ name: NonEmptyText, harness_sha: GitSha, sha256: Sha256Hex });
const ReviewVocabularyRef = Schema.Struct({ path: NonEmptyText, sha256: Sha256Hex });

export const GateReviewFinding = Schema.Struct({
  id: NonEmptyText,
  severity: GateFindingSeverity,
  class: NonEmptyText,
  file: NonEmptyText,
  line: PositiveInt,
  status: GateFindingStatus,
  evidence: NonEmptyText,
  /** Who raised the finding; absent means `reviewer.actor`. */
  raised_by: Schema.optionalKey(ReportActor),
  /** Who refuted it; a refutation holds only when an endorser is neither raiser nor author. */
  refuted_by: Schema.optionalKey(ReportActor),
  /** Who agreed with the refutation: a second reviewer or a human. */
  agreed_by: Schema.optionalKey(Schema.Array(ReportActor)),
});
export type GateReviewFinding = typeof GateReviewFinding.Type;

const ForbiddenVerdict = Schema.Never.annotate({ expected: "no verdict field (review-report@1 derives pass in eris gate check)" });

export const GateReviewReportV1 = Schema.Struct({
  schema: Schema.optionalKey(Schema.Literal(GATE_REVIEW_REPORT_SCHEMA)),
  target: ReviewTarget,
  surface: NonEmptyText,
  effort: GateReviewEffort,
  reviewer: Schema.Struct({
    actor: ReportActor,
    model: NonEmptyText,
    fresh_context: Schema.Boolean,
    skill: ReviewSkillRef,
    vocabulary: ReviewVocabularyRef,
  }),
  author: Schema.Struct({ actor: ReportActor }),
  classes_checked: Schema.Array(NonEmptyText),
  findings: Schema.Array(GateReviewFinding),
  /** Declared only to be refused: any `verdict` key fails decode. */
  verdict: Schema.optionalKey(ForbiddenVerdict),
});
/** A decoded report; `verdict` can never be present, so the type has none. */
export type GateReviewReport = Omit<typeof GateReviewReportV1.Type, "verdict">;

/** A review report as gate evidence: frontmatter in the record, prose `body` alongside. */
export const GateReviewReportEvidence = Schema.Struct({
  kind: Schema.Literal(GATE_REVIEW_REPORT_KIND),
  name: Schema.optionalKey(Schema.String),
  report: GateReviewReportV1,
  body: Schema.optionalKey(Schema.String),
  sha256: Schema.String,
});
export type GateReviewReportEvidence = typeof GateReviewReportEvidence.Type;

export const isGateReviewReportEvidence = (e: { readonly kind: string }): e is GateReviewReportEvidence => e.kind === GATE_REVIEW_REPORT_KIND;

export interface ParsedGateReviewReport {
  readonly report: GateReviewReport;
  readonly body: string;
}

function invalidReport(source: string, why: string): ContractFailure {
  return {
    slug: "gate-review-report-invalid",
    what: `${source}: ${why}`,
    fix:
      "Write a review-report@1 with YAML frontmatter (target, surface, effort, reviewer, author, classes_checked, findings)\n" +
      "and no 'verdict' key (eris gate check derives pass; see docs/GATE.md).",
    docs: "docs/ERRORS.md#gate-review-report-invalid",
    exit: 3,
  };
}

/** Synchronously validates `input` against `GateReviewReportV1`, strictly refusing unknown keys and any `verdict` key. */
export function decodeReviewReport(input: unknown): DecodeResult<GateReviewReport> {
  if (typeof input === "object" && input !== null && !Array.isArray(input) && Object.hasOwn(input, "verdict")) {
    return decodeResultStrict(GateReviewReportV1, { ...(input as Record<string, unknown>), verdict: (input as Record<string, unknown>).verdict ?? null });
  }
  return decodeResultStrict(GateReviewReportV1, input);
}

/** Splits `---\n<yaml>\n---\n<body>` frontmatter, or treats bare YAML/JSON as frontmatter with an empty body. */
export function splitFrontmatter(text: string): { readonly frontmatter: string; readonly body: string } | { readonly error: string } {
  const clean = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const open = /^---[ \t]*\r?\n/.exec(clean);
  if (open === null) return { frontmatter: clean, body: "" };
  const rest = clean.slice(open[0].length);
  const close = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/.exec(rest);
  if (close === null) return { error: "unclosed YAML frontmatter (missing closing ---)" };
  const fmEnd = close.index;
  const bodyStart = close.index + close[0].length;
  return { frontmatter: rest.slice(0, fmEnd), body: rest.slice(bodyStart).trim() };
}

/** Parses and validates a `review-report@1` markdown (or YAML/JSON) document into `{ report, body }`. */
export function parseReviewReport(text: string, source = "(review-report)"): Outcome<ParsedGateReviewReport> {
  const split = splitFrontmatter(text);
  if ("error" in split) return fail(invalidReport(source, split.error));
  let parsed: unknown;
  try {
    parsed = parseYaml(split.frontmatter) as unknown;
  } catch (e) {
    return fail(invalidReport(source, `not valid YAML frontmatter: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail(invalidReport(source, "frontmatter must be a YAML map of review-report@1 fields"));
  }
  const decoded = decodeReviewReport(parsed);
  if (decoded._tag === "Failure") return fail(invalidReport(source, decoded.failure.message));
  return succeed({ report: decoded.success, body: split.body });
}

/** A report and its prose as the canonical `review-report@1` document. */
export function formatReviewReport(report: GateReviewReport, body = ""): string {
  const canonical: GateReviewReport = { schema: GATE_REVIEW_REPORT_SCHEMA, ...report };
  const yaml = stringifyYaml(canonical).trimEnd();
  const trimmed = body.trim();
  return trimmed === "" ? `---\n${yaml}\n---\n` : `---\n${yaml}\n---\n\n${trimmed}\n`;
}

/** The sha256 a receipt holds for a report and its prose body. */
export function reviewReportDigest(report: GateReviewReport, body = ""): string {
  return createHash("sha256").update(formatReviewReport(report, body), "utf8").digest("hex");
}

export const effortRank = (effort: GateReviewEffort): number => GATE_REVIEW_EFFORTS.indexOf(effort);

export const effortMeets = (actual: GateReviewEffort, required: GateReviewEffort): boolean => effortRank(actual) >= effortRank(required);

/** Either sha may be an abbreviation (at least 7 hex chars) of the other. */
export function headMatches(reportHead: string, prHead: string): boolean {
  const r = reportHead.toLowerCase();
  const p = prHead.toLowerCase();
  return r.length >= 7 && p.length >= 7 && (p === r || p.startsWith(r) || r.startsWith(p));
}

/** NFKC, zero-width and soft-hyphen characters dropped, trimmed, lower-cased: two spellings of one actor compare equal. */
const normActor = (actor: string): string =>
  actor
    .normalize("NFKC")
    .replace(/[\u00AD\u200B-\u200F\u2060\uFEFF]/g, "")
    .trim()
    .toLowerCase();

/** Two report actors name the same actor (NFKC-normalised, trimmed, case-insensitive). */
export const sameActor = (a: string, b: string): boolean => normActor(a) === normActor(b);

export type IndependenceFailure = { readonly reason: "not-independent" | "not-fresh"; readonly why: string };

/** Why the reviewer is not independent of the author, or null. */
export function independenceFailure(report: GateReviewReport): IndependenceFailure | null {
  if (sameActor(report.reviewer.actor, report.author.actor)) {
    return { reason: "not-independent", why: `review-report reviewer ${report.reviewer.actor} is the author` };
  }
  if (!report.reviewer.fresh_context) {
    return { reason: "not-fresh", why: `review-report reviewer ${report.reviewer.actor} did not review in a fresh context` };
  }
  return null;
}

/**
 * A server-stamped `review:endorse` endorsement extracted from a `gate-receipt@v3` on `(issue, gate)`:
 * pairs the exact finding row carried on that stamped receipt with the receipt's issue and `MandateStamp`.
 */
export interface EndorsedFinding {
  readonly finding: GateReviewFinding;
  readonly issue: string;
  readonly stamp: GateMandateStamp;
}

/**
 * The actors an issue's receipts vouch for: `reviewed`, for every review-report on the judged gate
 * whose receipt its reviewer recorded, that reviewer and its findings; `humans`, the actor of every
 * receipt carrying a human grant; `endorsed`, every refuted blocking/major finding backed by a
 * server-stamped direct-root `review:endorse` `MandateStamp` on `(issue, gate)`. A report's own
 * text never adds to any of them.
 */
export interface KnownActors {
  readonly reviewed: ReadonlyArray<{ readonly actor: string; readonly findings: ReadonlyArray<GateReviewFinding> }>;
  readonly humans: ReadonlyArray<string>;
  readonly endorsed?: ReadonlyArray<EndorsedFinding> | undefined;
}

/**
 * Canonical `review:endorse` mandate scope for `(findingId, issue)`, or `null` when either value
 * fails shape validation, carries a bearer prefix (`mnd_`/`mct_`), or exceeds the scope length cap.
 * Rejects delimiter smuggling (`&`, `=`, `?`, whitespace, `,`) before composing the query string.
 */
export function reviewEndorseScope(findingId: string, issue: string): string | null {
  if (!ENDORSE_ISSUE_KEY.test(issue) || !ENDORSE_FINDING_VALUE.test(findingId) || ENDORSE_BEARER_RE.test(findingId)) return null;
  const scope = `sr:us:mandate:${REVIEW_ENDORSE_VERB}?finding=${findingId}&work_ref=linear:${issue}`;
  return scope.length <= ENDORSE_SCOPE_MAX_LENGTH ? scope : null;
}

export type ReviewEndorseFailureReason = "no_review_report" | "open_findings" | "no_refuted_high_finding" | "multiple_refuted_high_findings" | "invalid_scope";

export type ReviewEndorseExtraction =
  | { readonly ok: true; readonly finding: GateReviewFinding; readonly findingId: string; readonly scope: string }
  | { readonly ok: false; readonly reason: ReviewEndorseFailureReason; readonly detail: string };

/**
 * Extracts the single refuted blocking/major finding from `reports` and builds its canonical
 * `review:endorse` scope, failing closed on empty reports, open blocking/major findings, 0 or >1
 * refuted blocking/major findings, or a finding/issue pair that cannot form a canonical scope.
 */
export function extractReviewEndorseFinding(reports: ReadonlyArray<GateReviewReport>, issue: string): ReviewEndorseExtraction {
  if (reports.length === 0) {
    return {
      ok: false,
      reason: "no_review_report",
      detail: "review:endorse requires --review-report with one refuted blocking or major finding",
    };
  }
  const candidates: GateReviewFinding[] = [];
  for (const report of reports) {
    if (report.findings.some((f) => f.status === "open" && isHigh(f))) {
      return {
        ok: false,
        reason: "open_findings",
        detail: "review-report still carries open blocking/major findings; resolve them before endorsing a refutation",
      };
    }
    for (const f of report.findings) {
      if (f.status === "refuted" && isHigh(f)) candidates.push(f);
    }
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "no_refuted_high_finding",
      detail: "review:endorse requires a refuted blocking or major finding in review-report evidence",
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: "multiple_refuted_high_findings",
      detail: "review:endorse stamps one refuted blocking or major finding per receipt; found multiple candidates",
    };
  }
  const finding = candidates[0]!;
  const scope = reviewEndorseScope(finding.id, issue);
  if (scope === null) {
    return {
      ok: false,
      reason: "invalid_scope",
      detail: `finding ${finding.id} on linear:${issue} does not form a review:endorse mandate scope`,
    };
  }
  return { ok: true, finding, findingId: finding.id, scope };
}

const knownIn = (actors: ReadonlyArray<string> | undefined, a: string): boolean => (actors ?? []).some((k) => sameActor(k, a));

/** Two reports carry the same finding row: id, severity, class, file, line and evidence all equal. */
const sameFinding = (a: GateReviewFinding, b: GateReviewFinding): boolean =>
  a.id === b.id && a.severity === b.severity && a.class === b.class && a.file === b.file && a.line === b.line && a.evidence === b.evidence;

/** Whether `actor`'s own recorded reports on the gate carry `f`, not as fixed; with `refuted`, marked refuted by that report itself. */
const recordedBy = (known: KnownActors | undefined, actor: string, f: GateReviewFinding, refuted: boolean): boolean =>
  (known?.reviewed ?? []).some(
    (r) => sameActor(r.actor, actor) && r.findings.some((g) => sameFinding(g, f) && g.status !== "fixed" && (!refuted || g.status === "refuted")),
  );

/**
 * Whether `f` on `issue` is backed by a server-stamped direct passkey root (`id === root_id`)
 * `review:endorse` `MandateStamp` matching both the canonical `(f.id, issue)` scope and the exact
 * finding row (`sameFinding`). Delegated children, wrong finding/issue, and row swaps return false.
 */
export function hasDirectReviewEndorsement(f: GateReviewFinding, issue: string | undefined, known?: KnownActors): boolean {
  if (issue === undefined) return false;
  const expected = reviewEndorseScope(f.id, issue);
  if (expected === null) return false;
  return (known?.endorsed ?? []).some(
    (e) =>
      e.issue === issue &&
      e.stamp.id === e.stamp.root_id &&
      e.stamp.scope === expected &&
      e.finding.status === "refuted" &&
      isHigh(e.finding) &&
      sameFinding(e.finding, f),
  );
}

/**
 * The finding's raiser: its `raised_by` when that reviewer's own recorded report on the gate carries
 * the same finding row, else the report's reviewer.
 */
export const raiserOf = (f: GateReviewFinding, report: GateReviewReport, known?: KnownActors): string =>
  f.raised_by !== undefined && recordedBy(known, f.raised_by, f, false) ? f.raised_by : report.reviewer.actor;

export interface RefutationOptions {
  /** Issue key the report is being judged on, required to match `review:endorse` `MandateStamp` scopes. */
  readonly issue?: string | undefined;
  /** When true (Mandate-active org), prose `known.humans` grants never vouch a refutation. */
  readonly mandateActive?: boolean | undefined;
}

/**
 * A `refuted` finding's refutation holds when:
 *  - a server-stamped direct-root (`id === root_id`) `review:endorse` `MandateStamp` in `known.endorsed`
 *    endorses `(f, opts.issue)` over the same finding row; OR
 *  - an endorser (`refuted_by` or an `agreed_by` actor) is neither its raiser nor the author, and is
 *    vouched for: the report's reviewer, a reviewer whose own recorded report on the gate marks the
 *    finding refuted, or (only when `opts.mandateActive !== true`) a human-grant receipt's actor.
 */
export function refutationHolds(f: GateReviewFinding, report: GateReviewReport, known?: KnownActors, opts?: RefutationOptions): boolean {
  if (hasDirectReviewEndorsement(f, opts?.issue, known)) return true;
  const raiser = raiserOf(f, report, known);
  const endorsers = [...(f.refuted_by !== undefined ? [f.refuted_by] : []), ...(f.agreed_by ?? [])];
  const allowProseHuman = opts?.mandateActive !== true;
  const vouched = (a: string): boolean => sameActor(a, report.reviewer.actor) || recordedBy(known, a, f, true) || (allowProseHuman && knownIn(known?.humans, a));
  return endorsers.some((a) => vouched(a) && !sameActor(a, raiser) && !sameActor(a, report.author.actor));
}

const isHigh = (f: GateReviewFinding): boolean => (GATE_BLOCKING_SEVERITIES as readonly string[]).includes(f.severity);

/** The blocking/major findings marked `refuted` whose refutation does not hold. */
export const unendorsedRefutations = (report: GateReviewReport, known?: KnownActors, opts?: RefutationOptions): GateReviewFinding[] =>
  report.findings.filter((f) => f.status === "refuted" && isHigh(f) && !refutationHolds(f, report, known, opts));

/** A finding that still counts against the pass: `open`, or `refuted` without an endorser. */
export const countsOpen = (f: GateReviewFinding, report: GateReviewReport, known?: KnownActors, opts?: RefutationOptions): boolean =>
  isHigh(f) && (f.status === "open" || (f.status === "refuted" && !refutationHolds(f, report, known, opts)));

/** Heading pattern for a surface vocabulary (`## <PREFIX><n> — <name>`, `## <PREFIX><n>: <name>`) or reviewer checklist (`## Class <PREFIX><n> — <name>`). */
export const CLASS_HEADING = /^##[ \t]+(?:Class[ \t]+)?([A-Z]+[0-9]+)(?:[ \t]+[—–-]|:)/;

/** The class IDs of a vocabulary or checklist, in order, duplicates kept; headings inside fenced blocks do not count. */
export function classIds(markdown: string): string[] {
  const ids: string[] = [];
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = CLASS_HEADING.exec(line);
    if (m) ids.push(m[1]!);
  }
  return ids;
}

/** The vocabulary's distinct class ids, in order, outside fenced blocks. */
export function vocabularyClasses(markdown: string): string[] {
  return [...new Set(classIds(markdown))];
}

/** The vocabulary classes `classes_checked` misses. */
export const missingClasses = (report: GateReviewReport, classes: readonly string[]): string[] => classes.filter((c) => !report.classes_checked.includes(c));

export interface SkillFile {
  /** The path relative to the skill directory, `/`-separated. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * The canonical skill-directory digest `reviewer.skill.sha256` carries: sha256 over the sorted
 * lines `<path>\0<sha256(bytes)>\n` for every tracked file of `skills/<name>/`.
 */
export function skillDigest(files: readonly SkillFile[]): string {
  const lines = files
    .map((f) => `${f.path}\0${createHash("sha256").update(f.bytes).digest("hex")}\n`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(lines.join(""), "utf8").digest("hex");
}

/** What `main` holds for a report's skill and vocabulary; `why` when a side cannot be read. */
export interface ReviewMainState {
  readonly skill: { readonly sha256: string; readonly mainSha: string } | { readonly why: string };
  readonly vocabulary: { readonly sha256: string } | { readonly why: string };
}

const short = (s: string): string => s.slice(0, 12);

/**
 * The staleness reasons, empty when the report's skill and vocabulary match `main`. A side that
 * cannot be read is a reason too: an unverifiable report never passes without a human grant.
 */
export function staleness(report: GateReviewReport, main: ReviewMainState): string[] {
  const { skill, vocabulary } = report.reviewer;
  const out: string[] = [];
  if ("why" in main.skill) out.push(`cannot verify review skill ${skill.name}@${short(skill.harness_sha)}: ${main.skill.why}`);
  else if (main.skill.sha256 !== skill.sha256.toLowerCase()) {
    out.push(`review skill ${skill.name}@${short(skill.harness_sha)} is behind main@${short(main.skill.mainSha)}`);
  }
  if ("why" in main.vocabulary) out.push(`cannot verify review vocabulary ${vocabulary.path}: ${main.vocabulary.why}`);
  else if (main.vocabulary.sha256 !== vocabulary.sha256.toLowerCase()) {
    out.push(`review vocabulary ${vocabulary.path}@${short(vocabulary.sha256)} is behind main@${short(main.vocabulary.sha256)}`);
  }
  return out;
}

export type ReviewHeadSource = "--head-sha" | "checkout HEAD";
export type ReviewDiffSource = "--diff-sha256" | "--head-sha" | "checkout HEAD";

export interface ReviewCheckContext {
  readonly requiredEffort?: GateReviewEffort | undefined;
  readonly headSha?: string | undefined;
  readonly diffSha256?: string | undefined;
  /** The issue's known actors; absent, a raiser or endorser other than the report's reviewer counts for nothing. */
  readonly known?: KnownActors | undefined;
  /** Issue key the report is being judged on, for verifying `review:endorse` `MandateStamp` scopes. */
  readonly issue?: string | undefined;
  /** When true (Mandate-active org), prose human grants cannot vouch a refutation. */
  readonly mandateActive?: boolean | undefined;
  /** The surface vocabulary's class ids at `main`; `classes_checked` must cover them. */
  readonly vocabularyClasses?: readonly string[] | undefined;
  /** Which head `headSha` came from (`--head-sha` vs `checkout HEAD`), named on `head-mismatch`. */
  readonly headSource?: ReviewHeadSource | undefined;
  /** Which diff `diffSha256` came from (`--diff-sha256`, `--head-sha` or `checkout HEAD`), named on `diff-mismatch`. */
  readonly diffSource?: ReviewDiffSource | undefined;
}

export type ReviewFailReason = "open-findings" | "self-refuted" | "not-independent" | "not-fresh" | "missing-classes" | "insufficient-effort" | "head-mismatch" | "diff-mismatch";

export type DerivedReviewPass =
  | { readonly pass: true; readonly verdict: "PASS" }
  | {
      readonly pass: false;
      readonly verdict: "BLOCKING";
      readonly status: "blocking" | "drift";
      readonly reason: ReviewFailReason;
      readonly why: string;
    };

const block = (status: "blocking" | "drift", reason: ReviewFailReason, why: string): DerivedReviewPass => ({
  pass: false,
  verdict: "BLOCKING",
  status,
  reason,
  why,
});

/**
 * Derives whether a `review-report@1` passes:
 *   1. no `open` finding at `blocking` or `major`;
 *   2. no `refuted` blocking/major finding without an endorser other than raiser and author;
 *   3. reviewer actor ≠ author actor, and `fresh_context`;
 *   4. `classes_checked` ⊇ the vocabulary's classes (when resolved);
 *   5. `effort >= requiredEffort` (when specified);
 *   6. `target.head_sha` and `target.diff_sha256` match the PR head (when resolved).
 * Skill and vocabulary staleness need git, so `gate check` judges them after this (`staleness`).
 */
export function deriveReviewPass(report: GateReviewReport, ctx: ReviewCheckContext = {}): DerivedReviewPass {
  const openHigh = report.findings.filter((f) => f.status === "open" && isHigh(f));
  if (openHigh.length > 0) {
    const list = openHigh.map((f) => `${f.id} (${f.severity} ${f.class} at ${f.file}:${f.line})`).join(", ");
    return block("blocking", "open-findings", `review-report has ${openHigh.length} open blocking/major finding(s): ${list}`);
  }
  const selfRefuted = unendorsedRefutations(report, ctx.known, { issue: ctx.issue, mandateActive: ctx.mandateActive });
  if (selfRefuted.length > 0) {
    const list = selfRefuted.map((f) => `${f.id} (${f.severity} ${f.class})`).join(", ");
    const detail =
      ctx.mandateActive === true
        ? `review-report has ${selfRefuted.length} refuted blocking/major finding(s) without a second reviewer or a direct-root review:endorse mandate stamp: ${list}`
        : `review-report has ${selfRefuted.length} refuted blocking/major finding(s) no one but the raiser or author agrees with: ${list}`;
    return block("blocking", "self-refuted", detail);
  }
  const notIndependent = independenceFailure(report);
  if (notIndependent !== null) return block("blocking", notIndependent.reason, notIndependent.why);
  if (ctx.vocabularyClasses !== undefined) {
    const missing = missingClasses(report, ctx.vocabularyClasses);
    if (missing.length > 0) {
      return block(
        "blocking",
        "missing-classes",
        `review-report classes_checked misses ${missing.length} class(es) of vocabulary ${report.reviewer.vocabulary.path}: ${missing.join(", ")}`,
      );
    }
  }
  if (ctx.requiredEffort !== undefined && !effortMeets(report.effort, ctx.requiredEffort)) {
    return block("blocking", "insufficient-effort", `review-report effort ${report.effort} is below required ${ctx.requiredEffort}`);
  }
  if (ctx.headSha !== undefined && !headMatches(report.target.head_sha, ctx.headSha)) {
    const headLabel = ctx.headSource === "--head-sha" ? "PR head (--head-sha)" : ctx.headSource === "checkout HEAD" ? "checkout HEAD" : "PR head";
    return block("drift", "head-mismatch", `review-report target.head_sha ${short(report.target.head_sha)} does not match ${headLabel} ${short(ctx.headSha)}`);
  }
  if (ctx.diffSha256 !== undefined && report.target.diff_sha256.toLowerCase() !== ctx.diffSha256.toLowerCase()) {
    const src = ctx.diffSource ?? ctx.headSource;
    const diffLabel =
      src === "--diff-sha256" ? "PR diff (--diff-sha256)" : src === "--head-sha" ? "PR diff (--head-sha)" : src === "checkout HEAD" ? "checkout HEAD diff" : "PR diff";
    if (ctx.diffSha256 === "") {
      const missingSha = ctx.headSha !== undefined && ctx.headSha !== "" ? short(ctx.headSha) : short(report.target.head_sha);
      return block("drift", "diff-mismatch", `review-report target.diff_sha256 ${short(report.target.diff_sha256)} does not match ${diffLabel} (commit ${missingSha} not in checkout)`);
    }
    return block("drift", "diff-mismatch", `review-report target.diff_sha256 ${short(report.target.diff_sha256)} does not match ${diffLabel} ${short(ctx.diffSha256)}`);
  }
  return { pass: true, verdict: "PASS" };
}
