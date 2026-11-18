/**
 * yak-clusters.ts — `eris yak clusters` and `eris yak show`: the caller's org's
 * most-reported recent yak clusters, and one cluster or observation read in
 * full. Loaded only when one of them dispatches (the manifest is ./index.ts).
 *
 * The gateway answers `GET /v1/yaks/clusters?days=&limit=`, `GET
 * /v1/yaks/clusters/:id` and `GET /v1/yaks/observations/:id?detail=1` for any
 * authenticated bearer. `days` is 7 or 30 and `limit` 1..50: the server
 * refuses anything else with 400, so this refuses it first.
 *
 * Invariants:
 *   - The request goes only to the url and bearer `resolveEndpoint` returns
 *     for the directory's selected org, never to a url built here.
 *   - Every body is parsed against a schema that drops unknown keys, so a
 *     field the server adds is not re-printed in either rendering.
 *   - Fields the server omits when empty (a cluster's issue, a link's close time, an observation's error) are optional here and never defaulted. A summary, body or error is the reporter's text but arrives as data: it
 *     is printed with control characters removed (one line in a table).
 *   - `--min-sightings <n>` keeps the clusters whose `recent_count` is at least
 *     n; the server has no such parameter, so it filters after the read.
 *   - Every failure is the failure block on stderr, nothing on stdout, exit 1.
 */

import { readArgs, type VerbContext } from "../../src/cli/plugin";
import { z } from "zod";
import { emitJson, fail, home, request, resolveEndpoint, table, type AdminDeps, type Failure } from "./yak-admin";
import plugin from "./index";

// `…Slug`-named unions: `tests/errors-doc.test.ts` harvests their members.
export type YakClustersSlug = "yak-clusters-invalid" | "yak-clusters-unavailable";
export type YakShowSlug = "yak-show-missing-id" | "yak-show-not-found" | "yak-show-unavailable";

const CLUSTERS_PATH = "/v1/yaks/clusters";
const OBSERVATIONS_PATH = "/v1/yaks/observations";
const WINDOWS = ["7", "30"] as const;
const LIMIT_MAX = 50;

const Ranked = z.object({
  id: z.string(),
  kind: z.string(),
  summary: z.string(),
  recent_count: z.number().int(),
  total_count: z.number().int(),
  last_seen: z.string(),
  issue_identifier: z.string().nullable(),
  recent_by_status: z.object({ filed: z.number().int(), pending: z.number().int(), failed: z.number().int() }),
});
const Ranking = z.object({ days: z.number().int(), clusters: z.array(Ranked) });

const ClusterDetail = z.object({
  id: z.string(),
  kind: z.string(),
  canonical_summary: z.string(),
  observation_count: z.number().int(),
  first_seen: z.string(),
  last_seen: z.string(),
  current_issue_identifier: z.string().nullish(),
  issue_history: z.array(z.object({ issue_identifier: z.string(), linked_at: z.string(), closed_observed_at: z.string().nullish() })),
  observations: z.array(z.object({ id: z.string(), verb: z.string(), summary: z.string(), source: z.string(), received_at: z.string(), status: z.string() })),
});

const ObservationDetail = z.object({
  id: z.string(),
  verb: z.string(),
  route: z.string(),
  summary: z.string(),
  source: z.string(),
  received_at: z.string(),
  status: z.string(),
  cluster_id: z.string().nullish(),
  delivered_at: z.string().nullish(),
  attempts: z.number().int(),
  last_error: z.string().nullish(),
  data: z.object({ body: z.string().optional(), evidence: z.string().optional(), repro: z.string().optional() }).nullish(),
});

/** The server's problem `code` when it is a short snake_case word: anything else is not echoed. */
const safeCode = (code: string | undefined): string | undefined => (code !== undefined && /^[a-z][a-z_]{0,39}$/.test(code) ? code : undefined);

/** Whitespace runs collapse to a space and other control characters are dropped. */
const oneLine = (text: string): string => text.replace(/[\p{Cc}\u{2028}\u{2029}]+/gu, " ").replace(/ {2,}/g, " ").trim();
/** Multi-line text keeps its newlines and tabs; every other control character is dropped. */
const block = (text: string): string => text.replace(/[^\P{Cc}\n\t]/gu, "").replace(/\u{2028}|\u{2029}/gu, "\n");

function unavailable(slug: "yak-clusters-unavailable" | "yak-show-unavailable", status: number, code: string | undefined, target: string): Failure {
  const c = safeCode(code);
  const answered = `the endpoint answered ${status}${c ? ` ${c}` : ""} for ${target}`;
  if (status === 401) {
    return { slug: "yak-unauthorized", what: `${answered}: it rejected the bearer token`, fix: "run: eris login\n(or check ERIS_YAKS_TOKEN when it is set)" };
  }
  return { slug, what: answered, fix: "retry; 'eris whoami' shows which org and url this directory uses" };
}

const clustersRefusal = (status: number, code: string | undefined, target: string): Failure => unavailable("yak-clusters-unavailable", status, code, target);

const invalid = (what: string, fix: string): Failure => ({ slug: "yak-clusters-invalid", what, fix });

/** A whole number in [min, max] from a flag's text, or null. */
function wholeNumber(text: string, min: number, max: number): number | null {
  if (!/^\d{1,9}$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

export async function runClusters(args: string[], ctx: VerbContext, deps: AdminDeps = {}): Promise<number> {
  const p = readArgs(plugin.rows, "yak clusters", args, ctx);
  if (p === null) return 0;
  const days = p.flags["--days"];
  const limit = p.flags["--limit"];
  const min = p.flags["--min-sightings"];
  if (typeof days === "string" && !(WINDOWS as readonly string[]).includes(days)) {
    return fail(ctx, invalid(`--days ${oneLine(days)} is not a window the endpoint ranks over`, `use one of: ${WINDOWS.join(", ")}`));
  }
  if (typeof limit === "string" && wholeNumber(limit, 1, LIMIT_MAX) === null) {
    return fail(ctx, invalid(`--limit ${oneLine(limit)} is not a whole number from 1 to ${LIMIT_MAX}`, `use: --limit <1..${LIMIT_MAX}>`));
  }
  const minSightings = typeof min === "string" ? wholeNumber(min, 0, 1_000_000) : 0;
  if (minSightings === null) {
    return fail(ctx, invalid(`--min-sightings ${oneLine(String(min))} is not a whole number`, "use: --min-sightings <n>"));
  }
  const ep = await resolveEndpoint(ctx.env, home(ctx, deps), deps.cwd ?? process.cwd());
  if (!ep.ok) return fail(ctx, ep.failure);
  const query = [typeof days === "string" ? `days=${days}` : "", typeof limit === "string" ? `limit=${limit}` : ""].filter((q) => q !== "").join("&");
  const got = await request(ep.value, "GET", `${CLUSTERS_PATH}${query === "" ? "" : `?${query}`}`, Ranking, deps, undefined, clustersRefusal);
  if (!got.ok) return fail(ctx, got.failure);
  const kept = { days: got.value.days, clusters: got.value.clusters.filter((c) => c.recent_count >= minSightings) };
  if (ctx.format === "json") return emitJson(ctx, kept);
  if (kept.clusters.length === 0) {
    ctx.stderr.write("INFO no clusters in this window\n");
    return 0;
  }
  const rows = kept.clusters.map((c) => [oneLine(c.issue_identifier ?? "-"), String(c.recent_count), String(c.total_count), oneLine(c.last_seen), oneLine(c.summary)]);
  ctx.stdout.write(table([["issue", "recent", "total", "last_seen", "summary"], ...rows]));
  return 0;
}

function showRefusal(status: number, code: string | undefined, target: string): Failure {
  if (status === 404) return { slug: "yak-show-not-found", what: `no cluster or observation with that id (${target} answered 404)`, fix: "list ids with: eris yak clusters" };
  return unavailable("yak-show-unavailable", status, code, target);
}

const line = (label: string, value: string | number | null | undefined): string => `${`${label}:`.padEnd(14)}${value === null || value === undefined ? "-" : typeof value === "number" ? String(value) : oneLine(value)}\n`;

export async function runShow(args: string[], ctx: VerbContext, deps: AdminDeps = {}): Promise<number> {
  const p = readArgs(plugin.rows, "yak show", args, ctx);
  if (p === null) return 0;
  const id = p.pos[0];
  if (id === undefined) return fail(ctx, { slug: "yak-show-missing-id", what: "eris yak show takes a cluster or observation id", fix: "use: eris yak show <id>\nlist ids with: eris yak clusters" });
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return fail(ctx, showRefusal(404, undefined, "a malformed id"));
  const ep = await resolveEndpoint(ctx.env, home(ctx, deps), deps.cwd ?? process.cwd());
  if (!ep.ok) return fail(ctx, ep.failure);
  const asCluster = await request(ep.value, "GET", `${CLUSTERS_PATH}/${id}`, ClusterDetail, deps, undefined, showRefusal);
  if (asCluster.ok) {
    if (ctx.format === "json") return emitJson(ctx, asCluster.value);
    const c = asCluster.value;
    let out = line("cluster", c.id) + line("kind", c.kind) + line("summary", c.canonical_summary) + line("issue", c.current_issue_identifier) + line("observations", c.observation_count) + line("first_seen", c.first_seen) + line("last_seen", c.last_seen);
    if (c.issue_history.length > 0) out += `\n${table([["issue", "linked_at", "closed_observed_at"], ...c.issue_history.map((h) => [oneLine(h.issue_identifier), oneLine(h.linked_at), oneLine(h.closed_observed_at ?? "-")])])}`;
    if (c.observations.length > 0) out += `\n${table([["observation", "verb", "status", "received_at", "summary"], ...c.observations.map((o) => [oneLine(o.id), oneLine(o.verb), oneLine(o.status), oneLine(o.received_at), oneLine(o.summary)])])}`;
    ctx.stdout.write(out);
    return 0;
  }
  if (asCluster.failure.slug !== "yak-show-not-found") return fail(ctx, asCluster.failure);
  const asObservation = await request(ep.value, "GET", `${OBSERVATIONS_PATH}/${id}?detail=1`, ObservationDetail, deps, undefined, showRefusal);
  if (!asObservation.ok) return fail(ctx, asObservation.failure);
  if (ctx.format === "json") return emitJson(ctx, asObservation.value);
  const o = asObservation.value;
  let out = line("observation", o.id) + line("verb", o.verb) + line("route", o.route) + line("status", o.status) + line("source", o.source) + line("cluster", o.cluster_id) + line("received_at", o.received_at) + line("delivered_at", o.delivered_at) + line("attempts", o.attempts) + line("last_error", o.last_error) + line("summary", o.summary);
  if (o.data?.body !== undefined) out += `\nbody:\n${block(o.data.body)}\n`;
  if (o.data?.evidence !== undefined) out += `\nevidence:\n${block(o.data.evidence)}\n`;
  if (o.data?.repro !== undefined) out += `\nrepro:\n${block(o.data.repro)}\n`;
  ctx.stdout.write(out);
  return 0;
}
