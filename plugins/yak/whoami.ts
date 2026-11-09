/**
 * whoami.ts — `eris whoami`: the org this directory acts as, why that org, and
 * where its bearer comes from, without the bearer. Loaded only when it
 * dispatches (the manifest is ./index.ts).
 *
 * The org comes from `resolveOrgSelection` (`ERIS_ORG`, else `repo.org` in the
 * nearest `eris.yaml` that names one, else the default org) and the bearer
 * from `resolveOrgBearer`, the resolver every org-bound command uses, so what
 * this prints is what `eris yak` would send.
 *
 * Invariants:
 *   - No token is ever written to stdout or stderr, in text or JSON: only the
 *     org ids, the token's source (`env` or `config`) and the url.
 *   - A selection that would fail closed in another command fails here too,
 *     with the same slug and fix, and exits 1.
 */

import { readArgs, readYaksFileConfig, renderFailureBlock, resolveOrgBearer, tokenOrg, yaksConfigPath, type OrgSelection, type VerbContext } from "../../src/cli/plugin";
import plugin from "./index";

export const WHOAMI_USAGE = `Usage: eris whoami

Print the org this directory acts as and why (ERIS_ORG, a repo's eris.yaml
repo.org, or this machine's default org), where its token comes from and the
url it goes to, and every org this machine is signed in to. Never prints a
token. Exits 1, with the fix, when the selected org cannot be used here.
`;

export interface WhoamiDeps {
  home?: string;
  cwd?: string;
}

function why(selection: OrgSelection): string {
  if (selection.source === "env") return "ERIS_ORG";
  if (selection.source === "eris.yaml") return `repo.org in ${selection.path}`;
  return "this machine's default org";
}

export async function runWhoami(args: string[], ctx: VerbContext, deps: WhoamiDeps = {}): Promise<number> {
  const a = readArgs(plugin.rows, "whoami", args, ctx, { help: WHOAMI_USAGE });
  if (a === null) return 0;
  const home = deps.home ?? ctx.env.HOME ?? "";
  const cwd = deps.cwd ?? process.cwd();

  const bearer = await resolveOrgBearer({ home, env: ctx.env, cwd });
  if ("reason" in bearer) {
    ctx.stderr.write(renderFailureBlock({ slug: bearer.slug, what: bearer.reason, fix: bearer.fix }, ctx.erisDir));
    return 1;
  }
  const b = bearer.value;
  const file = await readYaksFileConfig(home);
  const stored = "value" in file ? file.value : {};
  const defaultOrg = tokenOrg(stored.token);
  const signedIn = [...(defaultOrg !== null ? [defaultOrg] : []), ...Object.keys(stored.orgs ?? {}).sort()];

  const record = {
    org: b.org,
    source: b.selection.source,
    ...(b.selection.source === "eris.yaml" ? { path: b.selection.path } : {}),
    default: b.isDefault,
    token_source: b.tokenSource,
    url: b.url,
    signed_in: signedIn,
    default_org: defaultOrg,
    file: yaksConfigPath(home),
  };
  if (ctx.format === "json") {
    ctx.stdout.write(`${JSON.stringify(record)}\n`);
    return 0;
  }
  const lines = [
    `org: ${b.org ?? "unknown (the token carries no org id)"}${b.isDefault ? " (default)" : ""}`,
    `why: ${why(b.selection)}`,
    `token: ${b.tokenSource === "env" ? "ERIS_YAKS_TOKEN" : record.file}`,
    `url: ${b.url}`,
    `signed in to: ${signedIn.length === 0 ? "no org with an id" : signedIn.map((o) => (o === defaultOrg ? `${o} (default)` : o)).join(", ")}`,
  ];
  ctx.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
