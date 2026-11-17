/**
 * pull.ts — `eris doctrine pull` and `eris doctrine path`: the org's hosted policy, fetched over the
 * gates client (docs/dev/GATES-CLIENT.md) on the `eris login` bearer of the org this directory acts
 * as, and the verified tree it is written to (org-tree.ts).
 *
 * `pull` never reads the old tree, so it is the fix for an edited one. `path` verifies the tree
 * before it names it, so a path it prints is one the offline verbs can trust.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { BUNDLE_PROFILES_FILE, type ContractFailure, fail, fetchOrgPolicy, gatesEndpoint, type Outcome, succeed } from "eris/gates-contract";
import { CliExit, readArgs, renderFailureBlock, renderWarnLines, resolveOrgBearer, type VerbContext } from "../../src/cli/plugin";
import plugin from "./index";
import { linkedDoctrineFile, materialize, orgPath, orgTree } from "./org-tree";

const ROWS = plugin.rows;

/** What the network and the clock are in a test; the process's own when absent. */
export interface PullDeps {
  readonly home?: string;
  readonly cwd?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

export const PULL_USAGE = `Usage: eris doctrine pull [--output json]

Fetch the org's policy (GET /v1/gates/policy and /settings, gates-contract/v1.5)
on the 'eris login' bearer of the org this directory acts as (ERIS_ORG, else
repo.org in eris.yaml, else the default org), check its bundle_sha, and write
~/.eris/doctrine/<orgId>/{manifest.json,doctrine.md,profiles.yaml,loops/*.md}.
The new tree is verified on disk before it replaces the old one, so a failed
pull leaves the previous copy in place. Prints '<orgId>\\t<bundle_sha>'; JSON:
{ org, bundle_sha, dir }.
`;

export const PATH_USAGE = `Usage: eris doctrine path

Print the pulled doctrine.md of the org this directory acts as, through the
org's link (~/.eris/doctrine/<orgId>/doctrine.md), after verifying the tree
offline. No pulled policy exits 3 (doctrine-file-missing); a tree edited since
the pull exits 3 (doctrine-local-modified). Pass the path to the offline verbs:
eris doctrine check --file "$(eris doctrine path)".
`;

function stop(ctx: VerbContext, f: ContractFailure): never {
  ctx.stderr.write(renderFailureBlock({ slug: f.slug, what: f.what, fix: f.fix, docs: f.docs }, ctx.erisDir));
  throw new CliExit(f.exit);
}

const home = (ctx: VerbContext, deps: PullDeps): string => deps.home ?? ctx.env.HOME ?? homedir();

/** The slugs the bearer resolver names that keep their own heading; every other miss is a login to run. */
const RESOLVER_SLUGS = new Set(["yak-url-unresolved", "org-not-signed-in", "org-selector-invalid", "org-token-mismatch"]);

/** What a pull wrote: the org, the bundle it verified, and the tree it swapped in. */
export interface Pulled {
  readonly org: string;
  readonly bundle_sha: string;
  readonly dir: string;
}

/** Pull the org this directory acts as: its bundle fetched, verified and swapped in, or the failure. */
export async function pullOrg(ctx: VerbContext, deps: PullDeps = {}): Promise<Outcome<Pulled>> {
  const h = home(ctx, deps);
  const bearer = await resolveOrgBearer({ home: h, env: ctx.env, cwd: deps.cwd ?? process.cwd() });
  if ("reason" in bearer) {
    const slug = RESOLVER_SLUGS.has(bearer.slug) ? bearer.slug : "eris-login-required";
    const fix = slug === "eris-login-required" ? "Run 'eris login' once on this machine (or set ERIS_YAKS_TOKEN to a sib_ service token), then re-run." : bearer.fix;
    return fail({ slug, what: bearer.reason, fix, docs: `docs/ERRORS.md#${slug}`, exit: 3 });
  }
  const org = bearer.value.org;
  if (org === null) {
    return fail({
      slug: "doctrine-org-unresolved",
      what: "the eris login bearer for this directory names no org, so there is no org policy to pull",
      fix: "Run 'eris login' to mint an org bearer (sib_<org>_...), or set ERIS_ORG to the org this directory acts as.",
      docs: "docs/ERRORS.md#doctrine-org-unresolved",
      exit: 3,
    });
  }
  const ep = gatesEndpoint(bearer.value.url, bearer.value.token, { fetch: deps.fetch });
  if (!ep.ok) return ep;
  const pulled = await fetchOrgPolicy(ep.value);
  if (!pulled.ok) return pulled;
  const dir = await materialize(h, org, pulled.value, (deps.now ?? (() => new Date()))());
  if (!dir.ok) return dir;
  return succeed({ org, bundle_sha: pulled.value.bundle_sha, dir: dir.value });
}

/** `eris doctrine pull`. */
export async function runPull(args: string[], ctx: VerbContext, deps: PullDeps = {}): Promise<number> {
  const a = readArgs(ROWS, "doctrine pull", args, ctx, { help: PULL_USAGE });
  if (a === null) return 0;
  const pulled = await pullOrg(ctx, deps);
  if (!pulled.ok) stop(ctx, pulled.failure);
  const { org, bundle_sha, dir } = pulled.value;
  if (ctx.format === "json") ctx.stdout.write(`${JSON.stringify({ org, bundle_sha, dir })}\n`);
  else ctx.stdout.write(`${org}\t${bundle_sha}\n`);
  return 0;
}

/**
 * The pull a build runs after a successful `eris login`, so the org has its doctrine without a second
 * command. A failure is one WARN naming its slug, never the login's exit: the token is written either way.
 */
export function seedAfterLogin(deps: PullDeps = {}): (ctx: VerbContext) => Promise<void> {
  return async (ctx) => {
    const pulled = await pullOrg(ctx, deps);
    if (pulled.ok) ctx.stderr.write(`INFO pulled org ${pulled.value.org} policy ${pulled.value.bundle_sha}\n`);
    else ctx.stderr.write(renderWarnLines(`eris login: this org's policy was not pulled (${pulled.failure.slug}); run 'eris doctrine pull'`, pulled.failure.slug));
  };
}

/**
 * The files the offline verbs read when no flag or build default names one: the pulled, verified tree
 * of the org this directory acts as, through the org's link. `{}` when no org resolves or none is
 * pulled; an edited tree is `doctrine-local-modified`, never read.
 */
export async function pulledDefaults(ctx: VerbContext, deps: PullDeps = {}): Promise<Outcome<{ doctrineFile?: string; profilesFile?: string }>> {
  const h = home(ctx, deps);
  const bearer = await resolveOrgBearer({ home: h, env: ctx.env, cwd: deps.cwd ?? process.cwd() });
  const org = "reason" in bearer ? null : bearer.value.org;
  if (org === null) return succeed({});
  const tree = await orgTree(h, org);
  if (!tree.ok) return tree;
  if (tree.value === null) return succeed({});
  return succeed({ doctrineFile: linkedDoctrineFile(h, org), profilesFile: join(orgPath(h, org), BUNDLE_PROFILES_FILE) });
}

/** `eris doctrine path`. */
export async function runPath(args: string[], ctx: VerbContext, deps: PullDeps = {}): Promise<number> {
  const a = readArgs(ROWS, "doctrine path", args, ctx, { help: PATH_USAGE });
  if (a === null) return 0;
  const h = home(ctx, deps);
  const missing = (why: string): ContractFailure => ({
    slug: "doctrine-file-missing",
    what: `eris doctrine path: ${why}`,
    fix: "Run 'eris login', then 'eris doctrine pull'; or pass --file <path> to the verb that reads it.",
    docs: "docs/ERRORS.md#doctrine-file-missing",
    exit: 3,
  });
  const bearer = await resolveOrgBearer({ home: h, env: ctx.env, cwd: deps.cwd ?? process.cwd() });
  const org = "reason" in bearer ? null : bearer.value.org;
  if (org === null) stop(ctx, missing("no signed-in org resolves for this directory, so no org policy is pulled"));
  const tree = await orgTree(h, org);
  if (!tree.ok) stop(ctx, tree.failure);
  if (tree.value === null) stop(ctx, missing(`no org policy is pulled for org ${org}`));
  ctx.stdout.write(`${linkedDoctrineFile(h, org)}\n`);
  return 0;
}
