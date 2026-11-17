/**
 * `eris loop hand-back` (plugins/loop/hand-back.ts): post a loop's hand-back as the org's app. With
 * `--claim` it is the release response of that claim; otherwise, or when the claim no longer holds the
 * issue, it is a comment. `--report-to` also comments there.
 *
 * The seam is the loop handler over the loopback gateway of tests/helpers/loop-fixture.ts, with the
 * body on an injected stdin.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readClaim, writeClaim } from "../plugins/loop/claims";
import { loop, loopWorld, type LoopWorld, slugOf, stopServer } from "./helpers/loop-fixture";

const CLAIM = "claim-held-0001";
let w: LoopWorld;
beforeEach(async () => {
  w = await loopWorld();
  w.issues.set("ABC-7", { state: { name: "In Progress", type: "started" } });
  w.issues.set("ABC-2", { state: { name: "Todo", type: "unstarted" } });
  w.claims.set("ABC-7", { claimId: CLAIM, loop: "one-shot", runtime: "claude", session_id: "job00001", agent_session_id: null });
  writeClaim(w.home, { issue: "ABC-7", claim_id: CLAIM, loop: "one-shot", runtime: "claude", session_id: "job00001", claimed_at: "2026-11-17T12:00:00+00:00" });
});
afterEach(() => w.close());
afterAll(() => stopServer());

const writes = () => w.seen.map((s) => [s.path, s.body]);

describe("eris loop hand-back", () => {
  it("releases the held claim with the body as its response, drops the ledger entry, and comments on --report-to", async () => {
    /** When the hand-back is posted as a comment while the claim stays held (or the report-to target is skipped), the issue stays claimed until expiry and the launcher never hears back: observed on the gateway's writes, its claims and the ledger. */
    const r = await loop(w, ["hand-back", "abc-7", "--claim", CLAIM, "--report-to", "ABC-2"], { stdin: "result: done\n" });
    expect(r.rc).toBe(0);
    expect(r.stdout).toBe("handed back ABC-7 · released claim claim-he with the hand-back as its response\nhanded back ABC-7 · comment comment-2 on ABC-2\n");
    expect(writes()).toEqual([
      ["/v1/linear/issues/ABC-7/release", { claim_id: CLAIM, outcome: "handed_back", body: "result: done\n" }],
      ["/v1/linear/issues/ABC-2/comments", { body: "result: done\n" }],
    ]);
    expect(w.claims.has("ABC-7")).toBe(false);
    expect(readClaim(w.home, "ABC-7")).toBeNull();
  });

  it("comments instead when the claim no longer holds the issue", async () => {
    /** When a superseded loop's hand-back is dropped because its release answered released:false, its result is lost: observed on the comment write and the stderr note. */
    w.claims.set("ABC-7", { claimId: "successor-0001", loop: "one-shot", runtime: "claude", session_id: "job00002", agent_session_id: null });
    const r = await loop(w, ["hand-back", "ABC-7", "--claim", CLAIM], { format: "json", stdin: "late result" });
    expect(r.rc).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ lines: ["handed back ABC-7 · comment comment-2 on ABC-7"], failed: [] });
    expect(r.stderr).toContain("superseded");
    expect(w.claims.get("ABC-7")!.claimId).toBe("successor-0001");
  });

  it("refuses a blank or oversized body before any request", async () => {
    /** When a blank or over-cap body is sent, the release spends the claim on an empty response or the comment route refuses it after the claim was released: observed on the slug and the empty request log. */
    for (const body of ["  \n", "x".repeat(65537)]) {
      const r = await loop(w, ["hand-back", "ABC-7", "--claim", CLAIM], { stdin: body });
      expect([r.rc, slugOf(r.stderr), r.stdout]).toEqual([2, "loop-usage", ""]);
    }
    const bad = await loop(w, ["hand-back", "ABC-7", "--outcome", "done"], { stdin: "b" });
    expect([bad.rc, slugOf(bad.stderr)]).toEqual([2, "loop-usage"]);
    expect(w.seen).toEqual([]);
  });

  it("refuses a body holding a secret before any request, naming the rule and never the text", async () => {
    /** When the scan is skipped or runs after the release, an agent's hand-back posts a live credential to the tracker, where it cannot be recalled: observed on the slug, the stderr and the empty request log. */
    const token = "ghp" + "_" + "0123456789abcdefghijABCDEFGHIJ012345";
    const r = await loop(w, ["hand-back", "ABC-7", "--claim", CLAIM], { stdin: `result: done\nused ${token} to push\n` });
    expect([r.rc, slugOf(r.stderr), r.stdout]).toEqual([2, "loop-secret-detected", ""]);
    expect(r.stderr).not.toContain(token);
    expect(w.seen).toEqual([]);
    expect(readClaim(w.home, "ABC-7")?.claim_id).toBe(CLAIM);
  });

  it("prints what landed, then fails loop-hand-back-failed (exit 1) naming the target that got nothing", async () => {
    /** When a target that got nothing still exits 0, a hand-back is silently lost; when the failure hides what did land, it is posted twice on re-run: observed on stdout, the slug and the exit. */
    const r = await loop(w, ["hand-back", "ABC-7", "--claim", CLAIM, "--report-to", "ABC-404"], { stdin: "result" });
    expect(r.rc).toBe(1);
    expect(slugOf(r.stderr)).toBe("loop-hand-back-failed");
    expect(r.stderr).toContain("ABC-404");
    expect(r.stdout).toBe("handed back ABC-7 · released claim claim-he with the hand-back as its response\n");
  });

  it("retries a write the gateway shed with 429, and only that", async () => {
    /** When a 429 is not retried, a hand-back shed by the rate limit is lost; when the retry is unbounded, the verb never ends: observed on the comment count and the exit. */
    let shed = 1;
    w.refuse.set("POST /v1/linear/issues/ABC-2/comments", () => {
      if (shed-- > 0) return Response.json({ type: "about:blank", status: 429, code: "rate_limited" }, { status: 429, headers: { "retry-after": "1" } });
      w.refuse.delete("POST /v1/linear/issues/ABC-2/comments");
      return Response.json({ comment: { id: "c-after-retry" }, contract_version: "linear-contract/v1" });
    });
    const r = await loop(w, ["hand-back", "ABC-2"], { stdin: "result" });
    expect([r.rc, r.stdout]).toEqual([0, "handed back ABC-2 · comment c-after-retry on ABC-2\n"]);
    expect(w.seen.filter((s) => s.path.endsWith("/comments"))).toHaveLength(2);
  });
});
