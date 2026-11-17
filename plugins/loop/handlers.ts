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
import { type LoopDeps, runOf, treeOf } from "./deps";
import { LoopFailure, usage } from "./failure";
import { HELP, USAGE } from "./help";
import plugin, { type LoopDefaults } from "./index";
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
      if (g.sub === "list") return await runList(g.rest, ctx, defaults, deps);
      return await runResolve(g.rest, ctx, deps);
    } catch (e) {
      if (!(e instanceof LoopFailure)) throw e;
      const f = e.failure;
      ctx.stderr.write(renderFailureBlock({ slug: f.slug, what: f.what, fix: f.fix, docs: f.docs }, ctx.erisDir));
      return f.exit;
    }
  };
}
