/**
 * `eris loop reap` (plugins/loop/reap.ts, reap-worktrees.ts): stop finished loop sessions, release
 * their claims and orphaned reservations, and remove finished worktrees.
 *
 * The seam is the loop handler over the loopback gateway, sandbox HOME and fake `claude` of
 * tests/helpers/loop-fixture.ts, with real git repositories and worktrees under the gitignored
 * `data/scratch/`. `gh` and `lsof` are pinned by fakes on PATH (`gh` lists no pull request; `lsof`
 * reports the one directory a test names as some process's cwd), so neither branch depends on the
 * machine.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimPath, readClaim, writeClaim } from "../plugins/loop/claims";
import { loop, loopWorld, type LoopWorld, slugOf, stopServer } from "./helpers/loop-fixture";

setDefaultTimeout(60_000);

let w: LoopWorld;
let wt: (name: string) => string;

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

beforeEach(async () => {
  w = await loopWorld();
  wt = (name) => join(w.dir, name);
  const bin = join(w.dir, "bin");
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho '[]'\n", { mode: 0o755 });
  writeFileSync(join(bin, "lsof"), '#!/bin/sh\n[ -n "$FAKE_LSOF_CWD" ] && echo "n$FAKE_LSOF_CWD"\nexit 0\n', { mode: 0o755 });
  git(w.repo, "init", "-q");
  writeFileSync(join(w.repo, "a.txt"), "a\n");
  git(w.repo, "add", "a.txt");
  git(w.repo, "commit", "-qm", "init");
  git(w.repo, "worktree", "add", "-q", wt("wt-merged"), "-b", "merged");
  git(w.repo, "worktree", "add", "-q", wt("wt-dirty"), "-b", "dirty");
  writeFileSync(join(wt("wt-dirty"), "scratch.txt"), "uncommitted\n");
  git(w.repo, "worktree", "add", "-q", wt("wt-unmerged"), "-b", "unmerged");
  writeFileSync(join(wt("wt-unmerged"), "b.txt"), "b\n");
  git(wt("wt-unmerged"), "add", "b.txt");
  git(wt("wt-unmerged"), "commit", "-qm", "work");
  git(w.repo, "worktree", "add", "-q", wt("wt-busy"), "-b", "busy");
  git(w.repo, "worktree", "add", "-q", wt("wt-gone"), "-b", "gone");
  rmSync(wt("wt-gone"), { recursive: true, force: true });
  w.issues.set("ABC-7", { state: { name: "Todo", type: "unstarted" } });
  w.issues.set("ABC-8", { state: { name: "Todo", type: "unstarted" } });
  w.issues.set("ABC-9", { state: { name: "Todo", type: "unstarted" } });
});
afterEach(() => w.close());
afterAll(() => stopServer());

const worktrees = () =>
  git(w.repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));

/** A finished loop on ABC-7 (its claim bound), a working one on ABC-8 inside wt-unmerged, and two unbound reservations: one stale, one fresh. */
async function sessions() {
  expect((await loop(w, ["launch", "one-shot", "ABC-7", "--cwd", w.repo, "--model", "sonnet"])).rc).toBe(0);
  expect((await loop(w, ["launch", "one-shot", "ABC-8", "--cwd", wt("wt-unmerged"), "--model", "sonnet"])).rc).toBe(0);
  w.setJob("job00001", { state: "done" });
  w.claims.set("ABC-9", { claimId: "stale-reserve-01", loop: "fixer", runtime: "claude", session_id: null, agent_session_id: null });
  writeClaim(w.home, { issue: "ABC-9", claim_id: "stale-reserve-01", loop: "fixer", runtime: "claude", session_id: null, claimed_at: "2026-11-17T11:40:00+00:00" });
  w.issues.set("ABC-10", { state: { name: "Todo", type: "unstarted" } });
  writeClaim(w.home, { issue: "ABC-10", claim_id: "fresh-reserve-1", loop: "fixer", runtime: "claude", session_id: null, claimed_at: "2026-11-17T11:55:00+00:00" });
}

describe("eris loop reap", () => {
  it("with --dry-run prints what it would do and changes nothing", async () => {
    /** When --dry-run stops, releases, removes or prunes anything, an operator previewing a reap loses work: observed on the job states, the gateway's claims, the ledger and the worktree list. */
    await sessions();
    const before = worktrees();
    w.seen.length = 0;
    const r = await loop(w, ["reap", "--dry-run", "--repo", w.repo], { env: { FAKE_LSOF_CWD: wt("wt-busy") } });
    expect(r.rc).toBe(0);
    expect(r.stdout).toContain(`dry-run: stop session job00001 (eris-loop-one-shot-abc-7, done)\n`);
    expect(r.stdout).toContain("dry-run: release claim stale-re on ABC-9 (its launch never bound a session)\n");
    expect(r.stdout).toContain(`dry-run: remove worktree ${wt("wt-merged")} (merged, on-main)\n`);
    expect(w.job("job00001").state).toBe("done");
    expect(w.seen.filter((s) => s.method === "POST")).toEqual([]);
    expect(readClaim(w.home, "ABC-9")).not.toBeNull();
    expect(worktrees()).toEqual(before);
    expect(existsSync(wt("wt-merged"))).toBe(true);
  });

  it("stops finished loops, releases their claims and stale reservations, and removes only clean, idle, merged worktrees", async () => {
    /** When reap removes a dirty, busy, working or unmerged worktree, or releases a live loop's claim or a fresh reservation, it destroys work or frees an issue a launch is about to bind: observed on every kept tree, the gateway's claims, the ledger and the summary. */
    await sessions();
    const r = await loop(w, ["reap", "--repo", w.repo], { env: { FAKE_LSOF_CWD: wt("wt-busy") } });
    expect(r.rc).toBe(0);
    expect(w.job("job00001").state).toBe("stopped");
    expect(w.job("job00002").state).toBe("working");
    expect(w.claims.has("ABC-7")).toBe(false);
    expect(w.claims.has("ABC-9")).toBe(false);
    expect(w.claims.has("ABC-8")).toBe(true);
    expect(readClaim(w.home, "ABC-10")).not.toBeNull();
    expect(existsSync(wt("wt-merged"))).toBe(false);
    for (const kept of ["wt-dirty", "wt-unmerged", "wt-busy"]) expect([kept, existsSync(wt(kept))]).toEqual([kept, true]);
    expect(worktrees().map((p) => p.split("/").pop()).sort()).toEqual(["repo", "wt-busy", "wt-dirty", "wt-unmerged"]);
    expect(r.stdout.trimEnd().split("\n").at(-1)).toBe(
      "reap: sessions stopped=1 failed=0 kept_working=1 · worktrees removed=1 failed=0 pruned_missing=1 kept_dirty=1 kept_open_pr=0 kept_busy=1 kept_working_loop=1 kept_unmerged=0 · claims released=2 failed=0",
    );
  });

  it("releases no session-bound claim when the session listing cannot be read", async () => {
    /** When an unreadable `claude agents` reads as "no sessions", reap frees the claim of every loop still working: observed on the gateway's claims. */
    await sessions();
    const r = await loop(w, ["reap", "--repo", w.repo], { env: { FAKE_CLAUDE_AGENTS_FAIL: "1" } });
    expect(r.rc).toBe(0);
    expect(w.claims.has("ABC-7")).toBe(true);
    expect(w.claims.has("ABC-8")).toBe(true);
    expect(w.claims.has("ABC-9")).toBe(false);
  });

  it("refuses a --repo that is not an absolute directory before any child runs", async () => {
    /** When a bad --repo is checked late, reap has already stopped sessions and released claims on a command line the operator mistyped: observed on the slug and the empty spawn log. */
    mkdirSync(join(w.dir, "x"));
    const r = await loop(w, ["reap", "--repo", "x"]);
    expect([r.rc, slugOf(r.stderr)]).toEqual([2, "loop-usage"]);
    expect(w.calls()).toEqual([]);
    expect(existsSync(claimPath(w.home, "ABC-9"))).toBe(false);
  });
});
