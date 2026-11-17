/**
 * failure.ts — how a gate verb stops: one thrown `GateFailure` carrying the slugged block, caught once
 * in the handler (gate.ts) and rendered with the SDK's `renderFailureBlock`. A failure the gates client
 * returns (an `Outcome`) is thrown as one too, unchanged, so its slug and exit reach the caller.
 *
 * Exit codes: 2 when the command line is wrong (`gate-usage`, a too-large evidence file), 3 when a
 * file, receipt or remote answer the verb needs is missing or does not hold.
 */

import type { ContractFailure, Outcome } from "eris/gates-contract";

/** The `docs/ERRORS.md` slugs the gate verbs raise themselves (`tests/errors-doc.test.ts`). */
export type GateSlug =
  | "gate-usage"
  | "gate-profile-unknown"
  | "gate-file-unreadable"
  | "gate-evidence-too-large"
  | "gate-artifact-uncommitted"
  | "gate-skip-unauthorized"
  | "gate-receipt-unseen"
  | "gate-check-failed"
  | "gate-burden-unreadable"
  | "gate-burden-unresolved"
  | "gate-ladder-invalid"
  | "gate-ci-event-invalid"
  | "gate-issue-missing"
  | "gate-ci-bot-surface"
  | "gate-ci-write-refused"
  | "gate-surfaces-invalid"
  | "gate-monotone-wider"
  | "gate-monotone-unresolved"
  | "gate-unlock-human"
  | "gate-unlock-unresolved"
  | "surface-lock-unauthorized"
  | "asks-listing-truncated";

export class GateFailure extends Error {
  constructor(readonly failure: ContractFailure) {
    super(failure.what);
    this.name = "GateFailure";
  }
}

/** The slugged block for `slug`, not yet thrown. */
export const block = (slug: GateSlug, what: string, fix: string, exit: 2 | 3): ContractFailure => ({ slug, what, fix, docs: `docs/ERRORS.md#${slug}`, exit });

/** Stop with `f` as it stands (a client failure, or one built here). */
export function stop(f: ContractFailure): never {
  throw new GateFailure(f);
}

/** The command line is wrong: exit 2. */
export function usage(what: string, fix: string, slug: GateSlug = "gate-usage"): never {
  return stop(block(slug, what, fix, 2));
}

/** Something the verb needs is missing or does not hold: exit 3. */
export function precondition(slug: GateSlug, what: string, fix: string): never {
  return stop(block(slug, what, fix, 3));
}

/** The value, or stop with the failure. */
export function unwrap<A>(o: Outcome<A>): A {
  if (!o.ok) return stop(o.failure);
  return o.value;
}
