/**
 * failure.ts — how a loop verb stops: one thrown `LoopFailure` carrying the slugged block, caught once
 * in the handler (handlers.ts) and rendered with the SDK's `renderFailureBlock`. A failure the gates
 * client returns (an `Outcome`) is thrown as one too, unchanged, so its slug and exit reach the caller.
 *
 * Exit codes: 1 the runtime failed to start or stop, or a hand-back reached no target; 2 an operand was
 * refused before anything was claimed or spawned; 3 a precondition (not signed in, the issue claimed
 * by another loop, the org's policy tree edited, the ledger unwritable).
 */

import type { ContractFailure, Outcome } from "eris/gates-contract";

/** The `docs/ERRORS.md` slugs the loop verbs raise themselves (`tests/errors-doc.test.ts`). */
export type LoopSlug =
  | "loop-usage"
  | "loop-unknown"
  | "loop-launch-failed"
  | "loop-hand-back-failed"
  | "loop-session-not-found"
  | "loop-session-ambiguous"
  | "loop-claim-ledger-unwritable"
  | "loop-secret-detected";

/** A slugged failure with the loop's wider exit range (the client's are 2 or 3). */
export interface LoopBlock extends Omit<ContractFailure, "exit"> {
  readonly exit: 1 | 2 | 3;
}

export class LoopFailure extends Error {
  constructor(readonly failure: LoopBlock) {
    super(failure.what);
    this.name = "LoopFailure";
  }
}

export const block = (slug: LoopSlug, what: string, fix: string, exit: 1 | 2 | 3): LoopBlock => ({ slug, what, fix, docs: `docs/ERRORS.md#${slug}`, exit });

/** Stop with `f` as it stands (a client failure, or one built here). */
export function stop(f: LoopBlock): never {
  throw new LoopFailure(f);
}

/** An operand was refused (exit 2): nothing was claimed or spawned. */
export function usage(what: string, fix = "Correct the operand and re-run; 'eris loop --help' lists them."): never {
  return stop(block("loop-usage", what, fix, 2));
}

/** The runtime failed to start or stop (exit 1). */
export function launchFailed(what: string): never {
  return stop(block("loop-launch-failed", what, "Fix what the detail names (the claude CLI, its background daemon, the working directory), then re-run.", 1));
}

/** The value, or stop with the failure. */
export function unwrap<A>(o: Outcome<A>): A {
  if (!o.ok) return stop(o.failure);
  return o.value;
}
