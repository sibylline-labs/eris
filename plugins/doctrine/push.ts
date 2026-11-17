/**
 * push.ts — `eris doctrine push`: save the org's locally edited policy tree as its hosted policy over the
 * gates client (docs/dev/GATES-CLIENT.md), then swap in the saved bundle as a verified tree.
 *
 * Invariants:
 *  - The live policy is read first, and a push is refused (`doctrine-push-stale`) unless its `bundle_sha` is
 *    the tree manifest's: the edits were made on that base, so saving them over a newer save would revert it.
 *  - A tree whose files decode to the base bundle saves nothing: the live policy is re-materialized.
 *  - The save is sent once. On any refusal the tree is left exactly as the operator left it.
 */

import { lstatSync, realpathSync } from "node:fs";
import { type ContractFailure, fail, fetchOrgPolicy, gatesEndpoint, type Outcome, putOrgPolicy, succeed } from "eris/gates-contract";
import { CliExit, readArgs, renderFailureBlock, resolveOrgBearer, type VerbContext } from "../../src/cli/plugin";
import plugin from "./index";
import { materialize, orgPath, readLocalBundle } from "./org-tree";
import { type PullDeps, resolveOrg } from "./pull";

const ROWS = plugin.rows;

export const PUSH_USAGE = `Usage: eris doctrine push [--output json]

Save the org's policy as you edited it under ~/.eris/doctrine/<orgId>/
(doctrine.md, profiles.yaml, loops/<slug>.md; manifest.json is read for the
base only) with PUT /v1/gates/policy on the 'eris login' bearer, then replace
the tree with the saved bundle, verified (so 'eris doctrine check' passes). The
saved files are re-rendered from the bundle, so YAML comments and layout are
normalized. Refused, with the tree left as it is, when the live policy moved
since your pull (doctrine-push-stale), when the tree holds a file a bundle does
not carry or does not decode (doctrine-push-invalid), or when the gateway does
not take saves on this bearer (doctrine-push-refused: the bearer is not an org
admin's, or the org's gates_policy_dev_push flag is off). An unedited tree
saves nothing. Prints '<orgId>\\t<bundle_sha>\\t<version|unchanged>'; JSON:
{ org, bundle_sha, version, saved_at, dir, pushed }.
`;

/** What a push did: the org, the bundle now live, the version it made (null when nothing was saved) and the tree swapped in. */
export interface Pushed {
  readonly org: string;
  readonly bundle_sha: string;
  readonly version: number | null;
  readonly saved_at: string | null;
  readonly dir: string;
  readonly pushed: boolean;
}

const notPulled = (org: string): ContractFailure => ({
  slug: "doctrine-file-missing",
  what: `~/.eris/doctrine/${org}/ holds no pulled policy, so there is no base to push edits from`,
  fix: "Run 'eris doctrine pull', edit the files under ~/.eris/doctrine/<orgId>/, then 'eris doctrine push'.",
  docs: "docs/ERRORS.md#doctrine-file-missing",
  exit: 3,
});

const stale = (org: string, base: string, live: string): ContractFailure => ({
  slug: "doctrine-push-stale",
  what: `~/.eris/doctrine/${org}/ was edited on policy ${base}, but the org's live policy is now ${live}; pushing would revert that save`,
  fix: "Copy your edited files out of ~/.eris/doctrine/<orgId>/, run 'eris doctrine pull', re-apply them, then 'eris doctrine push'.",
  docs: "docs/ERRORS.md#doctrine-push-stale",
  exit: 3,
});

/** Push the tree of the org this directory acts as: the live bundle it now holds, or the failure. */
export async function pushOrg(ctx: VerbContext, deps: PullDeps = {}): Promise<Outcome<Pushed>> {
  const resolved = await resolveOrg(ctx, deps, "there is no org policy to push");
  if (!resolved.ok) return resolved;
  const { org, home, bearer } = resolved.value;
  let dir: string;
  try {
    lstatSync(orgPath(home, org));
    dir = realpathSync(orgPath(home, org));
  } catch {
    return fail(notPulled(org));
  }
  const local = await readLocalBundle(dir, org);
  if (!local.ok) return local;
  const ep = gatesEndpoint(bearer.url, bearer.token, { fetch: deps.fetch });
  if (!ep.ok) return ep;
  const live = await fetchOrgPolicy(ep.value);
  if (!live.ok) return live;
  if (live.value.bundle_sha !== local.value.manifest.bundle_sha) return fail(stale(org, local.value.manifest.bundle_sha, live.value.bundle_sha));
  const now = (deps.now ?? (() => new Date()))();
  if (local.value.bundle_sha === live.value.bundle_sha) {
    const kept = await materialize(home, org, live.value, now);
    if (!kept.ok) return kept;
    return succeed({ org, bundle_sha: live.value.bundle_sha, version: null, saved_at: null, dir: kept.value, pushed: false });
  }
  const saved = await putOrgPolicy(ep.value, local.value.bundle);
  if (!saved.ok) return saved;
  const reread = await fetchOrgPolicy(ep.value);
  if (!reread.ok) return reread;
  const swapped = await materialize(home, org, reread.value, now);
  if (!swapped.ok) return swapped;
  return succeed({ org, bundle_sha: reread.value.bundle_sha, version: saved.value.version, saved_at: saved.value.saved_at, dir: swapped.value, pushed: true });
}

/** `eris doctrine push`. */
export async function runPush(args: string[], ctx: VerbContext, deps: PullDeps = {}): Promise<number> {
  const a = readArgs(ROWS, "doctrine push", args, ctx, { help: PUSH_USAGE });
  if (a === null) return 0;
  const pushed = await pushOrg(ctx, deps);
  if (!pushed.ok) {
    ctx.stderr.write(renderFailureBlock({ slug: pushed.failure.slug, what: pushed.failure.what, fix: pushed.failure.fix, docs: pushed.failure.docs }, ctx.erisDir));
    throw new CliExit(pushed.failure.exit);
  }
  if (ctx.format === "json") ctx.stdout.write(`${JSON.stringify(pushed.value)}\n`);
  else ctx.stdout.write(`${pushed.value.org}\t${pushed.value.bundle_sha}\t${pushed.value.version ?? "unchanged"}\n`);
  return 0;
}
