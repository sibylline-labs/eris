/**
 * yak-checkpoint.ts — `eris yak checkpoint <id> --stage <stage> --note <text>`:
 * record where a vendor report stands over `POST /v1/yaks/vendor-reports/:id/checkpoints`,
 * so the org that filed it reads the progress with `eris yak status <id>`.
 * Loaded only when it dispatches (the manifest is ./index.ts).
 *
 * Invariants:
 *   - Authorisation is the server's: only the vendor's own org may post a
 *     checkpoint, anyone else is answered 403 `vendor_operator_required`.
 *   - A checkpoint the server would refuse is refused here first, with nothing
 *     sent: a stage outside the seven, a note outside 1..500 characters, an
 *     over-long release, command or reason, `fixed` without its release and
 *     command, `wont-fix` without its reason.
 *   - The body carries only the keys given; an absent flag is never sent as null.
 *   - The id is validated before it enters the path, and the request goes only
 *     to the url and bearer `resolveEndpoint` returns for the selected org.
 *   - A replay is an answer, exit 0, and says it was already recorded.
 *   - Every failure is the failure block on stderr, nothing on stdout, exit 1.
 */

import { readArgs, type VerbContext } from "../../src/cli/plugin";
import { z } from "zod";
import { emitJson, fail, home, request, resolveEndpoint, type AdminDeps, type Failure } from "./yak-admin";
import { Checkpoint, oneLine, REPORT_ID, reportNotFound } from "./yak-reports";
import plugin from "./index";

// A `…Slug`-named union: `tests/errors-doc.test.ts` harvests its members.
export type YakCheckpointSlug = "yak-checkpoint-invalid" | "vendor-operator-required" | "yak-checkpoint-unavailable";

export const CHECKPOINT_STAGES = ["triaged", "fix-started", "pr-open", "merged", "released", "fixed", "wont-fix"] as const;
type Stage = (typeof CHECKPOINT_STAGES)[number];
const isStage = (s: string): s is Stage => (CHECKPOINT_STAGES as readonly string[]).includes(s);

/** Each text flag's longest accepted value, as the server caps it. */
const LIMITS = { "--note": 500, "--release": 80, "--command": 200, "--reason": 500 } as const;

const Recorded = z.object({ checkpoint: Checkpoint, replay: z.boolean() });

const USE = "use: eris yak checkpoint <id> --stage <stage> --note <text> [--release <v>] [--command <cmd>] [--reason <text>]";

const invalid = (what: string, fix = USE): Failure => ({ slug: "yak-checkpoint-invalid", what, fix });

function refusal(status: number, code: string | undefined, target: string): Failure {
  const answered = `the endpoint answered ${status}${code ? ` ${code}` : ""} for ${target}`;
  if (status === 401) return { slug: "yak-unauthorized", what: `${answered}: it rejected the bearer token`, fix: "run: eris login\n(or check ERIS_YAKS_TOKEN when it is set)" };
  if (status === 403 && code === "vendor_operator_required") {
    return { slug: "vendor-operator-required", what: `${answered}: only the vendor's own org can post checkpoints`, fix: "nothing to change here: the org that filed a report reads it with eris yak status <id>" };
  }
  if (status === 404 && code === "vendor_report_not_found") return reportNotFound(`${answered}: there is no vendor report with that id`);
  if (status === 422 && code === "checkpoint_invalid") return invalid(`${answered}: the server refused the checkpoint`);
  return { slug: "yak-checkpoint-unavailable", what: answered, fix: "retry; 'eris whoami' shows which org and url this directory uses" };
}

type Body = { stage: Stage; note: string; release?: string; command?: string; reason?: string };

/** The body to send, or why it would be refused. */
function checkpointBody(flags: Record<keyof typeof LIMITS | "--stage", string | undefined>): Body | Failure {
  const stage = flags["--stage"];
  if (stage === undefined || !isStage(stage)) return invalid(`--stage must be one of: ${CHECKPOINT_STAGES.join(", ")}`);
  for (const [flag, max] of Object.entries(LIMITS) as [keyof typeof LIMITS, number][]) {
    const value = flags[flag];
    if (value !== undefined && (value.length === 0 || value.length > max)) return invalid(`${flag} takes 1 to ${max} characters`);
  }
  const note = flags["--note"];
  if (note === undefined) return invalid("--note is required");
  if (stage === "fixed" && (flags["--release"] === undefined || flags["--command"] === undefined)) {
    return invalid("a fixed checkpoint needs --release and --command: the release the fix ships in, and what the filer runs to get it");
  }
  if (stage === "wont-fix" && flags["--reason"] === undefined) return invalid("a wont-fix checkpoint needs --reason");
  const body: Body = { stage, note };
  if (flags["--release"] !== undefined) body.release = flags["--release"];
  if (flags["--command"] !== undefined) body.command = flags["--command"];
  if (flags["--reason"] !== undefined) body.reason = flags["--reason"];
  return body;
}

export async function runCheckpoint(args: string[], ctx: VerbContext, deps: AdminDeps = {}): Promise<number> {
  const p = readArgs(plugin.rows, "yak checkpoint", args, ctx);
  if (p === null) return 0;
  const id = p.pos[0];
  if (id === undefined || id === "") return fail(ctx, invalid("eris yak checkpoint takes a vendor report id"));
  const body = checkpointBody(p.flags);
  if ("slug" in body) return fail(ctx, body);
  if (!REPORT_ID.test(id)) return fail(ctx, reportNotFound(`'${oneLine(id).slice(0, 80)}' is not a vendor report id; nothing was sent`));
  const ep = await resolveEndpoint(ctx.env, home(ctx, deps), deps.cwd ?? process.cwd());
  if (!ep.ok) return fail(ctx, ep.failure);
  const got = await request(ep.value, "POST", `/v1/yaks/vendor-reports/${encodeURIComponent(id)}/checkpoints`, Recorded, deps, body, refusal);
  if (!got.ok) return fail(ctx, got.failure);
  if (ctx.format === "json") return emitJson(ctx, got.value);
  const c = got.value.checkpoint;
  ctx.stdout.write(`${got.value.replay ? "already recorded" : "recorded"} checkpoint ${oneLine(c.id)} (${oneLine(c.stage)})\n`);
  return 0;
}
