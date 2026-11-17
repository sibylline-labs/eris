/**
 * client.ts — the client every eris verb that reaches the hosted gates API goes through
 * (docs/dev/GATES-CLIENT.md). It takes the `eris login` url and bearer the caller resolved, sends one
 * request per call, and hands back a decoded reply or a slugged `ContractFailure`. It never reads a
 * file or the environment, prints, or exits.
 *
 * Invariants:
 *   - The bearer goes only to `https:`, or `http:` on localhost, 127.0.0.1 or [::1]: `gatesEndpoint`
 *     refuses any other URL (`login-url-refused`) before an endpoint, and so a request, exists.
 *   - One attempt per request, with a deadline over the whole exchange and a cap on the reply; no
 *     retry hides a failure from the caller.
 *   - A reply body is `unknown` until its Schema decodes it. A body that does not decode, a reply
 *     over the cap, or a status the route does not answer with is `gate-contract-mismatch`.
 *   - A policy bundle is trusted only when `computeGatesBundleSha` over the decoded values equals the
 *     `bundle_sha` the server named.
 *   - No failure carries the bearer.
 */

import type * as Schema from "effect/Schema";
import { computeGatesBundleSha, type GatesBundleSha, type GatesOrgBundle, GatesPolicyReply, type GatesSettings, GatesSettingsReply } from "./bundle";
import { decodeResult } from "./decode";
import { type ContractFailure, fail, type Outcome, succeed } from "./failure";

export const POLICY_PATH = "/v1/gates/policy";
export const SETTINGS_PATH = "/v1/gates/settings";

const TIMEOUT_MS = 20_000;
const POLICY_REPLY_MAX_BYTES = 1024 * 1024;

/** Where the gates API is and the bearer it takes; made only by `gatesEndpoint`. */
export interface GatesEndpoint {
  readonly base: string;
  readonly token: string;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs: number;
}

export interface GatesEndpointOptions {
  /** The fetch every request goes through (a test's loopback server); the global fetch when absent. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/** The `docs/ERRORS.md` slugs the client returns (`tests/errors-doc.test.ts`). */
export type GatesClientSlug = "login-url-refused" | "eris-login-required" | "gate-store-forbidden" | "gate-store-unreachable" | "gate-contract-mismatch";

const failure = (slug: GatesClientSlug, what: string, fix: string): ContractFailure => ({ slug, what, fix, docs: `docs/ERRORS.md#${slug}`, exit: 3 });

/** The hosts an `http:` URL may name (`URL.hostname` lowercases and brackets IPv6, and folds `127.1` into `127.0.0.1`). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The endpoint for `url` and `token`, or `login-url-refused` when the URL would carry the bearer in cleartext. */
// lift-candidate: bearer-origin-check — https, or http on a loopback host only
export function gatesEndpoint(url: string, token: string, opts: GatesEndpointOptions = {}): Outcome<GatesEndpoint> {
  let parsed: URL | null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (parsed !== null && (parsed.protocol === "https:" || (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)))) {
    return succeed({ base: url.replace(/\/+$/, ""), token, fetch: opts.fetch ?? globalThis.fetch, timeoutMs: opts.timeoutMs ?? TIMEOUT_MS });
  }
  const what =
    parsed === null
      ? "the eris login URL is not an absolute URL, so the token is not sent"
      : parsed.protocol === "http:"
        ? `the eris login URL is plain http on ${parsed.hostname}, which is not a loopback host, so the token is not sent in cleartext`
        : `the eris login URL's scheme is ${parsed.protocol}; the token goes only to https, or http on localhost, 127.0.0.1 or [::1]`;
  return fail(failure("login-url-refused", what, "Set ERIS_YAKS_URL to the gateway's https URL (http only for localhost, 127.0.0.1 or [::1]), or run eris login again."));
}

const unreachable = (what: string) => failure("gate-store-unreachable", what, "Re-run once the gateway answers; ERIS_YAKS_URL (or yaks.json's url) names the host when it is not the default.");
const mismatch = (what: string) => failure("gate-contract-mismatch", what, "Update eris ('eris update'); if it persists, the gateway and this client disagree on the gates contract.");

/** The problem+json `code` of a refusal, else `HTTP <status>`; never the body text itself. */
function problemCode(body: unknown, status: number): string {
  if (body !== null && typeof body === "object") {
    const code = (body as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z0-9_.-]{1,64}$/i.test(code)) return code;
  }
  return `HTTP ${status}`;
}

/** One GET of `path`, its 2xx body decoded through `schema`; every other outcome mapped to its slug. */
async function getJson<S extends Schema.Top>(ep: GatesEndpoint, path: string, what: string, schema: S, maxBytes: number): Promise<Outcome<S["Type"]>> {
  const url = `${ep.base}${path}`;
  let status: number;
  let text: string;
  try {
    const res = await ep.fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${ep.token}`, accept: "application/json, application/problem+json" },
      signal: AbortSignal.timeout(ep.timeoutMs),
    });
    status = res.status;
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      await res.body?.cancel();
      return fail(mismatch(`${url} answered ${what} with ${declared} bytes, over the ${maxBytes}-byte cap`));
    }
    text = await res.text();
  } catch (err) {
    const name = (err as { name?: unknown }).name;
    const why = name === "TimeoutError" || name === "AbortError" ? `no answer within ${ep.timeoutMs / 1000}s` : "a network error";
    return fail(unreachable(`cannot reach ${url} for ${what} (${why})`));
  }
  if (new TextEncoder().encode(text).length > maxBytes) return fail(mismatch(`${url} answered ${what} with a reply over the ${maxBytes}-byte cap`));
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (status === 401) return fail(failure("eris-login-required", `the gateway rejected the stored login token (${problemCode(body, status)})`, "Run 'eris login' once on this machine (or set ERIS_YAKS_TOKEN to a sib_ service token), then re-run."));
  if (status === 402 || status === 403) {
    return fail(failure("gate-store-forbidden", `the gateway refused the token for ${what} (${problemCode(body, status)})`, "Sign in with an account whose org has Gates ('eris login'), or ask the org admin to grant it."));
  }
  if (status >= 500) return fail(unreachable(`the gateway failed ${what} (HTTP ${status}, ${problemCode(body, status)})`));
  if (status < 200 || status > 299) return fail(mismatch(`the gateway refused ${what} (HTTP ${status}, ${problemCode(body, status)})`));
  const decoded = decodeResult(schema, body);
  if (decoded._tag !== "Success") return fail(mismatch(`${url} answered ${what} with a body the gates contract does not describe (${decoded.failure.message})`));
  return succeed(decoded.success);
}

/** The org's policy bundle and settings, as one sha-verified pair. */
export interface PulledPolicy {
  readonly bundle: GatesOrgBundle;
  readonly settings: GatesSettings;
  readonly bundle_sha: GatesBundleSha;
}

/**
 * The org's policy bundle and settings (`GET /v1/gates/policy` and `/settings`). The two reads are one
 * bundle only when both name the same `bundle_sha`: a save landing between them is read once more,
 * then refused (`gate-store-unreachable`). The pair's recomputed sha must equal the server's
 * (`gate-contract-mismatch`), so a bundle is never trusted on the server's word.
 */
export async function fetchOrgPolicy(ep: GatesEndpoint): Promise<Outcome<PulledPolicy>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const [policy, settings] = await Promise.all([
      getJson(ep, POLICY_PATH, "the org policy read", GatesPolicyReply, POLICY_REPLY_MAX_BYTES),
      getJson(ep, SETTINGS_PATH, "the org settings read", GatesSettingsReply, POLICY_REPLY_MAX_BYTES),
    ]);
    if (!policy.ok) return policy;
    if (!settings.ok) return settings;
    if (policy.value.bundle_sha !== settings.value.bundle_sha) {
      if (attempt === 0) continue;
      return fail(unreachable(`the org's policy changed while it was read (${policy.value.bundle_sha} then ${settings.value.bundle_sha}); re-run 'eris doctrine pull'`));
    }
    const sha = await computeGatesBundleSha(policy.value.bundle, settings.value.settings);
    if (sha !== policy.value.bundle_sha) return fail(mismatch(`the gateway named bundle ${policy.value.bundle_sha}, but its policy and settings hash to ${sha}`));
    return succeed({ bundle: policy.value.bundle, settings: settings.value.settings, bundle_sha: sha });
  }
  return fail(unreachable("the org's policy could not be read as one bundle"));
}
