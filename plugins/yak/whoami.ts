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
url it goes to, every org this machine is signed in to, and what the org
itself reports for you: your role, its tier, its Linear connection, any
scheduled deletion and its entitlements. --output json prints that report as
the server sent it. Never prints a token. Exits 1, with the fix, when the
selected org cannot be used here or its endpoint does not answer.
`;

export interface WhoamiDeps {
  home?: string;
  cwd?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function why(selection: OrgSelection): string {
  if (selection.source === "env") return "ERIS_ORG";
  if (selection.source === "eris.yaml") return `repo.org in ${selection.path}`;
  return "this machine's default org";
}

/** The lines the org's own answer adds: the caller's role, the org's tier, Linear connection, scheduled deletion and entitlements. A field the server does not send is left out. */
function serverLines(me: Record<string, unknown>): string[] {
  const lines = [`role: ${String(me.role)}`];
  if (typeof me.tier === "string") lines.push(`tier: ${me.tier}`);
  const linear = me.linear;
  if (typeof linear === "object" && linear !== null) {
    const { status, cause } = linear as { status?: unknown; cause?: unknown };
    lines.push(`linear: ${String(status)}${typeof cause === "string" ? ` (${cause})` : ""}`);
  }
  if ("deletionScheduledAt" in me) lines.push(`deletion: ${typeof me.deletionScheduledAt === "string" ? `scheduled for ${me.deletionScheduledAt}` : "none scheduled"}`);
  const entitlements = me.entitlements;
  if (typeof entitlements === "object" && entitlements !== null) {
    const pairs = Object.entries(entitlements).map(([product, state]) => `${product} ${String(state)}`);
    lines.push(`entitlements: ${pairs.length === 0 ? "none" : pairs.join(", ")}`);
  }
  return lines;
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
  const { readOrgMe } = await import("./yak-admin");
  const me = await readOrgMe(b.url, b.token, { ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}) });
  if (!me.ok) {
    ctx.stderr.write(renderFailureBlock({ slug: me.failure.slug, what: me.failure.what, ...(me.failure.fix ? { fix: me.failure.fix } : {}) }, ctx.erisDir));
    return 1;
  }
  const file = await readYaksFileConfig(home);
  const stored = "value" in file ? file.value : {};
  const defaultOrg = tokenOrg(stored.token);
  const signedIn = [...(defaultOrg !== null ? [defaultOrg] : []), ...Object.keys(stored.orgs ?? {}).sort()];

  const tokenPath = yaksConfigPath(home);
  if (ctx.format === "json") {
    ctx.stdout.write(`${JSON.stringify(me.value)}\n`);
    return 0;
  }
  const lines = [
    `org: ${b.org ?? "unknown (the token carries no org id)"}${b.isDefault ? " (default)" : ""}`,
    `why: ${why(b.selection)}`,
    `token: ${b.tokenSource === "env" ? "ERIS_YAKS_TOKEN" : tokenPath}`,
    `url: ${b.url}`,
    `signed in to: ${signedIn.length === 0 ? "no org with an id" : signedIn.map((o) => (o === defaultOrg ? `${o} (default)` : o)).join(", ")}`,
    ...serverLines(me.value),
  ];
  ctx.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
