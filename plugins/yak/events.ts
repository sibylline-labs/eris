/**
 * events.ts — `eris events list` and `eris events parked`: one org's archived events for a
 * product and UTC day, and the operator's parked lines, over `GET /v1/events` and
 * `GET /v1/events/parked`. Loaded only when `eris events` dispatches (the manifest is ./index.ts).
 *
 * The routes are reads only. The org is the bearer's: nothing here names one. `parked` is
 * the operator's read; the server answers 404 to every other org, and that is reported as
 * `events-not-found`, not hidden.
 *
 * Invariants:
 *   - `--day` is a real UTC calendar date (default: today, UTC), `--limit` a whole number
 *     in 1..500 and `--product` a lowercase word: each is refused before a request is sent.
 *   - Bodies are parsed against schemas that keep unknown keys, so `--output json` prints
 *     the server's body, and the text rendering reads only the fields below.
 *   - A page's `next_cursor` goes to stderr (stdout is payload only).
 *   - Every failure is the failure block on stderr, nothing on stdout, exit 1.
 */

import { CliExit, groupArgs, readArgs, renderFailureBlock, type VerbContext } from "../../src/cli/plugin";
import { z } from "zod";
import { emitJson, fail, home, request, resolveEndpoint, table, type AdminDeps, type Failure } from "./yak-admin";
import plugin from "./index";

// A `…Slug`-named union: `tests/errors-doc.test.ts` harvests its members.
export type EventsSlug = "events-invalid" | "events-not-found" | "events-unavailable" | "events-unknown-command";

const LIMIT_MAX = 500;

/** The products the archive answers for: the gateway's closed product set. A name outside it is answered 400 `invalid_query`. */
export const EVENT_PRODUCTS = ["accounts", "yak", "graph", "socrates", "linear-proxy", "gates", "bus", "mandate"] as const;
const PRODUCT_LIST = EVENT_PRODUCTS.join(", ");

const EventRecord = z
  .object({ event_id: z.string(), product: z.string(), stream: z.string(), seq: z.number(), type: z.string(), occurred_at: z.string() })
  .passthrough();
const EventsPage = z.object({ events: z.array(EventRecord), next_cursor: z.string().nullable() }).passthrough();
const ParkedLine = z.object({ message_id: z.string(), enqueued_at: z.string(), attempts: z.number().optional() }).passthrough();
const ParkedPage = z.object({ lines: z.array(ParkedLine), next_cursor: z.string().nullable() }).passthrough();

export const EVENTS_USAGE = `Usage: eris events <command>

Commands:
  list --product <product> [--day <YYYY-MM-DD>] [--cursor <c>] [--limit <1..${LIMIT_MAX}>]
                    This org's archived events for a product and UTC day (default: today)
  parked [--day <YYYY-MM-DD>] [--cursor <c>] [--limit <1..${LIMIT_MAX}>]
                    The lines the archive parked as invalid; the operator org's read:
                    any other org is answered not found

Products: ${PRODUCT_LIST}.

A page ends with its next cursor on stderr; pass it back as --cursor.
`;

export const EVENTS_LIST_USAGE = `Usage: eris events list --product <product> [--day <YYYY-MM-DD>] [--cursor <c>] [--limit <1..${LIMIT_MAX}>]

This org's archived events for a product and UTC day (default: today).

  --product <product>   one of: ${PRODUCT_LIST}
  --day <YYYY-MM-DD>    a UTC calendar date
  --cursor <c>          the next cursor a page printed, unchanged
  --limit <1..${LIMIT_MAX}>      page size

A page ends with its next cursor on stderr; pass it back as --cursor.

Example:
  eris events list --product yak --day 2026-11-18
`;

const oneLine = (text: string): string => text.replace(/[\p{Cc}\u{2028}\u{2029}]+/gu, " ").replace(/ {2,}/g, " ").trim();
const invalid = (what: string, fix: string): Failure => ({ slug: "events-invalid", what, fix });

function refusal(status: number, code: string | undefined, target: string): Failure {
  const answered = `the endpoint answered ${status}${code && /^[a-z][a-z_]{0,39}$/.test(code) ? ` ${code}` : ""} for ${target}`;
  if (status === 401) return { slug: "yak-unauthorized", what: `${answered}: it rejected the bearer token`, fix: "run: eris login\n(or check ERIS_YAKS_TOKEN when it is set)" };
  if (status === 403) return { slug: "events-unavailable", what: `${answered}: this credential cannot read events`, fix: "run: eris login   (a CLI login carries the linear-proxy product; a service token without it does not)" };
  if (status === 404) return { slug: "events-not-found", what: `${answered}: nothing is served there for this org`, fix: "the parked read is the operator org's; for list, check the product with: eris whoami" };
  if (status === 400) return { slug: "events-invalid", what: `${answered}: the endpoint refused the query`, fix: `check --product (one of: ${PRODUCT_LIST}), --day (a UTC date), --limit (1..${LIMIT_MAX}) and --cursor (one a page printed, unchanged)` };
  return { slug: "events-unavailable", what: answered, fix: "retry; 'eris whoami' shows which org and url this directory uses" };
}

/** A real UTC calendar date, `YYYY-MM-DD`. */
function realDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && new Date(`${day}T00:00:00.000Z`).toISOString().startsWith(day);
}

/** The query every events read shares; null after it has written its own refusal. */
function sharedQuery(flags: Record<string, string | boolean | undefined>, ctx: VerbContext, now: Date): URLSearchParams | null {
  const day = typeof flags["--day"] === "string" ? flags["--day"] : now.toISOString().slice(0, 10);
  if (!realDay(day)) {
    fail(ctx, invalid(`--day ${oneLine(day)} is not a UTC date`, "use: --day YYYY-MM-DD"));
    return null;
  }
  const query = new URLSearchParams({ day });
  const limit = flags["--limit"];
  if (typeof limit === "string") {
    if (!/^\d{1,9}$/.test(limit) || Number(limit) < 1 || Number(limit) > LIMIT_MAX) {
      fail(ctx, invalid(`--limit ${oneLine(limit)} is not a whole number from 1 to ${LIMIT_MAX}`, `use: --limit <1..${LIMIT_MAX}>`));
      return null;
    }
    query.set("limit", limit);
  }
  const cursor = flags["--cursor"];
  if (typeof cursor === "string") {
    if (cursor === "" || cursor.length > 64) {
      fail(ctx, invalid("--cursor is empty or longer than 64 characters", "pass the next cursor a page printed, unchanged"));
      return null;
    }
    query.set("cursor", cursor);
  }
  return query;
}

async function runList(args: string[], ctx: VerbContext, deps: AdminDeps): Promise<number> {
  const p = readArgs(plugin.rows, "events list", args, ctx, { help: EVENTS_LIST_USAGE });
  if (p === null) return 0;
  const product = p.flags["--product"];
  if (typeof product !== "string" || !/^[a-z][a-z-]{0,31}$/.test(product)) {
    return fail(ctx, invalid(typeof product === "string" ? `--product ${oneLine(product)} is not a product name` : "eris events list was given no --product", `use: --product <product>, one of: ${PRODUCT_LIST}`));
  }
  const query = sharedQuery(p.flags, ctx, new Date());
  if (query === null) return 1;
  query.set("product", product);
  const ep = await resolveEndpoint(ctx.env, home(ctx, deps), deps.cwd ?? process.cwd());
  if (!ep.ok) return fail(ctx, ep.failure);
  const got = await request(ep.value, "GET", `/v1/events?${query.toString()}`, EventsPage, deps, undefined, refusal);
  if (!got.ok) return fail(ctx, got.failure);
  if (ctx.format === "json") return emitJson(ctx, got.value);
  if (got.value.events.length === 0) ctx.stderr.write("INFO no events for that product and day\n");
  else ctx.stdout.write(table([["event_id", "type", "occurred_at", "stream"], ...got.value.events.map((e) => [oneLine(e.event_id), oneLine(e.type), oneLine(e.occurred_at), oneLine(e.stream)])]));
  if (got.value.next_cursor !== null) ctx.stderr.write(`INFO next cursor: ${oneLine(got.value.next_cursor)}\n`);
  return 0;
}

async function runParked(args: string[], ctx: VerbContext, deps: AdminDeps): Promise<number> {
  const p = readArgs(plugin.rows, "events parked", args, ctx);
  if (p === null) return 0;
  const query = sharedQuery(p.flags, ctx, new Date());
  if (query === null) return 1;
  const ep = await resolveEndpoint(ctx.env, home(ctx, deps), deps.cwd ?? process.cwd());
  if (!ep.ok) return fail(ctx, ep.failure);
  const got = await request(ep.value, "GET", `/v1/events/parked?${query.toString()}`, ParkedPage, deps, undefined, refusal);
  if (!got.ok) return fail(ctx, got.failure);
  if (ctx.format === "json") return emitJson(ctx, got.value);
  if (got.value.lines.length === 0) ctx.stderr.write("INFO no parked lines for that day\n");
  else ctx.stdout.write(table([["message_id", "enqueued_at", "attempts"], ...got.value.lines.map((l) => [oneLine(l.message_id), oneLine(l.enqueued_at), l.attempts === undefined ? "-" : String(l.attempts)])]));
  if (got.value.next_cursor !== null) ctx.stderr.write(`INFO next cursor: ${oneLine(got.value.next_cursor)}\n`);
  return 0;
}

export async function runEvents(args: string[], ctx: VerbContext, deps: AdminDeps = {}): Promise<number> {
  const g = groupArgs(plugin.rows, "events", args);
  if (g.kind === "bare" || g.kind === "help") {
    if (ctx.format === "json") {
      ctx.stderr.write(renderFailureBlock({ slug: "output-json-unsupported", what: "eris events has no JSON rendering", fix: "use: eris --output json events list --product <product>" }, ctx.erisDir));
      throw new CliExit(1);
    }
    ctx.stdout.write(EVENTS_USAGE);
    return 0;
  }
  if (g.kind === "unknown") {
    ctx.stderr.write(renderFailureBlock({ slug: "events-unknown-command", what: `unknown events command '${oneLine(g.sub)}'`, fix: "use one of: list, parked\nrun 'eris events --help' for the command list" }, ctx.erisDir));
    throw new CliExit(1);
  }
  return g.sub === "list" ? runList(g.rest, ctx, deps) : runParked(g.rest, ctx, deps);
}
