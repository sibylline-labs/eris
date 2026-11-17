/**
 * store.ts — how the gate verbs reach the gates store: the gates client's endpoint on the `eris login`
 * bearer of the org this directory acts as.
 *
 * The client tries each call once and returns a 429 as a failure carrying `retryAfterMs`. Only calls
 * that are safe to repeat go through the client's `retryRateLimited` (eris/gates-contract): a receipt
 * listing, and a receipt write keyed by a comment id the caller chose, which the gateway dedupes on. An
 * asset upload is never retried (the store keeps every upload as a new asset).
 */

import { type GatesEndpoint, gatesEndpoint } from "eris/gates-contract";
import { RESOLVER_OWN_HEADING_SLUGS, resolveOrgBearer } from "../../src/cli/plugin";
import { stop, unwrap } from "./failure";

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
    const slug = RESOLVER_OWN_HEADING_SLUGS.has(bearer.slug) ? bearer.slug : "eris-login-required";
    const fix = slug === "eris-login-required" ? "Run 'eris login' once on this machine (or set ERIS_YAKS_TOKEN to a sib_ service token), then re-run." : bearer.fix;
    return stop({ slug, what: bearer.reason, fix, docs: `docs/ERRORS.md#${slug}`, exit: 3 });
  }
  return unwrap(gatesEndpoint(bearer.value.url, bearer.value.token, { fetch: o.fetch, policySha: o.policySha, onStale: o.onStale }));
}
