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
import { BUNDLE_DOCTRINE_FILE, BUNDLE_PROFILES_FILE, type ContractFailure, fail, fetchOrgPolicy, gatesEndpoint, type Outcome, succeed } from "eris/gates-contract";
import { CliExit, readArgs, renderFailureBlock, renderWarnLines, RESOLVER_OWN_HEADING_SLUGS, resolveOrgBearer, type VerbContext } from "../../src/cli/plugin";
import plugin from "./index";
import { linkedDoctrineFile, localModified, materialize, orgPath, orgTree } from "./org-tree";

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

/** What a pull wrote: the org, the bundle it verified, and the tree it swapped in. */
export interface Pulled {
  readonly org: string;
  readonly bundle_sha: string;
  readonly dir: string;
}

/** The org this directory acts as, its login bearer and the home its trees live under. */
export interface ResolvedOrg {
  readonly org: string;
  readonly home: string;
  readonly bearer: { readonly url: string; readonly token: string };
}

/** The org bearer: the org this directory acts as, or the slugged failure that names the login to run. `why` ends the sentence "so there is no org policy to ..." */
export async function resolveOrg(ctx: VerbContext, deps: PullDeps, why: string): Promise<Outcome<ResolvedOrg>> {
  const h = home(ctx, deps);
  const bearer = await resolveOrgBearer({ home: h, env: ctx.env, cwd: deps.cwd ?? process.cwd() });
  if ("reason" in bearer) {
    const slug = RESOLVER_OWN_HEADING_SLUGS.has(bearer.slug) ? bearer.slug : "eris-login-required";
    const fix = slug === "eris-login-required" ? "Run 'eris login' once on this machine (or set ERIS_YAKS_TOKEN to a sib_ service token), then re-run." : bearer.fix;
    return fail({ slug, what: bearer.reason, fix, docs: `docs/ERRORS.md#${slug}`, exit: 3 });
  }
  const org = bearer.value.org;
  if (org === null) {
    return fail({
      slug: "doctrine-org-unresolved",
      what: `the eris login bearer for this directory names no org, so ${why}`,
      fix: "Run 'eris login' to mint an org bearer (sib_<org>_...), or set ERIS_ORG to the org this directory acts as.",
      docs: "docs/ERRORS.md#doctrine-org-unresolved",
      exit: 3,
    });
  }
  return succeed({ org, home: h, bearer: { url: bearer.value.url, token: bearer.value.token } });
}

/** Pull the org this directory acts as: its bundle fetched, verified and swapped in, or the failure. */
export async function pullOrg(ctx: VerbContext, deps: PullDeps = {}): Promise<Outcome<Pulled>> {
  const resolved = await resolveOrg(ctx, deps, "there is no org policy to pull");
  if (!resolved.ok) return resolved;
  const { org, home: h, bearer } = resolved.value;
  const ep = gatesEndpoint(bearer.url, bearer.token, { fetch: deps.fetch });
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

/**
 * The org's pulled tree as another verb group reads it (the gate verbs, composed in plugins/index.ts):
 * the verified tree's own doctrine and profiles files and the bundle sha they hash to. Null when no org
 * resolves or none is pulled; an edited tree is `doctrine-local-modified`.
 */
export async function pulledTree(ctx: VerbContext, deps: PullDeps = {}): Promise<Outcome<{ doctrineFile: string; profilesFile: string; bundleSha: string } | null>> {
  const h = home(ctx, deps);
  const bearer = await resolveOrgBearer({ home: h, env: ctx.env, cwd: deps.cwd ?? process.cwd() });
  const org = "reason" in bearer ? null : bearer.value.org;
  if (org === null) return succeed(null);
  const tree = await orgTree(h, org);
  if (!tree.ok) return tree;
  if (tree.value === null) return succeed(null);
  const { dir, manifest } = tree.value;
  return succeed({ doctrineFile: join(dir, BUNDLE_DOCTRINE_FILE), profilesFile: join(dir, BUNDLE_PROFILES_FILE), bundleSha: manifest.bundle_sha });
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

/** A loop slug in a verified tree's manifest: `loops/<slug>.md`. */
const LOOP_FILE = /^loops\/([^/]+)\.md$/;

/**
 * The org's verified tree as the loop verbs read it (composed in plugins/index.ts): pulled first when
 * this machine has none, or when `claimSha` (the claim reply's view of the org's policy) names another
 * bundle; read as it is otherwise. An edited tree is refused (`doctrine-local-modified`), never pulled
 * over and never pushed: saving it is the operator's act. A pull that lands a bundle newer than the
 * claim's is used as it is.
 */
export async function freshTree(ctx: VerbContext, claimSha: string | undefined, deps: PullDeps = {}): Promise<Outcome<{ org: string; dir: string; bundleSha: string; loops: string[] }>> {
  const resolved = await resolveOrg(ctx, deps, "there is no org policy to run a loop from");
  if (!resolved.ok) return resolved;
  const { org, home: h } = resolved.value;
  let tree = await orgTree(h, org);
  if (!tree.ok) {
    const f = tree.failure;
    return f.slug === "doctrine-local-modified" ? fail({ ...f, fix: `Run 'eris doctrine push' to save the edits as the org's policy, or 'eris doctrine pull' to discard them, then re-run.` }) : tree;
  }
  if (tree.value === null || (claimSha !== undefined && claimSha !== tree.value.manifest.bundle_sha)) {
    const pulled = await pullOrg(ctx, deps);
    if (!pulled.ok) return pulled;
    tree = await orgTree(h, org);
    if (!tree.ok) return tree;
    if (tree.value === null) return fail(localModified(org, "the pull reported success but left no tree"));
  }
  const { dir, manifest } = tree.value;
  const loops = Object.keys(manifest.files)
    .flatMap((rel) => {
      const m = LOOP_FILE.exec(rel);
      return m === null ? [] : [m[1]!];
    })
    .sort();
  return succeed({ org, dir, bundleSha: manifest.bundle_sha, loops });
}
