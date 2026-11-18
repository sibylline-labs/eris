/**
 * yak-retry.ts — `eris yak retry <observation-id>`: requeue one failed observation
 * over `POST /v1/yaks/observations/:id/retry`. Loaded only when it dispatches
 * (the manifest is ./index.ts).
 *
 * Invariants:
 *   - Authorisation is the server's: an org admin may requeue, anyone else is
 *     answered 403 `admin_required`. The role is never pre-checked here.
 *   - The id is validated before it enters the path, and the request goes only
 *     to the url and bearer `resolveEndpoint` returns for the selected org.
 *   - A row that is not `failed` is left as it is and the server says so
 *     (`requeued: false`); that is an answer, exit 0, not a refusal.
 *   - Every failure is the failure block on stderr, nothing on stdout, exit 1.
 */

import { readArgs, type VerbContext } from "../../src/cli/plugin";
import { z } from "zod";
import { emitJson, fail, home, request, resolveEndpoint, type AdminDeps, type Failure } from "./yak-admin";
import plugin from "./index";

// A `…Slug`-named union: `tests/errors-doc.test.ts` harvests its members.
export type YakRetrySlug = "yak-retry-missing-id" | "yak-retry-not-found" | "yak-retry-admin-required" | "yak-retry-unavailable";

// passthrough: --output json prints the body as sent.
const Retried = z.object({ requeued: z.boolean(), status: z.string() }).passthrough();

const OBSERVATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A server string for a terminal: control characters become `?`. */
const plain = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");

function refusal(status: number, code: string | undefined, target: string): Failure {
  const answered = `the endpoint answered ${status}${code ? ` ${code}` : ""} for ${target}`;
  if (status === 401) return { slug: "yak-unauthorized", what: `${answered}: it rejected the bearer token`, fix: "run: eris login\n(or check ERIS_YAKS_TOKEN when it is set)" };
  if (status === 403 && code === "admin_required") {
    return { slug: "yak-retry-admin-required", what: `${answered}: only an admin of this org can requeue a failed observation`, fix: "ask an org admin to run it" };
  }
  if (status === 404) return { slug: "yak-retry-not-found", what: `${answered}: this org has no observation with that id`, fix: "find a failed one: eris yak clusters, then eris yak show <cluster-id>" };
  return { slug: "yak-retry-unavailable", what: answered, fix: "retry; 'eris whoami' shows which org and url this directory uses" };
}

export async function runRetry(args: string[], ctx: VerbContext, deps: AdminDeps = {}): Promise<number> {
  const p = readArgs(plugin.rows, "yak retry", args, ctx);
  if (p === null) return 0;
  const id = p.pos[0];
  if (id === undefined || id === "") {
    return fail(ctx, { slug: "yak-retry-missing-id", what: "eris yak retry takes an observation id", fix: "use: eris yak retry <observation-id>\nfind one: eris yak show <cluster-id>" });
  }
  if (!OBSERVATION_ID.test(id)) return fail(ctx, refusal(404, undefined, "a malformed id"));
  const ep = await resolveEndpoint(ctx.env, home(ctx, deps), deps.cwd ?? process.cwd());
  if (!ep.ok) return fail(ctx, ep.failure);
  const got = await request(ep.value, "POST", `/v1/yaks/observations/${id}/retry`, Retried, deps, undefined, refusal);
  if (!got.ok) return fail(ctx, got.failure);
  if (ctx.format === "json") return emitJson(ctx, got.value);
  ctx.stdout.write(got.value.requeued ? `requeued ${id}\n` : `not requeued: ${id} is ${plain(got.value.status)}, only a failed observation is requeued\n`);
  return 0;
}
