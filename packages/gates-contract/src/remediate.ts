/**
 * remediate.ts — pure remediation-loop state machine: round partitioning, actor independence, span
 * calculation, and `@remediate` row grading over `ListedReceipt[]`. Zero git or CLI runtime dependency.
 */

import * as Schema from "effect/Schema";
import type { ListedReceipt } from "./client";
import { decodeResult } from "./decode";
import { isHumanGrant } from "./grants";
import { decodePayload, type GateReceipt } from "./receipt";

export const REMEDIATE_GATE = "remediate";
/** The name of the inline text evidence item a launch receipt carries its round in. */
export const ROUND_EVIDENCE = "remediate-round";

const Text = Schema.String.check(Schema.isPattern(/\S/));

/** The `review-report@1` fields remediation reads structurally. */
export const ReviewReportLike = Schema.Struct({
  target: Schema.Struct({ head_sha: Text }),
  reviewer: Schema.Struct({ actor: Text }),
  author: Schema.Struct({ actor: Text }),
  findings: Schema.Array(Schema.Struct({ id: Text, severity: Text, class: Text, file: Text, line: Schema.Number, status: Text })),
});
export type ReviewReportLike = typeof ReviewReportLike.Type;
export type Finding = ReviewReportLike["findings"][number];

/** What a launch receipt records about its round, as JSON in its `remediate-round` text evidence. */
export const RoundRecord = Schema.Struct({
  round: Schema.Number,
  max_rounds: Schema.Number,
  loop: Text,
  runtime: Text,
  session: Text,
  head: Text,
  findings: Schema.Array(Text),
  report: Text,
});
export type RoundRecord = typeof RoundRecord.Type;

/** One review report and the receipt comment that carries it. */
export interface DatedReport {
  readonly report: ReviewReportLike;
  readonly comment: string;
  readonly at: string;
}

export interface Round {
  /** 0 for the reviews before the first launch. */
  readonly n: number;
  /** The launch that opened this round (absent for round 0). */
  readonly launch?: { readonly record: RoundRecord; readonly comment: string; readonly at: string } | undefined;
  readonly reports: readonly DatedReport[];
}

export interface RemediationState {
  readonly rounds: readonly Round[];
  /** The first `max_rounds` hand-off (a `remediate` BLOCKING), and the human-granted PASS that cleared it, if any. */
  readonly handOff?: { readonly comment: string; readonly cleared?: string | undefined } | undefined;
  /** Whether any `remediate` receipt exists (a launch, hand-off or clear). */
  readonly any: boolean;
}

/** The review reports a record's evidence carries, read structurally (works on any receipt version). */
export function reportsOf(payload: unknown): ReviewReportLike[] {
  const evidence = (payload as { evidence?: unknown } | null)?.evidence;
  if (!Array.isArray(evidence)) return [];
  const out: ReviewReportLike[] = [];
  for (const e of evidence) {
    if ((e as { kind?: unknown } | null)?.kind !== "review-report") continue;
    const decoded = decodeResult(ReviewReportLike, (e as { report?: unknown }).report);
    if (decoded._tag === "Success") out.push(decoded.success);
  }
  return out;
}

/** A launch receipt's round, or undefined when the receipt is not a launch. */
export function roundOf(receipt: GateReceipt): RoundRecord | undefined {
  if (receipt.gate !== REMEDIATE_GATE || receipt.verdict !== "AMENDED") return undefined;
  for (const e of receipt.evidence) {
    // Only eris writes a named `text` item; a `--log` file of that name is not a round.
    if (e.kind !== "text" || !("content" in e) || e.name !== ROUND_EVIDENCE) continue;
    try {
      const decoded = decodeResult(RoundRecord, JSON.parse(e.content));
      if (decoded._tag === "Success") return decoded.success;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** A `remediate` PASS carrying a human (non-doctrine, non-repo) `--authorized` grant: the only hand-off clear. */
function humanGrant(r: GateReceipt): boolean {
  return r.verdict === "PASS" && isHumanGrant(r.authorized);
}

/** Partitions an issue's receipt records (any order) into rounds, oldest first. */
export function stateOf(issue: string, records: ReadonlyArray<ListedReceipt>): RemediationState {
  const sorted = [...records].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const rounds: { n: number; launch?: Round["launch"]; reports: DatedReport[] }[] = [{ n: 0, reports: [] }];
  let handOff: { comment: string; cleared?: string } | undefined;
  let any = false;
  for (const c of sorted) {
    const parsed = decodePayload(c.version, c.payload);
    const receipt = parsed.kind === "receipt" ? parsed.receipt : undefined;
    if (receipt !== undefined && receipt.issue !== issue) continue;
    if (receipt?.gate === REMEDIATE_GATE) {
      any = true;
      const record = roundOf(receipt);
      // A launch never clears a hand-off, and only a human-granted PASS does.
      if (record !== undefined) rounds.push({ n: rounds.length, launch: { record, comment: c.id, at: c.createdAt }, reports: [] });
      else if (receipt.verdict === "BLOCKING" && handOff === undefined) handOff = { comment: c.id };
      else if (handOff !== undefined && handOff.cleared === undefined && humanGrant(receipt)) handOff.cleared = c.id;
      continue;
    }
    if ((c.payload as { issue?: unknown } | null)?.issue !== issue) continue;
    for (const report of reportsOf(c.payload)) rounds[rounds.length - 1]!.reports.push({ report, comment: c.id, at: c.createdAt });
  }
  return { rounds, handOff, any };
}

export function latestReport(state: RemediationState): DatedReport | undefined {
  for (let i = state.rounds.length - 1; i >= 0; i--) {
    const reports = state.rounds[i]!.reports;
    if (reports.length > 0) return reports[reports.length - 1];
  }
  return undefined;
}

/** A hand-off stands until a later human-granted `remediate` PASS clears it. */
export function handOffStands(state: RemediationState): boolean {
  return state.handOff !== undefined && state.handOff.cleared === undefined;
}

/** Whether round `r`'s launch has been answered by a fresh report on a head other than its launch head. */
function answered(r: Round): boolean {
  return r.launch === undefined || r.reports.some((d) => d.report.target.head_sha !== r.launch!.record.head);
}

/**
 * Separation and freshness across rounds: each violation as one line. Round k >= 1's reviewer is
 * none of the authors of rounds 0..k (the remediators and the original author) and none of the
 * earlier reviewers; its author is not round 0's author (the remediator is a different actor); and
 * its report is bound to a head other than the round's launch head.
 */
export function independence(state: RemediationState): string[] {
  const out: string[] = [];
  const authors = new Map<string, number>();
  const reviewers = new Map<string, number>();
  const originals = new Set(state.rounds[0]!.reports.map((d) => d.report.author.actor));
  for (const d of state.rounds[0]!.reports) {
    authors.set(d.report.author.actor, 0);
    reviewers.set(d.report.reviewer.actor, 0);
  }
  for (const r of state.rounds.slice(1)) {
    for (const d of r.reports) if (!authors.has(d.report.author.actor)) authors.set(d.report.author.actor, r.n);
    for (const d of r.reports) {
      const { reviewer, author, target } = d.report;
      if (originals.has(author.actor)) out.push(`round ${r.n}: the remediator ${author.actor} is the original author`);
      const authored = authors.get(reviewer.actor);
      if (authored !== undefined) out.push(`round ${r.n}: reviewer ${reviewer.actor} authored round ${authored}`);
      const reviewed = reviewers.get(reviewer.actor);
      if (reviewed !== undefined && reviewed < r.n) out.push(`round ${r.n}: reviewer ${reviewer.actor} already reviewed round ${reviewed}`);
      if (target.head_sha === r.launch!.record.head) out.push(`round ${r.n}: report ${d.comment} is bound to the launch head ${target.head_sha.slice(0, 12)}, not a fresh head`);
    }
    for (const d of r.reports) if (!reviewers.has(d.report.reviewer.actor)) reviewers.set(d.report.reviewer.actor, r.n);
  }
  return [...new Set(out)];
}

/** The base and head of the remediation diff: round 1's launch head and the latest report's head. */
export function remediationSpan(state: RemediationState): { readonly base: string; readonly head: string } | undefined {
  const first = state.rounds[1]?.launch;
  const latest = latestReport(state);
  if (first === undefined || latest === undefined || state.rounds.length < 2) return undefined;
  const lastRound = state.rounds[state.rounds.length - 1]!;
  if (lastRound.reports.length === 0 && state.rounds.slice(1).every((r) => r.reports.length === 0)) return undefined;
  return { base: first.record.head, head: latest.report.target.head_sha };
}

/** The surface bar a remediation diff is held to: `wider` names each path that widens a surface or edits a review skill. */
export interface SurfaceBar {
  readonly wider: (span: { readonly base: string; readonly head: string }) => Promise<readonly string[]>;
}

/** A path the conservative bar reads as wider: the surface registry, or a review skill's files. */
export const WIDER_PATH = /(^|\/)\.claude\/surfaces\.yml$|(^|\/)skills\/[^/]*review[^/]*\//;

export interface RemediateRow {
  readonly status: "ok" | "pending" | "violated" | "hand-off";
  readonly round: string;
  readonly why: readonly string[];
}

/** The `@remediate` row `gate check` prints, or undefined when the issue has no `remediate` receipt. */
export async function remediateRow(state: RemediationState, bar: SurfaceBar): Promise<RemediateRow | undefined> {
  if (!state.any) return undefined;
  const launches = state.rounds.slice(1);
  const max = launches[launches.length - 1]?.launch?.record.max_rounds;
  const round = `round ${launches.length}/${max ?? "-"}`;
  if (handOffStands(state)) return { status: "hand-off", round, why: [`max_rounds reached; a human signs off (${state.handOff!.comment})`] };
  const why = independence(state);
  const span = remediationSpan(state);
  if (span !== undefined) for (const p of await bar.wider(span)) why.push(`the remediation diff widens a surface: ${p} (a human signs it)`);
  if (why.length > 0) return { status: "violated", round, why };
  const last = state.rounds[state.rounds.length - 1]!;
  return { status: answered(last) ? "ok" : "pending", round, why: [] };
}
