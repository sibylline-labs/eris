/**
 * sessions.ts — a `<ref>` resolved over every runtime a run has: the built-in Claude Code jobs
 * (claude.ts) and each supplied runtime's `find` (runtime.ts, docs/LOOP.md#distribution-seams).
 *
 * Invariants:
 *  - the Claude jobs resolve in their own tiers (`matchJobs`); a supplied runtime's matches join them,
 *    so an issue key names a loop whichever runtime runs it;
 *  - `findSession` (stop, resume): more than one match across all runtimes is
 *    `loop-session-ambiguous`, none is `loop-session-not-found`;
 *  - a run with no supplied runtime asks nothing beyond the Claude jobs.
 */

import { type ClaudeJob, matchJobs, sessionAmbiguous, sessionNotFound, trimmed } from "./claude";
import { type Run, runtimeEnv } from "./deps";
import type { LoopRuntime, LoopRuntimeSession } from "./runtime";

/** A session a ref named: a Claude job, or a supplied runtime's session. */
export type LoopSession =
  | { readonly kind: "claude"; readonly job: ClaudeJob }
  | { readonly kind: "runtime"; readonly runtime: string; readonly rt: LoopRuntime; readonly session: LoopRuntimeSession };

export const sessionIdOf = (s: LoopSession): string => (s.kind === "claude" ? s.job.id : s.session.id);
export const sessionNameOf = (s: LoopSession): string => (s.kind === "claude" ? trimmed(s.job.state.name) : s.session.name.trim());
export const sessionStateOf = (s: LoopSession): string => (s.kind === "claude" ? s.job.state.state || "unknown" : s.session.state || "unknown");
export const isWorking = (s: LoopSession): boolean => (s.kind === "claude" ? s.job.state.state === "working" : s.rt.working(s.session));

/** Every session `ref` names: the Claude jobs' first matching tier, then each runtime's matches. */
export async function matchSessions(run: Run, ref: string): Promise<ReadonlyArray<LoopSession>> {
  const out: LoopSession[] = matchJobs(run.home, ref, run.legacyPrefixes).map((job) => ({ kind: "claude", job }));
  const clean = ref.trim();
  if (clean === "") return out;
  for (const [runtime, rt] of run.runtimes) {
    for (const session of await rt.find(runtimeEnv(run), clean)) out.push({ kind: "runtime", runtime, rt, session });
  }
  return out;
}

/** No session matched `ref`. */
export const notFound = (run: Run, ref: string): never =>
  sessionNotFound(
    ref,
    run.home,
    run.runtimes.map(([n]) => n),
  );

/** The one session `ref` names; several is `loop-session-ambiguous`, none `loop-session-not-found`. */
export async function findSession(run: Run, ref: string): Promise<LoopSession> {
  const matches = await matchSessions(run, ref);
  if (matches.length > 1) sessionAmbiguous(ref, matches.map(sessionIdOf));
  return matches[0] ?? notFound(run, ref);
}
