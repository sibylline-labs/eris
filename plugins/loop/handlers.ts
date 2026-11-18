/**
 * handlers.ts — `eris loop <command>`: the dispatch, the one place a failure is rendered, and the
 * read-only verbs `list` and `resolve` (docs/LOOP.md).
 *
 * stdout carries only the payload; every diagnostic goes to stderr. Exit status: 0 done; 1 the
 * runtime failed to start or stop, or a hand-back reached no target; 2 an operand refused before
 * anything was claimed or spawned; 3 a precondition (not signed in, the issue claimed by another
 * loop, the org's policy tree edited).
 *
 * The handler parses with `loopRows(defaults)`, the rows the manifest composed for the same defaults,
 * so a flag a runtime declares is one the parser accepts. A build's `afterHandBack` runs once a
 * hand-back reached every target, and its failure only warns.
 */

import { groupArgs, readArgs, renderFailureBlock, type VerbContext, type VerbHandler } from "../../src/cli/plugin";
import { type LoopDeps, readStdin, runOf, treeOf } from "./deps";
import { block, LoopFailure, stop, usage } from "./failure";
import { HELP, launchHelp, USAGE } from "./help";
import { type LoopDefaults, type LoopRows, loopRows, runtimeFlagsOf, runtimesOf } from "./index";
import { handBack } from "./hand-back";
import { launchLoop, launchReceipt } from "./launch";
import { normaliseIssue } from "./names";
import { reapLoops } from "./reap";
import { resumeLoop } from "./resume";
import { loopStatus } from "./status";
import { stopLoop } from "./stop";
import { resolveTarget } from "./target";

export type { LoopDeps } from "./deps";

async function runList(ROWS: LoopRows, args: string[], ctx: VerbContext, defaults: LoopDefaults, deps: LoopDeps): Promise<number> {
  if (readArgs(ROWS, "loop list", args, ctx, { help: HELP.list }) === null) return 0;
  const run = runOf(ctx, defaults, deps);
  const tree = await treeOf(defaults, run, { cwd: run.cwd });
  ctx.stdout.write(ctx.format === "json" ? `${JSON.stringify({ loops: tree.loops })}\n` : tree.loops.map((s) => `${s}\n`).join(""));
  return 0;
}

async function runResolve(ROWS: LoopRows, args: string[], ctx: VerbContext, defaults: LoopDefaults, deps: LoopDeps): Promise<number> {
  const a = readArgs(ROWS, "loop resolve", args, ctx, { help: HELP.resolve });
  if (a === null) return 0;
  const ref = a.pos[0];
  if (ref === undefined) usage("resolve requires <ISSUE|YAK-ID>");
  const run = runOf(ctx, defaults, deps);
  const t = await resolveTarget(run, ref, run.cwd);
  ctx.stdout.write(ctx.format === "json" ? `${JSON.stringify(t)}\n` : `${t.issue}\n`);
  return 0;
}

async function runLaunch(ROWS: LoopRows, args: string[], ctx: VerbContext, defaults: LoopDefaults, deps: LoopDeps): Promise<number> {
  const a = readArgs(ROWS, "loop launch", args, ctx, { help: launchHelp(runtimesOf(defaults)) });
  if (a === null) return 0;
  const f = a.flags;
  // The runtime-declared flags are in the composed row, not in the public row's type: read them by name.
  const parsed: Readonly<Record<string, unknown>> = f;
  const runtimeFlags = Object.fromEntries(runtimeFlagsOf(defaults).map(({ name }) => [name, typeof parsed[name] === "string" ? (parsed[name] as string) : undefined]));
  const r = await launchLoop(runOf(ctx, defaults, deps), {
    loop: a.pos[0],
    issue: a.pos[1],
    cwd: f["--cwd"],
    model: f["--model"],
    reportTo: f["--report-to"],
    caller: f["--caller"],
    context: f["--context"],
    force: f["--force"],
    unclaimed: f["--unclaimed"],
    runtime: f["--runtime"],
    runtimeFlags,
  });
  ctx.stdout.write(ctx.format === "json" ? `${JSON.stringify(r)}\n` : `${launchReceipt(r)}\n`);
  return 0;
}

/** The receipt lines, as text or as `{lines}`. */
const printLines = (ctx: VerbContext, lines: ReadonlyArray<string>): void => void ctx.stdout.write(ctx.format === "json" ? `${JSON.stringify({ lines })}\n` : lines.map((l) => `${l}\n`).join(""));

async function runResume(ROWS: LoopRows, args: string[], ctx: VerbContext, defaults: LoopDefaults, deps: LoopDeps): Promise<number> {
  const a = readArgs(ROWS, "loop resume", args, ctx, { help: HELP.resume });
  if (a === null) return 0;
  printLines(ctx, await resumeLoop(runOf(ctx, defaults, deps), { ref: a.pos[0], all: a.flags["--all"], prompt: a.flags["--prompt"], unclaimed: a.flags["--unclaimed"] }));
  return 0;
}

async function runStop(ROWS: LoopRows, args: string[], ctx: VerbContext, defaults: LoopDefaults, deps: LoopDeps): Promise<number> {
  const a = readArgs(ROWS, "loop stop", args, ctx, { help: HELP.stop });
  if (a === null) return 0;
  printLines(ctx, [await stopLoop(runOf(ctx, defaults, deps), a.pos[0])]);
  return 0;
}

async function runStatus(ROWS: LoopRows, args: string[], ctx: VerbContext, defaults: LoopDefaults, deps: LoopDeps): Promise<number> {
  const a = readArgs(ROWS, "loop status", args, ctx, { help: HELP.status });
  if (a === null) return 0;
  ctx.stdout.write(await loopStatus(runOf(ctx, defaults, deps), a.pos[0]));
  return 0;
}

async function runReap(ROWS: LoopRows, args: string[], ctx: VerbContext, defaults: LoopDefaults, deps: LoopDeps): Promise<number> {
  const a = readArgs(ROWS, "loop reap", args, ctx, { help: HELP.reap });
  if (a === null) return 0;
  printLines(ctx, await reapLoops(runOf(ctx, defaults, deps), { dryRun: a.flags["--dry-run"], repos: a.flags["--repo"] }));
  return 0;
}

async function runHandBack(ROWS: LoopRows, args: string[], ctx: VerbContext, defaults: LoopDefaults, deps: LoopDeps): Promise<number> {
  const a = readArgs(ROWS, "loop hand-back", args, ctx, { help: HELP.handBack });
  if (a === null) return 0;
  const run = runOf(ctx, defaults, deps);
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
  if (defaults.afterHandBack !== undefined) {
    try {
      await defaults.afterHandBack(ctx, { issue: normaliseIssue(issue ?? "") });
    } catch (e) {
      run.warn(`eris loop: after the hand-back: ${e instanceof LoopFailure ? e.failure.what : (e as Error).message}`);
    }
  }
  return 0;
}

/** The `eris loop` group: dispatch, then one place that renders a failure. */
export function loopHandler(defaults: LoopDefaults = {}, deps: LoopDeps = {}): VerbHandler {
  const ROWS = loopRows(defaults);
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
          return await runList(ROWS, g.rest, ctx, defaults, deps);
        case "launch":
          return await runLaunch(ROWS, g.rest, ctx, defaults, deps);
        case "resume":
          return await runResume(ROWS, g.rest, ctx, defaults, deps);
        case "stop":
          return await runStop(ROWS, g.rest, ctx, defaults, deps);
        case "status":
          return await runStatus(ROWS, g.rest, ctx, defaults, deps);
        case "reap":
          return await runReap(ROWS, g.rest, ctx, defaults, deps);
        case "hand-back":
          return await runHandBack(ROWS, g.rest, ctx, defaults, deps);
        default:
          return await runResolve(ROWS, g.rest, ctx, defaults, deps);
      }
    } catch (e) {
      if (!(e instanceof LoopFailure)) throw e;
      const f = e.failure;
      ctx.stderr.write(renderFailureBlock({ slug: f.slug, what: f.what, fix: f.fix, docs: f.docs }, ctx.erisDir));
      return f.exit;
    }
  };
}
