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
import { gatesEndpoint } from "eris/gates-contract";
import { claimPath, claimsDir, type ClaimRecord, dropClaim, ledgerOf, readClaim, reserveClaim, writeClaim } from "../plugins/loop/claims";
import { LoopFailure } from "../plugins/loop/failure";
import { CLAIM_ID_RE } from "../plugins/loop/names";

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

describe("reserveClaim when the claim reply is lost", () => {
  const NOW = Date.parse("2026-11-17T12:00:00Z");
  const held = new Map<string, string>();
  const released: Array<{ issue: string; claimId: string; outcome: string }> = [];
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = (await req.json()) as Record<string, string | undefined>;
      const m = /^\/v1\/linear\/issues\/([A-Z]+-\d+)\/(claim|release)$/.exec(url.pathname);
      if (m === null) return Response.json({ type: "about:blank", status: 404, code: "not_found" }, { status: 404 });
      const [, issue, action] = m;
      if (action === "claim") {
        if (held.has(issue!)) {
          return Response.json(
            {
              type: "about:blank",
              status: 409,
              code: "issue_already_claimed",
              fields: { holder: { loop: "fixer", runtime: "claude", session_id: "job99999", claimed_at: "2026-11-17T11:00:00Z", expires_at: "2026-11-17T15:00:00Z" } },
            },
            { status: 409, headers: { "content-type": "application/problem+json" } },
          );
        }
        // Gateway persists the reservation, then fails with 503 before the caller sees a 201 reply.
        held.set(issue!, body.claim_id!);
        return Response.json({ type: "about:blank", status: 503, code: "gates_unavailable" }, { status: 503, headers: { "content-type": "application/problem+json" } });
      }
      released.push({ issue: issue!, claimId: body.claim_id!, outcome: body.outcome! });
      if (held.get(issue!) === body.claim_id) held.delete(issue!);
      return Response.json({ released: true, contract_version: "linear-contract/v1" });
    },
  });
  afterAll(() => srv.stop(true));

  const endpoint = () => {
    const r = gatesEndpoint(`http://127.0.0.1:${srv.port}`, "test-bearer");
    if (!r.ok) throw new Error(r.failure.what);
    return r.value;
  };

  // admits: integration: a claim written by the gateway before a 503 reply must be released under the same claim id, or retries fail linear-issue-claimed until the claim expires.
  it("releases the reserved claim by its claim id and still fails with the original error", async () => {
    /** When claimIssue fails with 503 after the gateway wrote the reservation, leaving it unreleased blocks every retry until expiry: observed on the original failure slug, the release request, the server claim map and the empty ledger. */
    held.clear();
    released.length = 0;
    const home = freshHome();
    let slug = "";
    try {
      await reserveClaim(endpoint(), { ledger: ledgerOf(home, []), issue: "ABC-7", slug: "one-shot", runtime: "claude", now: NOW });
    } catch (e) {
      if (!(e instanceof LoopFailure)) throw e;
      slug = e.failure.slug;
    }
    expect(slug).toBe("gate-store-unreachable");
    expect(released).toHaveLength(1);
    expect(released[0]!.issue).toBe("ABC-7");
    expect(released[0]!.outcome).toBe("aborted");
    expect(released[0]!.claimId).toMatch(CLAIM_ID_RE);
    expect(held.has("ABC-7")).toBe(false);
    expect(readClaim(home, "ABC-7")).toBeNull();
  });

  // admits: integration: linear-issue-claimed means another loop holds the issue, so reserveClaim must send no release request for a claim it never held.
  it("sends no release when another holder already owns the issue", async () => {
    /** When reserveClaim sends a release on linear-issue-claimed, it issues a spurious write against another holder's issue: observed on the slug, the empty release log and the surviving holder claim. */
    held.clear();
    released.length = 0;
    held.set("ABC-8", "other-claim-01");
    const home = freshHome();
    let slug = "";
    try {
      await reserveClaim(endpoint(), { ledger: ledgerOf(home, []), issue: "ABC-8", slug: "one-shot", runtime: "claude", now: NOW });
    } catch (e) {
      if (!(e instanceof LoopFailure)) throw e;
      slug = e.failure.slug;
    }
    expect(slug).toBe("linear-issue-claimed");
    expect(released).toEqual([]);
    expect(held.get("ABC-8")).toBe("other-claim-01");
    expect(readClaim(home, "ABC-8")).toBeNull();
  });
});
