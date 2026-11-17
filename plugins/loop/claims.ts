/**
 * claims.ts — a loop's tracker claim and the ledger that names it on this machine.
 *
 * The gateway is the authority (one live claim per org and issue), reached through the gates client.
 * The ledger `~/.eris/loop/claims/<ISSUE>.json` records which claim id this machine holds for an issue
 * (issue, claim_id, loop, runtime, session_id, claimed_at), so stop, reap and a forced relaunch can name
 * the claim they release.
 *
 * Invariants:
 *  - the ledger is written whole (temp file + rename in its own directory), owner-only (dir 0700, file 0600);
 *  - a record that does not decode reads as no record (it holds no claim id this machine can use);
 *  - `dropClaim` removes a record only while it names that claim id, so a forced successor survives;
 *  - `bindClaim` records the session in the ledger before it binds, so reap can release a claim whose bind failed;
 *  - a reservation whose ledger write fails is released (`aborted`) before the verb stops.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { claimIssue, decodeResult, type GatesEndpoint, releaseIssue } from "eris/gates-contract";
import { block, stop, unwrap } from "./failure";
import { CLAIM_ID_RE } from "./names";

/** How long a bind waits before its one re-send when the reply adopted no tracker agent session. */
export const BIND_SESSION_WAIT_MS = 3000;
/** The runtime every claim this build makes records. */
export const RUNTIME = "claude";

export const ClaimRecord = Schema.Struct({
  issue: Schema.String,
  claim_id: Schema.String.check(Schema.isPattern(CLAIM_ID_RE, { expected: "a claim id of 8-64 letters, digits or dashes" })),
  loop: Schema.String,
  runtime: Schema.String,
  session_id: Schema.NullOr(Schema.String),
  claimed_at: Schema.String,
});
export type ClaimRecord = typeof ClaimRecord.Type;

export type Warn = (line: string) => void;

export const claimsDir = (home: string): string => join(home, ".eris", "loop", "claims");
export const claimPath = (home: string, issue: string): string => join(claimsDir(home), `${issue}.json`);

/** The slug as the gateway's `loop` field admits it (`[a-z0-9][a-z0-9-]*`): `_` reads as `-`. */
export const claimLoopName = (slug: string): string => slug.replaceAll("_", "-");

/** The ledger's claim for `issue`, or null when there is none (or it does not decode). */
export function readClaim(home: string, issue: string): ClaimRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(claimPath(home, issue), "utf8"));
  } catch {
    return null;
  }
  const decoded = decodeResult(ClaimRecord, raw);
  return decoded._tag === "Success" ? decoded.success : null;
}

/** Write the ledger entry whole and owner-only; `loop-claim-ledger-unwritable` when it cannot be. */
export function writeClaim(home: string, record: ClaimRecord): void {
  const dir = claimsDir(home);
  const tmp = join(dir, `.claim-${randomBytes(6).toString("hex")}.json`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(record));
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, claimPath(home, record.issue));
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // the directory itself is what failed: there is no temp file to remove
    }
    stop(block("loop-claim-ledger-unwritable", `cannot write the claim ledger under ${dir}: ${(e as Error).message}`, `Make ${dir} writable by you (it is created 0700), then re-run.`, 3));
  }
}

/** Remove the ledger entry only while it still names `claimId`: a forced relaunch's successor stays. */
export function dropClaim(home: string, issue: string, claimId: string): void {
  if (readClaim(home, issue)?.claim_id === claimId) rmSync(claimPath(home, issue), { force: true });
}

export interface Reserved {
  readonly claimId: string;
  /** The org's live policy sha the claim reply carried, when it carried one. */
  readonly bundleSha?: string;
}

/**
 * Reserve `issue` for a new loop before it spawns, and record it in the ledger. Another holder is
 * `linear-issue-claimed` (exit 3): nothing is written. A ledger that cannot be written releases the
 * reservation (`aborted`), then stops, so no claim is left that this machine cannot name.
 */
export async function reserveClaim(ep: GatesEndpoint, input: { home: string; issue: string; slug: string; now: number }): Promise<Reserved> {
  const claimId = randomUUID();
  const reply = unwrap(await claimIssue(ep, input.issue, { claimId, loop: claimLoopName(input.slug), runtime: RUNTIME }));
  const record: ClaimRecord = {
    issue: input.issue,
    claim_id: claimId,
    loop: input.slug,
    runtime: RUNTIME,
    session_id: null,
    claimed_at: new Date(input.now).toISOString().replace(/\.\d{3}Z$/, "+00:00"),
  };
  try {
    writeClaim(input.home, record);
  } catch (e) {
    await releaseIssue(ep, input.issue, { claimId, outcome: "aborted", body: "eris loop: the claim ledger could not be written, so the launch stopped." });
    throw e;
  }
  return { claimId, ...(reply.bundleSha !== undefined ? { bundleSha: reply.bundleSha } : {}) };
}

/**
 * Bind the reservation to the spawned session. The ledger learns the session first; a failed bind
 * only warns. When the reply adopted no tracker agent session, wait and re-send the bind once: an issue
 * delegated before opens no new agent session on the first write, and the holder's re-sent bind does.
 */
export async function bindClaim(ep: GatesEndpoint, input: { home: string; issue: string; claimId: string; slug: string; session: string; sleep: (ms: number) => Promise<void>; warn: Warn }): Promise<void> {
  const record = readClaim(input.home, input.issue);
  if (record !== null && record.claim_id === input.claimId) {
    try {
      writeClaim(input.home, { ...record, session_id: input.session });
    } catch (e) {
      input.warn(`eris loop: ${(e as Error).message}`);
    }
  }
  const bind = { claimId: input.claimId, loop: claimLoopName(input.slug), runtime: RUNTIME, sessionId: input.session };
  let reply = await claimIssue(ep, input.issue, bind);
  if (reply.ok && reply.value.claim.agent_session_id === null) {
    await input.sleep(BIND_SESSION_WAIT_MS);
    reply = await claimIssue(ep, input.issue, bind);
  }
  if (!reply.ok) input.warn(`eris loop: could not bind ${input.issue}'s claim: ${reply.failure.slug}: ${reply.failure.what}`);
}

/** Release `claimId`, warning on failure; true once the gateway answered (the ledger entry is then dropped). */
export async function releaseClaim(
  ep: GatesEndpoint,
  input: { home: string; issue: string; claimId: string; outcome: "handed_back" | "aborted"; body: string; warn: Warn },
): Promise<boolean> {
  const r = await releaseIssue(ep, input.issue, { claimId: input.claimId, outcome: input.outcome, ...(input.body.trim() === "" ? {} : { body: input.body }) });
  if (!r.ok) {
    input.warn(`eris loop: could not release ${input.issue}'s claim: ${r.failure.slug}: ${r.failure.what}`);
    return false;
  }
  dropClaim(input.home, input.issue, input.claimId);
  return true;
}
