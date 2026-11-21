/**
 * mandate.ts — local validation for `eris gate skip --mandate`, `eris gate record --review-report --mandate`,
 * and `ERIS_MANDATE`.
 *
 * Invariants:
 *  - This module never spends a mandate use and never calls a mandate service. The gates store
 *    spends one use atomically with the Receipt v3 stamp when `POST /v1/gates/receipts` carries
 *    `mandate_handle`.
 *  - This is the single file that reads `ERIS_MANDATE` and `flags["--mandate"]` (enforced by
 *    `mandate-handle-single-reader`).
 *  - It validates only what is known locally: handle shape (`mnd_<26-ULID>_<43-b64url>`),
 *    presenting session (`session:<id>`), and canonical `gate:skip` or `review:endorse` scope.
 *  - The validated `MandateHandle` is immediately wrapped in `effect/Redacted` and unwrapped only in
 *    `packages/gates-contract/src/client.ts` (enforced by `mandate-handle-confined`). No refusal
 *    ever echoes the handle (enforced by `mandate-handle-unprinted`).
 */

import * as Redacted from "effect/Redacted";
import {
  canonicalMandateScope,
  extractReviewEndorseFinding,
  GATE_NAME,
  type GateReviewFinding,
  type GateReviewReport,
  type GateVerdict,
  ISSUE_KEY,
  MANDATE_SESSION_RE,
  type MandateHandle,
  parseMandateHandle,
  REVIEW_ENDORSE_VERB,
  sameActor,
} from "eris/gates-contract";
import { readEnv } from "../../src/cli/plugin";
import { precondition } from "./failure";

/** The authority verb `eris gate skip --mandate` presents. */
export const MANDATE_VERB = "gate:skip";
/** The authority verb `eris gate record --review-report --mandate` presents. */
export const MANDATE_RECORD_VERB = REVIEW_ENDORSE_VERB;
/** The env var a session hands its handle in when it passes no `--mandate` (and no `--authorized`). */
export const MANDATE_ENV = "ERIS_MANDATE";

/** Canonical mandate scope for skipping `gate` on `issue`, or null when the target cannot form one. */
export function mandateScope(gate: string, issue: string): string | null {
  if (!GATE_NAME.test(gate) || !ISSUE_KEY.test(issue)) return null;
  return canonicalMandateScope(`sr:us:mandate:${MANDATE_VERB}?gate=${gate}&work_ref=linear:${issue}`);
}

function parseValidatedHandle(raw: string): MandateHandle {
  const parsed = parseMandateHandle(raw);
  if (parsed === null) {
    precondition(
      "mandate-handle-malformed",
      "the mandate handle is not a mnd_<org>_<secret> handle",
      "Pass the handle the mandate's holder gave you, unchanged, in --mandate or ERIS_MANDATE.",
    );
  }
  return parsed;
}

function requireSessionActor(actor: string, actLabel: string): void {
  if (!actor.startsWith("session:") || actor.length <= "session:".length || !MANDATE_SESSION_RE.test(actor)) {
    precondition(
      "mandate-session-required",
      "a mandate is presented from a session, and the actor is not session:<id>",
      `Run the ${actLabel} from the agent session that holds the mandate (or pass --actor session:<id>).`,
    );
  }
}

export interface MandateSkipInput {
  readonly flags: { readonly "--mandate"?: string | undefined; readonly "--authorized"?: string | undefined };
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly gate: string;
  readonly issue: string;
  readonly actor: string;
}

/**
 * Resolve and locally validate the mandate handle for `eris gate skip`, returning a redacted
 * `MandateHandle` when mandate mode applies or `undefined` otherwise.
 *
 * Precedence:
 *  - Explicit `--mandate` always enters mandate mode (even when empty, which fails closed with
 *    `mandate-handle-malformed`, and even beside `--authorized`, which becomes non-authoritative context).
 *  - `ERIS_MANDATE` enters mandate mode only when `--authorized` is absent and the env value is
 *    non-blank (an empty/whitespace `ERIS_MANDATE` is treated as unset).
 */
export function resolveMandateSkip(input: MandateSkipInput): Redacted.Redacted<MandateHandle> | undefined {
  const flag = input.flags["--mandate"];
  const envRaw = input.flags["--authorized"] === undefined ? readEnv(input.env, MANDATE_ENV) : undefined;
  const envVal = envRaw !== undefined && envRaw.trim() !== "" ? envRaw : undefined;
  if (flag === undefined && envVal === undefined) return undefined;

  const parsed = parseValidatedHandle(flag !== undefined ? flag : envVal!);
  requireSessionActor(input.actor, "skip");
  if (mandateScope(input.gate, input.issue) === null) {
    precondition(
      "mandate-act-unsupported",
      `gate ${input.gate} on linear:${input.issue} does not form a mandate scope`,
      "Name a kebab-case gate and an issue key (eris gate skip <gate> --issue <KEY>).",
    );
  }
  return Redacted.make(parsed);
}

export interface MandateRecordInput {
  readonly flags: { readonly "--mandate"?: string | undefined; readonly "--authorized"?: string | undefined };
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly issue: string;
  readonly actor: string;
  readonly verdict?: GateVerdict | undefined;
  readonly hasReports: boolean;
  /** Lazily reads and parses the `--review-report` files once, only when mandate resolution needs them. */
  readonly readReports: () => ReadonlyArray<GateReviewReport>;
}

export interface MandateRecordResolution {
  readonly mode: "explicit" | "env";
  readonly mandate: Redacted.Redacted<MandateHandle>;
  readonly finding: GateReviewFinding;
  readonly findingId: string;
  readonly scope: string;
}

/**
 * Resolve and locally validate the mandate handle for `eris gate record --review-report`, returning
 * a redacted `MandateHandle` plus the extracted `(finding, scope)` when `review:endorse` applies,
 * or `undefined` otherwise.
 *
 * Precedence:
 *  - Explicit `--mandate` always enters mandate mode (validating handle shape and session before
 *    reading reports, then requiring non-BLOCKING verdict and a single refuted blocking/major
 *    finding with 0 open blocking/major findings; `--authorized` beside it is context only).
 *  - `ERIS_MANDATE` enters mandate mode only when `--authorized` is absent, `--review-report` is
 *    given, verdict is not `BLOCKING`, and `extractReviewEndorseFinding` finds one refuted
 *    blocking/major finding (never hijacking non-report or clean-report `gate record` calls).
 */
function reportEndorsable(reports: ReadonlyArray<GateReviewReport>, actor: string): string | null {
  for (const r of reports) {
    if (!sameActor(r.reviewer.actor, actor)) {
      return `review-report reviewer ${r.reviewer.actor} does not match recording actor ${actor}`;
    }
    if (sameActor(r.reviewer.actor, r.author.actor)) {
      return `review-report reviewer ${r.reviewer.actor} is not independent of author ${r.author.actor}`;
    }
    if (!r.reviewer.fresh_context) {
      return "review-report reviewer did not run in a fresh context";
    }
  }
  return null;
}

export function resolveMandateRecord(input: MandateRecordInput): MandateRecordResolution | undefined {
  const flag = input.flags["--mandate"];
  if (flag !== undefined) {
    const parsed = parseValidatedHandle(flag);
    requireSessionActor(input.actor, "record");
    if (input.verdict === "BLOCKING") {
      precondition(
        "mandate-act-unsupported",
        "review:endorse requires a PASS or AMENDED verdict, not BLOCKING",
        "Resolve open findings and record PASS/AMENDED (or omit --verdict to derive it) with --review-report.",
      );
    }
    if (!input.hasReports) {
      precondition(
        "mandate-act-unsupported",
        "review:endorse requires --review-report with one refuted blocking or major finding",
        "Pass --review-report <path> carrying one refuted blocking or major finding, or use 'eris gate skip --mandate' for a gate skip.",
      );
    }
    const reports = input.readReports();
    const extracted = extractReviewEndorseFinding(reports, input.issue);
    if (!extracted.ok) {
      precondition(
        "mandate-act-unsupported",
        extracted.detail,
        "Pass a review-report@1 with 0 open blocking/major findings and exactly 1 refuted blocking/major finding.",
      );
    }
    const badReport = reportEndorsable(reports, input.actor);
    if (badReport !== null) {
      precondition(
        "mandate-act-unsupported",
        `review:endorse requires a passing review-report: ${badReport}`,
        "Record as the independent fresh-context reviewer session that produced the report, or record without --mandate.",
      );
    }
    return { mode: "explicit", mandate: Redacted.make(parsed), finding: extracted.finding, findingId: extracted.findingId, scope: extracted.scope };
  }

  if (input.flags["--authorized"] !== undefined || !input.hasReports || input.verdict === "BLOCKING") return undefined;
  const envRaw = readEnv(input.env, MANDATE_ENV);
  const envVal = envRaw !== undefined && envRaw.trim() !== "" ? envRaw : undefined;
  if (envVal === undefined) return undefined;

  const reports = input.readReports();
  const extracted = extractReviewEndorseFinding(reports, input.issue);
  if (!extracted.ok) return undefined;
  if (reportEndorsable(reports, input.actor) !== null) return undefined;

  const parsed = parseValidatedHandle(envVal);
  requireSessionActor(input.actor, "record");
  return { mode: "env", mandate: Redacted.make(parsed), finding: extracted.finding, findingId: extracted.findingId, scope: extracted.scope };
}
