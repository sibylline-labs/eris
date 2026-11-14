/**
 * policy.ts — the policy `eris socrates classify` and `submit` score under:
 * the org's policy, cached from the endpoint, merged with the stricter-only
 * layer the repo's nearest `eris.yaml` sets under `socrates.policy`.
 *
 * Invariants:
 *   - The repo layer is the contract's `SocratesRepoPolicy`: it turns a hard
 *     gate on, raises the threshold, pins auto-resolve off, and nothing else.
 *     Any other key under `socrates` or `socrates.policy` is refused, never
 *     dropped (`socrates-repo-policy-invalid`, naming the file).
 *   - A layer that would loosen the org policy is refused, never clamped
 *     (`mergeRepoPolicy`; `socrates-repo-policy-looser`).
 *   - The org policy is the cache's only when the cache was fetched for the
 *     rubric scoring; else the rubric's defaults. A cache that cannot be read
 *     or decoded is absent: reading it never fails a verb.
 *   - The cache is written whole (a temp file renamed over it), only from a
 *     reply decoded through the contract's `SocratesPolicyResponse`.
 *   - A stamp carries a policy hash at most `POLICY_CACHE_TTL_MS` old: a cache
 *     fetched longer ago (or in the future) is fetched again before it is read
 *     (`readFreshPolicy`). Scoring locally (`classify`) reads whatever is cached.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { defaultPolicy, mergeRepoPolicy, type RubricDefinition, type ScoringPolicy } from "eris/socrates-core";
import { z } from "zod";
import { CliExit, nearestErisYaml, type VerbContext } from "../../src/cli/plugin";
import { fail, postSocrates, printable, type SocratesDeps, type SocratesEndpoint } from "./client";
import { SocratesRepoPolicy } from "./socrates-contract.v1";
import { SOCRATES_ROUTES, SocratesPolicyResponse, SocratesPolicyResult } from "./socrates-contract.v1.verbs";

/** How long a cached policy is stamped as it stands; older is fetched again first. */
export const POLICY_CACHE_TTL_MS = 60 * 60 * 1000;

/** What `~/.eris/socrates-policy.json` holds: the endpoint's policy answer and when it was fetched. */
export const PolicyCache = SocratesPolicyResult.extend({ fetched_at: z.string().datetime({ offset: true }) });
export type PolicyCache = z.infer<typeof PolicyCache>;

/** The `socrates` block of an `eris.yaml`: only `policy`. */
const ErisYamlSocrates = z.object({ policy: SocratesRepoPolicy.optional() }).strict();

/** The repo layer and the file it came from. */
export interface RepoLayer {
  readonly path: string;
  readonly policy: SocratesRepoPolicy;
}

/** The policy a verb scores under, and what it was made of. */
export interface LocalPolicy {
  readonly policy: ScoringPolicy;
  /** The org policy's hash when the cache's rubric is the one scoring; null for the rubric's defaults. */
  readonly policy_hash: string | null;
  readonly repo_policy: SocratesRepoPolicy | null;
}

export function policyCachePath(ctx: VerbContext, deps: SocratesDeps): string {
  return join(deps.home ?? ctx.env.HOME ?? homedir(), ".eris", "socrates-policy.json");
}

/** The nearest `eris.yaml`'s `socrates.policy`, or undefined when it sets none. */
export async function readRepoPolicy(ctx: VerbContext, cwd: string): Promise<RepoLayer | undefined> {
  const found = await nearestErisYaml(cwd);
  if (found === undefined) return undefined;
  // A manifest that cannot be read could carry a stricter layer: refuse it rather than score without it.
  if (!found.ok) fail(ctx, "socrates-repo-policy-invalid", `${found.path}: ${printable(found.error)}`, "fix the eris.yaml so it parses, then run the command again");
  const { path, value } = found;
  if (value === null || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "socrates")) return undefined;
  const parsed = ErisYamlSocrates.safeParse((value as Record<string, unknown>).socrates);
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${["socrates", ...i.path].join(".")}: ${i.message}${i.code === "unrecognized_keys" ? ` (${i.keys.join(", ")})` : ""}`).join("; ");
    fail(ctx, "socrates-repo-policy-invalid", `${path}: ${printable(why)}`, "socrates.policy may only set gates.<gate>.enabled: true, threshold: <number >= 0> and auto_resolve: false");
  }
  return parsed.data.policy === undefined ? undefined : { path, policy: parsed.data.policy };
}

/** The cached org policy, or undefined when the file is missing, unreadable or not a cache. */
export async function readPolicyCache(ctx: VerbContext, deps: SocratesDeps): Promise<PolicyCache | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(policyCachePath(ctx, deps), "utf8"));
  } catch {
    return undefined;
  }
  const parsed = PolicyCache.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** A fetched policy, and the hash the cache held before it replaced it (absent when it held none). */
export interface RefreshedPolicy {
  readonly cache: PolicyCache;
  readonly previous_hash: string | undefined;
}

/** GET the org's current policy and cache it; the endpoint's refusals fail as every socrates call does. */
export async function refreshPolicy(ctx: VerbContext, deps: SocratesDeps, endpoint: SocratesEndpoint): Promise<RefreshedPolicy> {
  const previous_hash = (await readPolicyCache(ctx, deps))?.policy_hash;
  const reply = await postSocrates(ctx, deps, endpoint, { path: SOCRATES_ROUTES.policy.path, method: "GET", query: {}, decoder: SocratesPolicyResponse, subject: "the policy request" });
  const cache: PolicyCache = { ...reply, fetched_at: new Date().toISOString() };
  const file = policyCachePath(ctx, deps);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
    await writeFile(tmp, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o644 });
    await rename(tmp, file);
  } catch {
    // An unwritten cache is refetched by the next submit; the policy in hand is still current.
    await rm(tmp, { force: true }).catch(() => undefined);
  }
  return { cache, previous_hash };
}

/** The cached policy when it was fetched within `POLICY_CACHE_TTL_MS`, else the endpoint's current one (cached). */
export async function readFreshPolicy(ctx: VerbContext, deps: SocratesDeps, endpoint: SocratesEndpoint): Promise<PolicyCache> {
  const cache = await readPolicyCache(ctx, deps);
  if (cache !== undefined) {
    const age = Date.now() - Date.parse(cache.fetched_at);
    if (age >= 0 && age < POLICY_CACHE_TTL_MS) return cache;
  }
  return (await refreshPolicy(ctx, deps, endpoint)).cache;
}

/**
 * `refreshPolicy` after the candidate is already sent: a failure must not fail
 * the submit, so its block is dropped and the stale cache removed (the next
 * stamped submit fetches the policy first). False when the refresh failed.
 */
export async function refreshPolicyAfterSubmit(ctx: VerbContext, deps: SocratesDeps, endpoint: SocratesEndpoint): Promise<boolean> {
  try {
    await refreshPolicy({ ...ctx, stderr: { write: () => true } }, deps, endpoint);
    return true;
  } catch (err) {
    if (!(err instanceof CliExit)) throw err;
    await rm(policyCachePath(ctx, deps), { force: true }).catch(() => undefined);
    return false;
  }
}

/** The org policy (cached, or the rubric's defaults) with the repo layer merged in; a looser layer fails. */
export function localPolicy(ctx: VerbContext, rubric: RubricDefinition, cache: PolicyCache | undefined, repo: RepoLayer | undefined): LocalPolicy {
  const cached = cache !== undefined && cache.rubric_version === rubric.version ? cache : undefined;
  const org: ScoringPolicy = cached?.policy ?? defaultPolicy(rubric);
  const policy_hash = cached?.policy_hash ?? null;
  if (repo === undefined) return { policy: org, policy_hash, repo_policy: null };
  const merged = mergeRepoPolicy(rubric, org, repo.policy);
  if (!merged.ok) fail(ctx, "socrates-repo-policy-looser", `${repo.path}: ${merged.problems.join("; ")}`, "raise threshold to at least the org's or remove it; name only hard gates");
  return { policy: merged.policy, policy_hash, repo_policy: repo.policy };
}

/** JSON with every object's keys sorted and undefined members dropped: the server's hash input, byte for byte. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The hash the server gives `rubric`'s default policy when the org chose no Canon doc: sha256 of the
 * canonical `{rubric_version, policy}`. Stamped when the cached org policy belongs to another
 * rubric, so the server's rubric-keyed resolve agrees instead of reclassifying every submit.
 */
export function defaultPolicyHash(rubric: RubricDefinition): string {
  return createHash("sha256").update(canonicalJson({ rubric_version: rubric.version, policy: defaultPolicy(rubric) })).digest("hex");
}

/** One line naming the policy a verdict was scored under. */
export function policyLine(p: Pick<LocalPolicy, "policy_hash" | "repo_policy">): string {
  return `policy: ${p.policy_hash === null ? "rubric defaults" : `org ${p.policy_hash.slice(0, 12)}`}${p.repo_policy === null ? "" : " + repo layer"}`;
}
