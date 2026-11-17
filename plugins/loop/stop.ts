/**
 * stop.ts — `eris loop stop`: stop a loop session, release its claim and move its issue back to Todo.
 *
 * Order: the runtime stop (a failure stops here, nothing released) → when the ledger's claim for the
 * issue is bound to this very session, release it (`aborted`; a failed release warns, the gateway's
 * expiry clears it) and move the issue to Todo while it is In Progress → the receipt. A session that
 * holds no claim (an unclaimed loop, another session's claim, none) touches neither: the claim and the
 * issue's status belong to whoever holds the claim.
 *
 * Receipt: `stopped <ISSUE> → loop <slug> · <id>` for a loop session, else `stopped <name|id> · <id>`.
 */

import { readClaim, releaseClaim } from "./claims";
import { findJob, sessionNotFound, stopClaude, trimmed } from "./claude";
import { endpoint, type Run } from "./deps";
import { usage } from "./failure";
import { loopOf } from "./names";
import { stopIssue } from "./transitions";

export const STOP_RELEASE_BODY = "eris loop: stopped by the operator.";

/** `<verb> <ISSUE> → loop <slug> · <id>` for a loop session, else `<verb> <name|id> · <id>`. */
export function sessionReceipt(verb: string, id: string, name: string): string {
  const l = loopOf(name);
  return l !== null ? `${verb} ${l.issue} → loop ${l.slug} · ${id}` : `${verb} ${name.trim() || id} · ${id}`;
}

/** Stop the session `ref` names; the receipt line. */
export async function stopLoop(run: Run, ref: string | undefined): Promise<string> {
  const clean = ref?.trim() ?? "";
  if (clean === "") usage("stop requires <session id|name|ISSUE>");
  const job = findJob(run.home, clean);
  if (job === null) sessionNotFound(clean, run.home);
  const name = trimmed(job.state.name);
  await stopClaude(run, job);
  const l = loopOf(name);
  const record = l === null ? null : readClaim(run.home, l.issue);
  if (l !== null && record !== null && record.session_id === job.id) {
    const ep = await endpoint(run);
    await releaseClaim(ep, { home: run.home, issue: l.issue, claimId: record.claim_id, outcome: "aborted", body: STOP_RELEASE_BODY, warn: run.warn });
    await stopIssue(ep, l.issue, run.warn);
  }
  return sessionReceipt("stopped", job.id, name || job.id);
}
