/**
 * retry.ts — the one bounded retry of a rate-limited gateway call, shared by every verb that reaches
 * the gates client (docs/dev/GATES-CLIENT.md: the client tries each call once; a retry is the verb's).
 *
 * Only a failure carrying `retryAfterMs` (an HTTP 429, shed before the route ran) is retried, so a call
 * that reached the route is never doubled. Pass only calls that are safe to repeat: a read, or a write
 * keyed by an id the caller chose, which the gateway dedupes on.
 */

import type { Outcome } from "./failure";

export interface RetryOpts {
  /** Fallback waits (ms) per retry when the reply names no `Retry-After`; the length is the retry bound. */
  readonly delaysMs: ReadonlyArray<number>;
  /** Upper bound (ms) on any single wait before jitter. */
  readonly maxWaitMs: number;
  /** How a wait is slept (tests pass one that returns at once). */
  readonly sleep: (ms: number) => Promise<void>;
  /** A source of numbers in [0, 1) for the jitter. */
  readonly jitter: () => number;
  /** Told of each retry before it sleeps: the unjittered wait and the 1-based attempt. */
  readonly onRetry?: ((waitMs: number, attempt: number) => void) | undefined;
}

/** Largest fraction of a wait added as jitter, so callers that share one `Retry-After` do not wake together. */
const JITTER_FRACTION = 0.25;

/** Run `op`, retrying a rate-limited failure up to `delaysMs.length` times; any other failure, or the last, is returned as it is. */
export async function retryRateLimited<A>(op: () => Promise<Outcome<A>>, o: RetryOpts): Promise<Outcome<A>> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await op();
    if (res.ok || !("retryAfterMs" in res.failure) || attempt >= o.delaysMs.length) return res;
    const hinted = res.failure.retryAfterMs;
    const raw = hinted !== undefined && hinted !== null && hinted > 0 ? hinted : (o.delaysMs[attempt] ?? 0);
    const waitMs = Math.max(0, Math.min(raw, o.maxWaitMs));
    o.onRetry?.(waitMs, attempt + 1);
    if (waitMs > 0) await o.sleep(waitMs + Math.floor(waitMs * JITTER_FRACTION * Math.min(Math.max(o.jitter(), 0), 0.999999)));
  }
}
