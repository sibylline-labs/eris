/**
 * `eris loop stop` and `eris loop resume` (plugins/loop/stop.ts, resume.ts): a session found by id,
 * exact name or issue key; its claim released or held again; its issue moved back to Todo only while
 * In Progress.
 *
 * The seam is the loop handler over the loopback gateway, sandbox HOME and fake `claude` of
 * tests/helpers/loop-fixture.ts; each session is launched through the real `launch` first.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readClaim } from "../plugins/loop/claims";
import { loop, loopWorld, type LoopWorld, slugOf, stopServer } from "./helpers/loop-fixture";

let w: LoopWorld;
beforeEach(async () => {
  w = await loopWorld();
  w.issues.set("ABC-7", { state: { name: "Todo", type: "unstarted" } });
  w.issues.set("ABC-8", { state: { name: "Todo", type: "unstarted" } });
});
afterEach(() => w.close());
afterAll(() => stopServer());

const launch = async (issue = "ABC-7", extra: string[] = []) => {
  const r = await loop(w, ["launch", "one-shot", issue, "--cwd", w.repo, "--model", "sonnet", ...extra]);
  expect(r.rc).toBe(0);
};

describe("eris loop stop", () => {
  it("stops the session, releases its claim (aborted) and moves an In Progress issue back to Todo", async () => {
    /** When stop leaves the claim held or the issue In Progress, the issue reads as worked by a loop that is gone, and no relaunch can claim it: observed on the receipt, the job's state, the gateway's claim and the issue's state. */
    await launch();
    expect(w.issues.get("ABC-7")!.state.name).toBe("In Progress");
    const r = await loop(w, ["stop", "abc-7"]);
    expect(r).toEqual({ rc: 0, stdout: "stopped ABC-7 → loop one-shot · job00001\n", stderr: "" });
    expect(w.job("job00001").state).toBe("stopped");
    expect(w.claims.has("ABC-7")).toBe(false);
    expect(w.seen.find((s) => s.path.endsWith("/release"))!.body).toMatchObject({ outcome: "aborted" });
    expect(readClaim(w.home, "ABC-7")).toBeNull();
    expect(w.issues.get("ABC-7")!.state).toEqual({ name: "Todo", type: "unstarted" });
  });

  it("leaves an issue in review standing, and touches no claim another session holds", async () => {
    /** When stop moves an In Review issue back to Todo, or releases a claim bound to another session, it undoes a builder's hand-off: observed on the issue's state and the gateway's claim. */
    await launch();
    w.issues.get("ABC-7")!.state = { name: "In Review", type: "started" };
    expect((await loop(w, ["stop", "job00001"])).rc).toBe(0);
    expect(w.issues.get("ABC-7")!.state.name).toBe("In Review");

    await launch("ABC-8");
    await loop(w, ["launch", "fixer", "ABC-8", "--cwd", w.repo, "--model", "sonnet", "--unclaimed"]);
    const held = w.claims.get("ABC-8")!.claimId;
    expect((await loop(w, ["stop", "eris-loop-fixer-abc-8"])).stdout).toBe("stopped ABC-8 → loop fixer · job00003\n");
    expect(w.claims.get("ABC-8")!.claimId).toBe(held);
  });

  it("refuses a ref that names no session, and one that names several", async () => {
    /** When an unknown or ambiguous ref stops a session anyway, the operator stops the wrong loop: observed on the slugs. */
    const none = await loop(w, ["stop", "ABC-9"]);
    expect([none.rc, slugOf(none.stderr)]).toEqual([2, "loop-session-not-found"]);
    await launch();
    await loop(w, ["launch", "fixer", "ABC-7", "--cwd", w.repo, "--model", "sonnet", "--unclaimed"]);
    const two = await loop(w, ["stop", "ABC-7"]);
    expect([two.rc, slugOf(two.stderr)]).toEqual([2, "loop-session-ambiguous"]);
    expect(w.job("job00001").state).toBe("working");
  });
});

describe("eris loop resume", () => {
  it("re-binds the claim this session holds to the resumed session, and tells it the claim again", async () => {
    /** When a resume reserves anew although its own claim is held (or does not re-bind it), the claim is held by a dead session or refused by itself: observed on the claim requests, the ledger and the continuation prompt. */
    await launch();
    w.setJob("job00001", { state: "done" });
    const claimId = readClaim(w.home, "ABC-7")!.claim_id;
    w.seen.length = 0;
    const r = await loop(w, ["resume", "ABC-7", "--prompt", "Carry on."]);
    expect(r).toEqual({ rc: 0, stdout: "resumed ABC-7 → loop one-shot · job00002\n", stderr: "" });
    expect(w.seen.map((s) => [s.path, (s.body as { claim_id?: string; session_id?: string }).session_id])).toEqual([["/v1/linear/issues/ABC-7/claim", "job00002"]]);
    expect(readClaim(w.home, "ABC-7")).toMatchObject({ claim_id: claimId, session_id: "job00002" });
    const resumed = w.calls().at(-1)!;
    expect(resumed.slice(0, 3)).toEqual(["--bg", "--resume", "sess-job00001"]);
    expect(resumed[3]).toStartWith(`Carry on.\nClaim: ${claimId} `);
  });

  it("reserves a fresh claim when this machine holds none, and refuses while another loop holds the issue", async () => {
    /** When a resume runs with no claim, or over another loop's, two loops work one issue: observed on the slug, the spawn log and the reserved claim. */
    await launch();
    w.setJob("job00001", { state: "failed" });
    const other = { claimId: "other-claim-01", loop: "fixer", runtime: "claude", session_id: null, agent_session_id: null };
    w.claims.set("ABC-7", other);
    const { rmSync } = await import("node:fs");
    const { claimPath } = await import("../plugins/loop/claims");
    rmSync(claimPath(w.home, "ABC-7"));
    const refused = await loop(w, ["resume", "job00001"]);
    expect([refused.rc, slugOf(refused.stderr)]).toEqual([3, "linear-issue-claimed"]);
    expect(w.calls()).toHaveLength(1);
    w.claims.delete("ABC-7");
    const ok = await loop(w, ["resume", "job00001"]);
    expect(ok.rc).toBe(0);
    expect(readClaim(w.home, "ABC-7")).toMatchObject({ session_id: "job00002" });
    expect(w.claims.get("ABC-7")!.session_id).toBe("job00002");
  });

  it("refuses a working session, and with --all resumes each failed loop session on an open issue", async () => {
    /** When a working session is resumed, two runtimes drive one session; when --all resumes a loop whose issue closed, it reopens finished work: observed on the slug, the receipts and the spawn log. */
    await launch();
    const working = await loop(w, ["resume", "ABC-7"]);
    expect([working.rc, slugOf(working.stderr)]).toEqual([2, "loop-usage"]);
    await launch("ABC-8");
    w.setJob("job00001", { state: "failed" });
    w.setJob("job00002", { state: "failed" });
    w.issues.get("ABC-8")!.state = { name: "Done", type: "completed" };
    const all = await loop(w, ["resume", "--all"], { format: "json" });
    expect([all.rc, JSON.parse(all.stdout)]).toEqual([0, { lines: ["resumed ABC-7 → loop one-shot · job00003"] }]);
  });
});
