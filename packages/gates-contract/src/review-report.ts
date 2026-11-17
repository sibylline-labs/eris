/**
 * review-report.ts — the `review-report@1` evidence a gate receipt may carry: the machine-readable
 * frontmatter of a code review, its prose body, and the sha256 the receipt holds for the pair.
 *
 * This package decodes such evidence so a receipt carrying it reads as a receipt (never as an
 * undecodable record), and re-checks its digest. It does not judge a report: deriving pass from its
 * findings needs a distribution's registered review skills, so public `eris gate check` reads a
 * receipt with review-report evidence as `blocking` and says why.
 *
 * Invariants:
 *  - A report never declares its own verdict: a `verdict` key, whatever its value, fails decode.
 *  - The digest is sha256 over the canonical document `formatReviewReport` writes (YAML frontmatter
 *    with `schema` first, then the trimmed body), so any build that recorded the report reproduces it.
 */

import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import { stringify as stringifyYaml } from "yaml";

export const GATE_REVIEW_REPORT_SCHEMA = "review-report@1";
/** The evidence `kind` a review report rides under. */
export const GATE_REVIEW_REPORT_KIND = "review-report";

export const GATE_REVIEW_EFFORTS = ["low", "medium", "high", "max"] as const;
export const GATE_FINDING_SEVERITIES = ["blocking", "major", "minor", "nit"] as const;
export const GATE_FINDING_STATUSES = ["open", "fixed", "refuted"] as const;

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

const ReviewFinding = Schema.Struct({
  id: NonEmptyText,
  severity: Schema.Literals(GATE_FINDING_SEVERITIES),
  class: NonEmptyText,
  file: NonEmptyText,
  line: PositiveInt,
  status: Schema.Literals(GATE_FINDING_STATUSES),
  evidence: NonEmptyText,
  /** Who raised the finding; absent means `reviewer.actor`. */
  raised_by: Schema.optionalKey(ReportActor),
  /** Who refuted it. */
  refuted_by: Schema.optionalKey(ReportActor),
  /** Who agreed with the refutation. */
  agreed_by: Schema.optionalKey(Schema.Array(ReportActor)),
});

const ForbiddenVerdict = Schema.Never.annotate({ expected: "no verdict field (review-report@1 derives pass in eris gate check)" });

export const GateReviewReportV1 = Schema.Struct({
  schema: Schema.optionalKey(Schema.Literal(GATE_REVIEW_REPORT_SCHEMA)),
  target: ReviewTarget,
  surface: NonEmptyText,
  effort: Schema.Literals(GATE_REVIEW_EFFORTS),
  reviewer: Schema.Struct({
    actor: ReportActor,
    model: NonEmptyText,
    fresh_context: Schema.Boolean,
    skill: ReviewSkillRef,
    vocabulary: ReviewVocabularyRef,
  }),
  author: Schema.Struct({ actor: ReportActor }),
  classes_checked: Schema.Array(NonEmptyText),
  findings: Schema.Array(ReviewFinding),
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
