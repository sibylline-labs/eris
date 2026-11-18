/**
 * claims.ts — a loop's tracker claim and the ledger that names it on this machine.
 *
 * The gateway is the authority (one live claim per org and issue), reached through the gates client.
 * The ledger `~/.eris/loop/claims/<ISSUE>.json` records which claim id this machine holds for an issue
 * (issue, claim_id, loop, runtime, session_id, claimed_at), so stop, reap and a forced relaunch can name
 * the claim they release.
 *
 * A build may name legacy ledger directories (`LoopDefaults.legacy.claimDirs`); a `Ledger` is the
 * primary directory then those, and the verbs reach the ledger only through it
 * (`loop-ledger-every-dir`, rules/). The home-based helpers see the primary directory alone.
 *
 * Invariants:
 *  - the ledger is written whole (temp file + rename in its own directory), owner-only (dir 0700, file 0600);
 *  - every write goes to the primary directory; a legacy directory is read, and a record in it is
 *    removed once released or re-bound, never rewritten;
 *  - a record that does not decode reads as no record (it holds no claim id this machine can use);
 *  - a read takes the first directory whose record decodes, primary first;
 *  - a drop removes a record only while it names that claim id, in whichever directory holds it, so a
 *    forced successor survives;
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
/** The built-in runtime, the one a claim records unless the launch names another. */
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

/** The ledger directories a verb reads, the primary one (every write's) first. */
export interface Ledger {
  readonly dirs: readonly [string, ...string[]];
}

/** The ledger under `home`: `~/.eris/loop/claims`, then each legacy directory (`[]` for none). */
export const ledgerOf = (home: string, legacyDirs: ReadonlyArray<string>): Ledger => ({ dirs: [claimsDir(home), ...legacyDirs.filter((d) => d !== claimsDir(home))] });

/** `<dir>/<ISSUE>.json`: one ledger directory's record for an issue. */
export const recordPath = (dir: string, issue: string): string => join(dir, `${issue}.json`);

/** The record `<dir>/<issue>.json` holds, or null when there is none (or it does not decode). */
export function readClaimIn(dir: string, issue: string): ClaimRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(recordPath(dir, issue), "utf8"));
  } catch {
    return null;
  }
  const decoded = decodeResult(ClaimRecord, raw);
  return decoded._tag === "Success" ? decoded.success : null;
}

/** The primary directory's claim for `issue`, or null when there is none (or it does not decode). */
export const readClaim = (home: string, issue: string): ClaimRecord | null => readClaimIn(claimsDir(home), issue);

/** A claim the ledger holds, and the directory whose file holds it. */
export interface HeldClaim {
  readonly record: ClaimRecord;
  readonly dir: string;
}

/** The ledger's claim for `issue`: the first directory whose record decodes, primary first; null when none does. */
export function heldClaim(ledger: Ledger, issue: string): HeldClaim | null {
  for (const dir of ledger.dirs) {
    const record = readClaimIn(dir, issue);
    if (record !== null) return { record, dir };
  }
  return null;
}

/** Write the primary directory's entry whole and owner-only; `loop-claim-ledger-unwritable` when it cannot be. */
export const writeClaim = (home: string, record: ClaimRecord): void => writeClaimIn(claimsDir(home), record);

function writeClaimIn(dir: string, record: ClaimRecord): void {
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
    renameSync(tmp, recordPath(dir, record.issue));
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // the directory itself is what failed: there is no temp file to remove
    }
    stop(block("loop-claim-ledger-unwritable", `cannot write the claim ledger under ${dir}: ${(e as Error).message}`, `Make ${dir} writable by you (it is created 0700), then re-run.`, 3));
  }
}

/** Remove `<dir>/<issue>.json` only while it still names `claimId`: a forced relaunch's successor stays. */
function dropClaimIn(dir: string, issue: string, claimId: string): void {
  if (readClaimIn(dir, issue)?.claim_id === claimId) rmSync(recordPath(dir, issue), { force: true });
}

/** Remove the primary directory's entry only while it still names `claimId`. */
export const dropClaim = (home: string, issue: string, claimId: string): void => dropClaimIn(claimsDir(home), issue, claimId);

/** Remove the entry naming `claimId` from every ledger directory that holds it. */
export function dropHeldClaim(ledger: Ledger, issue: string, claimId: string): void {
  for (const dir of ledger.dirs) dropClaimIn(dir, issue, claimId);
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
export async function reserveClaim(ep: GatesEndpoint, input: { ledger: Ledger; issue: string; slug: string; runtime: string; now: number }): Promise<Reserved> {
  const claimId = randomUUID();
  const reply = unwrap(await claimIssue(ep, input.issue, { claimId, loop: claimLoopName(input.slug), runtime: input.runtime }));
  const record: ClaimRecord = {
    issue: input.issue,
    claim_id: claimId,
    loop: input.slug,
    runtime: input.runtime,
    session_id: null,
    claimed_at: new Date(input.now).toISOString().replace(/\.\d{3}Z$/, "+00:00"),
  };
  try {
    writeClaimIn(input.ledger.dirs[0], record);
  } catch (e) {
    await releaseIssue(ep, input.issue, { claimId, outcome: "aborted", body: "eris loop: the claim ledger could not be written, so the launch stopped." });
    throw e;
  }
  return { claimId, ...(reply.bundleSha !== undefined ? { bundleSha: reply.bundleSha } : {}) };
}

/**
 * Bind the reservation to the spawned session. The ledger learns the session first, in the primary
 * directory (a legacy record of the same claim is then removed); a failed bind only warns. When the
 * reply adopted no tracker agent session, wait and re-send the bind once: an issue delegated before
 * opens no new agent session on the first write, and the holder's re-sent bind does.
 */
export async function bindClaim(
  ep: GatesEndpoint,
  input: { ledger: Ledger; issue: string; claimId: string; slug: string; runtime: string; session: string; sleep: (ms: number) => Promise<void>; warn: Warn },
): Promise<void> {
  const held = heldClaim(input.ledger, input.issue);
  if (held !== null && held.record.claim_id === input.claimId) {
    try {
      writeClaimIn(input.ledger.dirs[0], { ...held.record, session_id: input.session });
      if (held.dir !== input.ledger.dirs[0]) dropClaimIn(held.dir, input.issue, input.claimId);
    } catch (e) {
      input.warn(`eris loop: ${(e as Error).message}`);
    }
  }
  const bind = { claimId: input.claimId, loop: claimLoopName(input.slug), runtime: input.runtime, sessionId: input.session };
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
  input: { ledger: Ledger; issue: string; claimId: string; outcome: "handed_back" | "aborted"; body: string; warn: Warn },
): Promise<boolean> {
  const r = await releaseIssue(ep, input.issue, { claimId: input.claimId, outcome: input.outcome, ...(input.body.trim() === "" ? {} : { body: input.body }) });
  if (!r.ok) {
    input.warn(`eris loop: could not release ${input.issue}'s claim: ${r.failure.slug}: ${r.failure.what}`);
    return false;
  }
  dropHeldClaim(input.ledger, input.issue, input.claimId);
  return true;
}
