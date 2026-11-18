/**
 * resume.ts — `eris loop resume`: continue a finished loop session with a prompt, holding its claim
 * again.
 *
 * Claim rules, for a session named `eris-loop-<slug>-<issue>` (or a build's legacy prefix):
 *  - the ledger's claim for the issue is bound to this very session → re-bind that claim id to the
 *    resumed session;
 *  - otherwise reserve a fresh claim before resuming and bind it after; another holder is
 *    `linear-issue-claimed` (exit 3) and nothing resumes; `--unclaimed`, or a slug the build marks
 *    claimless, skips the reserve;
 *  - a fresh reservation whose resume fails is released (`aborted`);
 *  - the continuation prompt carries the claim and hand-back lines, so the session's hand-back releases
 *    the claim it now holds.
 *
 * The session is a Claude job or a supplied runtime's (sessions.ts); the owning runtime resumes it.
 * `--all` resumes every failed loop session, on every runtime, whose issue is open; every issue is read
 * before anything is resumed, so an unreadable tracker stops the run with nothing resumed.
 */

import type { GatesEndpoint } from "eris/gates-contract";
import { bindClaim, heldClaim, releaseClaim, reserveClaim, RUNTIME } from "./claims";
import { listJobs, refuseWorking, resumeClaude, trimmed } from "./claude";
import { endpoint, type Run, runtimeEnv } from "./deps";
import { LoopFailure, usage } from "./failure";
import { HAND_BACK_MAX, loopOf, normaliseResumePrompt } from "./names";
import { continuationPrompt } from "./prompt";
import { findSession, type LoopSession, sessionIdOf, sessionNameOf } from "./sessions";
import { sessionReceipt } from "./stop";
import { isClosed } from "./transitions";

export interface ResumeInput {
  readonly ref: string | undefined;
  readonly all: boolean;
  readonly prompt: string | undefined;
  readonly unclaimed: boolean;
}

interface Held {
  readonly issue: string;
  readonly claimId: string;
  readonly slug: string;
  /** Reserved by this resume (released if the resume fails), not re-bound from the ledger. */
  readonly fresh: boolean;
}

function unclaimedFix(e: unknown): never {
  if (e instanceof LoopFailure && e.failure.slug !== "linear-issue-claimed" && e.failure.slug !== "loop-claim-ledger-unwritable") {
    throw new LoopFailure({ ...e.failure, fix: `${e.failure.fix} Or re-run the resume with --unclaimed.` });
  }
  throw e;
}

const runtimeOf = (s: LoopSession): string => (s.kind === "claude" ? RUNTIME : s.runtime);

/** The claim a resume of `s` holds: the ledger's when bound to this session, else a fresh reservation; none for a non-loop session, `--unclaimed` or a claimless slug. */
async function holdClaim(run: Run, ep: () => Promise<GatesEndpoint>, s: LoopSession, unclaimed: boolean): Promise<Held | null> {
  const l = loopOf(sessionNameOf(s), run.legacyPrefixes);
  if (l === null || unclaimed || (run.defaults.claimless ?? []).includes(l.slug)) return null;
  const held = heldClaim(run.ledger, l.issue);
  if (held !== null && held.record.session_id === sessionIdOf(s)) return { issue: l.issue, claimId: held.record.claim_id, slug: held.record.loop, fresh: false };
  const reserved = await reserveClaim(await ep(), { ledger: run.ledger, issue: l.issue, slug: l.slug, runtime: runtimeOf(s), now: run.now() }).catch(unclaimedFix);
  return { issue: l.issue, claimId: reserved.claimId, slug: l.slug, fresh: true };
}

function refuseWorkingSession(s: LoopSession): void {
  if (s.kind === "claude") {
    if (s.job.state.state === "working") refuseWorking(s.job);
  } else if (s.rt.working(s.session)) {
    usage(`${s.runtime} session ${s.session.id} (${s.session.name.trim() || "unnamed"}) is currently working; wait for it to finish`, "Re-run once the session is no longer working.");
  }
}

async function resumeOne(run: Run, ep: () => Promise<GatesEndpoint>, s: LoopSession, prompt: string, unclaimed: boolean): Promise<string> {
  const name = sessionNameOf(s) || sessionIdOf(s);
  refuseWorkingSession(s);
  const held = await holdClaim(run, ep, s, unclaimed);
  let session: string;
  try {
    const next = continuationPrompt(prompt, held);
    session = s.kind === "claude" ? await resumeClaude(run, s.job, next, run.cwd) : await s.rt.resume(runtimeEnv(run), s.session, next);
  } catch (e) {
    if (held?.fresh === true) {
      const why = e instanceof LoopFailure ? e.failure.what : String(e);
      await releaseClaim(await ep(), { ledger: run.ledger, issue: held.issue, claimId: held.claimId, outcome: "aborted", body: `eris loop: the resume failed: ${why}`.slice(0, HAND_BACK_MAX), warn: run.warn });
    }
    throw e;
  }
  if (held !== null) {
    await bindClaim(await ep(), { ledger: run.ledger, issue: held.issue, claimId: held.claimId, slug: held.slug, runtime: runtimeOf(s), session, sleep: run.sleep, warn: run.warn });
  }
  return sessionReceipt("resumed", session, name, run.legacyPrefixes);
}

/** Every failed loop session: the Claude jobs', then each supplied runtime's. */
async function failedSessions(run: Run): Promise<ReadonlyArray<LoopSession>> {
  const out: LoopSession[] = listJobs(run.home)
    .filter((j) => j.state.state === "failed")
    .map((job) => ({ kind: "claude", job }));
  for (const [runtime, rt] of run.runtimes) for (const session of await rt.failed(runtimeEnv(run))) out.push({ kind: "runtime", runtime, rt, session });
  return out.filter((s) => loopOf(sessionNameOf(s), run.legacyPrefixes) !== null);
}

/** Resume the session `ref` names, or every failed loop session on an open issue with `--all`; one receipt line each. */
export async function resumeLoop(run: Run, input: ResumeInput): Promise<ReadonlyArray<string>> {
  const ref = input.ref?.trim() ?? "";
  if (input.all && ref !== "") usage("pass either a session ref or --all, not both");
  if (!input.all && ref === "") usage("resume requires <session id|name|ISSUE> or --all");
  const prompt = normaliseResumePrompt(input.prompt);
  let cached: GatesEndpoint | undefined;
  const ep = async () => (cached ??= await endpoint(run));
  if (!input.all) return [await resumeOne(run, ep, await findSession(run, ref), prompt, input.unclaimed)];
  const open: LoopSession[] = [];
  for (const s of await failedSessions(run)) if (!(await isClosed(await ep(), loopOf(sessionNameOf(s), run.legacyPrefixes)!.issue, run.warn))) open.push(s);
  const lines: string[] = [];
  for (const s of open) lines.push(await resumeOne(run, ep, s, prompt, input.unclaimed));
  return lines;
}
