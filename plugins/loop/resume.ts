/**
 * resume.ts — `eris loop resume`: continue a finished loop session with a prompt, holding its claim
 * again.
 *
 * Claim rules, for a session named `eris-loop-<slug>-<issue>`:
 *  - the ledger's claim for the issue is bound to this very session → re-bind that claim id to the
 *    resumed session;
 *  - otherwise reserve a fresh claim before resuming and bind it after; another holder is
 *    `linear-issue-claimed` (exit 3) and nothing resumes; `--unclaimed` skips the reserve;
 *  - a fresh reservation whose resume fails is released (`aborted`);
 *  - the continuation prompt carries the claim and hand-back lines, so the session's hand-back releases
 *    the claim it now holds.
 *
 * `--all` resumes every failed loop session whose issue is open; every issue is read before anything is
 * resumed, so an unreadable tracker stops the run with nothing resumed.
 */

import type { GatesEndpoint } from "eris/gates-contract";
import { bindClaim, readClaim, releaseClaim, reserveClaim } from "./claims";
import { type ClaudeJob, findJob, listJobs, refuseWorking, resumeClaude, sessionNotFound, trimmed } from "./claude";
import { endpoint, type Run } from "./deps";
import { LoopFailure, usage } from "./failure";
import { HAND_BACK_MAX, loopOf, normaliseResumePrompt } from "./names";
import { continuationPrompt } from "./prompt";
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

/** The claim a resume of `job` holds: the ledger's when bound to this job, else a fresh reservation; none for a non-loop session or `--unclaimed`. */
async function holdClaim(run: Run, ep: () => Promise<GatesEndpoint>, job: ClaudeJob, unclaimed: boolean): Promise<Held | null> {
  const l = loopOf(trimmed(job.state.name));
  if (l === null || unclaimed) return null;
  const record = readClaim(run.home, l.issue);
  if (record !== null && record.session_id === job.id) return { issue: l.issue, claimId: record.claim_id, slug: record.loop, fresh: false };
  const reserved = await reserveClaim(await ep(), { home: run.home, issue: l.issue, slug: l.slug, now: run.now() }).catch(unclaimedFix);
  return { issue: l.issue, claimId: reserved.claimId, slug: l.slug, fresh: true };
}

async function resumeOne(run: Run, ep: () => Promise<GatesEndpoint>, job: ClaudeJob, prompt: string, unclaimed: boolean): Promise<string> {
  const name = trimmed(job.state.name) || job.id;
  if (job.state.state === "working") refuseWorking(job);
  const held = await holdClaim(run, ep, job, unclaimed);
  let session: string;
  try {
    session = await resumeClaude(run, job, continuationPrompt(prompt, held), run.cwd);
  } catch (e) {
    if (held?.fresh === true) {
      const why = e instanceof LoopFailure ? e.failure.what : String(e);
      await releaseClaim(await ep(), { home: run.home, issue: held.issue, claimId: held.claimId, outcome: "aborted", body: `eris loop: the resume failed: ${why}`.slice(0, HAND_BACK_MAX), warn: run.warn });
    }
    throw e;
  }
  if (held !== null) await bindClaim(await ep(), { home: run.home, issue: held.issue, claimId: held.claimId, slug: held.slug, session, sleep: run.sleep, warn: run.warn });
  return sessionReceipt("resumed", session, name);
}

/** Resume the session `ref` names, or every failed loop session on an open issue with `--all`; one receipt line each. */
export async function resumeLoop(run: Run, input: ResumeInput): Promise<ReadonlyArray<string>> {
  const ref = input.ref?.trim() ?? "";
  if (input.all && ref !== "") usage("pass either a session ref or --all, not both");
  if (!input.all && ref === "") usage("resume requires <session id|name|ISSUE> or --all");
  const prompt = normaliseResumePrompt(input.prompt);
  let cached: GatesEndpoint | undefined;
  const ep = async () => (cached ??= await endpoint(run));
  if (!input.all) {
    const job = findJob(run.home, ref);
    if (job === null) sessionNotFound(ref, run.home);
    return [await resumeOne(run, ep, job, prompt, input.unclaimed)];
  }
  const failed = listJobs(run.home).filter((j) => j.state.state === "failed" && loopOf(trimmed(j.state.name)) !== null);
  const open: ClaudeJob[] = [];
  for (const job of failed) if (!(await isClosed(await ep(), loopOf(trimmed(job.state.name))!.issue, run.warn))) open.push(job);
  const lines: string[] = [];
  for (const job of open) lines.push(await resumeOne(run, ep, job, prompt, input.unclaimed));
  return lines;
}
