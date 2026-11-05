/**
 * policy-verb.ts — `eris socrates policy [--cached]`, loaded only when `eris socrates policy`
 * dispatches (./submit.ts routes the group).
 *
 * Prints the policy a stamp will be scored under: the org's, fetched from the endpoint and cached
 * in ~/.eris/socrates-policy.json, merged with the stricter-only layer the repo's nearest
 * `eris.yaml` sets under `socrates.policy` (./policy.ts). The module is named for the verb, not
 * `policy.ts`, which holds the cache and the merge every stamping verb shares.
 *
 * Invariants:
 *   - Without `--cached`, one GET refreshes the cache (the policy in hand is the one cached), and
 *     the previous hash is shown beside the new one when they differ.
 *   - `--cached` makes no request and needs no login: it prints the cache, and fails
 *     (`socrates-policy-not-cached`) when there is none, never printing the rubric's defaults as if
 *     they were the org's.
 *   - The repo layer is merged as `classify` merges it, so a layer that loosens the org policy is
 *     refused here too. For a rubric this build does not score, the served policy is printed as
 *     it is and the layer is reported as not applied: it cannot be checked against questions this
 *     build does not know.
 */

import { type RubricVersion, rubricFor } from "eris/socrates-core";
import { readArgs, type VerbContext } from "../../src/cli/plugin";
import { fail, printable, type SocratesDeps, socratesEndpoint } from "./client";
import plugin from "./index";
import { localPolicy, type PolicyCache, policyCachePath, readPolicyCache, readRepoPolicy, refreshPolicy } from "./policy";
import type { SocratesRepoPolicy } from "./socrates-contract.v1";

export const POLICY_USAGE = `Usage: eris socrates policy [--cached]

Print the org's scoring policy as stamps carry it, and refresh the cache:

  org policy: <hash12> (<rubric>)
  changed: <old12> -> <new12>        only when the refresh moved the hash
  threshold: <n>[ (org <n>)]         the repo layer's, when it raised it
  enabled gates: <questions>
  repo layer: none | <eris.yaml> (<what it sets>)

The policy is fetched from the endpoint and written to ~/.eris/socrates-policy.json
(a stamp refetches a copy over an hour old). The repo layer is the nearest
eris.yaml's socrates.policy, which can only make the org's policy stricter;
'eris socrates classify --help' shows its keys. --output json prints
{rubric_version, policy_hash, cached, fetched_at, org_policy, policy,
repo_policy, repo_policy_path, changed?: {from, to}, contract_version}: policy
is the effective policy, org_policy the one served.

  --cached   print the cached policy; make no request (and need no login). Fails
             when nothing is cached

Sign in first with 'eris login' (not needed with --cached).
`;

/** What the repo layer sets, in a few words. */
function layerSummary(layer: SocratesRepoPolicy): string {
  const parts: string[] = [];
  if (layer.threshold !== undefined) parts.push(`threshold ${layer.threshold}`);
  const gates = Object.keys(layer.gates ?? {});
  if (gates.length > 0) parts.push(`gates ${gates.join(", ")}`);
  if (layer.auto_resolve === false) parts.push("auto_resolve off");
  return parts.length === 0 ? "sets nothing" : parts.join(", ");
}

export async function runPolicy(args: string[], ctx: VerbContext, deps: SocratesDeps = {}): Promise<number> {
  const a = readArgs(plugin.rows, "socrates policy", args, ctx, { help: POLICY_USAGE });
  if (a === null) return 0;
  const cached = a.flags["--cached"] === true;
  // The layer is read first: an eris.yaml that cannot be read fails before any request.
  const repo = await readRepoPolicy(ctx, deps.cwd ?? process.cwd());

  let cache: PolicyCache;
  let previous: string | undefined;
  if (cached) {
    const found = await readPolicyCache(ctx, deps);
    if (found === undefined) fail(ctx, "socrates-policy-not-cached", `no policy is cached (${printable(policyCachePath(ctx, deps))} is absent or is not a cached policy)`, "run 'eris socrates policy' to fetch it, or drop --cached");
    cache = found;
  } else {
    const refreshed = await refreshPolicy(ctx, deps, await socratesEndpoint(ctx, deps));
    cache = refreshed.cache;
    previous = refreshed.previous_hash;
  }
  const changed = previous !== undefined && previous !== cache.policy_hash ? { from: previous, to: cache.policy_hash } : undefined;

  const rubric = rubricFor(cache.rubric_version as RubricVersion);
  const local = rubric === undefined ? undefined : localPolicy(ctx, rubric, cache, repo);
  const effective = local?.policy ?? cache.policy;
  const applied = local?.repo_policy ?? null;

  if (ctx.format === "json") {
    const record = {
      rubric_version: cache.rubric_version,
      policy_hash: cache.policy_hash,
      cached,
      fetched_at: cache.fetched_at,
      org_policy: cache.policy,
      policy: effective,
      repo_policy: applied,
      repo_policy_path: repo === undefined ? null : repo.path,
      ...(changed === undefined ? {} : { changed }),
      contract_version: cache.contract_version,
    };
    ctx.stdout.write(`${JSON.stringify(record)}\n`);
    return 0;
  }

  const lines = [`org policy: ${cache.policy_hash.slice(0, 12)} (${cache.rubric_version})`];
  if (changed !== undefined) lines.push(`changed: ${changed.from.slice(0, 12)} -> ${changed.to.slice(0, 12)}`);
  lines.push(`threshold: ${effective.threshold}${effective.threshold === cache.policy.threshold ? "" : ` (org ${cache.policy.threshold})`}`);
  lines.push(`enabled gates: ${Object.entries(effective.gates).filter(([, g]) => g.enabled).map(([id]) => id).join(", ")}`);
  if (repo === undefined) lines.push("repo layer: none");
  else if (applied === null) lines.push(`repo layer: ${printable(repo.path)} (not applied: ${cache.rubric_version} is not a rubric this build scores)`);
  else lines.push(`repo layer: ${printable(repo.path)} (${layerSummary(applied)})`);
  ctx.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
