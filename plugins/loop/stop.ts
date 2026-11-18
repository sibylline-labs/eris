/**
 * stop.ts — `eris loop stop`: stop a loop session, release its claim and move its issue back to Todo.
 *
 * Order: the runtime stop (a failure stops here, nothing released) → when the ledger's claim for the
 * issue is bound to this very session, release it (`aborted`; a failed release warns, the gateway's
 * expiry clears it) and move the issue to Todo while it is In Progress → the receipt. A session that
 * holds no claim (an unclaimed loop, another session's claim, none) touches neither: the claim and the
 * issue's status belong to whoever holds the claim. The session is a Claude job or a supplied
 * runtime's (sessions.ts); the owning runtime stops it.
 *
 * Receipt: `stopped <ISSUE> → loop <slug> · <id>` for a loop session, else `stopped <name|id> · <id>`.
 */

import { heldClaim, releaseClaim } from "./claims";
import { stopClaude } from "./claude";
import { endpoint, type Run, runtimeEnv } from "./deps";
import { usage } from "./failure";
import { loopOf } from "./names";
import { findSession, sessionIdOf, sessionNameOf } from "./sessions";
import { stopIssue } from "./transitions";

export const STOP_RELEASE_BODY = "eris loop: stopped by the operator.";

/** `<verb> <ISSUE> → loop <slug> · <id>` for a loop session, else `<verb> <name|id> · <id>`. */
export function sessionReceipt(verb: string, id: string, name: string, legacyPrefixes: ReadonlyArray<string>): string {
  const l = loopOf(name, legacyPrefixes);
  return l !== null ? `${verb} ${l.issue} → loop ${l.slug} · ${id}` : `${verb} ${name.trim() || id} · ${id}`;
}

/** Stop the session `ref` names; the receipt line. */
export async function stopLoop(run: Run, ref: string | undefined): Promise<string> {
  const clean = ref?.trim() ?? "";
  if (clean === "") usage("stop requires <session id|name|ISSUE>");
  const s = await findSession(run, clean);
  const [id, name] = [sessionIdOf(s), sessionNameOf(s)];
  if (s.kind === "claude") await stopClaude(run, s.job);
  else await s.rt.stop(runtimeEnv(run), s.session);
  const l = loopOf(name, run.legacyPrefixes);
  const held = l === null ? null : heldClaim(run.ledger, l.issue);
  if (l !== null && held !== null && held.record.session_id === id) {
    const ep = await endpoint(run);
    await releaseClaim(ep, { ledger: run.ledger, issue: l.issue, claimId: held.record.claim_id, outcome: "aborted", body: STOP_RELEASE_BODY, warn: run.warn });
    await stopIssue(ep, l.issue, run.warn);
  }
  return sessionReceipt("stopped", id, name || id, run.legacyPrefixes);
}
