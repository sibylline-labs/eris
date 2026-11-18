/**
 * The loop plugin's distribution seams (plugins/loop/index.ts `LoopDefaults`, docs/LOOP.md#distribution-seams):
 * a supplied runtime, prompt lines, legacy session names and ledger directories, claimless loops, the
 * extra env scrub and the after-hand-back hook. Each seam left out is held by the unchanged
 * tests/loop-*.test.ts; these drive each one supplied.
 *
 * The seam is the loop handler with a build's defaults, over the loopback gateway, sandbox HOME and
 * fake `claude` of tests/helpers/loop-fixture.ts. The supplied runtime is an in-process fake that keeps
 * its sessions in a map and records every call, so what crosses the seam is observed directly.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOOP_DEFAULTS } from "../plugins/index";
import type { LoopDefaults } from "../plugins/loop";
import { readClaim } from "../plugins/loop/claims";
import { LoopFailure } from "../plugins/loop/failure";
import { loopOf } from "../plugins/loop/names";
import type { LoopRuntime, LoopRuntimeEnv, LoopRuntimeSession } from "../plugins/loop/runtime";
import { launchLoopSession } from "../src/sdk";
import { BUNDLE, loop, loopWorld, type LoopWorld, REPO, slugOf, stopServer } from "./helpers/loop-fixture";

setDefaultTimeout(60_000);

let w: LoopWorld;
beforeEach(async () => {
  w = await loopWorld();
  w.issues.set("ABC-7", { state: { name: "Todo", type: "unstarted" } });
  w.issues.set("ABC-2", { state: { name: "Todo", type: "unstarted" } });
});
afterEach(() => w.close());
afterAll(() => stopServer());

const paths = () => w.seen.map((s) => `${s.method} ${s.path}`);

interface FakeRuntime extends LoopRuntime {
  readonly sessions: Map<string, LoopRuntimeSession>;
  readonly calls: Array<{ readonly op: string; readonly arg: unknown; readonly env: LoopRuntimeEnv }>;
}

/** A second runtime: sessions in a map, every call recorded with the env it was handed. */
function fakeRuntime(): FakeRuntime {
  const sessions = new Map<string, LoopRuntimeSession>();
  const calls: FakeRuntime["calls"] = [];
  let n = 0;
  const loops = (pred: (s: LoopRuntimeSession) => boolean) => [...sessions.values()].filter(pred);
  return {
    sessions,
    calls,
    flags: [{ name: "--pool", takesValue: true }],
    prepare: async (env, input) => {
      calls.push({ op: "prepare", arg: input, env });
      if (input.flags["--pool"] === "nope") throw new LoopFailure({ slug: "loop-usage", what: "--pool nope is not a pool", fix: "Name a pool.", docs: "docs/ERRORS.md#loop-usage", exit: 2 });
      return { model: input.model ?? "" };
    },
    spawn: async (env, input) => {
      calls.push({ op: "spawn", arg: input, env });
      const id = `rt-${++n}`;
      sessions.set(id, { id, name: input.name, state: "working", updatedAt: n });
      return id;
    },
    live: async (env, issue, slug) => {
      calls.push({ op: "live", arg: { issue, slug }, env });
      return loops((s) => s.state === "working" && loopOf(s.name, [])?.issue === issue && (slug === undefined || loopOf(s.name, [])?.slug === slug)).map((s) => `${s.id} · ${s.name} · ${s.state}`);
    },
    find: async (env, ref) => {
      calls.push({ op: "find", arg: ref, env });
      return loops((s) => s.id === ref || s.name === ref || loopOf(s.name, [])?.issue === ref.toUpperCase());
    },
    stop: async (env, s) => {
      calls.push({ op: "stop", arg: s.id, env });
      sessions.set(s.id, { ...s, state: "stopped" });
    },
    resume: async (env, s, prompt) => {
      calls.push({ op: "resume", arg: { id: s.id, prompt }, env });
      const id = `rt-${++n}`;
      sessions.set(id, { id, name: s.name, state: "working", updatedAt: n });
      return id;
    },
    failed: async (env) => {
      calls.push({ op: "failed", arg: null, env });
      return loops((s) => s.state === "failed");
    },
    status: async (env, s, lines) => {
      calls.push({ op: "status", arg: lines, env });
      return `${s.id} · ${s.name} · ${s.state}${lines.claim !== null ? `\nclaim: ${lines.claim}` : ""}`;
    },
    working: (s) => s.state === "working",
  };
}

const withRuntime = (rt: LoopRuntime, extra: Partial<LoopDefaults> = {}): LoopDefaults => ({ ...LOOP_DEFAULTS, runtimes: { second: rt }, ...extra });
const ops = (rt: FakeRuntime) => rt.calls.map((c) => c.op);

describe("a supplied runtime", () => {
  // admits: integration: when launch, status or stop ignores --runtime or skips the owning runtime, a second-runtime loop runs as a Claude job (or not at all), holds a claim no stop can name, and leaves its issue In Progress; observed across the real verbs, ledger and loopback gateway, which no type sees.
  it("launches through it, records it on the claim, shows its status and stops it, releasing the claim", async () => {
    /** When a verb never dispatches to the owning runtime, a second-runtime loop cannot be started, read or stopped through eris: observed on the receipt, the fake's calls, the ledger, the gateway's claim and the issue's state. */
    const rt = fakeRuntime();
    const defaults = withRuntime(rt);
    const r = await loop(w, ["launch", "one-shot", "ABC-7", "--cwd", w.repo, "--model", "big", "--runtime", "second", "--pool", "p1"], { defaults });
    expect(r).toEqual({ rc: 0, stdout: "delegated ABC-7 → loop one-shot · rt-1 · model big\n", stderr: "" });
    expect(w.calls()).toEqual([]);
    expect(rt.calls.find((c) => c.op === "spawn")!.arg).toMatchObject({ name: "eris-loop-one-shot-abc-7", cwd: w.repo, model: "big", flags: { "--pool": "p1" } });
    expect(readClaim(w.home, "ABC-7")).toMatchObject({ runtime: "second", session_id: "rt-1" });
    expect(w.claims.get("ABC-7")).toMatchObject({ runtime: "second", session_id: "rt-1" });

    const status = await loop(w, ["status", "abc-7"], { defaults });
    const claim = readClaim(w.home, "ABC-7")!;
    expect(status).toEqual({ rc: 0, stdout: `rt-1 · eris-loop-one-shot-abc-7 · working\nclaim: ${claim.claim_id.slice(0, 8)} · ABC-7 · session rt-1 · since 2026-11-17T12:00:00+00:00\n`, stderr: "" });

    const stopped = await loop(w, ["stop", "ABC-7"], { defaults });
    expect(stopped).toEqual({ rc: 0, stdout: "stopped ABC-7 → loop one-shot · rt-1\n", stderr: "" });
    expect(rt.sessions.get("rt-1")!.state).toBe("stopped");
    expect(w.claims.has("ABC-7")).toBe(false);
    expect(readClaim(w.home, "ABC-7")).toBeNull();
    expect(w.issues.get("ABC-7")!.state.name).toBe("Todo");
  });

  // admits: integration: when the live check or resume skips a supplied runtime, a second loop is launched beside a working one, and a failed second-runtime loop is never resumed with its claim; observed across launch, resume and the ledger.
  it("counts its live sessions in the launch check, and resumes its sessions by ref and with --all", async () => {
    /** When the live check asks only Claude, two loops work one issue; when resume asks only Claude, a second-runtime loop can never continue holding its claim: observed on the refusal, the fake's resume prompt and the ledger. */
    const rt = fakeRuntime();
    const defaults = withRuntime(rt);
    expect((await loop(w, ["launch", "one-shot", "ABC-7", "--cwd", w.repo, "--runtime", "second"], { defaults })).rc).toBe(0);
    const beside = await loop(w, ["launch", "fixer", "ABC-7", "--cwd", w.repo, "--model", "sonnet"], { defaults });
    expect([beside.rc, slugOf(beside.stderr)]).toEqual([2, "loop-usage"]);
    expect(beside.stderr).toContain("rt-1 · eris-loop-one-shot-abc-7 · working");
    expect(w.calls()).toEqual([]);

    const claimId = readClaim(w.home, "ABC-7")!.claim_id;
    rt.sessions.set("rt-1", { ...rt.sessions.get("rt-1")!, state: "idle" });
    const resumed = await loop(w, ["resume", "rt-1", "--prompt", "Carry on."], { defaults });
    expect(resumed).toEqual({ rc: 0, stdout: "resumed ABC-7 → loop one-shot · rt-2\n", stderr: "" });
    expect((rt.calls.find((c) => c.op === "resume")!.arg as { prompt: string }).prompt).toStartWith(`Carry on.\nClaim: ${claimId} `);
    expect(readClaim(w.home, "ABC-7")).toMatchObject({ claim_id: claimId, runtime: "second", session_id: "rt-2" });

    rt.sessions.set("rt-2", { ...rt.sessions.get("rt-2")!, state: "failed" });
    const all = await loop(w, ["resume", "--all"], { defaults, format: "json" });
    expect([all.rc, JSON.parse(all.stdout)]).toEqual([0, { lines: ["resumed ABC-7 → loop one-shot · rt-3"] }]);
  });

  // admits: boundary-io: an argv value no type sees; when an unknown --runtime or a flag for another runtime gets past normalisation, the issue is claimed and moved before the launch fails; observed on the slug and the empty request, spawn and runtime logs.
  it("refuses an unknown --runtime, and a runtime's flag without that runtime, before any request or spawn", async () => {
    /** When --runtime or a runtime flag is checked after the claim, a typo leaves the issue claimed and In Progress with no session on it: observed on each refusal and on nothing having been requested, spawned or asked of the runtime. */
    const rt = fakeRuntime();
    const defaults = withRuntime(rt);
    const launch = (extra: string[], d?: LoopDefaults) => loop(w, ["launch", "one-shot", "ABC-7", "--cwd", w.repo, "--model", "sonnet", ...extra], d !== undefined ? { defaults: d } : {});
    for (const [extra, d] of [
      [["--runtime", "nope"], defaults],
      [["--runtime", "second"], undefined],
      [["--pool", "p1"], defaults],
      [["--runtime", "claude", "--pool", "p1"], defaults],
      [["--runtime", "second", "--pool", "nope"], defaults],
    ] as const) {
      const r = await launch([...extra], d);
      expect([extra.join(" "), r.rc, slugOf(r.stderr), r.stdout]).toEqual([extra.join(" "), 2, "loop-usage", ""]);
    }
    // A build that supplies no runtime has no such flag: the parser refuses it.
    const unknown = await launch(["--pool", "p1"]);
    expect([unknown.rc, unknown.stderr]).toEqual([1, expect.stringContaining("--pool")]);
    expect(w.seen).toEqual([]);
    expect(w.calls()).toEqual([]);
    expect(ops(rt)).toEqual(["prepare"]);
  });
});

describe("launchLoopSession", () => {
  // admits: integration: when the SDK's argv-free launch builds its run without the defaults it was handed, a distribution verb that starts a loop (a remediation, say) launches on the wrong runtime or refuses one the build supplies; observed on the returned record, the runtime's spawn and the ledger.
  it("launches as `loop launch` does, with the defaults and deps it is handed", async () => {
    /** When the lazy launch drops the build's defaults, a distribution's own verb cannot reach its runtime: observed on the Launched record and the fake's spawn. */
    const rt = fakeRuntime();
    const ctx = { erisDir: REPO, env: w.env, format: "text" as const, stdout: { write: () => true }, stderr: { write: () => true } };
    const input = { loop: "one-shot", issue: "ABC-7", cwd: w.repo, model: "big", reportTo: undefined, caller: undefined, context: undefined, force: false, unclaimed: false, runtime: "second" };
    const r = await launchLoopSession(ctx, withRuntime(rt), input, { home: w.home, cwd: w.repo, sleep: async () => undefined, now: () => Date.parse("2026-11-17T12:00:00Z") });
    expect(r).toEqual({ issue: "ABC-7", slug: "one-shot", session: "rt-1", runtime: "second", model: "big", claimId: readClaim(w.home, "ABC-7")!.claim_id });
    expect(ops(rt)).toContain("spawn");
  });
});

describe("legacy names and ledger directories", () => {
  const legacy: Partial<LoopDefaults> = { legacy: { sessionPrefixes: ["old-loop-"], claimDirs: (home) => [join(home, "old-claims")] } };
  const oldClaims = () => join(w.home, "old-claims");

  /** A working Claude job named with the legacy prefix, its claim held on the gateway and recorded only in the legacy ledger. */
  function legacyLoop(state: string) {
    const dir = join(w.home, ".claude", "jobs", "job00042");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ state, name: "old-loop-one-shot-abc-7", sessionId: "sess-job00042", cwd: w.repo }));
    mkdirSync(oldClaims(), { recursive: true, mode: 0o700 });
    writeFileSync(join(oldClaims(), "ABC-7.json"), JSON.stringify({ issue: "ABC-7", claim_id: "legacy-claim-01", loop: "one-shot", runtime: "claude", session_id: "job00042", claimed_at: "2026-11-17T11:00:00+00:00" }));
    w.claims.set("ABC-7", { claimId: "legacy-claim-01", loop: "one-shot", runtime: "claude", session_id: "job00042", agent_session_id: null });
  }

  // admits: boundary-io: session names and ledger files on disk under an older name; when status, the live check or stop reads only `eris-loop-` and `~/.eris/loop/claims`, a loop started under the older name is invisible, a second loop starts beside it and stop leaves its claim held; observed on the verbs' output, the gateway's claim and the legacy file.
  it("finds a legacy-named loop by its issue in status, the live check and stop, and releases its legacy claim", async () => {
    /** When a reader skips the legacy prefix or directory, the build loses every loop started before its rename: observed on the status text, the live-check refusal, the stop receipt, the gateway's claim and the legacy ledger file. */
    legacyLoop("working");
    const defaults = { ...LOOP_DEFAULTS, ...legacy };
    const unseen = await loop(w, ["status", "ABC-7"]);
    expect([unseen.rc, slugOf(unseen.stderr)]).toEqual([2, "loop-session-not-found"]);

    const status = await loop(w, ["status", "ABC-7"], { defaults });
    expect(status.stdout.split("\n").slice(0, 2)).toEqual(["job00042 · old-loop-one-shot-abc-7 · working", "claim: legacy-c · ABC-7 · session job00042 · since 2026-11-17T11:00:00+00:00"]);

    const beside = await loop(w, ["launch", "fixer", "ABC-7", "--cwd", w.repo, "--model", "sonnet"], { defaults });
    expect([beside.rc, slugOf(beside.stderr)]).toEqual([2, "loop-usage"]);
    expect(beside.stderr).toContain("job00042 · old-loop-one-shot-abc-7 · working");

    const stopped = await loop(w, ["stop", "ABC-7"], { defaults });
    expect(stopped).toEqual({ rc: 0, stdout: "stopped ABC-7 → loop one-shot · job00042\n", stderr: "" });
    expect(w.claims.has("ABC-7")).toBe(false);
    expect(existsSync(join(oldClaims(), "ABC-7.json"))).toBe(false);
    expect(existsSync(join(w.home, ".eris", "loop", "claims"))).toBe(false);
  });

  // admits: boundary-io: ledger files in two directories; when reap walks only the primary directory, a finished legacy loop's claim is held until the gateway's expiry; observed on the reap lines, the gateway's claim and the legacy file.
  it("reaps a finished legacy-named loop and releases its claim from the legacy directory", async () => {
    /** When reap reads only the primary ledger or the `eris-loop-` prefix, a finished loop from before a rename keeps its session running and its issue claimed: observed on the stopped job, the released claim and the drained legacy file. */
    legacyLoop("done");
    const bin = join(w.dir, "bin");
    writeFileSync(join(bin, "lsof"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(bin, "gh"), "#!/bin/sh\necho '[]'\n", { mode: 0o755 });
    const r = await loop(w, ["reap"], { defaults: { ...LOOP_DEFAULTS, ...legacy } });
    expect(r.rc).toBe(0);
    expect(r.stdout).toContain("stopped session job00042 (old-loop-one-shot-abc-7, done)\n");
    expect(r.stdout).toContain("released claim legacy-c on ABC-7 (its session job00042 is done)\n");
    expect(w.job("job00042").state).toBe("stopped");
    expect(w.claims.has("ABC-7")).toBe(false);
    expect(readdirSync(oldClaims())).toEqual([]);
  });
});

describe("prompt lines, claimless loops, the env scrub and the hand-back hook", () => {
  // admits: integration: when a build's prompt lines land before the Hand-back line, or a claimless slug still claims, the generic contract a loop parses moves or a review loop takes the issue from its builder; observed on the spawned prompt and the gateway's requests.
  it("puts the build's prompt lines after the Hand-back line, and launches a claimless loop with no claim", async () => {
    /** When the build's lines precede the Hand-back line, a loop's parser reads a house line where its contract was; when claimless is ignored, a reviewing loop claims and moves its builder's issue: observed on the prompt text, the promptLines input and the gateway's requests. */
    const seen: Array<{ claimId?: string | undefined; cwd: string }> = [];
    const defaults: LoopDefaults = {
      ...LOOP_DEFAULTS,
      claimless: ["fixer"],
      promptLines: (input) => {
        seen.push({ claimId: input.claimId, cwd: input.cwd });
        return ["House: one", "House: two"];
      },
    };
    expect((await loop(w, ["launch", "one-shot", "ABC-7", "--cwd", w.repo, "--model", "sonnet", "--report-to", "ABC-2"], { defaults })).rc).toBe(0);
    const claimId = readClaim(w.home, "ABC-7")!.claim_id;
    expect(w.calls()[0]![1]).toEndWith(
      `\nHand-back: post your hand-back once, with \`eris loop hand-back ABC-7 --claim ${claimId} --report-to ABC-2 < <file>\` (the body on stdin): it releases ABC-7's claim with the hand-back as its response, and comments wherever no claim holds.\nHouse: one\nHouse: two\n\n${BUNDLE.loops!["one-shot"]}`,
    );
    expect(seen).toEqual([{ claimId, cwd: w.repo }]);

    w.seen.length = 0;
    const r = await loop(w, ["launch", "fixer", "ABC-2", "--cwd", w.repo, "--model", "sonnet"], { defaults });
    expect(r).toEqual({ rc: 0, stdout: "delegated ABC-2 → loop fixer · job00002 · model sonnet\n", stderr: "" });
    expect(paths().filter((p) => p.includes("/v1/linear/"))).toEqual([]);
    expect(w.calls()[1]![1]).not.toContain("\nClaim: ");
    expect(readClaim(w.home, "ABC-2")).toBeNull();
  });

  // admits: boundary-io: a child process's inherited env; when the build's scrub list is not applied to every child (the claude spawn, its stop, a supplied runtime), a loop session inherits a bearer the launcher held; observed in the env each fake child actually received.
  it("drops the build's scrubbed names and prefixes from every child's env, and from a supplied runtime's", async () => {
    /** When scrubEnv reaches only the spawn, or only Claude, a loop's tools hold the launcher's bus key or service token: observed on the env the fake claude logged for the spawn and the stop, and on the env the fake runtime was handed. */
    const rt = fakeRuntime();
    const defaults = withRuntime(rt, { scrubEnv: ["HOUSE_KEY", "HOUSE_TOKEN_*"] });
    const env = { HOUSE_KEY: "k", HOUSE_TOKEN_A: "a", HOUSE_TOKEN: "kept", OTHER: "kept", FAKE_CLAUDE_ENV_KEYS: "HOUSE_KEY,HOUSE_TOKEN_A,HOUSE_TOKEN,OTHER" };
    expect((await loop(w, ["launch", "one-shot", "ABC-7", "--cwd", w.repo, "--model", "sonnet"], { defaults, env })).rc).toBe(0);
    expect((await loop(w, ["stop", "job00001"], { defaults, env })).rc).toBe(0);
    const scrubbed = { HOUSE_KEY: null, HOUSE_TOKEN_A: null, HOUSE_TOKEN: "kept", OTHER: "kept" };
    expect(w.childEnvs().map(({ HOUSE_KEY, HOUSE_TOKEN_A, HOUSE_TOKEN, OTHER }) => ({ HOUSE_KEY, HOUSE_TOKEN_A, HOUSE_TOKEN, OTHER }))).toEqual([scrubbed, scrubbed]);

    expect((await loop(w, ["launch", "one-shot", "ABC-2", "--cwd", w.repo, "--runtime", "second"], { defaults, env })).rc).toBe(0);
    const spawnEnv = rt.calls.find((c) => c.op === "spawn")!.env.env;
    expect(Object.keys(spawnEnv).filter((k) => k.startsWith("HOUSE") || k === "OTHER").sort()).toEqual(["HOUSE_TOKEN", "OTHER"]);
  });

  // admits: integration: when the after-hand-back hook runs although a target got nothing, or its failure fails the verb, a build tears down a session's follow-up wiring early or reports a posted hand-back as failed; observed on the hook's calls, the exit and the WARN.
  it("runs afterHandBack only when every target got the body, and its failure only warns", async () => {
    /** When the hook runs on a partial hand-back, the build clears what the unposted target still needs; when its error escapes, a posted hand-back exits non-zero and the loop retries a double post: observed on the hook's calls, the exit codes and stderr. */
    const hooked: string[] = [];
    let fail = false;
    const defaults: LoopDefaults = {
      ...LOOP_DEFAULTS,
      afterHandBack: async (_ctx, { issue }) => {
        hooked.push(issue);
        if (fail) throw new Error("the bus is down");
      },
    };
    w.refuse.set("POST /v1/linear/issues/ABC-2/comments", () => Response.json({ type: "about:blank", status: 404, code: "issue_not_found" }, { status: 404 }));
    const partial = await loop(w, ["hand-back", "abc-7", "--report-to", "ABC-2"], { defaults, stdin: "done\n" });
    expect([partial.rc, slugOf(partial.stderr), hooked]).toEqual([1, "loop-hand-back-failed", []]);

    w.refuse.clear();
    const ok = await loop(w, ["hand-back", "abc-7"], { defaults, stdin: "done\n" });
    expect([ok.rc, hooked]).toEqual([0, ["ABC-7"]]);

    fail = true;
    const warned = await loop(w, ["hand-back", "abc-7"], { defaults, stdin: "done\n" });
    expect([warned.rc, warned.stderr]).toEqual([0, "WARN eris loop: after the hand-back: the bus is down\n"]);
  });
});
