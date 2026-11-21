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

import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { bundleChanges, computeGatesBundleSha, GATES_POLICY_CONTRACT_VERSION, GatesBundleSha, type GatesOrgBundle, GatesPolicyReply, GatesSettings, GatesSettingsReply } from "./bundle";
import { decodeResult } from "./decode";
import {
  LINEAR_PATH,
  type LinearClaim,
  LinearClaimHolder,
  LinearClaimReply,
  LinearCommentReply,
  LinearIssueReply,
  LinearReleaseReply,
  type TRANSITION_STATE_TYPES,
  YAK_ULID_RE,
  YakClusterReply,
  YakObservationReply,
} from "./linear";
import { type ContractFailure, fail, type Outcome, succeed } from "./failure";

export const POLICY_PATH = "/v1/gates/policy";
export const SETTINGS_PATH = "/v1/gates/settings";
export const RECEIPTS_PATH = "/v1/gates/receipts";
export const DOCTRINE_COMMENTS_PATH = "/v1/gates/doctrine-comments";
export const ASSETS_PATH = "/v1/gates/assets";
export const ARTIFACTS_PATH = "/v1/gates/artifacts";
export const ASKS_PATH = "/v1/asks";

/** The contract version each receipt-route reply carries: receipts v1, assets v1.1, artifacts v1.2. */
export const GATES_RECEIPTS_CONTRACT_VERSION = "gates-contract/v1";
export const GATES_ASSETS_CONTRACT_VERSION = "gates-contract/v1.1";
export const GATES_ARTIFACTS_CONTRACT_VERSION = "gates-contract/v1.2";

/** The request header naming the bundle this machine pulled, and the reply headers that judge it. */
export const X_ERIS_POLICY_SHA = "x-eris-policy-sha";
export const X_GATES_POLICY_SHA = "x-gates-policy-sha";
export const X_GATES_POLICY_STALE = "x-gates-policy-stale";

/** The host every stored asset URL names; the store refuses any other, and so does this client. */
export const GATES_ASSET_HOST = ["uploads", "linear", "app"].join(".");

const TIMEOUT_MS = 20_000;
const POLICY_REPLY_MAX_BYTES = 1024 * 1024;
/** The server reads at most 500 comments; a listing of receipts with inline evidence stays well under this. */
const LIST_MAX_BYTES = 8 * 1024 * 1024;
const RECORD_REPLY_MAX_BYTES = 64 * 1024;
/** An upload or digest moves up to 25 MiB through the store's asset storage. */
const ASSET_TIMEOUT_MS = 120_000;
const ASSET_REPLY_MAX_BYTES = 64 * 1024;
/** A stored copy is at most 1 MiB decoded (the server's cap), so its base64 reply stays under this. */
const ARTIFACT_REPLY_MAX_BYTES = 4 * 1024 * 1024;
const ASKS_REPLY_MAX_BYTES = 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Where the gates API is and the bearer it takes; made only by `gatesEndpoint`. */
export interface GatesEndpoint {
  readonly base: string;
  readonly token: string;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs: number;
  /** Sent as `x-eris-policy-sha` on the receipt routes; absent for an org not yet pulled. */
  readonly policySha?: string | undefined;
  readonly onStale?: ((liveSha: string | null) => void) | undefined;
  /** Whether `onStale` has fired: it fires once per endpoint, however many receipt calls run. */
  readonly stale: { told: boolean };
}

export interface GatesEndpointOptions {
  /** The fetch every request goes through (a test's loopback server); the global fetch when absent. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  /** The pulled bundle's sha, sent as `x-eris-policy-sha` on the receipt routes. */
  readonly policySha?: string | undefined;
  /** Told once when a receipt reply carries `x-gates-policy-stale: soft|hard`, with the live sha when the reply names one. */
  readonly onStale?: ((liveSha: string | null) => void) | undefined;
}

/** The `docs/ERRORS.md` slugs the client returns (`tests/errors-doc.test.ts`). */
export type GatesClientSlug =
  | "login-url-refused"
  | "eris-login-required"
  | "gate-store-forbidden"
  | "gate-store-unreachable"
  | "gate-contract-mismatch"
  | "doctrine-out-of-date"
  | "doctrine-push-refused"
  | "doctrine-push-needs-approval"
  | "doctrine-push-stale"
  | "doctrine-push-invalid"
  | "linear-issue-not-found"
  | "linear-issue-claimed"
  | "linear-state-not-found"
  | "linear-rate-limited"
  | "yak-unresolved"
  | "asks-store-forbidden"
  | "asks-store-unreachable"
  | "asks-contract-mismatch"
  | "asks-rate-limited"
  | "mandate-agent-root"
  | "mandate-widened"
  | "mandate-out-of-path"
  | "mandate-expired"
  | "mandate-not-covered"
  | "mandate-exhausted"
  | "mandate-unknown-mandate"
  | "mandate-revoked"
  | "mandate-org-mismatch"
  | "mandate-session-required"
  | "mandate-act-unsupported"
  | "mandate-handle-in-receipt"
  | "mandate-client-supplied"
  | "mandate-unavailable";

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
    return succeed({
      base: url.replace(/\/+$/, ""),
      token,
      fetch: opts.fetch ?? globalThis.fetch,
      timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
      policySha: opts.policySha,
      onStale: opts.onStale,
      stale: { told: false },
    });
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
const loginRequired = (what: string) => failure("eris-login-required", what, "Run 'eris login' once on this machine (or set ERIS_YAKS_TOKEN to a sib_ service token), then re-run.");

/** The problem+json `code` of a refusal, else the router envelope's `error.code`, else `HTTP <status>`; never the body text itself. */
function problemCode(body: unknown, status: number): string {
  if (body !== null && typeof body === "object") {
    const b = body as { code?: unknown; error?: { code?: unknown } | null };
    for (const code of [b.code, b.error?.code]) if (typeof code === "string" && /^[a-z0-9_.-]{1,64}$/i.test(code)) return code;
  }
  return `HTTP ${status}`;
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date; null when absent or unreadable. */
function retryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const t = header.trim();
  if (/^\d+$/.test(t)) return Number(t) * 1000;
  const at = Date.parse(t);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/** What the gateway answered: its status, its body parsed as JSON (or undefined), its headers and the URL asked. */
interface Answer {
  readonly url: string;
  readonly status: number;
  readonly body: unknown;
  readonly code: string;
  readonly headers: Headers;
}

interface Exchange {
  readonly method: "GET" | "POST" | "PUT";
  readonly path: string;
  readonly what: string;
  readonly maxBytes: number;
  readonly timeoutMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  /** Who is unreachable when the exchange fails: the gates store (default) or the asks API. */
  readonly unreachable?: (what: string) => ContractFailure;
  /** `manual`: a 3xx is the answer, never followed, so the bearer cannot be carried to the host it names. */
  readonly redirect?: "manual";
}

/** One request, its reply read under the cap and parsed; a timeout, network error or oversize reply is a failure. */
async function exchange(ep: GatesEndpoint, x: Exchange): Promise<Outcome<Answer>> {
  const url = `${ep.base}${x.path}`;
  const down = x.unreachable ?? unreachable;
  let status: number;
  let text: string;
  let headers: Headers;
  try {
    const res = await ep.fetch(url, {
      method: x.method,
      headers: { authorization: `Bearer ${ep.token}`, accept: "application/json, application/problem+json", ...x.headers },
      ...(x.body !== undefined ? { body: typeof x.body === "string" ? x.body : new Uint8Array(x.body) } : {}),
      signal: AbortSignal.timeout(x.timeoutMs ?? ep.timeoutMs),
      ...(x.redirect !== undefined ? { redirect: x.redirect } : {}),
    });
    status = res.status;
    headers = res.headers;
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > x.maxBytes) {
      await res.body?.cancel();
      return fail(mismatch(`${url} answered ${x.what} with ${declared} bytes, over the ${x.maxBytes}-byte cap`));
    }
    text = await res.text();
  } catch (err) {
    const name = (err as { name?: unknown }).name;
    const why = name === "TimeoutError" || name === "AbortError" ? `no answer within ${(x.timeoutMs ?? ep.timeoutMs) / 1000}s` : "a network error";
    return fail(down(`cannot reach ${url} for ${x.what} (${why})`));
  }
  if (new TextEncoder().encode(text).length > x.maxBytes) return fail(mismatch(`${url} answered ${x.what} with a reply over the ${x.maxBytes}-byte cap`));
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return succeed({ url, status, body, code: problemCode(body, status), headers });
}

/** A 2xx body decoded through `schema` (keys it does not name are dropped), else `gate-contract-mismatch`. */
function decoded<S extends Schema.Top>(a: Answer, what: string, schema: S, contract = "the gates contract", wrong = mismatch): Outcome<S["Type"]> {
  const d = decodeResult(schema, a.body);
  return d._tag === "Success" ? succeed(d.success) : fail(wrong(`${a.url} answered ${what} with a body ${contract} does not describe (${d.failure.message})`));
}

/** The gates store's refusal for a non-2xx answer: login, entitlement, outage, rate limit, else a contract mismatch. */
function storeRefusal(a: Answer, what: string, opts: { receipt?: boolean; issue?: boolean } = {}): ContractFailure {
  const { status, code } = a;
  if (status === 401) return loginRequired(`the gateway rejected the stored login token (${code})`);
  if (status === 402 || status === 403) {
    return failure("gate-store-forbidden", `the gateway refused the token for ${what} (${code})`, "Sign in with an account whose org has Gates ('eris login'), or ask the org admin to grant it.");
  }
  if (status === 429 && opts.receipt === true) {
    const ms = retryAfterMs(a.headers.get("retry-after"));
    return {
      ...failure("linear-rate-limited", `the gate receipt store rate-limited ${what} (HTTP 429)`, ms !== null ? `Wait ${Math.ceil(ms / 1000)}s and re-run.` : "Wait a minute and re-run."),
      retryAfterMs: ms,
    };
  }
  if (opts.issue === true && status === 404 && code === "issue_not_found") {
    return failure("linear-issue-not-found", "the tracker has no such issue visible to your org", "Check the issue key (e.g. ABC-123) and that it is not archived.");
  }
  if (opts.receipt === true && status === 409 && code === "doctrine_out_of_date") {
    return failure(
      "doctrine-out-of-date",
      "the gateway refused the receipt: this machine's copy of the org's policy is not the live one, and the org requires it (staleness: hard)",
      "Run 'eris doctrine pull', then re-run the command. Nothing was recorded.",
    );
  }
  if (opts.receipt === true && status === 409 && (code === "linear_disconnected" || code === "org_not_found")) return unreachable(`the gateway has no tracker connection for your org (${code})`);
  if (status >= 500) return unreachable(`the gateway failed ${what} (HTTP ${status}, ${code})`);
  return mismatch(`the gateway refused ${what} (HTTP ${status}, ${code})`);
}

const ok2xx = (a: Answer): boolean => a.status >= 200 && a.status <= 299;

/** One GET of `path`, its 2xx body decoded through `schema`; every other outcome mapped to its slug. */
async function getJson<S extends Schema.Top>(ep: GatesEndpoint, path: string, what: string, schema: S, maxBytes: number): Promise<Outcome<S["Type"]>> {
  const a = await exchange(ep, { method: "GET", path, what, maxBytes });
  if (!a.ok) return a;
  return ok2xx(a.value) ? decoded(a.value, what, schema) : fail(storeRefusal(a.value, what));
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

// --- the policy save and the doctrine-comment routes ----------------------------------------------

const POLICY_SAVE_REPLY_MAX_BYTES = 64 * 1024;

const PolicySaveReply = Schema.Struct({
  contract: Schema.Literal(GATES_POLICY_CONTRACT_VERSION),
  version: Schema.Number.check(Schema.makeFilter((n) => Number.isSafeInteger(n) && n > 0, { expected: "a positive integer" })),
  bundle_sha: GatesBundleSha,
  saved_at: Schema.String,
  widened: Schema.optionalKey(Schema.Boolean),
  reasons: Schema.optionalKey(Schema.Array(Schema.String)),
  auth_mode: Schema.optionalKey(Schema.String),
});

/** The version a policy save made, how the gateway judged it, and the parts of the base it changed. */
export interface SavedPolicy {
  readonly version: number;
  readonly bundle_sha: GatesBundleSha;
  readonly saved_at: string;
  /** Whether the save loosened the policy; null when the gateway did not say. */
  readonly widened: boolean | null;
  /** Why the gateway judged the save a widening, one phrase each. */
  readonly reasons: readonly string[];
  /** What authorised the save (`cli`, `portal_admin`, `mandate_passkey`, `seed`); null when the gateway did not say. */
  readonly auth_mode: string | null;
  /** `bundleChanges(base, bundle)`: the parts of the base the save changed. */
  readonly changed: readonly string[];
}

declare const MandateHandleBrand: unique symbol;
/** A passkey approval handle, `mnd_<orgUlid>_<43 base64url>`: a bearer capability, never printed or logged. */
export type MandateHandle = string & { readonly [MandateHandleBrand]: true };

const MANDATE_HANDLE = /^mnd_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}$/;

/** `raw` as a `MandateHandle` when it has the handle's shape, else null. Never echoes `raw`. */
export function parseMandateHandle(raw: string): MandateHandle | null {
  return MANDATE_HANDLE.test(raw) ? (raw as MandateHandle) : null;
}

/** The dash page that mints a policy-save approval. */
export const GATES_APPROVE_URL = "https://dash.sibylline.group/gates/approve";

/** The mandate service's refusals of a presented handle, as gates relays them (at 401, 403 or 404). */
const MANDATE_REFUSALS = new Set(["agent_root", "widened", "mandate_out_of_path", "expired", "not_covered", "exhausted", "revoked", "unknown_mandate"]);
const isMandateRefusal = (a: Answer): boolean => a.status >= 400 && a.status <= 499 && (MANDATE_REFUSALS.has(a.code) || a.code.startsWith("mandate_"));

/** What a refused save names: the part saved, the command that saves it, and how to recover from a stale or invalid body. */
interface SaveTarget {
  readonly noun: string;
  readonly cmd: string;
  readonly stale: string;
  readonly invalid: string;
}

const POLICY_TARGET: SaveTarget = {
  noun: "policy",
  cmd: "eris doctrine push",
  stale: "Copy your edited files out of ~/.eris/doctrine/<orgId>/, run 'eris doctrine pull', re-apply them, then 'eris doctrine push'.",
  invalid: "Fix the edited files ('eris doctrine check --file <doctrine.md>' names doctrine problems), then 'eris doctrine push' again.",
};

const SETTINGS_TARGET: SaveTarget = {
  noun: "settings",
  cmd: "eris doctrine settings set",
  stale: "Run 'eris doctrine settings show' to read the live settings, then re-run 'eris doctrine settings set'.",
  invalid: "Check the key and value ('eris doctrine settings --help' lists them), then re-run 'eris doctrine settings set'.",
};

/** The refusal of a save, one slug per class; never names the bearer, the handle or the body. `sent`: an approval rode in the body. */
function pushRefusal(a: Answer, sent: boolean, t: SaveTarget = POLICY_TARGET): ContractFailure | null {
  const { status, code } = a;
  const again = `rerun with ERIS_GATES_APPROVAL=<handle> ${t.cmd} (the approval lasts 5 minutes and covers one save)`;
  if (status === 403 && code === "policy_widening_requires_passkey") {
    return failure(
      "doctrine-push-needs-approval",
      `this save loosens the org's ${t.noun}, and the org's Mandate requires a passkey approval for that (HTTP 403, ${code})`,
      sent ? `The approval did not cover this save; approve again at ${GATES_APPROVE_URL}, then ${again}.` : `Open ${GATES_APPROVE_URL}, approve with your passkey, then ${again}.`,
    );
  }
  if (sent && isMandateRefusal(a)) {
    return failure(
      "doctrine-push-needs-approval",
      `the org's Mandate refused the approval sent with this save (HTTP ${status}, ${code}): it has expired, been used or revoked, or does not cover this save`,
      `That approval cannot be used; approve again at ${GATES_APPROVE_URL}, then ${again}.`,
    );
  }
  if (status === 403 || status === 405) {
    return failure(
      "doctrine-push-refused",
      `the gateway does not take ${t.noun} saves on this bearer (HTTP ${status}, ${code})`,
      `Sign in as an org admin with 'eris login', then rerun; service tokens and members cannot save the org's ${t.noun}. Or change it in the org's Gates settings${t.noun === "policy" ? ", then run 'eris doctrine pull'" : ""}.`,
    );
  }
  if (status === 409) {
    return failure(
      "doctrine-push-stale",
      `the org's ${t.noun} changed while it was saved (HTTP 409, ${code})`,
      `${t.stale}${sent ? ` Your approval may have been used; approve again at ${GATES_APPROVE_URL}.` : ""}`,
    );
  }
  if (status === 400 || status === 413 || status === 422) {
    return failure(
      "doctrine-push-invalid",
      `the gateway refused the ${t.noun} (HTTP ${status}, ${code}): it is not valid, is over its size cap, or holds a credential`,
      t.invalid,
    );
  }
  return null;
}

/** What a policy save sends beside the bundle: the base it was edited on, and an approval when the operator has one. */
export interface PolicySave {
  /** The live bundle the edits were made on; `changed` is taken against it. */
  readonly base: GatesOrgBundle;
  /** Sent as the body's `mandate_handle`; the gateway spends it only on a save it would otherwise refuse as a widening. */
  readonly mandateHandle?: MandateHandle | undefined;
}

/**
 * Save `bundle` as the org's policy (`PUT /v1/gates/policy`, `{ bundle, mandate_handle? }`). Sent once and
 * never retried: a retry is the caller's decision, after it reads the live policy again.
 */
export async function putOrgPolicy(ep: GatesEndpoint, bundle: GatesOrgBundle, save: PolicySave): Promise<Outcome<SavedPolicy>> {
  const what = "the org policy save";
  const sent = save.mandateHandle !== undefined;
  const body = JSON.stringify(sent ? { bundle, mandate_handle: save.mandateHandle } : { bundle });
  const a = await exchange(ep, { method: "PUT", path: POLICY_PATH, what, maxBytes: POLICY_SAVE_REPLY_MAX_BYTES, headers: { "content-type": "application/json" }, body });
  if (!a.ok) return a;
  if (!ok2xx(a.value)) return fail(pushRefusal(a.value, sent) ?? (a.value.status === 401 || a.value.status >= 500 ? storeRefusal(a.value, what) : mismatch(`the gateway refused ${what} (HTTP ${a.value.status}, ${a.value.code})`)));
  const d = decoded(a.value, what, PolicySaveReply);
  if (!d.ok) return d;
  return succeed({
    version: d.value.version,
    bundle_sha: d.value.bundle_sha,
    saved_at: d.value.saved_at,
    widened: d.value.widened ?? null,
    reasons: d.value.reasons ?? [],
    auth_mode: d.value.auth_mode ?? null,
    changed: bundleChanges(save.base, bundle),
  });
}

// --- the settings save and the policy history -----------------------------------------------------

export const POLICY_HISTORY_PATH = "/v1/gates/policy/history";
const HISTORY_REPLY_MAX_BYTES = 8 * 1024 * 1024;

const HistoryVersion = Schema.Struct({
  version: Schema.Number.check(Schema.makeFilter((n) => Number.isSafeInteger(n) && n > 0, { expected: "a positive integer" })),
  bundle_sha: GatesBundleSha,
  saved_at: Schema.String,
  widened: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  reasons: Schema.optionalKey(Schema.Array(Schema.String)),
  auth_mode: Schema.optionalKey(Schema.NullOr(Schema.String)),
  settings: GatesSettings,
});
const HistoryReply = Schema.Struct({ contract: Schema.Literal(GATES_POLICY_CONTRACT_VERSION), versions: Schema.Array(HistoryVersion) });

/** One stored policy version: who saved it (`auth_mode`), whether it loosened the policy, and the settings it held. */
export interface PolicyVersion {
  readonly version: number;
  readonly bundle_sha: GatesBundleSha;
  readonly saved_at: string;
  readonly widened: boolean | null;
  readonly reasons: readonly string[];
  readonly auth_mode: string | null;
  readonly settings: GatesSettings;
}

/** Every stored policy version, oldest first (`GET /v1/gates/policy/history`). */
export async function fetchPolicyHistory(ep: GatesEndpoint): Promise<Outcome<readonly PolicyVersion[]>> {
  const r = await getJson(ep, POLICY_HISTORY_PATH, "the policy history read", HistoryReply, HISTORY_REPLY_MAX_BYTES);
  if (!r.ok) return r;
  return succeed(r.value.versions.map((v) => ({ version: v.version, bundle_sha: v.bundle_sha, saved_at: v.saved_at, widened: v.widened ?? null, reasons: v.reasons ?? [], auth_mode: v.auth_mode ?? null, settings: v.settings })));
}

/** What a settings save sends beside the settings: the version it was edited on, and an approval when the operator has one. */
export interface SettingsSave {
  /** The stored version the edit was made on; the gateway refuses the save (409) when a newer one exists. */
  readonly expectedVersion: number;
  readonly mandateHandle?: MandateHandle | undefined;
}

/** The version a settings save made, and how the gateway judged it. */
export interface SavedSettings {
  readonly version: number;
  readonly bundle_sha: GatesBundleSha;
  readonly saved_at: string;
  readonly widened: boolean | null;
  readonly reasons: readonly string[];
  readonly auth_mode: string | null;
}

/**
 * Save `settings` as the org's settings (`PUT /v1/gates/settings`, `{ settings, expected_version, mandate_handle? }`).
 * Sent once and never retried.
 */
export async function putOrgSettings(ep: GatesEndpoint, settings: GatesSettings, save: SettingsSave): Promise<Outcome<SavedSettings>> {
  const what = "the org settings save";
  const sent = save.mandateHandle !== undefined;
  const body = JSON.stringify({ settings, expected_version: save.expectedVersion, ...(sent ? { mandate_handle: save.mandateHandle } : {}) });
  const a = await exchange(ep, { method: "PUT", path: SETTINGS_PATH, what, maxBytes: POLICY_SAVE_REPLY_MAX_BYTES, headers: { "content-type": "application/json" }, body });
  if (!a.ok) return a;
  if (!ok2xx(a.value)) return fail(pushRefusal(a.value, sent, SETTINGS_TARGET) ?? (a.value.status === 401 || a.value.status >= 500 ? storeRefusal(a.value, what) : mismatch(`the gateway refused ${what} (HTTP ${a.value.status}, ${a.value.code})`)));
  const d = decoded(a.value, what, PolicySaveReply);
  if (!d.ok) return d;
  return succeed({ version: d.value.version, bundle_sha: d.value.bundle_sha, saved_at: d.value.saved_at, widened: d.value.widened ?? null, reasons: d.value.reasons ?? [], auth_mode: d.value.auth_mode ?? null });
}

/** The doctrine-comment routes' contract version (the receipts' `gates-contract/v1`). */
const DOCTRINE_CONTRACT_VERSION = GATES_RECEIPTS_CONTRACT_VERSION;
const DOCTRINE_REPLY_MAX_BYTES = 1024 * 1024;

const OpenIssuesReply = Schema.Struct({ issues: Schema.Array(Schema.String), contract_version: Schema.Literal(DOCTRINE_CONTRACT_VERSION) });
const DoctrineCommentReply = Schema.Struct({
  id: Schema.String,
  issue: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  coalesced: Schema.Boolean,
  contract_version: Schema.Literal(DOCTRINE_CONTRACT_VERSION),
});

/** A gzip+base64 copy of a posture section, as the doctrine-comment route stores it. */
export interface PostureSnapshot {
  readonly sha256: string;
  readonly encoding: "gzip+base64";
  readonly content: string;
  readonly bytes: number;
}

/** What `postDoctrineComment` sends: a new comment, or an update of `replaceCommentId` in place. */
export interface DoctrineCommentWrite {
  readonly issue: string;
  readonly commentId: string;
  readonly replaceCommentId?: string | undefined;
  readonly body: string;
  readonly fromSnapshot: PostureSnapshot;
  readonly toSnapshot: PostureSnapshot;
}

export interface DoctrineCommentWritten {
  readonly id: string;
  readonly issue: string;
  readonly body: string;
  readonly createdAt: string;
  readonly coalesced: boolean;
}

/** The open issues among `candidates`, else every open issue holding a gate receipt (`GET /v1/gates/doctrine-comments`). */
export async function listOpenIssues(ep: GatesEndpoint, candidates?: ReadonlyArray<string>): Promise<Outcome<ReadonlyArray<string>>> {
  const what = "the open issues listing";
  const qs = candidates !== undefined && candidates.length > 0 ? `?candidates=${encodeURIComponent(candidates.join(","))}` : "";
  const a = await exchange(ep, { method: "GET", path: `${DOCTRINE_COMMENTS_PATH}${qs}`, what, maxBytes: DOCTRINE_REPLY_MAX_BYTES });
  if (!a.ok) return a;
  if (!ok2xx(a.value)) return fail(storeRefusal(a.value, what, { receipt: true }));
  const d = decoded(a.value, what, OpenIssuesReply);
  return d.ok ? succeed(d.value.issues) : d;
}

/** Post one doctrine-change comment, or coalesce into `replaceCommentId` (`POST /v1/gates/doctrine-comments`). One attempt: a retry reuses the same comment id. */
export async function postDoctrineComment(ep: GatesEndpoint, write: DoctrineCommentWrite): Promise<Outcome<DoctrineCommentWritten>> {
  const what = "the doctrine comment write";
  const body = JSON.stringify({
    issue: write.issue,
    comment_id: write.commentId,
    ...(write.replaceCommentId !== undefined ? { replace_comment_id: write.replaceCommentId } : {}),
    body: write.body,
    from_snapshot: write.fromSnapshot,
    to_snapshot: write.toSnapshot,
  });
  const a = await exchange(ep, { method: "POST", path: DOCTRINE_COMMENTS_PATH, what, maxBytes: DOCTRINE_REPLY_MAX_BYTES, headers: { "content-type": "application/json" }, body });
  if (!a.ok) return a;
  if (!ok2xx(a.value)) return fail(storeRefusal(a.value, what, { receipt: true, issue: true }));
  const d = decoded(a.value, what, DoctrineCommentReply);
  return d.ok ? succeed({ id: d.value.id, issue: d.value.issue, body: d.value.body, createdAt: d.value.createdAt, coalesced: d.value.coalesced }) : d;
}

// --- the receipt routes ---------------------------------------------------------------------------

const ReceiptListing = Schema.Struct({
  issue: Schema.String,
  receipts: Schema.Array(
    Schema.Struct({
      comment_id: Schema.String,
      created_at: Schema.String,
      marker_version: Schema.Literals(["v1", "v2"]),
      payload: Schema.Unknown,
      source: Schema.optionalKey(Schema.Literals(["olympus", "marker"])),
      record_sha256: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
  invalid: Schema.Number,
  mandate_active: Schema.optionalKey(Schema.Boolean),
  contract_version: Schema.Literal(GATES_RECEIPTS_CONTRACT_VERSION),
});

const RecordReply = Schema.Struct({
  comment_id: Schema.String,
  issue: Schema.String,
  gate: Schema.String,
  created_at: Schema.String,
  record_sha256: Schema.optionalKey(Schema.String),
  contract_version: Schema.Literal(GATES_RECEIPTS_CONTRACT_VERSION),
});

const UploadReply = Schema.Struct({ assetUrl: Schema.String, sha256: Schema.String, bytes: Schema.Number, contract_version: Schema.Literal(GATES_ASSETS_CONTRACT_VERSION) });
const DigestReply = Schema.Struct({ sha256: Schema.String, bytes: Schema.Number, contentType: Schema.String, contract_version: Schema.Literal(GATES_ASSETS_CONTRACT_VERSION) });
const ArtifactReply = Schema.Struct({
  sha256: Schema.String,
  encoding: Schema.Literal("gzip+base64"),
  content: Schema.String,
  bytes: Schema.Number,
  contract_version: Schema.Literal(GATES_ARTIFACTS_CONTRACT_VERSION),
});

/** One stored record on an issue: the comment it was published as, when, its marker version, and its payload undecoded. */
export interface ListedReceipt {
  readonly id: string;
  /** The server's timestamp: the only clock receipts are ordered by. */
  readonly createdAt: string;
  readonly version: "v1" | "v2";
  readonly payload: unknown;
}

export interface ReceiptListingRead {
  readonly receipts: ReadonlyArray<ListedReceipt>;
  /** Records the store itself could not read as a marker. */
  readonly invalid: number;
  /** Whether the org has Mandate active, when reported by the gateway. */
  readonly mandateActive?: boolean | undefined;
}

/** The headers a receipt route sends: the bearer's, plus the pulled bundle's sha when there is one. */
const receiptHeaders = (ep: GatesEndpoint): Record<string, string> => (ep.policySha !== undefined ? { [X_ERIS_POLICY_SHA]: ep.policySha } : {});

/** Tell the caller, once per endpoint, that a receipt reply marked this machine's policy stale. */
function noteStale(ep: GatesEndpoint, headers: Headers): void {
  const stale = headers.get(X_GATES_POLICY_STALE);
  if (ep.stale.told || ep.onStale === undefined || (stale !== "soft" && stale !== "hard")) return;
  ep.stale.told = true;
  const live = headers.get(X_GATES_POLICY_SHA);
  ep.onStale(live !== null && /^[0-9a-f]{12}$/.test(live) ? live : null);
}

/** Every receipt record on `issue` (`GET /v1/gates/receipts?issue=`), payloads undecoded: `decodePayload` reads each. */
export async function listReceipts(ep: GatesEndpoint, issue: string): Promise<Outcome<ReceiptListingRead>> {
  const what = "the receipt listing";
  const a = await exchange(ep, { method: "GET", path: `${RECEIPTS_PATH}?issue=${encodeURIComponent(issue)}`, what, maxBytes: LIST_MAX_BYTES, headers: receiptHeaders(ep) });
  if (!a.ok) return a;
  if (!ok2xx(a.value)) return fail(storeRefusal(a.value, what, { receipt: true, issue: true }));
  noteStale(ep, a.value.headers);
  const d = decoded(a.value, what, ReceiptListing);
  if (!d.ok) return d;
  return succeed({
    receipts: d.value.receipts.map((r) => ({ id: r.comment_id, createdAt: r.created_at, version: r.marker_version, payload: r.payload })),
    invalid: d.value.invalid,
    ...(d.value.mandate_active !== undefined ? { mandateActive: d.value.mandate_active } : {}),
  });
}

/**
 * The codes the gates store answers a receipt carrying `mandate_handle` with, at their HTTP statuses.
 * Each `what` is fixed text: no refusal echoes the handle.
 */
export const MANDATE_STORE_CODES = {
  agent_root: { status: 403, slug: "mandate-agent-root", what: "a root mandate needs a member's passkey; an agent cannot mint one" },
  widened: { status: 403, slug: "mandate-widened", what: "the child mandate is not inside its parent" },
  mandate_out_of_path: { status: 403, slug: "mandate-out-of-path", what: "the mandate is bound to another session" },
  expired: { status: 403, slug: "mandate-expired", what: "the mandate has expired" },
  not_covered: { status: 403, slug: "mandate-not-covered", what: "no scope on the mandate covers this gate act" },
  exhausted: { status: 403, slug: "mandate-exhausted", what: "the mandate has no uses left" },
  unknown_mandate: { status: 404, slug: "mandate-unknown-mandate", what: "no mandate matches the handle" },
  revoked: { status: 401, slug: "mandate-revoked", what: "the mandate was revoked" },
  org_mismatch: { status: 401, slug: "mandate-org-mismatch", what: "the handle belongs to another org than this login" },
  mandate_session_required: { status: 422, slug: "mandate-session-required", what: "a mandate is presented from a session: --actor must be session:<id>" },
  mandate_act_unsupported: { status: 422, slug: "mandate-act-unsupported", what: "the mandate service covers a gate skip or a review-report refutation endorsement (review:endorse) only" },
  handle_in_receipt: { status: 422, slug: "mandate-handle-in-receipt", what: "the receipt or its prose carries a mandate handle" },
  mandate_client_supplied: { status: 422, slug: "mandate-client-supplied", what: "the receipt carries its own mandate stamp; only the store writes one" },
  mandate_unavailable: { status: 503, slug: "mandate-unavailable", what: "the mandate service is unavailable, so nothing was stamped or stored" },
} as const satisfies Record<string, { readonly status: number; readonly slug: GatesClientSlug; readonly what: string }>;
export type MandateStoreCode = keyof typeof MANDATE_STORE_CODES;

export const isMandateStoreCode = (code: string): code is MandateStoreCode => Object.hasOwn(MANDATE_STORE_CODES, code);

/** The `mandate-*` failure slug for one store refusal code. */
export function mandateRefusalSlug(code: MandateStoreCode): (typeof MANDATE_STORE_CODES)[MandateStoreCode]["slug"] {
  return MANDATE_STORE_CODES[code].slug;
}

/** A refused mandate use on a receipt write (exit 3): nothing was stored. */
export function mandateRefused(code: MandateStoreCode): ContractFailure {
  const entry = MANDATE_STORE_CODES[code];
  return failure(
    entry.slug,
    `the gate receipt store refused the mandate (${code}): ${entry.what}; no receipt was stored`,
    code === "mandate_unavailable"
      ? "Re-run once the mandate service answers; the same comment id spends no second use."
      : "Ask the mandate's holder for a handle that covers this act from this session, or record with --authorized.",
  );
}

/** What `appendReceipt` sends: the caller's comment id (the gateway dedupes a retried write on it), the receipt, its prose, and an optional redacted mandate handle. */
export interface ReceiptAppend {
  readonly commentId: string;
  readonly issue: string;
  readonly receipt: unknown;
  readonly prose: string;
  /** A validated `mnd_` handle for the store to spend one use of and stamp the record `gate-receipt@v3` with; unwrapped only here into the JSON request body. */
  readonly mandateHandle?: Redacted.Redacted<MandateHandle> | undefined;
}

export interface AppendedReceipt {
  readonly id: string;
  readonly createdAt: string;
  /** The sha256 the store keyed the record under, when the reply names it. */
  readonly recordSha256?: string;
}

/** Store one receipt and publish its comment (`POST /v1/gates/receipts`). One attempt: a retry is the caller's, with the same comment id. */
export async function appendReceipt(ep: GatesEndpoint, append: ReceiptAppend): Promise<Outcome<AppendedReceipt>> {
  const what = "the receipt write";
  const body = JSON.stringify({
    comment_id: append.commentId,
    issue: append.issue,
    receipt: append.receipt,
    prose: append.prose,
    ...(append.mandateHandle !== undefined ? { mandate_handle: Redacted.value(append.mandateHandle) } : {}),
  });
  const a = await exchange(ep, {
    method: "POST",
    path: RECEIPTS_PATH,
    what,
    maxBytes: RECORD_REPLY_MAX_BYTES,
    headers: { ...receiptHeaders(ep), "content-type": "application/json" },
    body,
  });
  if (!a.ok) return a;
  if (!ok2xx(a.value)) {
    if (append.mandateHandle !== undefined && isMandateStoreCode(a.value.code) && MANDATE_STORE_CODES[a.value.code].status === a.value.status) {
      return fail(mandateRefused(a.value.code));
    }
    return fail(storeRefusal(a.value, what, { receipt: true, issue: true }));
  }
  noteStale(ep, a.value.headers);
  const d = decoded(a.value, what, RecordReply);
  if (!d.ok) return d;
  return succeed({ id: d.value.comment_id, createdAt: d.value.created_at, ...(d.value.record_sha256 !== undefined ? { recordSha256: d.value.record_sha256 } : {}) });
}

/** True for an https URL on exactly the asset host, with no userinfo or port. */
function onAssetHost(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname === GATES_ASSET_HOST && u.port === "" && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

export interface AssetUpload {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface StoredAsset {
  readonly assetUrl: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** Upload one media file (`POST /v1/gates/assets`, raw bytes). Never retried: the store keeps every upload as a new asset. */
export async function uploadAsset(ep: GatesEndpoint, file: AssetUpload): Promise<Outcome<StoredAsset>> {
  const what = `the upload of ${file.name}`;
  const a = await exchange(ep, {
    method: "POST",
    path: ASSETS_PATH,
    what,
    maxBytes: ASSET_REPLY_MAX_BYTES,
    timeoutMs: ASSET_TIMEOUT_MS,
    headers: { "content-type": file.contentType, "x-filename": file.name },
    body: file.bytes,
  });
  if (!a.ok) return a;
  if (!ok2xx(a.value)) return fail(storeRefusal(a.value, what, { receipt: true }));
  const d = decoded(a.value, what, UploadReply);
  if (!d.ok) return d;
  if (!onAssetHost(d.value.assetUrl)) return fail(mismatch(`the store returned an asset URL for ${file.name} outside ${GATES_ASSET_HOST}`));
  return succeed({ assetUrl: d.value.assetUrl, sha256: d.value.sha256, bytes: d.value.bytes });
}

/** A stored asset's digest, or `Gone` when the store holds no asset at the URL. */
export type AssetDigest =
  | { readonly _tag: "Digest"; readonly sha256: string; readonly bytes: number; readonly contentType: string }
  | { readonly _tag: "Gone"; readonly why: string };

/** The digest of the asset stored at `assetUrl` (`GET /v1/gates/assets/digest?url=`); 404 `asset_not_found` is `Gone`. */
export async function assetDigest(ep: GatesEndpoint, assetUrl: string): Promise<Outcome<AssetDigest>> {
  const what = "the asset digest read";
  const a = await exchange(ep, { method: "GET", path: `${ASSETS_PATH}/digest?url=${encodeURIComponent(assetUrl)}`, what, maxBytes: ASSET_REPLY_MAX_BYTES, timeoutMs: ASSET_TIMEOUT_MS });
  if (!a.ok) return a;
  if (a.value.status === 404 && a.value.code === "asset_not_found") return succeed({ _tag: "Gone", why: "the store holds no asset at its URL (asset_not_found)" });
  if (!ok2xx(a.value)) return fail(storeRefusal(a.value, what, { receipt: true }));
  const d = decoded(a.value, what, DigestReply);
  return d.ok ? succeed({ _tag: "Digest", sha256: d.value.sha256, bytes: d.value.bytes, contentType: d.value.contentType }) : d;
}

/** An artifact copy the store holds under its sha256, or `NotStored`. */
export type StoredCopyRead =
  | { readonly _tag: "Stored"; readonly copy: { readonly sha256: string; readonly encoding: "gzip+base64"; readonly content: string; readonly bytes: number } }
  | { readonly _tag: "NotStored"; readonly why: string };

/** The artifact copy stored under `sha256` (`GET /v1/gates/artifacts/<sha256>`); 404 `artifact_not_found` is `NotStored`. */
export async function artifactCopy(ep: GatesEndpoint, sha256: string): Promise<Outcome<StoredCopyRead>> {
  if (!SHA256_HEX.test(sha256)) return succeed({ _tag: "NotStored", why: "the receipt's sha256 is not 64 lowercase hex" });
  const what = "the artifact copy read";
  const a = await exchange(ep, { method: "GET", path: `${ARTIFACTS_PATH}/${sha256}`, what, maxBytes: ARTIFACT_REPLY_MAX_BYTES });
  if (!a.ok) return a;
  if (a.value.status === 404 && a.value.code === "artifact_not_found") return succeed({ _tag: "NotStored", why: "the store holds no copy under its sha256 (artifact_not_found)" });
  if (!ok2xx(a.value)) return fail(storeRefusal(a.value, what, { receipt: true }));
  const d = decoded(a.value, what, ArtifactReply);
  if (!d.ok) return d;
  if (d.value.sha256 !== sha256) return fail(mismatch(`the store answered the artifact copy for ${sha256.slice(0, 12)} with ${d.value.sha256.slice(0, 12)}'s`));
  return succeed({ _tag: "Stored", copy: { sha256: d.value.sha256, encoding: d.value.encoding, content: d.value.content, bytes: d.value.bytes } });
}

// --- the asks route --------------------------------------------------------------------------------

/** The most rows one asks listing returns; the route has no cursor, so a full page may be partial. */
export const ASKS_LIST_MAX = 100;

export const ASK_DOORS = ["one-way", "two-way"] as const;
export const ASK_STATES = ["open", "answered", "expired", "withdrawn"] as const;

/** The fields of an `ask@1` record the gate verbs read; the rest of the record is not decoded. */
export const AskRow = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
  door: Schema.Literals(ASK_DOORS),
  blocking: Schema.Boolean,
  state: Schema.Literals(ASK_STATES),
  binds: Schema.Struct({
    issue: Schema.String,
    pr: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
  }),
});
export type AskRow = typeof AskRow.Type;

const AskListing = Schema.Struct({ asks: Schema.Array(AskRow) });

/** A listing filter; an absent member does not filter. */
export interface AskQuery {
  readonly issue?: string | undefined;
  readonly state?: (typeof ASK_STATES)[number] | undefined;
  readonly blocking?: boolean | undefined;
  readonly limit?: number | undefined;
}

const asksUnreachable = (what: string) =>
  failure("asks-store-unreachable", what, "Re-run once the asks API answers. A create that timed out may still have landed: list the issue's asks before asking again.");
const asksMismatch = (what: string) => failure("asks-contract-mismatch", what, "Update eris ('eris update'); if it persists, the asks API and this client disagree on the ask@1 contract.");

/** The asks matching `q` (`GET /v1/asks?issue=&state=&blocking=&limit=`). */
export async function listAsks(ep: GatesEndpoint, q: AskQuery): Promise<Outcome<ReadonlyArray<AskRow>>> {
  const what = "the asks listing";
  const params = new URLSearchParams();
  if (q.issue !== undefined) params.set("issue", q.issue);
  if (q.state !== undefined) params.set("state", q.state);
  if (q.blocking !== undefined) params.set("blocking", String(q.blocking));
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  const qs = params.toString();
  const a = await exchange(ep, { method: "GET", path: qs === "" ? ASKS_PATH : `${ASKS_PATH}?${qs}`, what, maxBytes: ASKS_REPLY_MAX_BYTES, unreachable: asksUnreachable });
  if (!a.ok) return a.failure.slug === "gate-contract-mismatch" ? fail(asksMismatch(a.failure.what)) : a;
  const { status, code } = a.value;
  if (status === 401) return fail(loginRequired(`the asks API rejected the stored login token (${code})`));
  if (status === 402 || status === 403) {
    return fail(failure("asks-store-forbidden", `the asks API refused the token (${code})`, "Sign in with an account whose org may raise asks ('eris login'), or ask the org admin to grant it."));
  }
  if (status === 429) {
    const ms = retryAfterMs(a.value.headers.get("retry-after"));
    return fail({
      ...failure("asks-rate-limited", "the asks API rate-limited the call (HTTP 429)", ms !== null ? `Wait ${Math.ceil(ms / 1000)}s and re-run.` : "Wait a minute and re-run."),
      retryAfterMs: ms,
    });
  }
  if (status >= 500) return fail(asksUnreachable(`the asks API failed ${what} (HTTP ${status}, ${code})`));
  if (!ok2xx(a.value)) return fail(asksMismatch(`the asks API refused ${what} (HTTP ${status}, ${code})`));
  const d = decoded(a.value, what, AskListing, "ask@1", asksMismatch);
  return d.ok ? succeed(d.value.asks) : d;
}

// --- the /v1/linear routes and the yak lookup -------------------------------------------------------

/** A reply is one issue, claim or comment: well under this. */
const LINEAR_REPLY_MAX_BYTES = 1024 * 1024;
const YAKS_REPLY_MAX_BYTES = 256 * 1024;

/** An issue as a loop reads it: its key, state and parent. */
export interface LinearIssueState {
  readonly identifier: string;
  readonly state: { readonly name: string; readonly type: string };
  readonly parent: { readonly identifier: string; readonly state: { readonly name: string; readonly type: string } } | null;
}

/** What `claimIssue` sends: a reserve (no `sessionId`), or the same `claimId` with one to bind it. */
export interface LinearClaimRequest {
  readonly claimId: string;
  readonly loop: string;
  readonly runtime: string;
  readonly sessionId?: string | undefined;
}

export interface ClaimedIssue {
  readonly claim: LinearClaim;
  readonly delegateStatus: string;
  /** The org's live policy sha, when the gateway sends it. */
  readonly bundleSha?: string;
}

export interface LinearReleaseRequest {
  readonly claimId: string;
  readonly outcome: "handed_back" | "aborted";
  /** The hand-back (or the abort reason); absent, the gateway writes its own line. */
  readonly body?: string | undefined;
}

export interface ReleasedClaim {
  readonly released: boolean;
  readonly reason?: string;
}

export interface LinearStateTarget {
  readonly type: (typeof TRANSITION_STATE_TYPES)[number];
  readonly name?: string | undefined;
}

const issuePath = (key: string) => `${LINEAR_PATH}/issues/${encodeURIComponent(key)}`;

/** One `/v1/linear` POST: JSON body, never a followed redirect. */
function linearPost(ep: GatesEndpoint, path: string, what: string, body: Record<string, unknown>): Promise<Outcome<Answer>> {
  return exchange(ep, { method: "POST", path, what, maxBytes: LINEAR_REPLY_MAX_BYTES, headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "manual" });
}

const linearRefusal = (a: Answer, what: string): ContractFailure => storeRefusal(a, what, { receipt: true, issue: true });

const issueState = (i: (typeof LinearIssueReply.Type)["issue"]): LinearIssueState => ({
  identifier: i.identifier,
  state: { name: i.state.name, type: i.state.type },
  parent: i.parent === undefined || i.parent === null ? null : { identifier: i.parent.identifier, state: { name: i.parent.state.name, type: i.parent.state.type } },
});

/** The issue's state and its parent's (`GET /v1/linear/issues/{key}`). */
export async function getIssue(ep: GatesEndpoint, key: string): Promise<Outcome<LinearIssueState>> {
  const what = `the read of ${key}`;
  const a = await exchange(ep, { method: "GET", path: issuePath(key), what, maxBytes: LINEAR_REPLY_MAX_BYTES, redirect: "manual" });
  if (!a.ok) return a;
  if (!ok2xx(a.value)) return fail(linearRefusal(a.value, what));
  const d = decoded(a.value, what, LinearIssueReply, "linear-contract/v1");
  return d.ok ? succeed(issueState(d.value.issue)) : d;
}

/** The 409's `fields.holder`, or null when the body carries none this client can read. */
function claimHolder(body: unknown): typeof LinearClaimHolder.Type | null {
  const fields = body !== null && typeof body === "object" ? (body as { fields?: { holder?: unknown } | null }).fields : undefined;
  const d = decodeResult(LinearClaimHolder, fields?.holder);
  return d._tag === "Success" ? d.success : null;
}

/**
 * Reserve `key` for a loop, or bind (refresh) the caller's reservation to a session
 * (`POST /v1/linear/issues/{key}/claim`). Another `claimId`'s live claim is `linear-issue-claimed`,
 * naming the holder. One attempt.
 */
export async function claimIssue(ep: GatesEndpoint, key: string, req: LinearClaimRequest): Promise<Outcome<ClaimedIssue>> {
  const what = `the claim of ${key}`;
  const a = await linearPost(ep, `${issuePath(key)}/claim`, what, {
    claim_id: req.claimId,
    loop: req.loop,
    runtime: req.runtime,
    ...(req.sessionId !== undefined ? { session_id: req.sessionId } : {}),
  });
  if (!a.ok) return a;
  if (a.value.status === 409 && a.value.code === "issue_already_claimed") {
    const h = claimHolder(a.value.body);
    if (h !== null) {
      return fail(
        failure(
          "linear-issue-claimed",
          `${key} is claimed by loop ${h.loop} (runtime ${h.runtime}, session ${h.session_id ?? "none bound"}) since ${h.claimed_at}, until ${h.expires_at}`,
          "Message that loop or wait for its hand-back; nothing was claimed or spawned.",
        ),
      );
    }
  }
  if (!ok2xx(a.value)) return fail(linearRefusal(a.value, what));
  const d = decoded(a.value, what, LinearClaimReply, "linear-contract/v1");
  if (!d.ok) return d;
  return succeed({ claim: d.value.claim, delegateStatus: d.value.delegate_status, ...(d.value.bundle_sha !== undefined ? { bundleSha: d.value.bundle_sha } : {}) });
}

/** Release `claimId`'s claim on `key` (`POST .../release`); a stale id answers `released: false` with its reason. One attempt. */
export async function releaseIssue(ep: GatesEndpoint, key: string, req: LinearReleaseRequest): Promise<Outcome<ReleasedClaim>> {
  const what = `the release of ${key}`;
  const a = await linearPost(ep, `${issuePath(key)}/release`, what, { claim_id: req.claimId, outcome: req.outcome, ...(req.body !== undefined ? { body: req.body } : {}) });
  if (!a.ok) return a;
  if (!ok2xx(a.value)) return fail(linearRefusal(a.value, what));
  const d = decoded(a.value, what, LinearReleaseReply, "linear-contract/v1");
  return d.ok ? succeed({ released: d.value.released, ...(d.value.reason !== undefined ? { reason: d.value.reason } : {}) }) : d;
}

/** Post one comment on `key` as the org's app (`POST .../comments`). One attempt. */
export async function commentIssue(ep: GatesEndpoint, key: string, body: string): Promise<Outcome<{ readonly id: string }>> {
  const what = `the comment on ${key}`;
  const a = await linearPost(ep, `${issuePath(key)}/comments`, what, { body });
  if (!a.ok) return a;
  if (!ok2xx(a.value)) return fail(linearRefusal(a.value, what));
  const d = decoded(a.value, what, LinearCommentReply, "linear-contract/v1");
  return d.ok ? succeed({ id: d.value.comment.id }) : d;
}

/** Move `key` to a state of `to.type` (named `to.name` when given) (`POST .../transition`). A team with no such state is `linear-state-not-found`. */
export async function transitionIssue(ep: GatesEndpoint, key: string, to: LinearStateTarget): Promise<Outcome<LinearIssueState>> {
  const what = `the state update of ${key}`;
  const a = await linearPost(ep, `${issuePath(key)}/transition`, what, { state_type: to.type, ...(to.name !== undefined ? { state: to.name } : {}) });
  if (!a.ok) return a;
  if (a.value.status === 404 && a.value.code === "state_not_found") {
    return fail(failure("linear-state-not-found", `${key}'s team has no ${to.name ?? to.type} state (${to.type})`, "Add the state to the team's workflow, or move the issue by hand."));
  }
  if (!ok2xx(a.value)) return fail(linearRefusal(a.value, what));
  const d = decoded(a.value, what, LinearIssueReply, "linear-contract/v1");
  return d.ok ? succeed(issueState(d.value.issue)) : d;
}

const yakUnresolved = (what: string, fix: string): ContractFailure => ({ ...failure("yak-unresolved", what, fix), exit: 2 });

/**
 * The issue key yak `id` was filed under, on the same host and bearer: `GET /<v>/yaks/observations/<id>`
 * names its cluster, and `GET /<v>/yaks/clusters/<cluster>` its current issue (a ULID reads `/v1`, a
 * UUID `/v0`). A redirect is never followed. The key comes back as the server wrote it; the caller
 * validates it as it would a typed one.
 */
export async function resolveYakIssue(ep: GatesEndpoint, id: string): Promise<Outcome<string>> {
  const prefix = YAK_ULID_RE.test(id) ? "/v1/yaks" : "/v0/yaks";
  const get = async <S extends Schema.Top>(path: string, what: string, missing: string, schema: S): Promise<Outcome<S["Type"]>> => {
    const a = await exchange(ep, { method: "GET", path, what, maxBytes: YAKS_REPLY_MAX_BYTES, redirect: "manual" });
    if (!a.ok) return a;
    if (a.value.status === 404) return fail(yakUnresolved(missing, "Pass the issue key, or check the yak id against its 'recorded:' receipt."));
    if (!ok2xx(a.value)) return fail(storeRefusal(a.value, what));
    return decoded(a.value, what, schema);
  };
  const obs = await get(`${prefix}/observations/${encodeURIComponent(id)}`, `the lookup of yak ${id}`, `yak ${id} was not found`, YakObservationReply);
  if (!obs.ok) return obs;
  const cluster = obs.value.cluster_id ?? "";
  if (cluster === "") return fail(yakUnresolved(`yak ${id} has no cluster yet`, "Re-run once the yak is clustered, or pass the issue key."));
  const c = await get(`${prefix}/clusters/${encodeURIComponent(cluster)}`, `the lookup of yak ${id}'s cluster`, `yak ${id}'s cluster was not found`, YakClusterReply);
  if (!c.ok) return c;
  const key = c.value.current_issue_identifier ?? "";
  if (key === "") return fail(yakUnresolved(`yak ${id} has no tracker issue yet`, "File an issue for the yak or wait for one to be filed, then pass its key."));
  return succeed(key);
}
