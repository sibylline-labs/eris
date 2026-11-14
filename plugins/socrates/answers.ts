/**
 * answers.ts — the entry-title, rubric-answer and gate-override checks
 * `eris socrates classify`, `submit` and `resolve` share.
 *
 * Invariants:
 *   - Every entry title is one line of 1–80 characters with no unbackticked
 *     autolinkable dotted token (`parseTitle` + raw line-break guard); a `prd`
 *     title also fits within 80 characters after `'PRD authored: '`.
 *   - The answers are the rubric's own enums (`answersSchema`); each override
 *     is the contract's `SocratesOverride` (a one-line reason).
 *   - An override names a reject-routed gate that fires on these answers and
 *     that the policy runs, at most once. A gate the policy turns off never
 *     fires, so there is nothing to override.
 */

import { answersSchema, type Answers, CURRENT_RUBRIC, disabledGates, ENTRY_TITLE_MAX_LENGTH, type Features, type GateId, gateFiring, parseTitle, type ScoringPolicy, type Title } from "eris/socrates-core";
import { z } from "zod";
import type { VerbContext } from "../../src/cli/plugin";
import { fail, printable } from "./client";
import { type SocratesCandidate, SocratesOverride } from "./socrates-contract.v1";

export type Rubric = typeof CURRENT_RUBRIC;
export type Override = z.infer<typeof SocratesOverride>;

export const ANSWER_FIX = "pass one --answer <question>=<answer> per rubric question; run 'eris socrates classify --help' for the answers";
export const OVERRIDE_FIX = "use --override <gate>=<one-line reason>";

export function issues(error: z.ZodError, root: string): string {
  return error.issues.map((i) => `${[root, ...i.path].join(".")}: ${i.message}`).join("; ");
}

/** `<key>=<value>` pairs into a record; a pair without `=`, or a repeated key, is refused. */
export function pairs(ctx: VerbContext, flag: string, words: readonly string[], slug: "socrates-answers-invalid" | "socrates-override-invalid", fix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const w of words) {
    const at = w.indexOf("=");
    if (at <= 0) fail(ctx, slug, `${flag} ${printable(w)} is not <key>=<value>`, fix);
    const key = w.slice(0, at);
    if (Object.hasOwn(out, key)) fail(ctx, slug, `${flag} names ${printable(key)} twice`, fix);
    out[key] = w.slice(at + 1);
  }
  return out;
}

export function answersOf(ctx: VerbContext, rubric: Rubric, raw: unknown): Answers<Rubric> {
  const parsed = answersSchema(rubric).safeParse(raw);
  if (parsed.success) return parsed.data;
  const expected = Object.entries(rubric.questions)
    .map(([id, q]) => `${id}=${q.answers.join("|")}`)
    .join("\n");
  fail(ctx, "socrates-answers-invalid", `the answers do not fit ${rubric.version} (${printable(issues(parsed.error, "answers"))})`, `answer every question with one of its answers:\n${expected}`);
}

/** Each override is a one-line reason on a reject-routed gate the policy runs and that fires here, once. */
export function overridesOf(ctx: VerbContext, rubric: Rubric, policy: ScoringPolicy, raw: unknown, answers: Answers<Rubric>, features: Features<Rubric>): Override[] {
  const fix = "override only the gate a rejection named, as --override <gate>=<one-line reason>";
  const parsed = z.array(SocratesOverride).safeParse(raw);
  if (!parsed.success) fail(ctx, "socrates-override-invalid", `the override is not a gate with a one-line reason (${printable(issues(parsed.error, "overrides"))})`, fix);
  const off = new Set(disabledGates(rubric, policy));
  const seen = new Set<string>();
  for (const { gate } of parsed.data) {
    const q = (rubric.questions as Readonly<Record<string, { kind: string; route?: string }>>)[gate];
    if (q === undefined || q.kind !== "gate") fail(ctx, "socrates-override-invalid", `${gate} is not a gate of ${rubric.version}`, fix);
    if (q.route !== "reject") fail(ctx, "socrates-override-invalid", `${gate} routes the candidate (${q.route}) rather than rejecting it, so it cannot be overridden`, "answer the gate as it is; a reroute is not a rejection");
    if (seen.has(gate)) fail(ctx, "socrates-override-invalid", `${gate} is overridden twice`, fix);
    if (off.has(gate)) fail(ctx, "socrates-override-invalid", `${gate} is turned off by the policy, so there is nothing to override`, fix);
    if (gateFiring(rubric, gate as GateId<Rubric>, answers, features, [...off] as GateId<Rubric>[]) === undefined) fail(ctx, "socrates-override-invalid", `${gate} does not reject these answers, so there is nothing to override`, fix);
    seen.add(gate);
  }
  return parsed.data;
}

const LINE_BREAK = /[\r\n\u2028\u2029]/;
const PRD_PREFIX = "PRD authored: ";
export const PRD_TITLE_MAX_LENGTH = ENTRY_TITLE_MAX_LENGTH - PRD_PREFIX.length;

/** Validate an entry title against the living-doc / review-issue rule (`parseTitle` + raw line breaks). */
export function checkEntryTitle(ctx: VerbContext, raw: string, slug: "socrates-candidate-invalid" | "socrates-amend-invalid", prefix = ""): Title {
  if (LINE_BREAK.test(raw)) {
    fail(ctx, slug, `${prefix}entry title must be a single line of at most ${ENTRY_TITLE_MAX_LENGTH} characters`, `pass a single-line title of <= ${ENTRY_TITLE_MAX_LENGTH} characters`);
  }
  const parsed = parseTitle(raw);
  if (parsed.ok) return parsed.title;
  const reason = parsed.refusal.kind === "bad-title" ? parsed.refusal.reason : "too-long";
  if (reason === "multi-line") {
    fail(ctx, slug, `${prefix}entry title must be a single line of at most ${ENTRY_TITLE_MAX_LENGTH} characters`, `pass a single-line title of <= ${ENTRY_TITLE_MAX_LENGTH} characters`);
  }
  if (reason === "autolinkable") {
    fail(
      ctx,
      slug,
      `${prefix}entry title (max ${ENTRY_TITLE_MAX_LENGTH} characters) contains an unbackticked dotted token Linear autolinks`,
      "wrap file names, domains and dotted identifiers in backticks",
    );
  }
  if (reason === "too-long") {
    fail(
      ctx,
      slug,
      `${prefix}entry title must be at most ${ENTRY_TITLE_MAX_LENGTH} characters (got ${raw.trim().length})`,
      `shorten the title to <= ${ENTRY_TITLE_MAX_LENGTH} characters`,
    );
  }
  fail(ctx, slug, `${prefix}entry title must be a non-empty single line of at most ${ENTRY_TITLE_MAX_LENGTH} characters`, `pass a non-empty single-line title of <= ${ENTRY_TITLE_MAX_LENGTH} characters`);
}

/** A decision or practice statement renders as one line of its living-doc entry, so a line break would file a review issue that later refuses at resolve time. */
export function checkEntryStatement(ctx: VerbContext, raw: string, slug: "socrates-candidate-invalid" | "socrates-amend-invalid", prefix = ""): void {
  if (LINE_BREAK.test(raw)) {
    fail(ctx, slug, `${prefix}statement must be a single line`, "put the statement on one line of at most 4000 characters");
  }
}

/** Refuse a multi-line `decision` or `practice` statement; `prd` and `conflict` statements parse their own multi-line grammars. */
export function checkCandidateStatement(ctx: VerbContext, candidate: Pick<SocratesCandidate, "kind" | "statement">): void {
  if (candidate.kind === "decision" || candidate.kind === "practice") {
    checkEntryStatement(ctx, candidate.statement, "socrates-candidate-invalid", `${candidate.kind} `);
  }
}

/** Validate a candidate's entry title (and `'PRD authored: <title>' <= 80` for `--kind prd`) before scoring or sending. */
export function checkCandidateTitle<T extends Pick<SocratesCandidate, "kind" | "title">>(ctx: VerbContext, candidate: T): T & { readonly title: Title } {
  const title = checkEntryTitle(ctx, candidate.title, "socrates-candidate-invalid");
  if (candidate.kind === "prd" && !parseTitle(`${PRD_PREFIX}${title}`).ok) {
    fail(
      ctx,
      "socrates-candidate-invalid",
      `PRD entry title '${PRD_PREFIX}<title>' must be at most ${ENTRY_TITLE_MAX_LENGTH} characters (got ${PRD_PREFIX.length + title.length})`,
      `shorten --title to <= ${PRD_TITLE_MAX_LENGTH} characters so '${PRD_PREFIX}<title>' fits in ${ENTRY_TITLE_MAX_LENGTH} characters`,
    );
  }
  return { ...candidate, title };
}
