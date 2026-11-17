/**
 * failure.ts — a contract read that cannot go on: the slugged failure a verb renders as its
 * `ERROR`/`slug:`/`fix:`/`docs:` block, and the exit code it ends with (2: the input's shape is
 * wrong; 3: a file or value the verb needs is missing or does not decode). Plain data, so the
 * contract carries no CLI runtime: the caller renders it.
 */

export interface ContractFailure {
  readonly slug: string;
  readonly what: string;
  readonly fix: string;
  /** Repo-relative doc path, with its `#anchor`. */
  readonly docs: string;
  readonly exit: 2 | 3;
}

/** A value, or the failure that stopped it. */
export type Outcome<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly failure: ContractFailure };

export const succeed = <A>(value: A): Outcome<A> => ({ ok: true, value });
export const fail = (failure: ContractFailure): Outcome<never> => ({ ok: false, failure });
