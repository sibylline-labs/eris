/**
 * src/runtime/process.ts — the subprocess adapter.
 *
 * The failure modes it exists to prevent, both seen in practice:
 * a timed-out or interrupted child whose descendant made its own process
 * group survives the kill, reparents to PID 1 holding the capture pipe, and
 * the reader never sees EOF (an unattributed hang, not a failed test). So the
 * tree tests assert three things together: the call settles promptly, the
 * descendant pid was alive and is now dead, and the pipe closed.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeRunner } from "eris/sdk/testing";
import { nodeRunner, runMany, type RunResult } from "../src/runtime/process";

const REPO_ROOT = join(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "eris-runtime-process-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A zombie answers `kill(pid, 0)` until its parent reaps it; it holds no pipe and runs nothing, so it counts as dead. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.charAt(stat.lastIndexOf(")") + 2) !== "Z";
  } catch {
    const ps = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
    return !ps.stdout.toString().trim().startsWith("Z");
  }
}

/** Parse the "pid pid" pairs a worker echoed as `$! $$`. */
function pidsFrom(text: string): number[] {
  return text.trim().split(/\s+/).map(Number).filter((n) => n > 1);
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
    await Bun.sleep(20);
  }
}

describe("result kinds — 'could not tell' never collapses into a clean non-zero", () => {
  it("ok: exit 0 with captured stdout/stderr bytes", async () => {
    const r = await nodeRunner.run(["bash", "-c", "printf 'out\\0bytes'; printf err >&2"], { timeoutMs: 5000 });
    expect(r.kind).toBe("ok");
    expect(r.stdout.equals(Buffer.from("out\0bytes"))).toBe(true);
    expect(r.stderr.toString()).toBe("err");
  });

  it("exit: a non-zero code is kept as that code", async () => {
    const r = await nodeRunner.run(["bash", "-c", "exit 3"], { timeoutMs: 5000 });
    expect(r).toMatchObject({ kind: "exit", code: 3 });
  });

  it("signal: a child that dies by a signal nobody here sent", async () => {
    const r = await nodeRunner.run(["bash", "-c", "kill -KILL $$"], { timeoutMs: 5000 });
    expect(r).toMatchObject({ kind: "signal", signal: "SIGKILL" });
  });

  it("spawn-failed: ENOENT is distinct from any exit code", async () => {
    const r = await nodeRunner.run(["eris-no-such-binary-xyz"], { timeoutMs: 5000 });
    expect(r).toMatchObject({ kind: "spawn-failed", errno: "ENOENT" });
  });

  it("stdin input reaches the child", async () => {
    const r = await nodeRunner.run(["cat"], { timeoutMs: 5000, input: "fed\n" });
    expect(r.kind).toBe("ok");
    expect(r.stdout.toString()).toBe("fed\n");
  });
});

describe("timeout kills the WHOLE tree", () => {
  // detached:false shares OUR group, so this also proves the kill never
  // signals its own caller's group (the test runner would die with it).
  for (const detached of [true, false]) {
    it(`detached=${detached}: a grandchild that setpgrp'd into its own group and holds stdout is killed; the call settles`, async () => {
      const t0 = Date.now();
      const r = await nodeRunner.run(
        ["bash", "-c", `perl -e 'setpgrp(0,0); exec q(sleep), 30' & echo "$! $$" >&2; sleep 30`],
        { timeoutMs: 500, killGraceMs: 500, detached },
      );
      const elapsed = Date.now() - t0;
      const pids = pidsFrom(r.stderr.toString());
      expect(r.kind).toBe("timeout");
      expect(pids.length).toBe(2);
      expect(elapsed).toBeLessThan(3000);
      // `close` only fires once every holder of the pipe is gone.
      expect(r.kind === "timeout" && r.forcedClose).toBe(false);
      // A KILLed process is gone once the kernel finishes tearing it down, not at the syscall.
      await waitFor(() => pids.every((p) => !alive(p)), 500);
    });
  }

  it("a TERM-ignoring child is escalated to KILL after the grace period", async () => {
    const r = await nodeRunner.run(["perl", "-e", `$SIG{TERM}="IGNORE"; print STDERR "$$\\n"; sleep 30`], {
      timeoutMs: 300,
      killGraceMs: 300,
    });
    expect(r).toMatchObject({ kind: "timeout", escalated: true, forcedClose: false });
    const [pid] = pidsFrom(r.stderr.toString());
    expect(pid).toBeGreaterThan(1);
    await waitFor(() => !alive(pid as number), 500);
  });

  async function interruptedRun(mode: "signal" | "exit" | "early") {
    const pidFile = join(scratch, `${mode}.pids`);
    const bun = spawn(process.execPath, [join(REPO_ROOT, "tests/fixtures/runtime/interrupted-run.ts")], {
      detached: true, // own group, so a group signal is a Ctrl-C to it alone
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PID_FILE: pidFile, MODE: mode },
    });
    let out = "";
    bun.stdout!.on("data", (d) => (out += d));
    const closed = new Promise<{ code: number | null; signal: string | null }>((res) =>
      bun.on("close", (code, signal) => res({ code, signal })),
    );
    let pids: number[] = [];
    await waitFor(() => {
      try {
        pids = pidsFrom(readFileSync(pidFile, "utf8"));
      } catch {
        pids = [];
      }
      return pids.length === 2;
    });
    return { bun, closed, pids: () => pids, out: () => out };
  }

  it("SIGINT to a bun process mid-run (terminal Ctrl-C) kills the detached child's tree", async () => {
    const h = await interruptedRun("signal");
    for (const pid of h.pids()) expect(alive(pid)).toBe(true);
    const t0 = Date.now();
    process.kill(-h.bun.pid!, "SIGINT");
    const res = await h.closed; // stdout EOF: close fires only after it
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(res.signal === "SIGINT" || res.code === 130).toBe(true);
    expect(h.out()).toBe("");
    await waitFor(() => h.pids().every((p) => !alive(p)), 2000);
    for (const pid of h.pids()) expect(alive(pid)).toBe(false);
  });

  it("a SIGINT that lands while spawn() is still returning still reaps the child's tree", async () => {
    /** When the signal handlers are armed only after spawn() returns, a signal in that window kills bun by the default disposition and the setpgrp'd grandchild survives under PID 1. */
    const h = await interruptedRun("early");
    const res = await h.closed;
    expect(res.signal === "SIGINT" || res.code === 130).toBe(true);
    expect(h.out()).toBe("");
    await waitFor(() => h.pids().every((p) => !alive(p)), 2000);
    for (const pid of h.pids()) expect(alive(pid)).toBe(false);
  });

  it("process.exit mid-run (a die while a child is live) terminates the child's tree", async () => {
    const h = await interruptedRun("exit");
    const res = await h.closed;
    expect(res.code).toBe(1);
    await waitFor(() => h.pids().every((p) => !alive(p)), 2000);
    for (const pid of h.pids()) expect(alive(pid)).toBe(false);
  });
});

describe("redaction and child env", () => {
  const redact = (s: string) => s.replaceAll("abc123", "[REDACTED]");
  const cases: Array<{ name: string; script: string; opts?: { timeoutMs: number }; kind: RunResult["kind"] }> = [
    { name: "ok", script: "echo token=abc123 >&2", kind: "ok" },
    { name: "exit", script: "echo token=abc123 >&2; exit 4", kind: "exit" },
    { name: "timeout", script: "echo token=abc123 >&2; sleep 30", opts: { timeoutMs: 300 }, kind: "timeout" },
  ];
  for (const c of cases) {
    it(`the only exposed stderr is redacted (${c.name})`, async () => {
      const r = await nodeRunner.run(["bash", "-c", c.script], { timeoutMs: 5000, ...c.opts, redact });
      expect(r.kind).toBe(c.kind);
      expect(r.stderr.toString()).toContain("token=[REDACTED]");
      expect(r.stderr.toString()).not.toContain("abc123");
      expect(JSON.stringify(r)).not.toContain("abc123");
    });
  }

  it("BUN_CONFIG_VERBOSE_FETCH is stripped from an explicit env; the rest passes through", async () => {
    const r = await nodeRunner.run(["env"], {
      timeoutMs: 5000,
      env: { PATH: process.env.PATH ?? "", BUN_CONFIG_VERBOSE_FETCH: "curl", ERIS_SENTINEL: "kept" },
    });
    expect(r.stdout.toString()).toContain("ERIS_SENTINEL=kept\n");
    expect(r.stdout.toString()).not.toContain("BUN_CONFIG_VERBOSE_FETCH");
  });

  it("…and from the inherited process env", () => {
    // In a child process: bun keeps BUN_CONFIG_VERBOSE_FETCH once set, so setting
    // it here would dump every later fetch's headers in this `bun test` run.
    const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "helpers", "runner-inherited-env-child.ts")], {
      env: { PATH: process.env.PATH ?? "", BUN_CONFIG_VERBOSE_FETCH: "curl", ERIS_SENTINEL_INHERITED: "kept" },
    });
    expect({ rc: p.exitCode, stderr: p.stderr.toString() }).toEqual({ rc: 0, stderr: "" });
    const r = JSON.parse(p.stdout.toString()) as { kind: string; env: string; own: string | null };
    expect(r.kind).toBe("ok");
    expect(r.env).toContain("ERIS_SENTINEL_INHERITED=kept\n");
    expect(r.env).not.toContain("BUN_CONFIG_VERBOSE_FETCH");
    expect(r.own).toBe("curl"); // the parent's own env untouched
  });

  it("no test sets BUN_CONFIG_VERBOSE_FETCH in the bun test process", () => {
    /** When a test assigns it to process.env, bun latches it and every later fetch in the run prints its request headers — bearer tokens included — into the test log. */
    const offenders: string[] = [];
    const glob = new Bun.Glob("**/*.ts");
    for (const f of glob.scanSync({ cwd: join(REPO_ROOT, "tests") })) {
      const text = readFileSync(join(REPO_ROOT, "tests", f), "utf8");
      if (/process\.env\.BUN_CONFIG_VERBOSE_FETCH\s*=[^=]|process\.env\[["']BUN_CONFIG_VERBOSE_FETCH["']\]\s*=[^=]/.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
    // The scan reads real files: this one names the variable.
    expect([...glob.scanSync({ cwd: join(REPO_ROOT, "tests") })]).toContain("runtime-process.test.ts");
  });
});

describe("runMany — bounded fan-out over an injected runner", () => {
  for (const [raw, cap] of [
    ["2", 2],
    ["not-a-number", 8], // clamps (ts/lib/pool.ts), never unbounded
  ] as const) {
    it(`ERIS_BATCH_CONCURRENCY=${raw}: at most ${cap} in flight, results in input order`, async () => {
      let inFlight = 0;
      let peak = 0;
      const fake = createFakeRunner(async (argv) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Bun.sleep(5);
        inFlight--;
        return { kind: "ok", code: 0, stdout: Buffer.from(argv[1] as string), stderr: Buffer.alloc(0) };
      });
      const jobs = Array.from({ length: 20 }, (_, i) => ({ argv: ["job", String(i)], opts: { timeoutMs: 1000 } }));
      const results = await runMany(jobs, { runner: fake, env: { ERIS_BATCH_CONCURRENCY: raw } });
      expect(peak).toBe(cap);
      expect(results.map((r) => r.stdout.toString())).toEqual(jobs.map((j) => j.argv[1]));
      expect(fake.calls.length).toBe(20);
    });
  }
});
