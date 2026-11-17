/**
 * `eris loop launch` (plugins/loop/launch.ts): claim the issue on the gateway, read the loop's body
 * from the org's verified tree (pulled when the claim names a newer one), start it as a `claude --bg`
 * session, bind the claim to that session, and move the issue and its unstarted parent to In Progress.
 *
 * The seam is the loop handler through the build's own wiring, over the loopback gateway, the
 * sandbox HOME and the fake `claude` of tests/helpers/loop-fixture.ts: every request crosses real
 * HTTP and every session is a real child process that writes a real job file.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readClaim } from "../plugins/loop/claims";
import { BUNDLE, LOGIN, loop, loopWorld, type LoopWorld, slugOf, stopServer } from "./helpers/loop-fixture";

setDefaultTimeout(60_000);

let w: LoopWorld;
beforeEach(async () => {
  w = await loopWorld();
  w.issues.set("ABC-7", { state: { name: "Todo", type: "unstarted" }, parent: "ABC-1" });
  w.issues.set("ABC-1", { state: { name: "Backlog", type: "backlog" } });
});
afterEach(() => w.close());
afterAll(() => stopServer());

const launch = (extra: string[] = [], o: Parameters<typeof loop>[2] = {}) => loop(w, ["launch", "one-shot", "abc-7", "--cwd", w.repo, "--model", "sonnet", ...extra], o);
const loginUrl = () => (JSON.parse(readFileSync(join(w.home, ".eris", "yaks.json"), "utf8")) as { url: string }).url;
const paths = () => w.seen.map((s) => `${s.method} ${s.path}`);

describe("eris loop launch", () => {
  it("claims, pulls, spawns in --cwd, binds the claim to the session, starts the issue and its parent, and prints the receipt", async () => {
    /** When any step of the launch is skipped or reordered, a session runs unclaimed, from a stale body, in the wrong directory, or with a claim no hand-back can release: observed on the receipt, the gateway's requests and claim, the claude argv and the ledger. */
    const r = await launch(["--context", "one line", "--report-to", "abc-2"], { env: { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" } });
    expect(r).toEqual({ rc: 0, stdout: "delegated ABC-7 → loop one-shot · job00001 · model sonnet\n", stderr: "" });
    const record = readClaim(w.home, "ABC-7")!;
    expect(record).toMatchObject({ issue: "ABC-7", loop: "one-shot", runtime: "claude", session_id: "job00001" });
    expect(w.claims.get("ABC-7")).toMatchObject({ claimId: record.claim_id, loop: "one-shot", session_id: "job00001" });
    expect(paths()).toEqual([
      "POST /v1/linear/issues/ABC-7/claim",
      expect.stringMatching(/^GET \/v1\/gates\/(policy|settings)$/),
      expect.stringMatching(/^GET \/v1\/gates\/(policy|settings)$/),
      "POST /v1/linear/issues/ABC-7/claim",
      "GET /v1/linear/issues/ABC-7",
      "POST /v1/linear/issues/ABC-7/transition",
      "POST /v1/linear/issues/ABC-1/transition",
    ]);
    expect(w.issues.get("ABC-7")!.state).toEqual({ name: "In Progress", type: "started" });
    expect(w.issues.get("ABC-1")!.state).toEqual({ name: "In Progress", type: "started" });
    const [call] = w.calls();
    expect(call!.slice(0, 1)).toEqual(["--bg"]);
    expect(call!.slice(2)).toEqual(["--name", "eris-loop-one-shot-abc-7", "--model", "sonnet"]);
    expect(call![1]).toStartWith("Loop one-shot · target issue ABC-7\nReport to: ABC-2");
    expect(call![1]).toContain(`\nContext: one line\nClaim: ${record.claim_id} `);
    expect(call![1]).toEndWith(`\n\n${BUNDLE.loops!["one-shot"]}`);
    expect(w.childEnvs()).toEqual([{ cwd: w.repo, CLAUDECODE: null, CLAUDE_CODE_ENTRYPOINT: null, ERIS_YAKS_TOKEN: null }]);
  });

  it("keeps eris's bearer out of the session's env, and prints the launch as JSON", async () => {
    /** When a loop child inherits ERIS_YAKS_TOKEN, every tool the session runs holds the org's bearer: observed on the fake claude's env; the JSON row is the machine surface. */
    const r = await launch([], { format: "json", env: { ERIS_YAKS_TOKEN: LOGIN, ERIS_YAKS_URL: loginUrl() } });
    expect(r.rc).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(out).toEqual({ issue: "ABC-7", slug: "one-shot", session: "job00001", runtime: "claude", model: "sonnet", claimId: readClaim(w.home, "ABC-7")!.claim_id });
    expect(w.childEnvs()[0]!.ERIS_YAKS_TOKEN).toBeNull();
  });

  it("refuses every bad operand before any request or spawn", async () => {
    /** When an operand is checked after the claim, a typo leaves the issue claimed and moved with no session working it: observed on the slug and the empty request and spawn logs. */
    for (const args of [
      ["launch", "one-shot", "abc-7", "--cwd", "repo", "--model", "sonnet"],
      ["launch", "one-shot", "abc-7", "--cwd", w.repo],
      ["launch", "../x", "abc-7", "--cwd", w.repo, "--model", "sonnet"],
      ["launch", "one-shot", "seven", "--cwd", w.repo, "--model", "sonnet"],
      ["launch", "one-shot", "abc-7", "--cwd", w.home, "--model", "sonnet"],
    ]) {
      const r = await loop(w, args);
      expect([args.join(" "), r.rc, slugOf(r.stderr), r.stdout]).toEqual([args.join(" "), 2, "loop-usage", ""]);
    }
    const noClaude = await launch([], { env: { PATH: "/nonexistent" } });
    expect([noClaude.rc, slugOf(noClaude.stderr)]).toEqual([2, "loop-usage"]);
    expect(w.seen).toEqual([]);
    expect(w.calls()).toEqual([]);
  });

  it("releases the claim (aborted, with the reason) when anything after the reserve fails", async () => {
    /** When a failed spawn or an unknown loop leaves the reservation held, the issue stays claimed by no one until the gateway's expiry and every relaunch is refused: observed on the gateway's claim, the release body and the ledger. */
    const failed = await launch([], { env: { FAKE_CLAUDE_FAIL: "1" } });
    expect([failed.rc, slugOf(failed.stderr), failed.stdout]).toEqual([1, "loop-launch-failed", ""]);
    expect(failed.stderr).toContain("the daemon is down");
    expect(w.claims.has("ABC-7")).toBe(false);
    const release = w.seen.find((s) => s.path.endsWith("/release"))!;
    expect(release.body).toMatchObject({ outcome: "aborted", body: expect.stringContaining("the daemon is down") });
    expect(readdirSync(join(w.home, ".eris", "loop", "claims"))).toEqual([]);
    expect(w.issues.get("ABC-7")!.state.type).toBe("unstarted");

    w.seen.length = 0;
    const unknown = await loop(w, ["launch", "nope", "ABC-7", "--cwd", w.repo, "--model", "sonnet"]);
    expect([unknown.rc, slugOf(unknown.stderr)]).toEqual([2, "loop-unknown"]);
    expect(w.claims.has("ABC-7")).toBe(false);
    expect(paths().at(-1)).toBe("POST /v1/linear/issues/ABC-7/release");
  });

  it("refuses an issue another loop holds, spawning nothing", async () => {
    /** When a second launch on a claimed issue goes ahead, two loops work one issue and each overwrites the other's tracker state: observed on the slug, the holder in the block and the spawn log. */
    w.claims.set("ABC-7", { claimId: "other-claim-01", loop: "fixer", runtime: "claude", session_id: "job99999", agent_session_id: null });
    const r = await launch();
    expect([r.rc, slugOf(r.stderr), r.stdout]).toEqual([3, "linear-issue-claimed", ""]);
    expect(r.stderr).toContain("loop fixer");
    expect(w.calls()).toEqual([]);
    expect(w.claims.get("ABC-7")!.claimId).toBe("other-claim-01");
  });

  it("refuses beside a live local session, and with --force releases this machine's prior claim before reserving anew", async () => {
    /** When the live check is skipped, or --force reserves without releasing the prior claim, a relaunch is refused by its own predecessor's claim or leaves it held: observed on the slug, the release of the prior id and the new ledger entry. */
    expect((await launch()).rc).toBe(0);
    const prior = readClaim(w.home, "ABC-7")!.claim_id;
    const again = await launch();
    expect([again.rc, slugOf(again.stderr)]).toEqual([2, "loop-usage"]);
    expect(again.stderr).toContain("job00001");
    w.seen.length = 0;
    const forced = await launch(["--force"]);
    expect(forced.rc).toBe(0);
    expect(w.seen[0]).toMatchObject({ path: "/v1/linear/issues/ABC-7/release", body: { claim_id: prior, outcome: "aborted" } });
    const now = readClaim(w.home, "ABC-7")!;
    expect(now.claim_id).not.toBe(prior);
    expect(now.session_id).toBe("job00002");
  });

  it("pulls the org's policy first when the claim names a newer bundle, and runs the newer body", async () => {
    /** When a launch reads the local tree although the claim's reply names another bundle, the session starts from a body the org has since changed: observed on the prompt's body and the policy reads. */
    expect((await loop(w, ["list"])).rc).toBe(0);
    await w.setBundle({ ...BUNDLE, loops: { ...BUNDLE.loops, "one-shot": "# One shot, revised\n" } });
    w.seen.length = 0;
    expect((await launch()).rc).toBe(0);
    expect(paths().filter((p) => p.startsWith("GET /v1/gates/"))).toHaveLength(2);
    expect(w.calls()[0]![1]).toEndWith("\n\n# One shot, revised\n");
  });

  it("with --unclaimed takes no claim and moves no state", async () => {
    /** When an unclaimed follow-on loop claims or moves the issue, it reverts the state of the loop that owns the issue: observed on the gateway's requests and the prompt. */
    const r = await launch(["--unclaimed"]);
    expect(r).toEqual({ rc: 0, stdout: "delegated ABC-7 → loop one-shot · job00001 · model sonnet\n", stderr: "" });
    expect(paths().filter((p) => p.includes("/v1/linear/"))).toEqual([]);
    expect(w.calls()[0]![1]).not.toContain("\nClaim: ");
    expect(readdirSync(join(w.home, ".eris")).includes("loop")).toBe(false);
  });

  it("never reopens a closed issue, and warns (exit 0) when a state move fails", async () => {
    /** When a launch moves a closed issue back to In Progress, a follow-on loop reopens finished work; when a failed move fails the launch, a running session is reported as not started: observed on the issue's state, the exit and the WARN. */
    w.issues.set("ABC-7", { state: { name: "Done", type: "completed" }, parent: "ABC-1" });
    w.refuse.set("POST /v1/linear/issues/ABC-1/transition", () => Response.json({ type: "about:blank", status: 404, code: "state_not_found" }, { status: 404 }));
    const r = await launch();
    expect(r.rc).toBe(0);
    expect(w.issues.get("ABC-7")!.state.type).toBe("completed");
    expect(r.stderr).toContain("WARN eris loop: could not move ABC-1 to In Progress: linear-state-not-found");
  });
});
