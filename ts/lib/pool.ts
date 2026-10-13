/**
 * pool.ts — env-driven concurrency/deadline resolution, and the in-process
 * bounded-concurrency runner.
 *
 * `ERIS_BATCH_CONCURRENCY` caps how many tasks run at once and
 * `ERIS_BATCH_TIMEOUT` (seconds) bounds each one. An unset, non-numeric, zero
 * or negative value CLAMPS to the default rather than disabling the bound:
 * a typo in an env var must never turn a large batch into an unbounded
 * fan-out.
 */

/** Digits only — no sign, no decimal point. An empty, non-numeric, zero or
 *  negative value clamps to 8 rather than disabling the cap. */
export function resolveConcurrency(raw: string | undefined): number {
  if (raw !== undefined && /^[0-9]+$/.test(raw)) {
    const n = Number(raw);
    if (n > 0) return n;
  }
  return 8;
}

/** Same integer-seconds grammar, converted to milliseconds for `AbortSignal`.
 *  Defaults to 60 seconds. Invalid
 *  input clamps to the default rather than producing NaN (which would mean
 *  "no deadline at all" — the opposite of the safety property a timeout
 *  exists to provide). */
export function resolveDeadlineMs(raw: string | undefined): number {
  if (raw !== undefined && /^[0-9]+$/.test(raw)) {
    const n = Number(raw);
    if (n > 0) return n * 1000;
  }
  return 60_000;
}

/**
 * Run `worker` over every item in `items`, at most `concurrency` in flight
 * at once, preserving input order in the returned array regardless of
 * completion order. A thrown worker error propagates (rejects the whole
 * pool) rather than being swallowed — callers that want per-item
 * ok/error/absent results encode that in R itself, so a THROW here always
 * means a programming error, not a classified task failure.
 */
export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;

  let next = 0;
  async function runner(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i] as T, i);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runner()));
  return results;
}
