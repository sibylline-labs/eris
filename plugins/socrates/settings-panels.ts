/**
 * settings-panels.ts — `eris socrates settings policy|enrolment|health|usage|canon`, the CLI side of
 * the dash's settings panels. Loaded with ./settings.ts, which routes the group.
 *
 * Every read is the one `GET /v1/socrates/settings` read model; the writes are the admin-only
 * `PUT .../settings/policy` and `PUT .../settings/canon`. The server owns the admin check, the
 * policy version and the hash; these verbs name the change and print the receipt.
 *
 * Invariants:
 *   - A response is read only through the route's decoder (./client.ts owns the exchange).
 *   - A policy change is read-modify-write: the draft is the served policy plus the flags, and the
 *     PUT carries the version that was read as `expected_version`, so a policy that moved since is
 *     refused (409) and never overwritten. A change that changes nothing sends nothing.
 *   - `--preview` sends nothing but the read: it prints the draft's difference from the served
 *     policy. The hash a save would carry is the server's, so it is not shown.
 *   - Nothing leaves the machine before `eris/outbound-scan` has run over the write's body.
 *   - Text a server sent is shown only after control characters are stripped; `--output json` prints
 *     the decoded reply.
 */

import { scanStrings } from "eris/outbound-scan";
import { readArgs, type VerbContext } from "../../src/cli/plugin";
import { fail, postSocrates, printable, type SocratesDeps, type SocratesEndpoint, socratesEndpoint } from "./client";
import plugin from "./index";
import { SOCRATES_CONTRACT_VERSION } from "./socrates-contract.v1";
import { SOCRATES_ROUTES, SocratesPolicy, SocratesSettingsCanonRequest, SocratesSettingsPolicyRequest, SocratesSettingsResponse, type SocratesSettingsResult, SocratesSettingsWriteResponse } from "./socrates-contract.v1.verbs";

type Policy = ReturnType<typeof SocratesPolicy.parse>;

export const POLICY_USAGE = `Usage: eris socrates settings policy [--threshold <n>] [--verbosity <v>] [--escalation <e>]
                                   [--reporting <r>] [--auto-resolve on|off]
                                   [--gate <key>=on|off]... [--weight <key>=<n>]... [--preview]

Show the org's scoring policy, or change it (an org admin's). With no flag it prints the served
policy; with a flag it saves the policy with that change as a new version, stamped with a new hash.

  --threshold <n>        the score a candidate must reach
  --verbosity <v>        spine, load_bearing, considered, chatty or everything
  --escalation <e>       off, evidence or connected_repos
  --reporting <r>        pulse, epic_comment or none
  --auto-resolve on|off  whether a closed review Epic resolves its entries
  --gate <key>=on|off    turn a gate on or off; <key> must be a gate the policy already has
  --weight <key>=<n>     set a gate's weight
  --preview              print what the change would alter and send nothing

The save carries the version that was read: when someone saved since, it is refused and nothing is
overwritten; run the command again. A change that alters nothing is not sent.

--output json prints the served view {policy: {rubric_version, version, source, policy_hash, policy,
updated_at}, contract_version}; with a flag, the saved receipt; with --preview, {preview: true,
version, policy_hash, policy, draft, changes: [{field, from, to}], contract_version}.

Sign in first with 'eris login'.
`;

export const ENROLMENT_USAGE = `Usage: eris socrates settings enrolment

List the projects enrolled in Socrates, how each was enrolled (label or stub) and its Linear link.
Enrolment is read-only here: it follows the 'Socrates > Enrolled' label on the project in Linear.

--output json prints {projects: [{id, name, source, url}], contract_version}.

Sign in first with 'eris login'.
`;

export const HEALTH_USAGE = `Usage: eris socrates settings health

Print the org's Socrates health: the install state and any missing labels, the last webhook
delivery, the last reconcile, and writes that are stuck. The install line is followed by the Linear
scopes the install holds: not checked yet, all granted, or the missing ones.

--output json prints {health: {install, webhook, reconcile, stuck}, contract_version}; install
carries scopes ({granted, missing}, or null when unread).

Sign in first with 'eris login'.
`;

export const USAGE_USAGE = `Usage: eris socrates settings usage

Print usage that costs no credit over the server's window: entries by state, accept and reject
rates, and classifications with their overrides.

--output json prints {usage, contract_version}.

Sign in first with 'eris login'.
`;

export const CANON_USAGE = `Usage: eris socrates settings canon [--doc <id> | --clear]

Show which Linear document is the org's Canon, or choose it (an org admin's). 'eris socrates
consult --canon' reads the chosen document afterwards.

  --doc <id>  the Linear document id to use as Canon
  --clear     remove the choice

--output json prints {canon: {doc_id}, contract_version}; with --doc or --clear, the saved receipt
{rubric_version, policy_version, policy_hash, policy, canon_doc_id, contract_version}.

Sign in first with 'eris login'.
`;

const READ_ROUTE_MISSING = `this endpoint does not serve ${SOCRATES_ROUTES.settings.path}: update the server, or check the url points at a Socrates endpoint`;

const readFix = (status: number): string | undefined => (status === 404 ? "this org has no Socrates settings yet: enrol a project first" : undefined);
const badReadFix = (status: number): string | undefined => (status === 404 || status === 405 ? READ_ROUTE_MISSING : undefined);

const writeFix = (status: number): string | undefined => {
  if (status === 403) return "ask an org admin to run this command";
  if (status === 409) return "the settings changed since they were read: run the command again";
  if (status === 422) return "fix the value the detail names, then run the command again";
  return undefined;
};
const badWriteFix = (path: string) => (status: number): string | undefined => (status === 404 || status === 405 ? `this endpoint does not serve ${path}: update the server, or check the url points at a Socrates endpoint` : undefined);

/** The read model, with a refusal printed as a failure block. */
async function readSettings(ctx: VerbContext, deps: SocratesDeps, endpoint: SocratesEndpoint): Promise<SocratesSettingsResult> {
  return postSocrates(ctx, deps, endpoint, { method: "GET", path: SOCRATES_ROUTES.settings.path, query: {}, decoder: SocratesSettingsResponse, subject: "the settings read", refusalFix: readFix, badResponseFix: badReadFix });
}

const when = (iso: string | null): string => (iso === null ? "never" : printable(iso));
const onOff = (b: boolean): string => (b ? "on" : "off");
const pct = (r: number | null): string => (r === null ? "-" : `${Math.round(r * 1000) / 10}%`);
const json = (ctx: VerbContext, value: unknown): number => (ctx.stdout.write(`${JSON.stringify(value)}\n`), 0);

/** `settings enrolment`. */
export async function runEnrolment(args: string[], ctx: VerbContext, deps: SocratesDeps): Promise<number> {
  if (readArgs(plugin.rows, "socrates settings enrolment", args, ctx, { help: ENROLMENT_USAGE }) === null) return 0;
  const r = await readSettings(ctx, deps, await socratesEndpoint(ctx, deps));
  if (ctx.format === "json") return json(ctx, { projects: r.enrolment.projects, contract_version: r.contract_version });
  const rows = r.enrolment.projects;
  ctx.stdout.write(rows.length === 0 ? "no projects are enrolled\n" : `${rows.map((p) => `${printable(p.name ?? p.id)} (${p.source}) ${p.url === null ? "-" : printable(p.url)}`).join("\n")}\n`);
  return 0;
}

/** The Linear scopes row, in the dash Health panel's three states: unread, none missing, or what is missing and the fix. */
function scopesLine(scopes: { granted: string[]; missing: string[] } | null): string {
  if (scopes === null) return "linear scopes: not checked yet";
  if (scopes.missing.length === 0) return scopes.granted.length === 0 ? "linear scopes: all granted" : `linear scopes: all granted (${scopes.granted.map(printable).join(", ")})`;
  return `linear scopes: ${scopes.missing.length} missing (${scopes.missing.map(printable).join(", ")}); a Linear workspace admin can re-install the app to grant them`;
}

/** `settings health`. */
export async function runHealth(args: string[], ctx: VerbContext, deps: SocratesDeps): Promise<number> {
  if (readArgs(plugin.rows, "socrates settings health", args, ctx, { help: HEALTH_USAGE }) === null) return 0;
  const r = await readSettings(ctx, deps, await socratesEndpoint(ctx, deps));
  const h = r.health;
  const scopes = h.install.scopes ?? null;
  if (ctx.format === "json") return json(ctx, { health: { ...h, install: { ...h.install, scopes } }, contract_version: r.contract_version });
  const labels = h.install.missing_labels.length === 0 ? "" : `; missing labels: ${h.install.missing_labels.map(printable).join(", ")}`;
  ctx.stdout.write(
    [
      `install: ${h.install.state ?? "unknown"}${labels} (checked ${when(h.install.checked_at)})`,
      scopesLine(scopes),
      `webhook: last delivery ${when(h.webhook.last_delivery_at)}`,
      `reconcile: last ${when(h.reconcile.last_at)}, watermark ${when(h.reconcile.watermark)}`,
      `stuck: ${h.stuck.retrying_writes} retrying write(s)${h.stuck.oldest_retrying_at === null ? "" : ` (oldest ${printable(h.stuck.oldest_retrying_at)})`}, ${h.stuck.refused_entries} refused entr${h.stuck.refused_entries === 1 ? "y" : "ies"}`,
    ].join("\n") + "\n",
  );
  return 0;
}

/** `settings usage`. */
export async function runUsage(args: string[], ctx: VerbContext, deps: SocratesDeps): Promise<number> {
  if (readArgs(plugin.rows, "socrates settings usage", args, ctx, { help: USAGE_USAGE }) === null) return 0;
  const r = await readSettings(ctx, deps, await socratesEndpoint(ctx, deps));
  if (ctx.format === "json") return json(ctx, { usage: r.usage, contract_version: r.contract_version });
  const u = r.usage;
  const e = u.entries;
  ctx.stdout.write(
    [
      `last ${u.window_days} days`,
      `entries: ${e.total} (pending ${e.pending}, filed ${e.filed}, resolved ${e.resolved}, rejected ${e.rejected}, needs input ${e.needs_input})`,
      `accept rate: ${pct(u.accept_rate)}, reject rate: ${pct(u.reject_rate)}`,
      `classifications: ${u.classifications.total} (passed ${u.classifications.passed}, failed ${u.classifications.failed}, overridden ${u.classifications.overridden}), ${u.classifications.overrides} override(s)`,
    ].join("\n") + "\n",
  );
  return 0;
}

// --- policy -----------------------------------------------------------------

interface Change {
  field: string;
  from: string | number | boolean;
  to: string | number | boolean;
}

/** Each place the draft differs from the served policy, in a stable order. */
function diffPolicy(from: Policy, to: Policy): Change[] {
  const out: Change[] = [];
  if (from.threshold !== to.threshold) out.push({ field: "threshold", from: from.threshold, to: to.threshold });
  for (const f of ["verbosity", "escalation", "reporting"] as const) if (from[f] !== to[f]) out.push({ field: f, from: from[f], to: to[f] });
  if (from.auto_resolve !== to.auto_resolve) out.push({ field: "auto_resolve", from: from.auto_resolve, to: to.auto_resolve });
  for (const [key, gate] of Object.entries(to.gates)) {
    const before = from.gates[key];
    if (before === undefined) continue;
    if (before.enabled !== gate.enabled) out.push({ field: `gate ${key}`, from: onOff(before.enabled), to: onOff(gate.enabled) });
    if (before.weight !== gate.weight) out.push({ field: `weight ${key}`, from: before.weight, to: gate.weight });
  }
  return out;
}

const changeLine = (c: Change): string => `${printable(c.field)}: ${typeof c.from === "boolean" ? onOff(c.from) : c.from} -> ${typeof c.to === "boolean" ? onOff(c.to) : c.to}`;

function showPolicy(view: SocratesSettingsResult["policy"]): string {
  const p = view.policy;
  const gates = Object.entries(p.gates).map(([key, g]) => `${printable(key)} ${onOff(g.enabled)} (weight ${g.weight})`);
  return `${[
    `policy v${view.version} (${view.source}, ${printable(view.rubric_version)}) hash ${view.policy_hash.slice(0, 12)}, updated ${when(view.updated_at)}`,
    `threshold: ${p.threshold}`,
    `verbosity: ${p.verbosity}`,
    `escalation: ${p.escalation}`,
    `auto_resolve: ${onOff(p.auto_resolve)}`,
    `reporting: ${p.reporting}`,
    `gates: ${gates.length === 0 ? "none" : gates.join(", ")}`,
  ].join("\n")}\n`;
}

const POLICY_FIX = "eris socrates settings policy [--threshold <n>] [--verbosity <v>] [--escalation <e>] [--reporting <r>] [--auto-resolve on|off] [--gate <key>=on|off] [--weight <key>=<n>] [--preview]";

/** `key=value` operands of a repeatable flag, each key one of the served gates. */
function gateOperands(ctx: VerbContext, flag: string, raw: unknown, served: Policy, value: (v: string) => unknown): [string, unknown][] {
  const list = Array.isArray(raw) ? (raw as string[]) : [];
  return list.map((item) => {
    const at = item.indexOf("=");
    const key = at < 0 ? "" : item.slice(0, at);
    const given = at < 0 ? "" : item.slice(at + 1);
    if (key === "" || given === "") fail(ctx, "socrates-flag-required", `${flag} takes <key>=<value>, not '${printable(item)}'`, POLICY_FIX);
    if (!Object.hasOwn(served.gates, key)) fail(ctx, "socrates-flag-required", `${flag}: '${printable(key)}' is not a gate of this policy`, `use one of: ${Object.keys(served.gates).map(printable).join(", ")}`);
    return [key, value(given)] as [string, unknown];
  });
}

/** The served policy with the flags applied; every value is checked through the contract's schema afterwards. */
function draftPolicy(ctx: VerbContext, served: Policy, flags: Record<string, unknown>): Policy {
  const draft: Record<string, unknown> = structuredClone(served);
  const threshold = flags["--threshold"];
  if (typeof threshold === "string") draft.threshold = threshold.trim() === "" ? Number.NaN : Number(threshold);
  for (const f of ["verbosity", "escalation", "reporting"] as const) {
    const v = flags[`--${f}`];
    if (typeof v === "string") draft[f] = v;
  }
  const auto = flags["--auto-resolve"];
  if (typeof auto === "string") {
    if (auto !== "on" && auto !== "off") fail(ctx, "socrates-flag-required", `--auto-resolve takes on or off, not '${printable(auto)}'`, POLICY_FIX);
    draft.auto_resolve = auto === "on";
  }
  const gates = draft.gates as Record<string, { enabled: boolean; weight: number }>;
  for (const [key, v] of gateOperands(ctx, "--gate", flags["--gate"], served, (s) => s)) {
    if (v !== "on" && v !== "off") fail(ctx, "socrates-flag-required", `--gate ${printable(key)} takes on or off, not '${printable(String(v))}'`, POLICY_FIX);
    gates[key]!.enabled = v === "on";
  }
  for (const [key, v] of gateOperands(ctx, "--weight", flags["--weight"], served, (s) => Number(s))) gates[key]!.weight = v as number;
  const parsed = SocratesPolicy.safeParse(draft);
  if (!parsed.success) fail(ctx, "socrates-flag-required", `not a valid policy: ${printable(parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "))}`, POLICY_FIX);
  return parsed.data;
}

/** `settings policy`. */
export async function runPolicy(args: string[], ctx: VerbContext, deps: SocratesDeps): Promise<number> {
  const a = readArgs(plugin.rows, "socrates settings policy", args, ctx, { help: POLICY_USAGE });
  if (a === null) return 0;
  const flags = a.flags as Record<string, unknown>;
  const preview = flags["--preview"] === true;
  const edits = ["--threshold", "--verbosity", "--escalation", "--reporting", "--auto-resolve", "--gate", "--weight"].some((f) => (Array.isArray(flags[f]) ? (flags[f] as unknown[]).length > 0 : flags[f] !== undefined));
  if (preview && !edits) fail(ctx, "socrates-flag-required", "--preview needs a change to preview", POLICY_FIX);

  const endpoint = await socratesEndpoint(ctx, deps);
  const read = await readSettings(ctx, deps, endpoint);
  const view = read.policy;
  if (!edits) {
    if (ctx.format === "json") return json(ctx, { policy: view, contract_version: read.contract_version });
    ctx.stdout.write(showPolicy(view));
    return 0;
  }

  const draft = draftPolicy(ctx, view.policy, flags);
  const changes = diffPolicy(view.policy, draft);
  if (preview) {
    if (ctx.format === "json") return json(ctx, { preview: true, version: view.version, policy_hash: view.policy_hash, policy: view.policy, draft, changes, contract_version: read.contract_version });
    ctx.stdout.write(`${changes.length === 0 ? "no change: the draft equals the served policy" : changes.map(changeLine).join("\n")}\npreview: nothing was sent; the hash is assigned when the policy is saved\n`);
    return 0;
  }
  if (changes.length === 0) {
    if (ctx.format === "json") return json(ctx, { policy: view, contract_version: read.contract_version });
    ctx.stdout.write(`no change: policy v${view.version} stays at hash ${view.policy_hash.slice(0, 12)}\n`);
    return 0;
  }

  const parsed = SocratesSettingsPolicyRequest.safeParse({ schema_version: SOCRATES_CONTRACT_VERSION, rubric_version: view.rubric_version, policy: draft, expected_version: view.version });
  if (!parsed.success) fail(ctx, "socrates-flag-required", `not a valid policy request: ${printable(parsed.error.issues.map((i) => i.path.join(".")).join(", "))}`, POLICY_FIX);
  const leaked = scanStrings(parsed.data);
  if (leaked.length > 0) fail(ctx, "socrates-secret-detected", `a secret was found in the arguments (${leaked.map((h) => h.rule).join(", ")}); nothing was sent`, "pass policy values only; this check cannot be overridden");
  const receipt = await postSocrates(ctx, deps, endpoint, {
    path: SOCRATES_ROUTES.settings_policy.path,
    method: "PUT",
    body: parsed.data,
    decoder: SocratesSettingsWriteResponse,
    subject: "the policy change",
    refusalFix: writeFix,
    badResponseFix: badWriteFix(SOCRATES_ROUTES.settings_policy.path),
  });
  if (ctx.format === "json") return json(ctx, receipt);
  ctx.stdout.write(`${changes.map(changeLine).join("\n")}\nsaved policy v${receipt.policy_version}, hash ${receipt.policy_hash.slice(0, 12)}\n`);
  return 0;
}

// --- canon ------------------------------------------------------------------

/** `settings canon`. */
export async function runCanon(args: string[], ctx: VerbContext, deps: SocratesDeps): Promise<number> {
  const a = readArgs(plugin.rows, "socrates settings canon", args, ctx, { help: CANON_USAGE });
  if (a === null) return 0;
  const doc = a.flags["--doc"];
  const clear = a.flags["--clear"] === true;
  const usage = "eris socrates settings canon [--doc <id> | --clear]";
  if (doc !== undefined && clear) fail(ctx, "socrates-flag-required", "pass either --doc <id> or --clear, not both", usage);

  const endpoint = await socratesEndpoint(ctx, deps);
  if (doc === undefined && !clear) {
    const r = await readSettings(ctx, deps, endpoint);
    if (ctx.format === "json") return json(ctx, { canon: r.canon, contract_version: r.contract_version });
    ctx.stdout.write(r.canon.doc_id === null ? "no Canon doc is chosen\n" : `canon: ${printable(r.canon.doc_id)}\n`);
    return 0;
  }

  const parsed = SocratesSettingsCanonRequest.safeParse({ schema_version: SOCRATES_CONTRACT_VERSION, doc: clear ? null : doc });
  if (!parsed.success) fail(ctx, "socrates-flag-required", `not a document id: ${printable(parsed.error.issues.map((i) => i.message).join(", "))}`, usage);
  const leaked = scanStrings(parsed.data);
  if (leaked.length > 0) fail(ctx, "socrates-secret-detected", `a secret was found in the arguments (${leaked.map((h) => h.rule).join(", ")}); nothing was sent`, "pass the document's id; this check cannot be overridden");
  const receipt = await postSocrates(ctx, deps, endpoint, {
    path: SOCRATES_ROUTES.settings_canon.path,
    method: "PUT",
    body: parsed.data,
    decoder: SocratesSettingsWriteResponse,
    subject: "the Canon change",
    refusalFix: writeFix,
    badResponseFix: badWriteFix(SOCRATES_ROUTES.settings_canon.path),
  });
  if (ctx.format === "json") return json(ctx, receipt);
  ctx.stdout.write(receipt.canon_doc_id === null ? "canon cleared\n" : `canon: ${printable(receipt.canon_doc_id)}\n`);
  return 0;
}
