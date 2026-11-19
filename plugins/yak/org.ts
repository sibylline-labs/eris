/**
 * org.ts — `eris org members` and `eris org members deactivate <id>`: the org's
 * members, listed and (by an admin) deactivated, over the gateway's bearer
 * routes `GET /v1/org/members` and `POST /v1/org/members/:id/deactivate`.
 * Loaded only when `eris org` dispatches (the manifest is ./index.ts).
 * `eris org delete --confirm <workspace>` and `--cancel` schedule and cancel the org's
 * deletion over `POST` and `DELETE /v1/org/deletion`.
 * `eris org billing checkout|portal` prints a Stripe Checkout or Billing Portal URL for the org
 * (`POST /v1/org/billing/checkout|portal`); the CLI never takes payment details.
 * `eris org connect-linear` has an admin's bearer mint an org-bound install link
 * (`POST /v1/org/linear/connect`), hands it to the browser, and polls `GET /v1/org/me` until
 * `linear.status` reads `connected`.
 * `eris org connect-github --account <github-org>` opens the platform GitHub App's install page,
 * waits until `gh api orgs/<github-org>/installations` lists the App, then binds that installation
 * over `POST /v1/github/installation`, sending the caller's own `gh auth token` once as the proof that
 * they own the GitHub org (the server lists the installation with it and keeps nothing).
 * `eris org github` reads the binding (`GET /v1/github`); `eris org disconnect-github` retires it.
 * `eris org webhooks logfire` prints the org's Logfire alert webhook URL (`GET
 * /v1/org/webhooks/logfire`), and `eris org webhooks logfire revoke` replaces it with a new one
 * (`POST /v1/org/webhooks/logfire/revoke`); the old URL stops working at once.
 *
 * The routes answer success as plain JSON and every refusal as problem+json
 * with a top-level `code` (`admin_required`, `member_not_found`,
 * `cannot_deactivate_self`, `invalid_token`).
 *
 * Invariants:
 *   - The bearer and url come from `resolveOrgBearer` with the caller's `cwd`, the
 *     resolver every org-bound command uses, so a repo that selects org B acts
 *     on org B. The bearer and the GitHub token are never written to either stream.
 *   - Authorisation is the server's. The role is not pre-checked here: a 403
 *     `admin_required` is rendered as the `org-admin-required` refusal, and a
 *     stale role cannot make the CLI refuse or allow wrongly.
 *   - Every failure is the slugged block on stderr, nothing on stdout, exit 1.
 *     Under `--output json` a success prints the server's body, bare; `webhooks logfire` adds
 *     `url`, the path joined to the org's url, since the path alone is not an address.
 *   - One request, bounded by `ORG_TIMEOUT_MS` over the whole exchange. `connect-linear` is a
 *     sequence of such requests whose wait ends at the link's expiry, never later than `MAX_WAIT_MS`.
 *   - The link the server minted is opened only when it is an http(s) url, and is printed on
 *     stderr alone (stdout is the payload).
 */

import { homedir } from "node:os";
import { CliExit, groupArgs, readArgs, renderFailureBlock, resolveOrgBearer, type VerbContext } from "../../src/cli/plugin";
import { z } from "zod";
import plugin from "./index";
import { defaultOpenBrowser } from "./login";
import { problemCode } from "./yak-admin";

// A `…Slug`-named union: `tests/errors-doc.test.ts` harvests its members.
export type OrgSlug = "org-unauthorized" | "org-admin-required" | "org-member-not-found" | "org-cannot-deactivate-self" | "org-unavailable" | "org-unknown-verb" | "org-member-id-missing" | "org-scope-denied" | "org-delete-flags" | "org-confirmation-mismatch" | "org-workspace-name-unknown" | "org-tokens-revoked" | "org-connect-unconfigured" | "org-connect-timeout" | "org-admin-action-invalid" | "org-last-admin" | "org-github-unconfigured" | "org-github-account-invalid" | "org-gh-unavailable" | "org-github-not-owner" | "org-github-timeout" | "org-github-unproven" | "org-github-bound-elsewhere" | "org-github-org-bound" | "org-bus-lapsed" | "org-billing-unavailable" | "org-billing-nothing-to-bill";

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
const AdminGrant = z.object({ memberId: z.string(), role: z.string(), roleSource: z.string().nullable().optional() }).passthrough();
const Deactivated = z.object({ memberId: z.string(), status: z.string() }).passthrough();
const Scheduled = z.object({ dueAt: z.string(), cause: z.string() }).passthrough();
const Cancelled = z.object({ cancelled: z.boolean() }).passthrough();
// passthrough: --output json prints the org's body as sent; only the connection's state is read here.
const OrgMe = z.object({ linear: z.object({ status: z.string(), cause: z.string().optional() }).passthrough() }).passthrough();
const ConnectLink = z.object({ url: z.string(), expires_at: z.string() }).passthrough();

/** How often the org is asked whether Linear is connected yet, and how many consecutive failed asks end the wait. */
const POLL_MS = 2_000;
const MAX_TRANSIENT = 3;
/** The wait never outlives the link by more than this: the server's clock and the machine's differ by a little. */
const EXPIRY_GRACE_MS = 5_000;

/** A member id is a ULID; anything else never leaves the machine (`.` and `..` would otherwise rewrite the path). */
const MEMBER_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/** The dash Members page's names for a seat (`PRODUCT_NAMES`); an id it does not know prints as itself. */
const SEAT_NAMES: Readonly<Record<string, string>> = { accounts: "Accounts", yak: "Yaks", graph: "Graph", socrates: "Socrates", "linear-proxy": "Linear proxy" };

export const ORG_USAGE = `Usage: eris org <command>

Commands:
  members                        List this org's members: name, email, role, status, seats, id
  members deactivate <member-id> Deactivate a member (an org admin's)
  members admin grant <member-id>  Make a member an admin (an org admin's)
  members admin revoke <member-id> Demote an admin to member (an org admin's)
  delete --confirm <workspace>   Schedule this org's deletion (an org admin's)
  delete --cancel                Cancel a scheduled deletion
  connect-linear [--no-browser]  Connect this org's Linear workspace through the browser (an org admin's)
  github                         Show the GitHub App installation this org's bus receives events from
  connect-github --account <org> [--no-browser]
                                 Install the GitHub App on a GitHub org you own and bind it (an org admin's)
  disconnect-github              Unbind this org's GitHub App installation (an org admin's)
  billing checkout               Print a Stripe Checkout URL for this org's subscription (an org admin's)
  billing portal                 Print a Stripe Billing Portal URL for this org (an org admin's)
  webhooks logfire [revoke]      Print this org's Logfire alert webhook URL, or replace it (an org admin's)

The org is the one this directory acts as ('eris whoami').
`;

export const MEMBERS_USAGE = `Usage: eris org members [deactivate <member-id> | admin grant|revoke <member-id>]

List the members of the org this directory acts as: name (else the email's
local part), email, role, status, seats and the member id. 'eris --output json org members'
prints the server's body.

  eris org members deactivate <member-id>   deactivate a member: their sessions,
  CLI tokens and seats end now. Only an org admin may; anyone else is refused
  (org-admin-required). The id is the memberId in 'eris org members'. You
  cannot deactivate yourself.

  eris org members admin grant <member-id>    make a member an admin at once
  eris org members admin revoke <member-id>   demote an admin to member; refused
  while it would leave the org no other active admin (org-last-admin)
  Both are an org admin's and print the member's role afterwards; the server
  decides who may, never this command.
`;

export const CONNECT_USAGE = `Usage: eris org connect-linear [--no-browser]

Connect (or reconnect) the Linear workspace of the org this directory acts as. An org
admin's bearer mints a short-lived, single-use link bound to the org; this opens it in the
browser (or only prints it under --no-browser), then waits until the org reports Linear as
connected. An org that is already connected says so and mints nothing. Anyone but an org
admin is refused before the browser is opened (org-admin-required). The link stops working
after 10 minutes; run the command again for a new one. 'eris --output json org connect-linear'
prints the org's own body once connected.
`;

export const GITHUB_CONNECT_USAGE = `Usage: eris org connect-github --account <github-org> [--no-browser]

Bind a GitHub App installation to the org this directory acts as, so GitHub pull request,
review, comment and CI events reach its bus ('eris bus subscribe gh:*'). Opens the platform
App's install page in the browser (or only prints it under --no-browser); install it on
<github-org>. It then waits until 'gh api orgs/<github-org>/installations' lists the App,
and binds that installation. The bind sends your own 'gh auth token' once, as proof that you
own <github-org>: the server lists the installation with it through GitHub's owner-only API
and keeps nothing. Needs the GitHub CLI ('gh'), signed in as an owner of <github-org>, and an
org admin's eris login. GitHub organizations only; a personal account cannot be proven.
'eris --output json org connect-github' prints the server's body once bound.
`;

export const BILLING_USAGE = `Usage: eris org billing checkout | portal

  checkout   print a Stripe Checkout URL for this org's subscription
  portal     print a Stripe Billing Portal URL for this org

An org admin's. Open the printed URL in a browser and pay or manage billing on Stripe's page: eris never
takes card details and opens nothing itself. Each run opens a new session; the URL is short-lived and meant
for one person. 'eris --output json org billing checkout' prints the server's body ({url}). A platform with
billing off answers org-billing-unavailable.
`;

export const BILLING_CHECKOUT_USAGE = `Usage: eris org billing checkout

Print a Stripe Checkout URL for this org's subscription. An org admin's. Open the URL in a browser and pay on
Stripe's page: eris never takes card details and opens nothing itself. Each run opens a new, short-lived
session. 'eris --output json org billing checkout' prints the server's body ({url}). A platform with billing
off answers org-billing-unavailable.
`;

export const BILLING_PORTAL_USAGE = `Usage: eris org billing portal

Print a Stripe Billing Portal URL for this org's customer, to manage its subscription and payment method on
Stripe's page. An org admin's. eris never takes card details and opens nothing itself. Each run opens a new,
short-lived session. 'eris --output json org billing portal' prints the server's body ({url}). A platform
with billing off answers org-billing-unavailable.
`;

export const WEBHOOKS_USAGE = `Usage: eris org webhooks logfire [revoke]

Print the webhook URL that posts this org's Logfire alerts onto its bus: paste it as the
webhook of a Logfire alert channel. The URL is a credential: anyone holding it can post
alerts to this org, so keep it out of chat and logs.

  eris org webhooks logfire revoke   replace the URL with a new one and print it. The old URL
  stops working at once, so update every Logfire channel that uses it.

Both are an org admin's (org-admin-required otherwise); the dashboard's Webhooks section shows
the same URL. 'eris --output json org webhooks logfire' prints {url, path, generation}.
`;

export const GITHUB_USAGE = `Usage: eris org github

Show the GitHub App installation bound to the org this directory acts as, and the App's
install link. An org admin's. 'eris --output json org github' prints the server's body.
`;

export const GITHUB_DISCONNECT_USAGE = `Usage: eris org disconnect-github

Unbind the org's GitHub App installation: its events stop reaching the bus. The installation
stays held by this org, so another org cannot take it; uninstall the App on GitHub to remove
it there. An org admin's. 'eris --output json org disconnect-github' prints the server's body.
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
  /** Hands a url to the operating system's browser opener. */
  openBrowser?: (url: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Time between asks of `connect-linear`'s wait. */
  pollMs?: number;
  /** Runs the GitHub CLI; `gh` on the caller's PATH (`ctx.env`) when absent. */
  runGh?: (args: readonly string[]) => Promise<GhResult>;
  /** How long one `gh` run may take before it is killed. */
  ghTimeoutMs?: number;
}

/** What one `gh` run answered; `code` -1 when it could not be started. */
export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Failure {
  slug: OrgSlug | string;
  what: string;
  fix?: string;
}

/** A success carries the org's url (`base`, no trailing slash) the request went to. */
type Outcome<T> = { ok: true; value: T; base: string } | { ok: false; failure: Failure };

type Action = "grant admin" | "revoke admin" | "deactivate a member" | "delete the org" | "cancel the org's deletion" | "connect Linear" | "connect GitHub" | "disconnect GitHub" | "read the Logfire webhook URL" | "revoke the Logfire webhook URL" | "open Stripe billing";

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
      fix:
        action === "grant admin" || action === "revoke admin"
          ? "ask an org admin to run it, or to change the member's role in the dashboard's Members page"
          : action === "deactivate a member"
          ? "ask an org admin to run it, or to deactivate the member in the dashboard's Members page"
          : action === "connect Linear"
            ? "ask an org admin to run: eris org connect-linear"
            : action === "open Stripe billing"
            ? "ask an org admin to run it, or to use the dashboard's Billing page"
            : action === "connect GitHub" || action === "disconnect GitHub"
            ? `ask an org admin to run: eris org ${action === "connect GitHub" ? "connect-github" : "disconnect-github"}`
            : action === "read the Logfire webhook URL" || action === "revoke the Logfire webhook URL"
            ? `ask an org admin to run: eris org webhooks logfire${action === "revoke the Logfire webhook URL" ? " revoke" : ""}   (or to use the dashboard's Webhooks section)`
            : "ask an org admin to run it, or to use the dashboard's Danger zone",
    };
  }
  if (status === 503 && code === "connect_unconfigured") {
    return { slug: "org-connect-unconfigured", what: `${answered}: this platform has no dashboard address to ${action === "open Stripe billing" ? "send Stripe's return links to" : "send the install link to"}; nothing was opened`, fix: "this is the platform's setup, not this machine's: tell the platform's operator" };
  }
  if (action === "open Stripe billing" && status === 404 && code === "org_not_found") {
    return { slug: "org-unavailable", what: `${answered}: the server does not know this org`, fix: "check which org this directory acts as: eris whoami" };
  }
  if (action === "open Stripe billing" && status === 409 && code === "nothing_to_bill") {
    return { slug: "org-billing-nothing-to-bill", what: `${answered}: no product of this org needs a new subscription (each is free, or already billed); nothing was opened`, fix: "manage an existing subscription instead: eris org billing portal" };
  }
  if (action === "open Stripe billing" && status === 503 && code === "billing_invalid_config") {
    return { slug: "org-billing-unavailable", what: `${answered}: billing is on but this platform's Stripe configuration is invalid; nothing was opened`, fix: "this is the platform's setup, not this machine's: tell the platform's operator" };
  }
  if (action === "open Stripe billing" && status === 404) {
    return { slug: "org-billing-unavailable", what: `${answered}: billing is not turned on for this platform, so there is no Stripe session to open`, fix: "this is the platform's setup, not this machine's: tell the platform's operator" };
  }
  if (action === "open Stripe billing" && status === 503 && code === "billing_unconfigured") {
    return { slug: "org-billing-unavailable", what: `${answered}: billing is on but this platform's Stripe is not configured; nothing was opened`, fix: "this is the platform's setup, not this machine's: tell the platform's operator" };
  }
  if (status === 402 && code === "entitlement_lapsed") {
    // The GitHub verbs reach a row verified for bus, so they meet this refusal too: say what was refused per action.
    const refused = action === "revoke the Logfire webhook URL" ? "no new webhook URL is issued" : `this org cannot ${action}`;
    return { slug: "org-bus-lapsed", what: `${answered}: this org's bus product is not active, so ${refused}; nothing changed`, fix: "reactivate the bus product for this org (the dashboard's Billing page), then run it again" };
  }
  if (status === 503 && code === "github_app_unconfigured") {
    return { slug: "org-github-unconfigured", what: `${answered}: this platform has no GitHub App configured; nothing was bound`, fix: "this is the platform's setup, not this machine's: tell the platform's operator" };
  }
  if (status === 403 && code === "installation_unproven") {
    return {
      slug: "org-github-unproven",
      what: `${answered}: your GitHub token did not list that installation of the platform's App on the GitHub org named; nothing was bound`,
      fix: "run it signed in to gh as an owner of that GitHub org ('gh auth status'), with --account naming the org the App is installed on",
    };
  }
  if (status === 409 && code === "installation_already_bound") {
    return { slug: "org-github-bound-elsewhere", what: `${answered}: that installation is bound to another org; nothing was bound`, fix: "moving an installation between orgs is the platform operator's act: tell them" };
  }
  if (status === 409 && code === "org_already_bound") {
    return { slug: "org-github-org-bound", what: `${answered}: this org already has another GitHub App installation bound`, fix: "unbind it first: eris org disconnect-github" };
  }
  if (status === 403 && code === "scope_denied") {
    if (action === "connect GitHub" || action === "disconnect GitHub") {
      return { slug: "org-scope-denied", what: `${answered}: this token does not carry the bus scope (the org may not have the bus product)`, fix: "run: eris login   (a CLI login carries every product the org has; 'eris whoami' lists them)" };
    }
    return { slug: "org-scope-denied", what: `${answered}: this token does not carry the accounts scope`, fix: "run: eris login   (a CLI login carries it; a service token without the accounts scope does not)" };
  }
  if (status === 404 && code === "member_not_found") return { slug: "org-member-not-found", what: `${answered}: this org has no such member`, fix: "list the ids: eris org members" };
  if (status === 400 && code === "confirmation_mismatch") {
    return { slug: "org-confirmation-mismatch", what: `${answered}: the name given is not this org's workspace name; nothing was scheduled`, fix: "give the workspace name exactly as the dashboard shows it" };
  }
  if (status === 409 && code === "workspace_name_unknown") {
    return { slug: "org-workspace-name-unknown", what: `${answered}: this org has no stored workspace name to confirm against; nothing was scheduled`, fix: "connect or reconnect the org's Linear workspace in the dashboard, then run it again" };
  }
  if (status === 409 && code === "last_admin") {
    return { slug: "org-last-admin", what: `${answered}: this would leave the org with no other active admin; nothing changed`, fix: "grant admin to another member first: eris org members admin grant <member-id>" };
  }
  if (status === 400 && code === "cannot_deactivate_self") return { slug: "org-cannot-deactivate-self", what: `${answered}: you cannot deactivate your own member`, fix: "have another admin deactivate it" };
  return { slug: "org-unavailable", what: answered, fix: "retry; 'eris whoami' shows which org and url this directory uses" };
}

/** One bounded request with the org's bearer; the body parsed against `schema`. */
export async function request<S extends z.ZodTypeAny>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  schema: S,
  ctx: VerbContext,
  deps: OrgDeps,
  opts: { body?: unknown; action?: Action; refuse?: (status: number, code: string | undefined, target: string, retryAfter: string | null) => Failure | null } = {},
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
        // A redirect would re-send the body (a GitHub token, on a bind) to whatever host it names.
        redirect: "error",
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
    if (!response.ok) {
      const code = problemCode(parsed);
      return { ok: false, failure: opts.refuse?.(response.status, code, target, response.headers.get("retry-after")) ?? refusal(response.status, code, target, opts.action) };
    }
    const shaped = schema.safeParse(parsed);
    if (!shaped.success) {
      return { ok: false, failure: { slug: "org-unavailable", what: `the org endpoint answered ${response.status} with a body that does not match the contract (${target})`, fix: "update eris: eris update" } };
    }
    return { ok: true, value: shaped.data, base };
  } finally {
    clearTimeout(timer);
  }
}

export function fail(ctx: VerbContext, failure: Failure): number {
  ctx.stderr.write(renderFailureBlock({ slug: failure.slug, what: failure.what, ...(failure.fix ? { fix: failure.fix } : {}) }, ctx.erisDir));
  return 1;
}

/** A server string for a terminal: control characters (escapes, newlines) become `?`. */
export const plain = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");

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

async function runAdmin(op: string | undefined, id: string | undefined, ctx: VerbContext, deps: OrgDeps): Promise<number> {
  if (op !== "grant" && op !== "revoke") {
    return fail(ctx, { slug: "org-admin-action-invalid", what: `eris org members admin was given ${op === undefined ? "no action" : `'${plain(op)}'`}`, fix: "eris org members admin grant <member-id>   or   eris org members admin revoke <member-id>" });
  }
  if (id === undefined || id === "") {
    return fail(ctx, { slug: "org-member-id-missing", what: `eris org members admin ${op} was given no member id`, fix: `eris org members admin ${op} <member-id>   (the ids: eris org members)` });
  }
  if (!MEMBER_ID.test(id)) {
    return fail(ctx, { slug: "org-member-not-found", what: `'${plain(id)}' is not a member id (a member id is a 26-character ULID); nothing was sent`, fix: "list the ids: eris org members" });
  }
  const got = await request(op === "grant" ? "POST" : "DELETE", `/v1/org/members/${id}/admin`, AdminGrant, ctx, deps, { action: op === "grant" ? "grant admin" : "revoke admin" });
  if (!got.ok) return fail(ctx, got.failure);
  if (ctx.format === "json") {
    ctx.stdout.write(`${JSON.stringify(got.value)}\n`);
    return 0;
  }
  ctx.stdout.write(`${got.value.memberId} is now ${plain(got.value.role)}\n`);
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
    ctx.stdout.write(`deletion scheduled for ${plain(got.value.dueAt)}\n`);
    ctx.stderr.write("INFO this org's tokens, this machine's included, are now revoked; cancel from the dashboard's Danger zone, signed in again\n");
    return 0;
  }
  const got = await request("DELETE", "/v1/org/deletion", Cancelled, ctx, deps, { action: "cancel the org's deletion" });
  if (!got.ok) return fail(ctx, got.failure);
  if (ctx.format === "json") {
    ctx.stdout.write(`${JSON.stringify(got.value)}\n`);
    return 0;
  }
  ctx.stdout.write(got.value.cancelled ? "deletion cancelled\n" : "no deletion was scheduled\n");
  return 0;
}

/** The whole wait is bounded: the link's own lifetime (it cannot be redeemed after), and never longer than this. */
const MAX_WAIT_MS = 15 * 60_000;

async function runConnectLinear(noBrowser: boolean, ctx: VerbContext, deps: OrgDeps): Promise<number> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser;
  const pollMs = deps.pollMs ?? POLL_MS;
  const done = (body: z.infer<typeof OrgMe>, text: string): number => {
    ctx.stdout.write(ctx.format === "json" ? `${JSON.stringify(body)}\n` : text);
    return 0;
  };

  const first = await request("GET", "/v1/org/me", OrgMe, ctx, deps, { action: "connect Linear" });
  if (!first.ok) return fail(ctx, first.failure);
  if (first.value.linear.status === "connected") return done(first.value, "already connected\n");

  // The server decides who may connect: a member is refused here, before any link exists to open.
  const minted = await request("POST", "/v1/org/linear/connect", ConnectLink, ctx, deps, { action: "connect Linear" });
  if (!minted.ok) return fail(ctx, minted.failure);
  let link: URL;
  try {
    link = new URL(minted.value.url);
  } catch {
    link = new URL("about:blank");
  }
  if (link.protocol !== "https:" && link.protocol !== "http:") {
    return fail(ctx, { slug: "org-unavailable", what: "the org endpoint answered with a link that is not an http(s) url; nothing was opened", fix: "update eris: eris update   (or tell the platform's operator)" });
  }
  const started = now();
  const expires = Date.parse(minted.value.expires_at);
  const deadline = Math.min(Number.isNaN(expires) ? started + MAX_WAIT_MS : expires + EXPIRY_GRACE_MS, started + MAX_WAIT_MS);
  ctx.stderr.write(`To connect this org's Linear workspace, open this link in a browser signed in to Linear:\n\n  ${link.href}\n\nWaiting for Linear to connect (the link works once, for ${Math.max(1, Math.round((deadline - started) / 60_000))} min)...\n`);
  if (!noBrowser) await openBrowser(link.href).catch(() => undefined);

  let transient = 0;
  for (;;) {
    await sleep(pollMs);
    if (now() >= deadline) {
      return fail(ctx, { slug: "org-connect-timeout", what: "the org did not report Linear as connected before the link expired", fix: "run: eris org connect-linear   (it mints a new link; 'eris whoami' shows the connection's state)" });
    }
    const polled = await request("GET", "/v1/org/me", OrgMe, ctx, deps, { action: "connect Linear" });
    if (!polled.ok) {
      // Only an answer that says nothing about the connection (a dropped request, a 5xx) is waited out.
      if (polled.failure.slug === "org-unavailable" && ++transient <= MAX_TRANSIENT) continue;
      return fail(ctx, polled.failure);
    }
    transient = 0;
    if (polled.value.linear.status === "connected") return done(polled.value, "connected\n");
  }
}

const GithubInstallation = z.object({ installation_id: z.number(), bound_at: z.string() }).passthrough();
const GithubApp = z.object({ id: z.number(), slug: z.string(), install_url: z.string() }).passthrough();
// passthrough: --output json prints the server's body, fields this build does not know included.
const GithubView = z.object({ installation: GithubInstallation.nullable(), app: GithubApp.nullable() }).passthrough();

/** A GitHub organization login; anything else never reaches `gh` or the server. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** How long `connect-github` waits for the App to show up on the GitHub org, and how often it asks `gh`. */
const GITHUB_WAIT_MS = 10 * 60_000;
const GITHUB_POLL_MS = 3_000;

/** One `gh` run's limit: a listing or a token read, never an interactive one. */
const GH_TIMEOUT_MS = 30_000;
/** Every `gh` call names github.com, so a `GH_HOST` or an enterprise login never answers for it. */
const GH_HOST = ["--hostname", "github.com"] as const;

async function defaultRunGh(args: readonly string[], env: VerbContext["env"], timeoutMs: number): Promise<GhResult> {
  try {
    const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...env }, timeout: timeoutMs, killSignal: "SIGKILL" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  } catch (err) {
    return { code: -1, stdout: "", stderr: (err as Error).message };
  }
}

const BillingRedirect = z.object({ url: z.string() }).passthrough();

/** The canonical href of a Stripe-hosted page, or null: `https` on `stripe.com` or one of its subdomains,
 *  no userinfo, no port, and no control or whitespace character anywhere in the text the server sent (the
 *  WHATWG parser strips tabs and newlines and ignores the rest, so the raw text is judged first). Only the
 *  parsed href is ever printed, so a terminal escape or a second line never reaches a person. */
function stripePage(raw: string): string | null {
  if (/[\u0000-\u0020\u007f-\u009f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return null;
  return url.hostname === "stripe.com" || url.hostname.endsWith(".stripe.com") ? url.href : null;
}

async function runBilling(kind: "checkout" | "portal", ctx: VerbContext, deps: OrgDeps): Promise<number> {
  const got = await request("POST", `/v1/org/billing/${kind}`, BillingRedirect, ctx, deps, { action: "open Stripe billing" });
  if (!got.ok) return fail(ctx, got.failure);
  const href = stripePage(got.value.url);
  if (href === null) {
    return fail(ctx, { slug: "org-unavailable", what: "the org endpoint answered with a link that is not a https://*.stripe.com page; nothing was printed", fix: "update eris: eris update   (or tell the platform's operator)" });
  }
  if (ctx.format === "json") {
    ctx.stdout.write(`${JSON.stringify({ ...got.value, url: href })}\n`);
    return 0;
  }
  ctx.stdout.write(`${plain(href)}\n`);
  ctx.stderr.write(`Open this link in a browser to ${kind === "checkout" ? "start your subscription" : "manage billing"} on Stripe. eris never takes card details.\n`);
  return 0;
}

const describeGithub = (view: z.infer<typeof GithubView>): string =>
  view.installation === null
    ? "no GitHub App installation is bound\n"
    : `bound: installation ${view.installation.installation_id} since ${plain(view.installation.bound_at)}\n`;

async function runGithub(ctx: VerbContext, deps: OrgDeps): Promise<number> {
  const got = await request("GET", "/v1/github", GithubView, ctx, deps, { action: "connect GitHub" });
  if (!got.ok) return fail(ctx, got.failure);
  if (ctx.format === "json") {
    ctx.stdout.write(`${JSON.stringify(got.value)}\n`);
    return 0;
  }
  ctx.stdout.write(describeGithub(got.value));
  if (got.value.installation === null && got.value.app !== null) ctx.stdout.write(`connect one: eris org connect-github --account <github-org>\n`);
  return 0;
}

// passthrough: --output json prints the server's body; the platform's `LogfireUrlViewSchema` (`{path, generation}`).
/** `/v1/webhooks/logfire/<org ULID>/<token>`: the token is 32 MAC bytes as unpadded base64url. */
const LOGFIRE_WEBHOOK_PATH = /^\/v1\/webhooks\/logfire\/[0-9A-HJKMNP-TV-Z]{26}\/[A-Za-z0-9_-]{43}$/;
const LogfireUrl = z.object({ path: z.string(), generation: z.number().int().nonnegative() }).passthrough();

async function runWebhooks(source: string | undefined, action: string | undefined, ctx: VerbContext, deps: OrgDeps): Promise<number> {
  if (source !== "logfire") return unknown(ctx, `webhooks${source === undefined ? "" : ` ${source}`}`, "webhooks logfire, webhooks logfire revoke");
  if (action !== undefined && action !== "revoke") return unknown(ctx, `webhooks logfire ${action}`, "webhooks logfire, webhooks logfire revoke");
  const revoke = action === "revoke";
  const got = revoke
    ? await request("POST", "/v1/org/webhooks/logfire/revoke", LogfireUrl, ctx, deps, { action: "revoke the Logfire webhook URL" })
    : await request("GET", "/v1/org/webhooks/logfire", LogfireUrl, ctx, deps, { action: "read the Logfire webhook URL" });
  if (!got.ok) return fail(ctx, got.failure);
  // The path is the server's: only the webhook route's exact shape (an org ULID, then a 43-character
  // base64url token, nothing after) is joined to the org's url, so no traversal, query or control
  // character can reach the printed address.
  if (!LOGFIRE_WEBHOOK_PATH.test(got.value.path)) {
    return fail(ctx, { slug: "org-unavailable", what: "the org endpoint answered a webhook path outside /v1/webhooks/logfire/; nothing was printed", fix: "update eris: eris update   (or tell the platform's operator)" });
  }
  const url = `${got.base}${got.value.path}`;
  // `url` last: a server field of the same name never replaces the address joined to the org's own url.
  ctx.stdout.write(ctx.format === "json" ? `${JSON.stringify({ ...got.value, url })}\n` : `${plain(url)}\n`);
  if (revoke) ctx.stderr.write("INFO the previous URL no longer works; update every Logfire alert channel that used it\n");
  return 0;
}

async function runDisconnectGithub(ctx: VerbContext, deps: OrgDeps): Promise<number> {
  const got = await request("POST", "/v1/github/installation/unbind", GithubView, ctx, deps, { action: "disconnect GitHub" });
  if (!got.ok) return fail(ctx, got.failure);
  ctx.stdout.write(ctx.format === "json" ? `${JSON.stringify(got.value)}\n` : "unbound\n");
  return 0;
}

/** This App's installation on `account` as `gh` lists it: the id, null when not (yet) installed, or the failure. */
async function listedInstallation(account: string, appId: number, runGh: NonNullable<OrgDeps["runGh"]>): Promise<{ ok: true; id: number | null } | { ok: false; failure: Failure }> {
  const r = await runGh(["api", ...GH_HOST, "--paginate", `orgs/${account}/installations`, "--jq", `.installations[] | select(.app_id == ${appId}) | .id`]);
  if (r.code === -1) {
    return { ok: false, failure: { slug: "org-gh-unavailable", what: "the GitHub CLI (gh) could not be started; nothing was bound", fix: "install it (https://cli.github.com) and run: gh auth login" } };
  }
  if (r.code !== 0) {
    return {
      ok: false,
      failure: {
        slug: "org-github-not-owner",
        what: `gh could not list the GitHub App installations of '${account}' (gh exited ${r.code}); only an owner of a GitHub organization can, and nothing was bound`,
        fix: "check: gh auth status   (signed in as an owner of the org), and that --account names a GitHub organization, not a user",
      },
    };
  }
  const id = r.stdout.split("\n").map((line) => line.trim()).find((line) => /^[1-9][0-9]{0,15}$/.test(line));
  return { ok: true, id: id === undefined ? null : Number(id) };
}

async function runConnectGithub(account: string | undefined, noBrowser: boolean, ctx: VerbContext, deps: OrgDeps): Promise<number> {
  if (account === undefined || !GITHUB_LOGIN.test(account)) {
    return fail(ctx, {
      slug: "org-github-account-invalid",
      what: account === undefined ? "eris org connect-github was given no --account" : `'${plain(account)}' is not a GitHub organization name; nothing was sent`,
      fix: "eris org connect-github --account <github-org>",
    });
  }
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser;
  const ghTimeoutMs = deps.ghTimeoutMs ?? GH_TIMEOUT_MS;
  const runGh = deps.runGh ?? ((args: readonly string[]) => defaultRunGh(args, ctx.env, ghTimeoutMs));
  const pollMs = deps.pollMs ?? GITHUB_POLL_MS;

  const first = await request("GET", "/v1/github", GithubView, ctx, deps, { action: "connect GitHub" });
  if (!first.ok) return fail(ctx, first.failure);
  const app = first.value.app;
  if (app === null) {
    return fail(ctx, { slug: "org-github-unconfigured", what: "this platform has no GitHub App configured (GET /v1/github answered app: null); nothing was opened", fix: "this is the platform's setup, not this machine's: tell the platform's operator" });
  }

  let listed = await listedInstallation(account, app.id, runGh);
  if (!listed.ok) return fail(ctx, listed.failure);
  const held = first.value.installation;
  if (held !== null) {
    // Bound already: done only when the binding is this account's installation; anything else is a refusal, never a quiet exit 0.
    if (listed.id === held.installation_id) {
      ctx.stdout.write(ctx.format === "json" ? `${JSON.stringify(first.value)}\n` : `already ${describeGithub(first.value)}`);
      return 0;
    }
    return fail(ctx, {
      slug: "org-github-org-bound",
      what: `this org already has installation ${held.installation_id} bound, which is not the App's installation on '${account}'; nothing was bound`,
      fix: "unbind it first: eris org disconnect-github",
    });
  }
  if (listed.id === null) {
    let link: URL;
    try {
      link = new URL(app.install_url);
    } catch {
      link = new URL("about:blank");
    }
    if (link.protocol !== "https:" || link.hostname !== "github.com" || link.port !== "" || !link.pathname.startsWith("/apps/")) {
      return fail(ctx, { slug: "org-unavailable", what: "the org endpoint answered an install link that is not a https://github.com/apps/ page; nothing was opened", fix: "update eris: eris update   (or tell the platform's operator)" });
    }
    ctx.stderr.write(`Install the GitHub App '${plain(app.slug)}' on the GitHub organization '${account}':\n\n  ${link.href}\n\nWaiting for it to appear on ${account} (up to ${GITHUB_WAIT_MS / 60_000} min)...\n`);
    if (!noBrowser) await openBrowser(link.href).catch(() => undefined);
    const deadline = now() + GITHUB_WAIT_MS;
    let transient = 0;
    let found: number | null = null;
    while (found === null) {
      await sleep(pollMs);
      if (now() >= deadline) {
        return fail(ctx, { slug: "org-github-timeout", what: `the App did not appear on '${account}' within ${GITHUB_WAIT_MS / 60_000} min; nothing was bound`, fix: `install it on ${account}, then run: eris org connect-github --account ${account}` });
      }
      const polled = await listedInstallation(account, app.id, runGh);
      if (!polled.ok) {
        // The first listing already proved access; a failure now is waited out a few times, as connect-linear does.
        if (++transient <= MAX_TRANSIENT) continue;
        return fail(ctx, polled.failure);
      }
      transient = 0;
      found = polled.id;
    }
    listed = { ok: true, id: found };
  }

  // The proof: the caller's own token, sent once to the server, which lists the installation with it.
  const token = await runGh(["auth", "token", ...GH_HOST]);
  const githubToken = token.stdout.trim();
  if (token.code !== 0 || githubToken === "") {
    return fail(ctx, { slug: "org-gh-unavailable", what: "'gh auth token' printed no token; nothing was bound", fix: "run: gh auth login" });
  }
  const bound = await request("POST", "/v1/github/installation", GithubView, ctx, deps, {
    body: { installation_id: listed.id, account, github_token: githubToken },
    action: "connect GitHub",
  });
  if (!bound.ok) return fail(ctx, bound.failure);
  ctx.stdout.write(ctx.format === "json" ? `${JSON.stringify(bound.value)}\n` : describeGithub(bound.value));
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
  if (g.kind === "unknown") return unknown(ctx, g.sub, "members, delete, connect-linear, github, connect-github, disconnect-github, webhooks, billing");
  if (g.sub === "connect-linear") {
    const c = readArgs(plugin.rows, "org connect-linear", g.rest, ctx, { help: CONNECT_USAGE });
    if (c === null) return 0;
    return runConnectLinear(c.flags["--no-browser"] === true, ctx, deps);
  }
  if (g.sub === "github") {
    const r = readArgs(plugin.rows, "org github", g.rest, ctx, { help: GITHUB_USAGE });
    if (r === null) return 0;
    return runGithub(ctx, deps);
  }
  if (g.sub === "connect-github") {
    const r = readArgs(plugin.rows, "org connect-github", g.rest, ctx, { help: GITHUB_CONNECT_USAGE });
    if (r === null) return 0;
    return runConnectGithub(r.flags["--account"], r.flags["--no-browser"] === true, ctx, deps);
  }
  if (g.sub === "billing") {
    const b = groupArgs(plugin.rows, "org billing", g.rest);
    if (b.kind === "bare" || b.kind === "help") {
      if (ctx.format === "json") {
        ctx.stderr.write(renderFailureBlock({ slug: "output-json-unsupported", what: "eris org billing has no JSON rendering", fix: "use: eris --output json org billing checkout" }, ctx.erisDir));
        throw new CliExit(1);
      }
      ctx.stdout.write(BILLING_USAGE);
      return 0;
    }
    if (b.kind === "unknown") return unknown(ctx, `billing ${b.sub}`, "billing checkout, billing portal");
    const kind = b.sub === "checkout" ? "checkout" : "portal";
    const r = kind === "checkout" ? readArgs(plugin.rows, "org billing checkout", b.rest, ctx, { help: BILLING_CHECKOUT_USAGE }) : readArgs(plugin.rows, "org billing portal", b.rest, ctx, { help: BILLING_PORTAL_USAGE });
    if (r === null) return 0;
    return runBilling(kind, ctx, deps);
  }
  if (g.sub === "disconnect-github") {
    const r = readArgs(plugin.rows, "org disconnect-github", g.rest, ctx, { help: GITHUB_DISCONNECT_USAGE });
    if (r === null) return 0;
    return runDisconnectGithub(ctx, deps);
  }
  if (g.sub === "webhooks") {
    const r = readArgs(plugin.rows, "org webhooks", g.rest, ctx, { help: WEBHOOKS_USAGE });
    if (r === null) return 0;
    const [source, action] = r.pos;
    return runWebhooks(source, action, ctx, deps);
  }
  if (g.sub === "delete") {
    const d = readArgs(plugin.rows, "org delete", g.rest, ctx, { help: DELETE_USAGE });
    if (d === null) return 0;
    return runDelete(d.flags["--confirm"], d.flags["--cancel"] === true, ctx, deps);
  }
  const a = readArgs(plugin.rows, "org members", g.rest, ctx, { help: MEMBERS_USAGE });
  if (a === null) return 0;
  const [action, first, second] = a.pos;
  if (action === undefined) return runList(ctx, deps);
  if (action === "admin") return runAdmin(first, second, ctx, deps);
  if (action !== "deactivate") return unknown(ctx, `members ${action}`, "members, members deactivate <member-id>, members admin grant|revoke <member-id>");
  return runDeactivate(first, ctx, deps);
}
