/**
 * mandate.ts — local validation for `eris gate skip --mandate` and `ERIS_MANDATE`.
 *
 * Invariants:
 *  - This module never spends a mandate use and never calls a mandate service. The gates store
 *    spends one use atomically with the Receipt v3 stamp when `POST /v1/gates/receipts` carries
 *    `mandate_handle`.
 *  - This is the single file that reads `ERIS_MANDATE` and `flags["--mandate"]` (enforced by
 *    `mandate-handle-single-reader`).
 *  - It validates only what is known locally: handle shape (`mnd_<26-ULID>_<43-b64url>`),
 *    presenting session (`session:<id>`), and canonical `gate:skip` scope.
 *  - The validated `MandateHandle` is immediately wrapped in `effect/Redacted` and unwrapped only in
 *    `packages/gates-contract/src/client.ts` (enforced by `mandate-handle-confined`). No refusal
 *    ever echoes the handle (enforced by `mandate-handle-unprinted`).
 */

import * as Redacted from "effect/Redacted";
import { canonicalMandateScope, GATE_NAME, ISSUE_KEY, MANDATE_SESSION_RE, type MandateHandle, parseMandateHandle } from "eris/gates-contract";
import { readEnv } from "../../src/cli/plugin";
import { precondition } from "./failure";

/** The authority verb `eris gate skip --mandate` presents. */
export const MANDATE_VERB = "gate:skip";
/** The env var a session hands its handle in when it passes no `--mandate` (and no `--authorized`). */
export const MANDATE_ENV = "ERIS_MANDATE";

/** Canonical mandate scope for skipping `gate` on `issue`, or null when the target cannot form one. */
export function mandateScope(gate: string, issue: string): string | null {
  if (!GATE_NAME.test(gate) || !ISSUE_KEY.test(issue)) return null;
  return canonicalMandateScope(`sr:us:mandate:${MANDATE_VERB}?gate=${gate}&work_ref=linear:${issue}`);
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

  const parsed = parseMandateHandle(flag !== undefined ? flag : envVal!);
  if (parsed === null) {
    precondition(
      "mandate-handle-malformed",
      "the mandate handle is not a mnd_<org>_<secret> handle",
      "Pass the handle the mandate's holder gave you, unchanged, in --mandate or ERIS_MANDATE.",
    );
  }
  if (!input.actor.startsWith("session:") || input.actor.length <= "session:".length || !MANDATE_SESSION_RE.test(input.actor)) {
    precondition(
      "mandate-session-required",
      "a mandate is presented from a session, and the actor is not session:<id>",
      "Run the skip from the agent session that holds the mandate (or pass --actor session:<id>).",
    );
  }
  if (mandateScope(input.gate, input.issue) === null) {
    precondition(
      "mandate-act-unsupported",
      `gate ${input.gate} on linear:${input.issue} does not form a mandate scope`,
      "Name a kebab-case gate and an issue key (eris gate skip <gate> --issue <KEY>).",
    );
  }
  return Redacted.make(parsed);
}
