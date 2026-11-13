/**
 * yak-reports.ts — `eris yak reports`: the caller's org's own `--vendor` yak
 * reports with their Linear state. Loaded only when `eris yak reports`
 * dispatches (the manifest is ./index.ts).
 *
 * The gateway answers `GET /v1/yaks/vendor-reports` for any authenticated
 * bearer, on the same product row as `eris yak status`. The dashboard's
 * `/v1/portal/yak/vendor-reports` is the session-only twin of the same read
 * and takes no bearer, so it is not used here. Which reports the caller sees
 * is the server's: it selects the rows the caller's org submitted.
 *
 * Invariants:
 *   - The request goes only to the url and bearer `resolveEndpoint` returns
 *     for the directory's selected org, never to a url built here.
 *   - The body is parsed against a schema that drops unknown keys, so a field
 *     the server adds is not re-printed in either rendering.
 *   - A report's summary is the org's own text but arrives as data: it is
 *     printed on one line with control characters removed.
 *   - Every failure is the failure block on stderr, nothing on stdout, exit 1.
 */

import { readArgs, type VerbContext } from "../../src/cli/plugin";
import { z } from "zod";
import { emitJson, fail, home, request, resolveEndpoint, table, type AdminDeps, type Failure } from "./yak-admin";
import plugin from "./index";

// A `…Slug`-named union: `tests/errors-doc.test.ts` harvests its members.
export type YakReportsSlug = "yak-reports-forbidden" | "yak-reports-unavailable" | "yak-reports-unconfigured";

const REPORTS_PATH = "/v1/yaks/vendor-reports";

const VendorReports = z.object({
  reports: z.array(
    z.object({
      id: z.string(),
      summary: z.string(),
      issue_identifier: z.string(),
      issue_url: z.string(),
      state: z.object({ name: z.string(), type: z.string() }),
      submitted_at: z.string(),
    }),
  ),
});

/** The server's `error.code` when it is a short snake_case word: anything else is not echoed. */
const safeCode = (code: string | undefined): string | undefined => (code !== undefined && /^[a-z][a-z_]{0,39}$/.test(code) ? code : undefined);

function refusal(status: number, code: string | undefined, target: string): Failure {
  const c = safeCode(code);
  const answered = `the endpoint answered ${status}${c ? ` ${c}` : ""} for ${target}`;
  if (status === 401) {
    return { slug: "yak-unauthorized", what: `${answered}: it rejected the bearer token`, fix: "run: eris login\n(or check ERIS_YAKS_TOKEN when it is set)" };
  }
  if (status === 403) {
    return { slug: "yak-reports-forbidden", what: `${answered}: this credential cannot read vendor reports`, fix: "run: eris login\n(a token without the yak product cannot read them)" };
  }
  if (status === 503 && c === "vendor_unconfigured") {
    return { slug: "yak-reports-unconfigured", what: `${answered}: the vendor report mirror is not set up on this endpoint`, fix: "nothing to change here: the endpoint's operator sets it up; retry later" };
  }
  return { slug: "yak-reports-unavailable", what: answered, fix: "retry; 'eris whoami' shows which org and url this directory uses" };
}

/** One line: whitespace runs collapse to a space and other control characters are dropped. */
const oneLine = (text: string): string => text.replace(/[\p{Cc}\u{2028}\u{2029}]+/gu, " ").replace(/ {2,}/g, " ").trim();

export async function runReports(args: string[], ctx: VerbContext, deps: AdminDeps = {}): Promise<number> {
  if (readArgs(plugin.rows, "yak reports", args, ctx) === null) return 0;
  const ep = await resolveEndpoint(ctx.env, home(ctx, deps), deps.cwd ?? process.cwd());
  if (!ep.ok) return fail(ctx, ep.failure);
  const got = await request(ep.value, "GET", REPORTS_PATH, VendorReports, deps, undefined, refusal);
  if (!got.ok) return fail(ctx, got.failure);
  if (ctx.format === "json") return emitJson(ctx, got.value);
  const { reports } = got.value;
  if (reports.length === 0) {
    ctx.stderr.write("INFO no vendor reports yet: file one with eris yak issue|suggest|fatal --vendor\n");
    return 0;
  }
  const rows = reports.map((r) => [oneLine(r.issue_identifier), oneLine(r.state.name), oneLine(r.submitted_at), oneLine(r.summary)]);
  ctx.stdout.write(table([["issue", "state", "submitted", "summary"], ...rows]));
  return 0;
}
