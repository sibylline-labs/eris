/**
 * The loop claim ledger, `~/.eris/loop/claims/<ISSUE>.json` (plugins/loop/claims.ts): which claim id
 * this machine holds for an issue. The gateway is the claim authority; the ledger is what lets stop,
 * reap and a forced relaunch name the claim to release.
 *
 * The seam is the ledger functions over a real sandbox HOME under the gitignored `data/scratch/`.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { claimPath, claimsDir, type ClaimRecord, dropClaim, readClaim, writeClaim } from "../plugins/loop/claims";
import { LoopFailure } from "../plugins/loop/failure";

const REPO = resolve(import.meta.dir, "..");
mkdirSync(join(REPO, "data", "scratch"), { recursive: true });
const SCRATCH = realpathSync(mkdtempSync(join(REPO, "data", "scratch", "loop-claims-")));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const record = (claim_id: string): ClaimRecord => ({ issue: "ABC-7", claim_id, loop: "one-shot", runtime: "claude", session_id: null, claimed_at: "2026-11-17T12:00:00+00:00" });
const freshHome = () => realpathSync(mkdtempSync(join(SCRATCH, "home-")));

describe("the claim ledger", () => {
  it("writes whole and owner-only: dir 0700, file 0600, no temp file left", () => {
    /** When the ledger is world-readable or written in place, another user reads the claim id (the release guard) or a crash leaves a torn record: observed on the modes and the directory listing. */
    const home = freshHome();
    writeClaim(home, record("claim-0001"));
    expect(statSync(claimsDir(home)).mode & 0o777).toBe(0o700);
    expect(statSync(claimPath(home, "ABC-7")).mode & 0o777).toBe(0o600);
    expect(readdirSync(claimsDir(home))).toEqual(["ABC-7.json"]);
    expect(readClaim(home, "ABC-7")).toEqual(record("claim-0001"));
  });

  it("reads a record that does not decode as none", () => {
    /** When a hand-edited or truncated record reads as a claim, stop or reap releases with a claim id the gateway never issued: observed on readClaim's answer. */
    const home = freshHome();
    mkdirSync(claimsDir(home), { recursive: true });
    for (const raw of ["{", JSON.stringify({ ...record("x"), claim_id: "short" }), JSON.stringify({ issue: "ABC-7" })]) {
      writeFileSync(claimPath(home, "ABC-7"), raw);
      expect(readClaim(home, "ABC-7")).toBeNull();
    }
  });

  it("drops a record only while it names the claim id given", () => {
    /** When a late hand-back of a superseded loop drops the ledger entry regardless, the forced successor's claim is orphaned and nothing on this machine can release it: observed on the record after each drop. */
    const home = freshHome();
    writeClaim(home, record("claim-0002"));
    dropClaim(home, "ABC-7", "claim-0001");
    expect(readClaim(home, "ABC-7")?.claim_id).toBe("claim-0002");
    dropClaim(home, "ABC-7", "claim-0002");
    expect(readClaim(home, "ABC-7")).toBeNull();
  });

  it("refuses with loop-claim-ledger-unwritable when the directory cannot be written", () => {
    /** When an unwritable ledger is ignored, a reserved claim is held that this machine cannot name, so nothing releases it until the gateway's expiry: observed on the failure's slug and exit. */
    const home = freshHome();
    mkdirSync(join(home, ".eris", "loop"), { recursive: true });
    writeFileSync(claimsDir(home), "a file, not a directory");
    let slug = "";
    try {
      writeClaim(home, record("claim-0001"));
    } catch (e) {
      if (!(e instanceof LoopFailure)) throw e;
      slug = `${e.failure.slug}/${e.failure.exit}`;
    }
    expect(slug).toBe("loop-claim-ledger-unwritable/3");
  });
});
