/**
 * `eris loop status` (plugins/loop/status.ts): a session's state, detail, claim, in-flight calls and
 * newest message, read from its job directory and the claim ledger.
 *
 * The seam is the loop handler over the sandbox HOME and fake `claude` of
 * tests/helpers/loop-fixture.ts; the session is launched through the real `launch`, then its job file
 * is given the fields a running Claude Code job writes.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readClaim } from "../plugins/loop/claims";
import { loop, loopWorld, type LoopWorld, slugOf, stopServer } from "./helpers/loop-fixture";

setDefaultTimeout(60_000);

const NOW = Date.parse("2026-11-17T12:00:00Z");
let w: LoopWorld;
beforeEach(async () => {
  w = await loopWorld();
  w.issues.set("ABC-7", { state: { name: "Todo", type: "unstarted" } });
  expect((await loop(w, ["launch", "one-shot", "ABC-7", "--cwd", w.repo, "--model", "sonnet"])).rc).toBe(0);
});
afterEach(() => w.close());
afterAll(() => stopServer());

describe("eris loop status", () => {
  it("prints the state, detail, claim, each in-flight call (flagging one past the budget) and the newest message", async () => {
    /** When status drops the claim line or misses a call running past its budget, an operator cannot tell a stalled loop from a working one, or which claim to release: observed on the whole text. */
    const jobDir = join(w.home, ".claude", "jobs", "job00001");
    w.setJob("job00001", {
      detail: "running the tests",
      fan: [
        { kind: "Bash", label: "bun test ./tests", startedAt: (NOW - 30 * 60_000) / 1000 },
        { kind: "Read", label: "a file", startedAt: (NOW - 5_000) / 1000, doneAt: (NOW - 1_000) / 1000 },
      ],
    });
    writeFileSync(join(jobDir, "timeline.jsonl"), `${JSON.stringify({ text: "older" })}\nnot json\n${JSON.stringify({ text: "Running the suite." })}\n`);
    const claim = readClaim(w.home, "ABC-7")!;
    const r = await loop(w, ["status", "ABC-7"]);
    expect(r).toEqual({
      rc: 0,
      stdout: [
        "job00001 · eris-loop-one-shot-abc-7 · working",
        "detail: running the tests",
        `claim: ${claim.claim_id.slice(0, 8)} · ABC-7 · session job00001 · since 2026-11-17T12:00:00+00:00`,
        "in-flight: Bash (30m 0s): bun test ./tests",
        "stalled: Bash running 30m (exceeds 25m budget): bun test ./tests",
        "",
        "last message:",
        "Running the suite.",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  it("shows the one working session when a ref names several, lists the rest, and refuses two working ones", async () => {
    /** When status picks an arbitrary match, an operator reads a finished session's state as the live one's: observed on the first line and the also: line; two working sessions refuse. */
    w.setJob("job00001", { state: "done" });
    expect((await loop(w, ["launch", "fixer", "ABC-7", "--cwd", w.repo, "--model", "sonnet", "--unclaimed"])).rc).toBe(0);
    const r = await loop(w, ["status", "ABC-7"]);
    expect(r.stdout.split("\n").slice(0, 1)).toEqual(["job00002 · eris-loop-fixer-abc-7 · working"]);
    expect(r.stdout).toContain("\nalso: job00001 done\n");
    w.setJob("job00001", { state: "working" });
    const two = await loop(w, ["status", "ABC-7"]);
    expect([two.rc, slugOf(two.stderr)]).toEqual([2, "loop-session-ambiguous"]);
    const none = await loop(w, ["status", "ABC-9"]);
    expect([none.rc, slugOf(none.stderr)]).toEqual([2, "loop-session-not-found"]);
  });

  // admits: boundary-io: idle-stall detection combines wall-clock elapsed time, state.json timestamps and claude agents --json subprocess output; positive stall and all negative branches (busy, unreadable listing, under threshold, done) are pinned together.
  it("flags a working job idle in claude agents past 10m as stalled, and emits no stall otherwise", async () => {
    /** When a resumed Claude session idles forever while state.json still says working, only `claude agents --json` exposes the stall; when busy, unreadable, below 10m or finished, a false stall misleads operators into stopping live work: observed on the stalled: lines of status stdout. */
    const MIN = 60_000;
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    const stalledLines = async (env: Record<string, string | undefined> = {}) => {
      const r = await loop(w, ["status", "ABC-7"], { env });
      expect(r.rc).toBe(0);
      return r.stdout.split("\n").filter((l) => l.startsWith("stalled:"));
    };

    w.setJob("job00001", { state: "working", status: "idle", updatedAt: at(11 * MIN), fan: [{ kind: "Bash", label: "ci", startedAt: (NOW - 11 * MIN) / 1000 }] });
    const stalled = await stalledLines();
    expect(stalled).toHaveLength(1);
    expect(stalled[0]).toContain("idle for 11m while state.json says working");

    w.setJob("job00001", { status: "busy" });
    expect(await stalledLines()).toEqual([]);

    w.setJob("job00001", { status: "idle" });
    expect(await stalledLines({ FAKE_CLAUDE_AGENTS_FAIL: "1" })).toEqual([]);

    w.setJob("job00001", { updatedAt: at(2 * MIN) });
    expect(await stalledLines()).toEqual([]);

    w.setJob("job00001", { state: "done", updatedAt: at(30 * MIN) });
    expect(await stalledLines()).toEqual([]);
  });
});
