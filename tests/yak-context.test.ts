/**
 * Tests for plugins/yak/yak-context.ts.
 *
 * Every probe is exercised through injected `cwd`/`env`/`run` so nothing
 * here depends on this machine's real git config, HOME, or CLAUDE_CODE_*
 * environment (dispatch constraint) — and so a probe can be made to fail
 * or hang ON PURPOSE, which is the whole point of the fail-soft/time-cap
 * assertions below.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherProvenance } from "../plugins/yak/yak-context";
import type { BoundedResult, Runner } from "../plugins/yak/yak-identity";

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function freshDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

/** A Runner that answers by exact argv match, {ok:false} for anything else —
 *  the same stub shape yak-identity.test.ts uses for resolveReporter. */
function stubRunner(answers: Record<string, BoundedResult>): Runner {
  return async (cmd: string[]) => answers[cmd.join(" ")] ?? { ok: false };
}

/** A Runner whose promises never settle — for the time-cap test. Every call
 *  is still a real (never-resolving) Promise, not a thrown error, so this
 *  exercises "the gather returns anyway" rather than "the gather tolerates
 *  a throw" (a different, already-covered path). */
function hangingRunner(): Runner {
  return () => new Promise<BoundedResult>(() => {});
}

const ALL_GIT_OK = (): Record<string, BoundedResult> => ({
  "git rev-parse --show-toplevel": { ok: true, stdout: "/repo\n" },
  "git config --get remote.origin.url": { ok: true, stdout: "git@github.com:org/repo.git\n" },
  "git rev-parse --abbrev-ref HEAD": { ok: true, stdout: "main\n" },
  "git rev-parse HEAD": { ok: true, stdout: "abc123\n" },
  "git status --porcelain": { ok: true, stdout: "" },
});

describe("gatherProvenance — categories that need no subprocess", () => {
  it(
    "resolves execution/harness/device/process from env and process facts alone " +
      "— observed at the returned record's keys",
    async () => {
      const cwd = await freshDir("yak-ctx-plain-");
      const provenance = await gatherProvenance({
        cwd,
        env: {
          CLAUDE_CODE_SESSION_ID: "sess-1",
          CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
          CLAUDECODE: "1",
          AI_AGENT: "claude-code_test_agent",
          SHELL: "/bin/bash",
        },
        pid: 111,
        ppid: 222,
        run: stubRunner({}), // no git anywhere — git/repo categories drop
      });

      expect(provenance.execution).toMatchObject({
        claude_code_session_id: "sess-1",
        entrypoint: "claude-desktop",
      });
      expect(provenance.harness).toMatchObject({ claudecode: "1", ai_agent: "claude-code_test_agent" });
      expect(provenance.device).toMatchObject({ platform: process.platform, arch: process.arch });
      expect(provenance.process).toMatchObject({ cwd, pid: 111, ppid: 222, shell: "/bin/bash" });
    },
  );

  it(
    "when NOTHING resolves for a category, that category is OMITTED — never emitted " +
      "as {} — observed at the key being absent from the returned object",
    async () => {
      const cwd = await freshDir("yak-ctx-empty-");
      const provenance = await gatherProvenance({ cwd, env: {}, run: stubRunner({}) });

      // execution/harness had nothing in `env` to read → both entirely absent
      expect("execution" in provenance).toBe(false);
      expect("harness" in provenance).toBe(false);
      // git had nothing from the stub → absent; repo had no eris.yaml anywhere
      // above a fresh tmp dir → absent
      expect("git" in provenance).toBe(false);
      expect("repo" in provenance).toBe(false);
      // device/process always resolve something real (hostname/platform/pid)
      expect("device" in provenance).toBe(true);
      expect("process" in provenance).toBe(true);
    },
  );
});

describe("gatherProvenance — git: one field failing drops only that field", () => {
  it(
    "when 'git config --get remote.origin.url' fails but the other four succeed, " +
      "origin_url is absent while root/branch/head_sha/dirty are all still present " +
      "— observed at the returned git record",
    async () => {
      const cwd = await freshDir("yak-ctx-git-partial-");
      const answers = ALL_GIT_OK();
      delete answers["git config --get remote.origin.url"];

      const provenance = await gatherProvenance({ cwd, env: {}, run: stubRunner(answers) });

      expect(provenance.git).toBeDefined();
      const git = provenance.git as Record<string, unknown>;
      expect("origin_url" in git).toBe(false);
      expect(git.root).toBe("/repo");
      expect(git.branch).toBe("main");
      expect(git.head_sha).toBe("abc123");
      expect(git.dirty).toBe(false);
    },
  );

  it(
    "a CLEAN tree (git status --porcelain exits 0 with empty stdout) reports " +
      "dirty: false — NOT absent — distinguishing 'measured clean' from 'unmeasured'",
    async () => {
      const cwd = await freshDir("yak-ctx-git-clean-");
      const provenance = await gatherProvenance({ cwd, env: {}, run: stubRunner(ALL_GIT_OK()) });
      const git = provenance.git as Record<string, unknown>;
      expect(git.dirty).toBe(false);
    },
  );

  it(
    "a DIRTY tree (git status --porcelain exits 0 with non-empty stdout) reports " +
      "dirty: true — observed at the returned git record",
    async () => {
      const cwd = await freshDir("yak-ctx-git-dirty-");
      const answers = ALL_GIT_OK();
      answers["git status --porcelain"] = { ok: true, stdout: " M some/file.ts\n" };
      const provenance = await gatherProvenance({ cwd, env: {}, run: stubRunner(answers) });
      const git = provenance.git as Record<string, unknown>;
      expect(git.dirty).toBe(true);
    },
  );

  it(
    "when the status probe itself FAILS (not a clean tree — a real failure), " +
      "dirty is absent entirely, never coerced to false — the absent-vs-empty distinction " +
      "this record exists to preserve",
    async () => {
      const cwd = await freshDir("yak-ctx-git-status-fails-");
      const answers = ALL_GIT_OK();
      delete answers["git status --porcelain"];
      const provenance = await gatherProvenance({ cwd, env: {}, run: stubRunner(answers) });
      const git = provenance.git as Record<string, unknown>;
      expect("dirty" in git).toBe(false);
    },
  );

  it(
    "when EVERY git probe fails, the whole 'git' category is omitted rather than " +
      "emitted as an all-absent {} — observed at the key being absent",
    async () => {
      const cwd = await freshDir("yak-ctx-git-none-");
      const provenance = await gatherProvenance({ cwd, env: {}, run: stubRunner({}) });
      expect("git" in provenance).toBe(false);
    },
  );
});

describe("gatherProvenance — repo: a raw single-file peek, not a config merge", () => {
  it(
    "finds the NEAREST eris.yaml's service field when invoked from a subdirectory " +
      "— observed at provenance.repo.service",
    async () => {
      const root = await freshDir("yak-ctx-repo-");
      await mkdir(join(root, "src", "nested"), { recursive: true });
      await writeFile(join(root, "eris.yaml"), "service: my-service\nenvs: {}\n");

      const provenance = await gatherProvenance({
        cwd: join(root, "src", "nested"),
        env: {},
        run: stubRunner({}),
      });
      expect(provenance.repo).toEqual({ service: "my-service" });
    },
  );

  it(
    "stops at the enclosing git checkout root and never reads an eris.yaml " +
      "ABOVE it — observed at provenance.repo being absent even though a manifest " +
      "exists further up the real tree",
    async () => {
      const outer = await freshDir("yak-ctx-repo-outer-");
      await writeFile(join(outer, "eris.yaml"), "service: outer-service\nenvs: {}\n");
      const inner = join(outer, "inner-checkout");
      await mkdir(join(inner, "src"), { recursive: true });
      await mkdir(join(inner, ".git"), { recursive: true }); // marks inner as its own repo root

      const provenance = await gatherProvenance({ cwd: join(inner, "src"), env: {}, run: stubRunner({}) });
      expect("repo" in provenance).toBe(false);
    },
  );

  it(
    "when no eris.yaml exists anywhere above cwd, the repo category is omitted " +
      "— observed at provenance.repo being absent",
    async () => {
      const dir = await freshDir("yak-ctx-repo-none-");
      const provenance = await gatherProvenance({ cwd: dir, env: {}, run: stubRunner({}) });
      expect("repo" in provenance).toBe(false);
    },
  );
});

describe("gatherProvenance — the overall time cap", () => {
  it(
    "when every git probe hangs forever, the gather still returns within a bounded " +
      "wall-clock time and simply omits the 'git' key — observed at elapsed time and the missing key, " +
      "NOT at a thrown error",
    async () => {
      const cwd = await freshDir("yak-ctx-hang-");
      const started = Date.now();
      const provenance = await gatherProvenance({
        cwd,
        env: { CLAUDE_CODE_SESSION_ID: "sess-1" },
        run: hangingRunner(),
      });
      const elapsed = Date.now() - started;

      // Comfortably under the module's OVERALL_GATHER_TIMEOUT_MS (1.5s) plus
      // scheduling slack — the point is this is NOT the caller waiting
      // forever on a hung subprocess.
      expect(elapsed).toBeLessThan(3_000);
      expect("git" in provenance).toBe(false);
      // Categories that never touched the hanging runner still resolved.
      expect(provenance.execution).toMatchObject({ claude_code_session_id: "sess-1" });
      expect(provenance.device).toBeDefined();
      expect(provenance.process).toBeDefined();
    },
  );
});
