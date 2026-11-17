/**
 * store.ts — how the gate verbs reach the gates store: the gates client's endpoint on the `eris login`
 * bearer of the org this directory acts as, and the one bounded retry of a rate-limited call.
 *
 * The client tries each call once and returns a 429 as a failure carrying `retryAfterMs`. Only calls
 * that are safe to repeat come through `retryRateLimited`: a receipt listing, and a receipt write keyed
 * by a comment id the caller chose, which the gateway dedupes on. An asset upload is never retried
 * (the store keeps every upload as a new asset).
 */

import { type GatesEndpoint, gatesEndpoint, type Outcome } from "eris/gates-contract";
import { resolveOrgBearer } from "../../src/cli/plugin";
import { stop, unwrap } from "./failure";

/** The slugs the bearer resolver names that keep their own heading; every other miss is a login to run. */
const RESOLVER_SLUGS = new Set(["yak-url-unresolved", "org-not-signed-in", "org-selector-invalid", "org-token-mismatch"]);

export interface StoreOptions {
  readonly home: string;
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly policySha?: string | undefined;
  readonly onStale?: ((liveSha: string | null) => void) | undefined;
}

/** The gates endpoint on the directory's `eris login` bearer; no login stops with `eris-login-required`. */
export async function storeEndpoint(o: StoreOptions): Promise<GatesEndpoint> {
  const bearer = await resolveOrgBearer({ home: o.home, env: o.env, cwd: o.cwd });
  if ("reason" in bearer) {
    const slug = RESOLVER_SLUGS.has(bearer.slug) ? bearer.slug : "eris-login-required";
    const fix = slug === "eris-login-required" ? "Run 'eris login' once on this machine (or set ERIS_YAKS_TOKEN to a sib_ service token), then re-run." : bearer.fix;
    return stop({ slug, what: bearer.reason, fix, docs: `docs/ERRORS.md#${slug}`, exit: 3 });
  }
  return unwrap(gatesEndpoint(bearer.value.url, bearer.value.token, { fetch: o.fetch, policySha: o.policySha, onStale: o.onStale }));
}

// lift-candidate: retry-after — bounded, jittered retry of a 429 on an idempotent call, waiting the reply's Retry-After

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

/** Largest fraction of a wait added as jitter, so loops that share one `Retry-After` do not wake together. */
const JITTER_FRACTION = 0.25;

/** Run `op`, retrying a rate-limited failure up to `delaysMs.length` times; any other failure, or the last, stops the verb. */
export async function retryRateLimited<A>(op: () => Promise<Outcome<A>>, o: RetryOpts): Promise<A> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await op();
    if (res.ok) return res.value;
    const hinted = res.failure.retryAfterMs;
    if (!("retryAfterMs" in res.failure) || attempt >= o.delaysMs.length) return stop(res.failure);
    const raw = hinted !== undefined && hinted !== null && hinted > 0 ? hinted : (o.delaysMs[attempt] ?? 0);
    const waitMs = Math.max(0, Math.min(raw, o.maxWaitMs));
    o.onRetry?.(waitMs, attempt + 1);
    if (waitMs > 0) await o.sleep(waitMs + Math.floor(waitMs * JITTER_FRACTION * Math.min(Math.max(o.jitter(), 0), 0.999999)));
  }
}
