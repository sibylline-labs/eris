/**
 * handlers.ts — `eris loop <command>`: the dispatch, the one place a failure is rendered, and the
 * read-only verbs `list` and `resolve` (docs/LOOP.md).
 *
 * stdout carries only the payload; every diagnostic goes to stderr. Exit status: 0 done; 1 the
 * runtime failed to start or stop, or a hand-back reached no target; 2 an operand refused before
 * anything was claimed or spawned; 3 a precondition (not signed in, the issue claimed by another
 * loop, the org's policy tree edited).
 */

import { groupArgs, readArgs, renderFailureBlock, type VerbContext, type VerbHandler } from "../../src/cli/plugin";
import { type LoopDeps, readStdin, runOf, treeOf } from "./deps";
import { block, LoopFailure, stop, usage } from "./failure";
import { HELP, USAGE } from "./help";
import plugin, { type LoopDefaults } from "./index";
import { handBack } from "./hand-back";
import { launchLoop, launchReceipt } from "./launch";
import { reapLoops } from "./reap";
import { resumeLoop } from "./resume";
import { loopStatus } from "./status";
import { stopLoop } from "./stop";
import { resolveTarget } from "./target";

export type { LoopDeps } from "./deps";

const ROWS = plugin.rows;

async function runList(args: string[], ctx: VerbContext, defaults: LoopDefaults, deps: LoopDeps): Promise<number> {
  if (readArgs(ROWS, "loop list", args, ctx, { help: HELP.list }) === null) return 0;
  const run = runOf(ctx, deps);
  const tree = await treeOf(defaults, run, { cwd: run.cwd });
  ctx.stdout.write(ctx.format === "json" ? `${JSON.stringify({ loops: tree.loops })}\n` : tree.loops.map((s) => `${s}\n`).join(""));
  return 0;
}

async function runResolve(args: string[], ctx: VerbContext, deps: LoopDeps): Promise<number> {
  const a = readArgs(ROWS, "loop resolve", args, ctx, { help: HELP.resolve });
  if (a === null) return 0;
  const ref = a.pos[0];
  if (ref === undefined) usage("resolve requires <ISSUE|YAK-ID>");
  const run = runOf(ctx, deps);
  const t = await resolveTarget(run, ref, run.cwd);
  ctx.stdout.write(ctx.format === "json" ? `${JSON.stringify(t)}\n` : `${t.issue}\n`);
  return 0;
}

async function runLaunch(args: string[], ctx: VerbContext, defaults: LoopDefaults, deps: LoopDeps): Promise<number> {
  const a = readArgs(ROWS, "loop launch", args, ctx, { help: HELP.launch });
  if (a === null) return 0;
  const f = a.flags;
  const r = await launchLoop(runOf(ctx, deps), defaults, {
    loop: a.pos[0],
    issue: a.pos[1],
    cwd: f["--cwd"],
    model: f["--model"],
    reportTo: f["--report-to"],
    caller: f["--caller"],
    context: f["--context"],
    force: f["--force"],
    unclaimed: f["--unclaimed"],
  });
  ctx.stdout.write(ctx.format === "json" ? `${JSON.stringify(r)}\n` : `${launchReceipt(r)}\n`);
  return 0;
}

/** The receipt lines, as text or as `{lines}`. */
const printLines = (ctx: VerbContext, lines: ReadonlyArray<string>): void => void ctx.stdout.write(ctx.format === "json" ? `${JSON.stringify({ lines })}\n` : lines.map((l) => `${l}\n`).join(""));

async function runResume(args: string[], ctx: VerbContext, deps: LoopDeps): Promise<number> {
  const a = readArgs(ROWS, "loop resume", args, ctx, { help: HELP.resume });
  if (a === null) return 0;
  printLines(ctx, await resumeLoop(runOf(ctx, deps), { ref: a.pos[0], all: a.flags["--all"], prompt: a.flags["--prompt"], unclaimed: a.flags["--unclaimed"] }));
  return 0;
}

async function runStop(args: string[], ctx: VerbContext, deps: LoopDeps): Promise<number> {
  const a = readArgs(ROWS, "loop stop", args, ctx, { help: HELP.stop });
  if (a === null) return 0;
  printLines(ctx, [await stopLoop(runOf(ctx, deps), a.pos[0])]);
  return 0;
}

async function runStatus(args: string[], ctx: VerbContext, deps: LoopDeps): Promise<number> {
  const a = readArgs(ROWS, "loop status", args, ctx, { help: HELP.status });
  if (a === null) return 0;
  ctx.stdout.write(loopStatus(runOf(ctx, deps), a.pos[0]));
  return 0;
}

async function runReap(args: string[], ctx: VerbContext, deps: LoopDeps): Promise<number> {
  const a = readArgs(ROWS, "loop reap", args, ctx, { help: HELP.reap });
  if (a === null) return 0;
  printLines(ctx, await reapLoops(runOf(ctx, deps), { dryRun: a.flags["--dry-run"], repos: a.flags["--repo"] }));
  return 0;
}

async function runHandBack(args: string[], ctx: VerbContext, deps: LoopDeps): Promise<number> {
  const a = readArgs(ROWS, "loop hand-back", args, ctx, { help: HELP.handBack });
  if (a === null) return 0;
  const run = runOf(ctx, deps);
  const issue = a.pos[0];
  const res = await handBack(run, { issue, claim: a.flags["--claim"], reportTo: a.flags["--report-to"], outcome: a.flags["--outcome"], body: readStdin(deps) });
  ctx.stdout.write(ctx.format === "json" ? `${JSON.stringify(res)}\n` : res.lines.map((l) => `${l}\n`).join(""));
  if (res.failed.length > 0) {
    stop(
      block(
        "loop-hand-back-failed",
        `the hand-back for ${issue ?? ""} was not posted on ${res.failed.join(", ")}`,
        "Read the WARN above for each target, fix it (sign-in, the issue key, the gateway), then re-run the hand-back with the same body on that target.",
        1,
      ),
    );
  }
  return 0;
}

/** The `eris loop` group: dispatch, then one place that renders a failure. */
export function loopHandler(defaults: LoopDefaults = {}, deps: LoopDeps = {}): VerbHandler {
  return async (args, ctx) => {
    const g = groupArgs(ROWS, "loop", args);
    if (g.kind === "bare" || g.kind === "help") {
      ctx.stdout.write(USAGE);
      return 0;
    }
    if (g.kind === "unknown") {
      ctx.stderr.write(`ERROR Unknown loop command: ${g.sub}\n`);
      return 1;
    }
    try {
      switch (g.sub) {
        case "list":
          return await runList(g.rest, ctx, defaults, deps);
        case "launch":
          return await runLaunch(g.rest, ctx, defaults, deps);
        case "resume":
          return await runResume(g.rest, ctx, deps);
        case "stop":
          return await runStop(g.rest, ctx, deps);
        case "status":
          return await runStatus(g.rest, ctx, deps);
        case "reap":
          return await runReap(g.rest, ctx, deps);
        case "hand-back":
          return await runHandBack(g.rest, ctx, deps);
        default:
          return await runResolve(g.rest, ctx, deps);
      }
    } catch (e) {
      if (!(e instanceof LoopFailure)) throw e;
      const f = e.failure;
      ctx.stderr.write(renderFailureBlock({ slug: f.slug, what: f.what, fix: f.fix, docs: f.docs }, ctx.erisDir));
      return f.exit;
    }
  };
}
