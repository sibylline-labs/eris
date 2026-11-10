/**
 * org.ts — `eris org members` and `eris org members deactivate <id>`: the org's
 * members, listed and (by an admin) deactivated, over the gateway's bearer
 * routes `GET /v1/org/members` and `POST /v1/org/members/:id/deactivate`.
 * Loaded only when `eris org` dispatches (the manifest is ./index.ts).
 * `eris org delete --confirm <workspace>` and `--cancel` schedule and cancel the org's
 * deletion over `POST` and `DELETE /v1/org/deletion`.
 *
 * The routes answer success as plain JSON and every refusal as problem+json
 * with a top-level `code` (`admin_required`, `member_not_found`,
 * `cannot_deactivate_self`, `invalid_token`).
 *
 * Invariants:
 *   - The bearer and url come from `resolveOrgBearer` with the caller's `cwd`, the
 *     resolver every org-bound command uses, so a repo that selects org B acts
 *     on org B. The bearer is never written to either stream.
 *   - Authorisation is the server's. The role is not pre-checked here: a 403
 *     `admin_required` is rendered as the `org-admin-required` refusal, and a
 *     stale role cannot make the CLI refuse or allow wrongly.
 *   - Every failure is the slugged block on stderr, nothing on stdout, exit 1.
 *     Under `--output json` a success prints the server's body, bare.
 *   - One request, bounded by `ORG_TIMEOUT_MS` over the whole exchange.
 */

import { homedir } from "node:os";
import { CliExit, groupArgs, readArgs, renderFailureBlock, resolveOrgBearer, type VerbContext } from "../../src/cli/plugin";
import { z } from "zod";
import plugin from "./index";

// A `…Slug`-named union: `tests/errors-doc.test.ts` harvests its members.
export type OrgSlug = "org-unauthorized" | "org-admin-required" | "org-member-not-found" | "org-cannot-deactivate-self" | "org-unavailable" | "org-unknown-verb" | "org-member-id-missing" | "org-scope-denied" | "org-delete-flags" | "org-confirmation-mismatch" | "org-workspace-name-unknown" | "org-tokens-revoked";

const ORG_TIMEOUT_MS = 15_000;

const Member = z
  .object({
  memberId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  role: z.string(),
  status: z.string(),
  seats: z.array(z.string()),
  })
  .passthrough();
// passthrough: --output json prints the server's body, fields this build does not know included.
const Members = z.object({ members: z.array(Member) }).passthrough();
const Deactivated = z.object({ memberId: z.string(), status: z.string() }).passthrough();
const Scheduled = z.object({ dueAt: z.string(), cause: z.string() }).passthrough();
const Cancelled = z.object({ cancelled: z.boolean() }).passthrough();

/** A member id is a ULID; anything else never leaves the machine (`.` and `..` would otherwise rewrite the path). */
const MEMBER_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/** The dash Members page's names for a seat (`PRODUCT_NAMES`); an id it does not know prints as itself. */
const SEAT_NAMES: Readonly<Record<string, string>> = { accounts: "Accounts", yak: "Yaks", graph: "Graph", socrates: "Socrates", "linear-proxy": "Linear proxy" };

export const ORG_USAGE = `Usage: eris org <command>

Commands:
  members                        List this org's members: name, email, role, status, seats, id
  members deactivate <member-id> Deactivate a member (an org admin's)
  delete --confirm <workspace>   Schedule this org's deletion (an org admin's)
  delete --cancel                Cancel a scheduled deletion

The org is the one this directory acts as ('eris whoami').
`;

export const MEMBERS_USAGE = `Usage: eris org members [deactivate <member-id>]

List the members of the org this directory acts as: name (else the email's
local part), email, role, status, seats and the member id. 'eris --output json org members'
prints the server's body.

  eris org members deactivate <member-id>   deactivate a member: their sessions,
  CLI tokens and seats end now. Only an org admin may; anyone else is refused
  (org-admin-required). The id is the memberId in 'eris org members'. You
  cannot deactivate yourself.
`;

export const DELETE_USAGE = `Usage: eris org delete --confirm <workspace> | --cancel

  --confirm <workspace>   schedule this org's deletion. The name must be the org's workspace
                          name exactly; a wrong name is refused and nothing is scheduled.
                          Only an org admin may.
  --cancel                cancel a scheduled deletion.

Scheduling revokes every token the org holds, this machine's included, so the cancel
is made from the dashboard's Danger zone, signed in again. 'eris --output json org delete'
prints the server's body.
`;

export interface OrgDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  home?: string;
  /** The directory whose `eris.yaml` selects the org; the process's cwd when absent. */
  cwd?: string;
}

interface Failure {
  slug: OrgSlug | string;
  what: string;
  fix?: string;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; failure: Failure };

/** The problem body's `code`: top level, else the `{error:{code}}` shape. */
function problemCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const top = (body as { code?: unknown }).code;
  if (typeof top === "string") return top;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string") return (error as { code: string }).code;
  return undefined;
}

type Action = "deactivate a member" | "delete the org";

function refusal(status: number, code: string | undefined, target: string, action: Action = "deactivate a member"): Failure {
  const answered = `the org endpoint answered ${status}${code ? ` ${code}` : ""} for ${target}`;
  if (status === 401 && code === "revoked") {
    return {
      slug: "org-tokens-revoked",
      what: `${answered}: this token is revoked. A scheduled deletion revokes every token the org holds`,
      fix: "if this org's deletion is scheduled, cancel it from the dashboard's Danger zone after signing in again; otherwise run: eris login",
    };
  }
  if (status === 401) return { slug: "org-unauthorized", what: `${answered}: it rejected the bearer token`, fix: "run: eris login\n(or check ERIS_YAKS_TOKEN when it is set)" };
  if (status === 403 && code === "admin_required") {
    return {
      slug: "org-admin-required",
      what: `${answered}: only an admin of this org can ${action}`,
      fix: action === "delete the org" ? "ask an org admin to run it, or to use the dashboard's Danger zone" : "ask an org admin to run it, or to deactivate the member in the dashboard's Members page",
    };
  }
  if (status === 403 && code === "scope_denied") {
    return { slug: "org-scope-denied", what: `${answered}: this token does not carry the accounts scope`, fix: "run: eris login   (a CLI login carries it; a service token without the accounts scope does not)" };
  }
  if (status === 404 && code === "member_not_found") return { slug: "org-member-not-found", what: `${answered}: this org has no such member`, fix: "list the ids: eris org members" };
  if (status === 400 && code === "confirmation_mismatch") {
    return { slug: "org-confirmation-mismatch", what: `${answered}: the name given is not this org's workspace name; nothing was scheduled`, fix: "give the workspace name exactly as the dashboard shows it" };
  }
  if (status === 409 && code === "workspace_name_unknown") {
    return { slug: "org-workspace-name-unknown", what: `${answered}: this org has no stored workspace name to confirm against; nothing was scheduled`, fix: "connect or reconnect the org's Linear workspace in the dashboard, then run it again" };
  }
  if (status === 400 && code === "cannot_deactivate_self") return { slug: "org-cannot-deactivate-self", what: `${answered}: you cannot deactivate your own member`, fix: "have another admin deactivate it" };
  return { slug: "org-unavailable", what: answered, fix: "retry; 'eris whoami' shows which org and url this directory uses" };
}

/** One bounded request with the org's bearer; the body parsed against `schema`. */
async function request<S extends z.ZodTypeAny>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  schema: S,
  ctx: VerbContext,
  deps: OrgDeps,
  opts: { body?: unknown; action?: Action } = {},
): Promise<Outcome<z.infer<S>>> {
  const bearer = await resolveOrgBearer({ home: deps.home ?? ctx.env.HOME ?? homedir(), env: ctx.env, cwd: deps.cwd ?? process.cwd() });
  if ("reason" in bearer) return { ok: false, failure: { slug: bearer.slug, what: bearer.reason, fix: bearer.fix } };
  const base = bearer.value.url.replace(/\/+$/, "");
  const target = `${method} ${base}${path}`;
  const timeoutMs = deps.timeoutMs ?? ORG_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    let parsed: unknown;
    try {
      response = await (deps.fetchImpl ?? fetch)(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${bearer.value.token}`, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
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
      const what = name === "AbortError" || name === "TimeoutError" ? `the org endpoint did not answer within ${timeoutMs}ms (${target})` : `cannot reach the org endpoint (${target}): ${(err as Error).message}`;
      return { ok: false, failure: { slug: "org-unavailable", what, fix: "check the network, and ERIS_YAKS_URL or the url in ~/.eris/yaks.json" } };
    }
    if (!response.ok) return { ok: false, failure: refusal(response.status, problemCode(parsed), target, opts.action) };
    const shaped = schema.safeParse(parsed);
    if (!shaped.success) {
      return { ok: false, failure: { slug: "org-unavailable", what: `the org endpoint answered ${response.status} with a body that does not match the contract (${target})`, fix: "update eris: eris update" } };
    }
    return { ok: true, value: shaped.data };
  } finally {
    clearTimeout(timer);
  }
}

function fail(ctx: VerbContext, failure: Failure): number {
  ctx.stderr.write(renderFailureBlock({ slug: failure.slug, what: failure.what, ...(failure.fix ? { fix: failure.fix } : {}) }, ctx.erisDir));
  return 1;
}

/** Columns, two spaces apart, the last unpadded. */
function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ").trimEnd()).join("\n") + "\n";
}

/** What a person is called: their name, else the part of their email before the `@` (the dash's rule). */
function displayName(m: z.infer<typeof Member>): string {
  if (m.name !== null && m.name.trim() !== "") return m.name;
  const local = m.email?.split("@")[0];
  return local === undefined || local === "" ? "Unnamed member" : local;
}

async function runList(ctx: VerbContext, deps: OrgDeps): Promise<number> {
  const got = await request("GET", "/v1/org/members", Members, ctx, deps);
  if (!got.ok) return fail(ctx, got.failure);
  if (ctx.format === "json") {
    ctx.stdout.write(`${JSON.stringify(got.value)}\n`);
    return 0;
  }
  const rows = got.value.members.map((m) => [displayName(m), m.email ?? "", m.role, m.status, m.seats.length === 0 ? "none" : m.seats.map((s) => SEAT_NAMES[s] ?? s).join(", "), m.memberId]);
  ctx.stdout.write(table([["NAME", "EMAIL", "ROLE", "STATUS", "SEATS", "ID"], ...rows]));
  return 0;
}

async function runDeactivate(id: string | undefined, ctx: VerbContext, deps: OrgDeps): Promise<number> {
  if (id === undefined || id === "") {
    return fail(ctx, { slug: "org-member-id-missing", what: "eris org members deactivate was given no member id", fix: "eris org members deactivate <member-id>   (the ids: eris org members)" });
  }
  if (!MEMBER_ID.test(id)) {
    return fail(ctx, { slug: "org-member-not-found", what: `'${id}' is not a member id (a member id is a 26-character ULID); nothing was sent`, fix: "list the ids: eris org members" });
  }
  const got = await request("POST", `/v1/org/members/${id}/deactivate`, Deactivated, ctx, deps);
  if (!got.ok) return fail(ctx, got.failure);
  if (ctx.format === "json") {
    ctx.stdout.write(`${JSON.stringify(got.value)}\n`);
    return 0;
  }
  ctx.stdout.write(`deactivated ${got.value.memberId}\n`);
  return 0;
}

async function runDelete(confirm: string | undefined, cancel: boolean, ctx: VerbContext, deps: OrgDeps): Promise<number> {
  const given = confirm !== undefined;
  if (given === cancel) {
    return fail(ctx, { slug: "org-delete-flags", what: given ? "eris org delete was given both --confirm and --cancel" : "eris org delete was given neither --confirm nor --cancel", fix: "eris org delete --confirm <workspace>   or   eris org delete --cancel" });
  }
  if (given && confirm.trim() === "") {
    return fail(ctx, { slug: "org-delete-flags", what: "eris org delete --confirm was given an empty workspace name; nothing was sent", fix: "eris org delete --confirm <workspace>" });
  }
  if (given) {
    const got = await request("POST", "/v1/org/deletion", Scheduled, ctx, deps, { body: { confirm }, action: "delete the org" });
    if (!got.ok) return fail(ctx, got.failure);
    if (ctx.format === "json") {
      ctx.stdout.write(`${JSON.stringify(got.value)}\n`);
      return 0;
    }
    ctx.stdout.write(`deletion scheduled for ${got.value.dueAt}\n`);
    ctx.stderr.write("INFO this org's tokens, this machine's included, are now revoked; cancel from the dashboard's Danger zone, signed in again\n");
    return 0;
  }
  const got = await request("DELETE", "/v1/org/deletion", Cancelled, ctx, deps, { action: "delete the org" });
  if (!got.ok) return fail(ctx, got.failure);
  if (ctx.format === "json") {
    ctx.stdout.write(`${JSON.stringify(got.value)}\n`);
    return 0;
  }
  ctx.stdout.write(got.value.cancelled ? "deletion cancelled\n" : "no deletion was scheduled\n");
  return 0;
}

function unknown(ctx: VerbContext, sub: string, use: string): never {
  ctx.stderr.write(renderFailureBlock({ slug: "org-unknown-verb", what: `unknown org command '${sub}'`, fix: `use: ${use}\nrun 'eris org --help' for the full command list` }, ctx.erisDir));
  throw new CliExit(1);
}

export async function runOrg(args: string[], ctx: VerbContext, deps: OrgDeps = {}): Promise<number> {
  const g = groupArgs(plugin.rows, "org", args);
  if (g.kind === "bare" || g.kind === "help") {
    if (ctx.format === "json") {
      ctx.stderr.write(renderFailureBlock({ slug: "output-json-unsupported", what: "eris org has no JSON rendering", fix: "use: eris --output json org members" }, ctx.erisDir));
      throw new CliExit(1);
    }
    ctx.stdout.write(ORG_USAGE);
    return 0;
  }
  if (g.kind === "unknown") return unknown(ctx, g.sub, "members, delete");
  if (g.sub === "delete") {
    const d = readArgs(plugin.rows, "org delete", g.rest, ctx, { help: DELETE_USAGE });
    if (d === null) return 0;
    return runDelete(d.flags["--confirm"], d.flags["--cancel"] === true, ctx, deps);
  }
  const a = readArgs(plugin.rows, "org members", g.rest, ctx, { help: MEMBERS_USAGE });
  if (a === null) return 0;
  const [action, id] = a.pos;
  if (action === undefined) return runList(ctx, deps);
  if (action !== "deactivate") return unknown(ctx, `members ${action}`, "members, members deactivate <member-id>");
  return runDeactivate(id, ctx, deps);
}
