/**
 * settings.ts — `eris doctrine settings` and `eris doctrine history`: the org's Gates settings and the
 * stored versions of its policy, over the gates client (docs/dev/GATES-CLIENT.md).
 *
 * Invariants:
 *  - A `set` edits the settings of the newest stored version and sends them with that version as
 *    `expected_version`, so a save landing in between is refused (`doctrine-push-stale`), never overwritten.
 *  - A `set` that leaves the settings as they are sends nothing.
 *  - `ERIS_GATES_APPROVAL`, when set, rides only as the PUT body's `mandate_handle` (see push.ts): no
 *    output, failure or log line carries it.
 *  - The save is sent once; a refusal changes nothing.
 */

import {
  canonicalJson,
  type ContractFailure,
  decodeResult,
  fail,
  fetchOrgPolicy,
  fetchPolicyHistory,
  GATES_APPROVE_URL,
  GatesSettings,
  gatesEndpoint,
  type Outcome,
  type PolicyVersion,
  putOrgSettings,
  succeed,
} from "eris/gates-contract";
import { CliExit, readArgs, renderFailureBlock, type VerbContext } from "../../src/cli/plugin";
import plugin from "./index";
import { type PullDeps, resolveOrg } from "./pull";
import { approvalFrom } from "./push";

const ROWS = plugin.rows;

export const SETTINGS_USAGE = `Usage: eris doctrine settings [show | set <key> <value>] [--output json]

Show the org's Gates settings (GET /v1/gates/settings), or set one key with
PUT /v1/gates/settings on the 'eris login' bearer of an org admin. Keys:
  skills_repo               owner/repo the org's skills install from, or 'unset'
  staleness                 soft | hard
  ci.check_profile_in_ci    on | off
  ci.untracked_prs          block | warn | allow
  ci.bot_allowlist          comma-separated GitHub logins ('dependabot[bot]'), or 'none'
  spend_cap_calls           most Gates API calls a month (a positive integer), or 'unset'

When the org has a Mandate, a save that loosens its settings needs a passkey
approval: get one at ${GATES_APPROVE_URL} and rerun with
ERIS_GATES_APPROVAL=<handle> eris doctrine settings set <key> <value> (it lasts
5 minutes and covers one save, and is never printed). Setting a key to the value
it holds saves nothing. A save changes the org's bundle_sha: run
'eris doctrine pull' before the next 'eris doctrine push'.

Show prints '<key>\\t<value>' per key; JSON: { org, bundle_sha, settings }.
Set prints '<orgId>\\t<bundle_sha>\\t<version|unchanged>', then on stderr
'INFO changed: <key>' and, for a loosening, 'INFO widened (<auth_mode>): ...';
JSON: { org, bundle_sha, version, saved_at, pushed, widened, reasons, auth_mode, changed, settings }.
Refusals: doctrine-push-refused (not an org admin's bearer), doctrine-push-needs-approval,
doctrine-push-stale (the settings moved since they were read), doctrine-push-invalid.
`;

export const HISTORY_USAGE = `Usage: eris doctrine history [--output json]

List every stored version of the org's policy (GET /v1/gates/policy/history),
oldest first: '<version>\\t<saved_at>\\t<auth_mode>\\t<widened|->\\t<bundle_sha>'. auth_mode says
who saved it (cli, portal_admin, mandate_passkey or seed). JSON: { org, versions: [{ version,
bundle_sha, saved_at, widened, reasons, auth_mode, settings }] }.
`;

const KEYS = ["skills_repo", "staleness", "ci.check_profile_in_ci", "ci.untracked_prs", "ci.bot_allowlist", "spend_cap_calls"] as const;
type Key = (typeof KEYS)[number];

const usage = (what: string): ContractFailure => ({
  slug: "doctrine-usage",
  what,
  fix: "usage: eris doctrine settings [show | set <key> <value>]; 'eris doctrine settings --help' lists the keys and their values",
  docs: "docs/ERRORS.md#doctrine-usage",
  exit: 2,
});

function stop(ctx: VerbContext, f: ContractFailure): never {
  ctx.stderr.write(renderFailureBlock({ slug: f.slug, what: f.what, fix: f.fix, docs: f.docs }, ctx.erisDir));
  throw new CliExit(f.exit);
}

/** The value of `key` as a settings field would hold it, text for the CLI: lists comma-joined, absent as '-'. */
function shown(s: GatesSettings, key: Key): string {
  switch (key) {
    case "skills_repo":
      return s.skills_repo ?? "-";
    case "staleness":
      return s.staleness;
    case "ci.check_profile_in_ci":
      return s.ci.check_profile_in_ci;
    case "ci.untracked_prs":
      return s.ci.untracked_prs;
    case "ci.bot_allowlist":
      return s.ci.bot_allowlist.length === 0 ? "-" : s.ci.bot_allowlist.join(",");
    case "spend_cap_calls":
      return s.spend_cap_calls === undefined ? "-" : String(s.spend_cap_calls);
  }
}

/** `settings` with `key` set to the text `value`, decoded through the contract's Schema: the new settings, or the usage failure. */
export function applySetting(settings: GatesSettings, key: string, value: string): Outcome<GatesSettings> {
  if (!(KEYS as readonly string[]).includes(key)) return fail(usage(`doctrine settings: '${key.slice(0, 40)}' is not a setting; keys: ${KEYS.join(", ")}`));
  const next: Record<string, unknown> = { ...settings, ci: { ...settings.ci } };
  const ci = next.ci as Record<string, unknown>;
  const clear = value === "unset";
  switch (key as Key) {
    case "skills_repo":
      if (clear) delete next.skills_repo;
      else next.skills_repo = value;
      break;
    case "spend_cap_calls":
      if (clear) delete next.spend_cap_calls;
      else next.spend_cap_calls = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      break;
    case "staleness":
      next.staleness = value;
      break;
    case "ci.check_profile_in_ci":
      ci.check_profile_in_ci = value;
      break;
    case "ci.untracked_prs":
      ci.untracked_prs = value;
      break;
    case "ci.bot_allowlist":
      ci.bot_allowlist = value === "none" ? [] : value.split(",").map((l) => l.trim());
      break;
  }
  const d = decodeResult(GatesSettings, next);
  if (d._tag !== "Success") return fail(usage(`doctrine settings: '${key}' does not take that value (${d.failure.message}); 'eris doctrine settings --help' lists the values`));
  return succeed(d.success);
}

/** What a `set` did. */
export interface SettingsSet {
  readonly org: string;
  readonly bundle_sha: string;
  readonly version: number | null;
  readonly saved_at: string | null;
  readonly pushed: boolean;
  readonly widened: boolean | null;
  readonly reasons: readonly string[];
  readonly auth_mode: string | null;
  readonly changed: readonly string[];
  readonly settings: GatesSettings;
}

/** Set `key` on the org this directory acts as: the save's outcome, or the failure. */
export async function setSetting(ctx: VerbContext, deps: PullDeps, key: string, value: string): Promise<Outcome<SettingsSet>> {
  const approval = approvalFrom(ctx.env);
  if (!approval.ok) return approval;
  const resolved = await resolveOrg(ctx, deps, "there are no org settings to save");
  if (!resolved.ok) return resolved;
  const { org, bearer } = resolved.value;
  const ep = gatesEndpoint(bearer.url, bearer.token, { fetch: deps.fetch });
  if (!ep.ok) return ep;
  const history = await fetchPolicyHistory(ep.value);
  if (!history.ok) return history;
  const latest = history.value.at(-1);
  if (latest === undefined) {
    return fail({
      slug: "gate-contract-mismatch",
      what: "the gateway's policy history holds no version, so there are no settings to edit",
      fix: "Update eris ('eris update'); if it persists, the gateway and this client disagree on the gates contract.",
      docs: "docs/ERRORS.md#gate-contract-mismatch",
      exit: 3,
    });
  }
  const next = applySetting(latest.settings, key, value);
  if (!next.ok) return next;
  if (canonicalJson(next.value) === canonicalJson(latest.settings)) {
    return succeed({ org, bundle_sha: latest.bundle_sha, version: null, saved_at: null, pushed: false, widened: null, reasons: [], auth_mode: null, changed: [], settings: latest.settings });
  }
  const saved = await putOrgSettings(ep.value, next.value, { expectedVersion: latest.version, mandateHandle: approval.value });
  if (!saved.ok) return saved;
  const { version, saved_at, widened, reasons, auth_mode, bundle_sha } = saved.value;
  return succeed({ org, bundle_sha, version, saved_at, pushed: true, widened, reasons, auth_mode, changed: [key], settings: next.value });
}

/** `eris doctrine settings`. */
export async function runSettings(args: string[], ctx: VerbContext, deps: PullDeps = {}): Promise<number> {
  const a = readArgs(ROWS, "doctrine settings", args, ctx, { help: SETTINGS_USAGE });
  if (a === null) return 0;
  const [action = "show", key, value] = a.pos;
  if (action === "show") {
    if (key !== undefined) stop(ctx, usage("doctrine settings show takes no key"));
    const resolved = await resolveOrg(ctx, deps, "there are no org settings to show");
    if (!resolved.ok) stop(ctx, resolved.failure);
    const ep = gatesEndpoint(resolved.value.bearer.url, resolved.value.bearer.token, { fetch: deps.fetch });
    if (!ep.ok) stop(ctx, ep.failure);
    const live = await fetchOrgPolicy(ep.value);
    if (!live.ok) stop(ctx, live.failure);
    if (ctx.format === "json") ctx.stdout.write(`${JSON.stringify({ org: resolved.value.org, bundle_sha: live.value.bundle_sha, settings: live.value.settings })}\n`);
    else for (const k of KEYS) ctx.stdout.write(`${k}\t${shown(live.value.settings, k)}\n`);
    return 0;
  }
  if (action !== "set") stop(ctx, usage(`doctrine settings: unknown action '${action.slice(0, 40)}'`));
  if (key === undefined || value === undefined) stop(ctx, usage("doctrine settings set: needs <key> and <value>"));
  const done = await setSetting(ctx, deps, key, value);
  if (!done.ok) stop(ctx, done.failure);
  const p = done.value;
  if (ctx.format === "json") {
    ctx.stdout.write(`${JSON.stringify(p)}\n`);
    return 0;
  }
  ctx.stdout.write(`org ${p.org}\tbundle_sha ${p.bundle_sha}\tversion ${p.version ?? "unchanged"}\n`);
  if (p.pushed) {
    ctx.stderr.write(`INFO changed: ${p.changed.join(", ")}\n`);
    if (p.widened === true) ctx.stderr.write(`INFO widened (${p.auth_mode ?? "unknown"}): ${p.reasons.length > 0 ? p.reasons.join("; ") : "no reason given"}\n`);
    ctx.stderr.write("INFO the org's bundle_sha moved: run 'eris doctrine pull' before the next 'eris doctrine push'\n");
  }
  return 0;
}

/** `eris doctrine history`. */
export async function runHistory(args: string[], ctx: VerbContext, deps: PullDeps = {}): Promise<number> {
  const a = readArgs(ROWS, "doctrine history", args, ctx, { help: HISTORY_USAGE });
  if (a === null) return 0;
  const resolved = await resolveOrg(ctx, deps, "there is no policy history to list");
  if (!resolved.ok) stop(ctx, resolved.failure);
  const ep = gatesEndpoint(resolved.value.bearer.url, resolved.value.bearer.token, { fetch: deps.fetch });
  if (!ep.ok) stop(ctx, ep.failure);
  const history = await fetchPolicyHistory(ep.value);
  if (!history.ok) stop(ctx, history.failure);
  const rows: readonly PolicyVersion[] = history.value;
  if (ctx.format === "json") ctx.stdout.write(`${JSON.stringify({ org: resolved.value.org, versions: rows })}\n`);
  else for (const v of rows) ctx.stdout.write(`${v.version}\t${v.saved_at}\t${v.auth_mode ?? "-"}\t${v.widened === null ? "-" : v.widened}\t${v.bundle_sha}\n`);
  return 0;
}
