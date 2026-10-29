/**
 * yak-admin.ts — `eris yak status`, `eris yak discover` and `eris yak config
 * get|set`: an org's destination for its yaks, read and set from the CLI.
 * Loaded only when one of them dispatches (the manifest is ./index.ts).
 *
 * The server answers `GET /v1/yaks/status`, `GET /v1/yaks/discovery`, and
 * `GET`/`PUT /v1/yaks/config` (shapes: `eris/yak-contract`, admin.ts). An org
 * with no config accepts yaks and parks them, so these verbs are how an agent
 * gets from `eris login` to yaks that file.
 *
 * Invariants:
 *   - Unlike `eris yak issue|suggest|fatal`, every failure here is the §4
 *     block on stderr, nothing on stdout, exit 1: a config command that
 *     reported success it did not have leaves the org parked.
 *   - Under `--output json` stdout is the server's body, bare: the status, the
 *     discovery, the config read, or the stored config a set answered.
 *   - `config set` sends only the keys it was given. A name is resolved to its
 *     Linear id against discovery (a team by id, key or name; a project, state
 *     or label by id or name), case-insensitively, and must match exactly one.
 *     Every value resolves through discovery, a UUID included, so a set never
 *     stores an id the workspace does not list (or a group label, which Linear
 *     will not apply). `none` clears a project or state, and the labels.
 *   - The bearer is read through the SDK's resolvers, the ones `eris yak` uses,
 *     and is never written to either stream.
 *   - One request at a time, each bounded by `ADMIN_TIMEOUT_MS` over the whole
 *     exchange, headers and body.
 */

import { homedir } from "node:os";
import { readArgs, readYaksFileConfig, renderFailureBlock, resolveToken, resolveUrl, type VerbContext } from "../../src/cli/plugin";
import {
  LinearId,
  YakConfigRead,
  YakDiscovery,
  YakStatus,
  YakStoredConfig,
  type YakConfigPatch,
} from "eris/yak-contract";
import type { z } from "zod";
import plugin from "./index";

// A `…Slug`-named union: `tests/errors-doc.test.ts` harvests its members.
export type YakAdminSlug =
  | "yak-admin-required"
  | "yak-admin-unavailable"
  | "yak-team-not-found"
  | "yak-linear-disconnected"
  | "yak-config-invalid"
  | "yak-config-set-empty"
  | "yak-config-no-match"
  | "yak-discover-unknown-kind";

const ADMIN_TIMEOUT_MS = 15_000;

/** Where an admin can set the destination without the CLI: the dashboard's
 *  page (the eris-yaks skill gives its full address). */
export const DASH_CONFIG_PAGE = "the dashboard's /yak/config page";

export interface AdminDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  home?: string;
}

interface Failure {
  slug: string;
  what: string;
  fix?: string;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; failure: Failure };

const failed = <T>(failure: Failure): Outcome<T> => ({ ok: false, failure });

interface Endpoint {
  url: string;
  token: string;
}

async function resolveEndpoint(env: Record<string, string | undefined>, home: string): Promise<Outcome<Endpoint>> {
  const file = await readYaksFileConfig(home);
  if ("reason" in file) return failed({ slug: file.slug, what: file.reason });
  const token = resolveToken(file.value, env);
  if ("reason" in token) return failed({ slug: token.slug, what: token.reason, fix: "run: eris login" });
  return { ok: true, value: { url: resolveUrl(file.value, env).value.replace(/\/+$/, ""), token: token.value } };
}

/** The server's `{error: {code}}`, when the body carries one. */
function errorCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function refusal(status: number, code: string | undefined, target: string): Failure {
  const answered = `the yaks endpoint answered ${status}${code ? ` ${code}` : ""} for ${target}`;
  if (status === 401) {
    return { slug: "yak-unauthorized", what: `${answered}: it rejected the bearer token`, fix: "run: eris login\n(or check ERIS_YAKS_TOKEN when it is set)" };
  }
  if (status === 403 && code === "admin_required") {
    return {
      slug: "yak-admin-required",
      what: `${answered}: only an admin member of this org can discover Linear or set the yak config`,
      fix: `run 'eris login' and have a Linear admin of this workspace approve it (a member's login stays a member's)\nor have an admin set the destination on ${DASH_CONFIG_PAGE}`,
    };
  }
  if (status === 404 && code === "team_not_found") {
    return { slug: "yak-team-not-found", what: `${answered}: no such Linear team in this workspace`, fix: "list the teams: eris yak discover teams" };
  }
  if (status === 409 && code === "linear_disconnected") {
    return { slug: "yak-linear-disconnected", what: `${answered}: this org's Linear connection is missing or revoked`, fix: "a Linear admin reconnects it in the dashboard: Sign in with Linear, then install the Yaks app" };
  }
  if (status === 422) {
    return { slug: "yak-config-invalid", what: `${answered}: the server refused the config`, fix: "an org's first set needs --team; every id must be one 'eris yak discover' lists" };
  }
  return { slug: "yak-admin-unavailable", what: answered, fix: "retry; 'eris yak status' shows whether the endpoint answers" };
}

/** One bounded request; the body parsed against `schema`. */
async function request<S extends z.ZodTypeAny>(
  ep: Endpoint,
  method: "GET" | "PUT",
  path: string,
  schema: S,
  deps: AdminDeps,
  body?: unknown,
): Promise<Outcome<z.infer<S>>> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? ADMIN_TIMEOUT_MS;
  const target = `${method} ${ep.url}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    let parsed: unknown;
    try {
      response = await fetchImpl(`${ep.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${ep.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      try {
        parsed = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
    } catch (err) {
      const name = (err as { name?: string }).name;
      const what = name === "AbortError" || name === "TimeoutError" ? `the yaks endpoint did not answer within ${timeoutMs}ms (${target})` : `cannot reach the yaks endpoint (${target}): ${(err as Error).message}`;
      return failed({ slug: "yak-admin-unavailable", what, fix: "check the network, and ERIS_YAKS_URL or the url in ~/.eris/yaks.json" });
    }
    if (!response.ok) return failed(refusal(response.status, errorCode(parsed), target));
    const shaped = schema.safeParse(parsed);
    if (!shaped.success) {
      return failed({ slug: "yak-admin-unavailable", what: `the yaks endpoint answered ${response.status} with a body that does not match the contract (${target})`, fix: "update eris: eris update" });
    }
    return { ok: true, value: shaped.data };
  } finally {
    clearTimeout(timer);
  }
}

/** Where the verbs write: the payload, the block, the exit code. */
function fail(ctx: VerbContext, failure: Failure): number {
  ctx.stderr.write(renderFailureBlock({ slug: failure.slug, what: failure.what, ...(failure.fix ? { fix: failure.fix } : {}) }, ctx.erisDir));
  return 1;
}

function emitJson(ctx: VerbContext, value: unknown): number {
  ctx.stdout.write(`${JSON.stringify(value)}\n`);
  return 0;
}

/** Columns, two spaces apart, the last unpadded. */
function table(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "";
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ").trimEnd()).join("\n") + "\n";
}

const home = (ctx: VerbContext, deps: AdminDeps) => deps.home ?? ctx.env.HOME ?? homedir();

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/** The org's status, or null when it could not be read: the parked-yak check
 *  after a submit (./yak.ts) calls it and stays silent on null. */
export async function readStatus(url: string, token: string, deps: AdminDeps): Promise<YakStatus | null> {
  const got = await request({ url: url.replace(/\/+$/, ""), token }, "GET", "/v1/yaks/status", YakStatus, deps);
  return got.ok ? got.value : null;
}

export async function runStatus(args: string[], ctx: VerbContext, deps: AdminDeps = {}): Promise<number> {
  if (readArgs(plugin.rows, "yak status", args, ctx) === null) return 0;
  const ep = await resolveEndpoint(ctx.env, home(ctx, deps));
  if (!ep.ok) return fail(ctx, ep.failure);
  const got = await request(ep.value, "GET", "/v1/yaks/status", YakStatus, deps);
  if (!got.ok) return fail(ctx, got.failure);
  const s = got.value;
  if (ctx.format === "json") return emitJson(ctx, s);
  ctx.stdout.write(
    table([
      ["configured:", s.configured ? "yes" : "no"],
      ["observations:", String(s.observation_count)],
      ["last filed:", s.last_filed_issue_identifier ?? "none"],
    ]),
  );
  if (!s.configured) {
    ctx.stderr.write(`INFO yaks are accepted and parked until a destination is set: eris yak discover teams, then eris yak config set --team <key> (or ${DASH_CONFIG_PAGE})\n`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------

const DISCOVER_KINDS = ["teams", "projects", "states", "labels"] as const;
type DiscoverKind = (typeof DISCOVER_KINDS)[number];
const isKind = (s: string): s is DiscoverKind => (DISCOVER_KINDS as readonly string[]).includes(s);

function discoveryPath(teamId: string | undefined): string {
  return `/v1/yaks/discovery${teamId === undefined ? "" : `?team_id=${encodeURIComponent(teamId)}`}`;
}

const lower = (s: string) => s.toLowerCase();

/** The one item `value` names: by id, else by any of `names`, case-insensitively. */
function pick<T extends { id: string }>(what: string, value: string, items: readonly T[], names: (item: T) => string[], label: (item: T) => string): Outcome<T> {
  const byId = items.find((item) => item.id === value);
  if (byId) return { ok: true, value: byId };
  const matches = items.filter((item) => names(item).some((n) => lower(n) === lower(value)));
  if (matches.length === 1) return { ok: true, value: matches[0]! };
  const candidates = (matches.length > 1 ? matches : items).map(label);
  return failed({
    slug: "yak-config-no-match",
    what: matches.length > 1 ? `${what} '${value}' matches ${matches.length} entries` : `no ${what} matches '${value}'`,
    fix: candidates.length > 0 ? `use an id or a unique name; one of:\n${candidates.slice(0, 20).join("\n")}` : `this workspace lists no ${what}s`,
  });
}

const teamLabel = (t: { id: string; key: string; name: string }) => `${t.key}  ${t.name}  ${t.id}`;
const named = (x: { id: string; name: string }) => `${x.name}  ${x.id}`;

/** Discovery for the team `team` names (id, key or name); the first team's when absent. */
async function discoverFor(ep: Endpoint, team: string | undefined, deps: AdminDeps): Promise<Outcome<YakDiscovery>> {
  // A UUID goes straight to `?team_id=`, which the server answers 404 for a team it does not list.
  const first = await request(ep, "GET", discoveryPath(team !== undefined && LinearId.safeParse(team).success ? team : undefined), YakDiscovery, deps);
  if (!first.ok || team === undefined || first.value.team_id === team) return first;
  const chosen = pick("team", team, first.value.teams, (t) => [t.key, t.name], teamLabel);
  if (!chosen.ok) return chosen;
  if (chosen.value.id === first.value.team_id) return first;
  return request(ep, "GET", discoveryPath(chosen.value.id), YakDiscovery, deps);
}

function renderDiscovery(d: YakDiscovery, kind: DiscoverKind | undefined): string {
  const sections: string[] = [];
  const team = d.teams.find((t) => t.id === d.team_id);
  const show = (k: DiscoverKind) => kind === undefined || kind === k;
  if (show("teams")) sections.push(`teams:\n${table(d.teams.map((t) => [t.id === d.team_id ? "*" : " ", t.key, t.name, t.id]))}`);
  const of = team ? ` (team ${team.key})` : "";
  if (show("projects")) sections.push(`projects${of}:\n${table(d.projects.map((p) => [p.name, p.status.name, p.id]))}`);
  if (show("states")) {
    const states = [...d.workflow_states].sort((a, b) => a.position - b.position);
    sections.push(`states${of}:\n${table(states.map((s) => [s.name, s.type, s.id, s.id === d.default_state_id ? "(default)" : ""]))}`);
  }
  if (show("labels")) sections.push(`labels${of}:\n${table(d.labels.filter((l) => !l.isGroup).map((l) => [l.name, l.teamId === null ? "workspace" : "team", l.id]))}`);
  return sections.join("\n");
}

export async function runDiscover(args: string[], ctx: VerbContext, deps: AdminDeps = {}): Promise<number> {
  const p = readArgs(plugin.rows, "yak discover", args, ctx);
  if (p === null) return 0;
  const kindArg = p.pos[0];
  if (kindArg !== undefined && !isKind(kindArg)) {
    return fail(ctx, { slug: "yak-discover-unknown-kind", what: `unknown discover kind '${kindArg}'`, fix: `use one of: ${DISCOVER_KINDS.join(", ")}` });
  }
  const ep = await resolveEndpoint(ctx.env, home(ctx, deps));
  if (!ep.ok) return fail(ctx, ep.failure);
  const got = await discoverFor(ep.value, p.flags["--team"], deps);
  if (!got.ok) return fail(ctx, got.failure);
  if (ctx.format === "json") return emitJson(ctx, got.value);
  ctx.stdout.write(renderDiscovery(got.value, kindArg));
  return 0;
}

// ---------------------------------------------------------------------------
// config get | set
// ---------------------------------------------------------------------------

function renderConfig(c: YakStoredConfig): string {
  const cfg = c.config;
  return table([
    ["team:", cfg.team_id],
    ["project:", cfg.project_id ?? "none (team default)"],
    ["state:", cfg.state_id ?? "none (team default)"],
    ["labels:", cfg.label_ids.length > 0 ? cfg.label_ids.join(", ") : "none"],
    ["updated:", `${c.updated_at} by ${c.updated_by.name}`],
  ]);
}

export async function runConfigGet(args: string[], ctx: VerbContext, deps: AdminDeps = {}): Promise<number> {
  if (readArgs(plugin.rows, "yak config get", args, ctx) === null) return 0;
  const ep = await resolveEndpoint(ctx.env, home(ctx, deps));
  if (!ep.ok) return fail(ctx, ep.failure);
  const got = await request(ep.value, "GET", "/v1/yaks/config", YakConfigRead, deps);
  if (!got.ok) return fail(ctx, got.failure);
  if (ctx.format === "json") return emitJson(ctx, got.value);
  if (!got.value.configured) {
    ctx.stdout.write("configured: no\n");
    ctx.stderr.write(`INFO set a destination: eris yak config set --team <key> (teams: eris yak discover teams)\n`);
    return 0;
  }
  ctx.stdout.write(`configured: yes\n${renderConfig(got.value)}`);
  return 0;
}

const NONE = "none";

export async function runConfigSet(args: string[], ctx: VerbContext, deps: AdminDeps = {}): Promise<number> {
  const p = readArgs(plugin.rows, "yak config set", args, ctx);
  if (p === null) return 0;
  const team = p.flags["--team"];
  const project = p.flags["--project"];
  const state = p.flags["--state"];
  const labels = p.flags["--labels"].flatMap((v) => v.split(",")).map((v) => v.trim()).filter((v) => v.length > 0 && v !== NONE);
  const labelsGiven = p.flags["--labels"].length > 0;
  if (team === undefined && project === undefined && state === undefined && !labelsGiven) {
    return fail(ctx, { slug: "yak-config-set-empty", what: "eris yak config set was given nothing to set", fix: "eris yak config set --team <id|key|name> [--project <id|name|none>] [--state <id|name|none>] [--labels <id|name,...>]" });
  }

  const ep = await resolveEndpoint(ctx.env, home(ctx, deps));
  if (!ep.ok) return fail(ctx, ep.failure);

  const needsLookup = team !== undefined || (project !== undefined && project !== NONE) || (state !== undefined && state !== NONE) || labels.length > 0;

  const patch: YakConfigPatch = {};
  if (needsLookup) {
    // Names resolve against the team being set, else the one already stored.
    let scope = team;
    if (scope === undefined) {
      const stored = await request(ep.value, "GET", "/v1/yaks/config", YakConfigRead, deps);
      if (!stored.ok) return fail(ctx, stored.failure);
      if (!stored.value.configured) {
        return fail(ctx, { slug: "yak-config-invalid", what: "this org has no config yet, so its first set needs a team", fix: "eris yak config set --team <id|key|name> ..." });
      }
      scope = stored.value.config.team_id;
    }
    const found = await discoverFor(ep.value, scope, deps);
    if (!found.ok) return fail(ctx, found.failure);
    const d = found.value;
    if (team !== undefined) patch.team_id = d.team_id ?? team;
    if (project !== undefined && project !== NONE) {
      const hit = pick("project", project, d.projects, (x) => [x.name], named);
      if (!hit.ok) return fail(ctx, hit.failure);
      patch.project_id = hit.value.id;
    }
    if (state !== undefined && state !== NONE) {
      const hit = pick("state", state, d.workflow_states, (x) => [x.name], named);
      if (!hit.ok) return fail(ctx, hit.failure);
      patch.state_id = hit.value.id;
    }
    if (labelsGiven) {
      const ids: string[] = [];
      for (const l of labels) {
        const hit = pick("label", l, d.labels.filter((x) => !x.isGroup), (x) => [x.name], named);
        if (!hit.ok) return fail(ctx, hit.failure);
        ids.push(hit.value.id);
      }
      patch.label_ids = ids;
    }
  } else if (labelsGiven) {
    patch.label_ids = [];
  }
  if (project === NONE) patch.project_id = null;
  if (state === NONE) patch.state_id = null;

  const set = await request(ep.value, "PUT", "/v1/yaks/config", YakStoredConfig, deps, patch);
  if (!set.ok) return fail(ctx, set.failure);
  if (ctx.format === "json") return emitJson(ctx, set.value);
  ctx.stdout.write(`configured: yes\n${renderConfig(set.value)}`);
  ctx.stderr.write("INFO ✓ yak destination set; parked yaks file on the next drain\n");
  return 0;
}
