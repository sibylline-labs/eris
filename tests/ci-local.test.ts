import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CI_YML, GATES, gateDrift, remoteDelegation } from "../scripts/ci-local";
import { checkoutOnly, REPO } from "./helpers/blackbox";

/**
 * scripts/ci-local.ts stands in for ci.yml on a laptop. It is only worth running
 * while it runs what CI runs, so ci.yml is the oracle here.
 */
describe.skipIf(checkoutOnly("reads ci.yml and the script from the checkout"))("ci-local stays in step with ci.yml", () => {
  const CI = readFileSync(CI_YML, "utf8");

  it("covers every ci.yml job and runs only ci.yml's own run: text", () => {
    /** When ci.yml gains a job, renames one, or rewrites a gate's `run:` line, the local runner silently stops running what CI runs and a push goes red that ci-local passed. */
    expect(gateDrift(CI, GATES)).toEqual([]);
    expect(GATES.map((g) => g.job)).toEqual(["bun", "binary-oracle", "ast-grep", "shellcheck", "scrub", "npm-pack"]);
  });

  it("reports a new job, a missing job and an edited run: line", () => {
    /** The positive pair of the check above: a drift it is meant to catch is reported, so an empty list is not the checker going blind. */
    const drifted = CI.replace("run: shellcheck -s sh -S warning eris", "run: shellcheck -s sh eris")
      .replace("  scrub:\n", "  scrub-renamed:\n")
      .replace("jobs:\n", "jobs:\n  audit:\n    runs-on: x\n    steps:\n      - run: bun audit\n");
    expect(gateDrift(drifted, GATES)).toEqual([
      "ci.yml job `audit` has no gate",
      "ci.yml job `scrub-renamed` has no gate",
      "gate `shellcheck` runs `shellcheck -s sh -S warning eris`, which job `shellcheck` does not",
      "gate `scrub` names ci.yml job `scrub`, which does not exist",
    ]);
  });

  it("runs both test jobs on the worker count the oracle cache is keyed for", () => {
    /** When a ci.yml test step drops `--parallel=6 --no-orphans`, CI runs one process while local runs six and a worker race shows on one side only. */
    const lines = CI.split("\n").filter((l) => /^\s*(- )?run: bun test /.test(l));
    expect(lines.length).toBe(2);
    for (const l of lines) expect(l).toContain("bun test --parallel=6 --no-orphans ./tests");
  });
});

describe("the offload hook", () => {
  const root = "/repo";

  it("hands the command this script's own arguments, from the repository root", () => {
    /** When the hook drops the argv, `--only` is lost on the far side and the whole suite runs where one gate was asked for. */
    expect(remoteDelegation({ ERIS_CI_REMOTE_CMD: "runner exec" }, ["--only", "scrub"], root)).toEqual({
      cmd: "runner",
      args: ["exec", "--only", "scrub"],
      cwd: root,
    });
  });

  it("passes the repository root first when asked", () => {
    /** When a remote runner needs the checkout path and the flag never arrives, it syncs the wrong tree. */
    expect(remoteDelegation({ ERIS_CI_REMOTE_CMD: "runner", ERIS_CI_REMOTE_REPO_ARG: "1" }, ["--skip", "scrub"], root)?.args).toEqual([
      "--repo",
      root,
      "--skip",
      "scrub",
    ]);
  });

  it("stays local when unset, on the far side, or in CI", () => {
    /** When the far side or CI delegates again, the command re-invokes itself without end. */
    expect(remoteDelegation({}, [], root)).toBeNull();
    expect(remoteDelegation({ ERIS_CI_REMOTE_CMD: "  " }, [], root)).toBeNull();
    expect(remoteDelegation({ ERIS_CI_REMOTE_CMD: "r", ERIS_IN_REMOTE_POD: "1" }, [], root)).toBeNull();
    expect(remoteDelegation({ ERIS_CI_REMOTE_CMD: "r", GITHUB_ACTIONS: "true" }, [], root)).toBeNull();
  });
});

describe.skipIf(checkoutOnly("spawns the script from the checkout"))("the script as run", () => {
  it("rejects an unknown gate with exit 2 and names the gates", () => {
    /** When --only stops validating, a typo runs zero gates and the verdict reads passed. */
    const r = Bun.spawnSync(["bun", join(REPO, "scripts/ci-local.ts"), "--only", "nope"], { cwd: REPO, env: { ...process.env, ERIS_CI_REMOTE_CMD: "" } });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("gates: bun, binary-oracle, ast-grep, shellcheck, scrub, npm-pack");
  });

  it("exits with the offloaded command's status and runs it from the root", () => {
    /** When the hook swallows the remote status, a failed remote run reads as green. */
    const r = Bun.spawnSync(["bun", join(REPO, "scripts/ci-local.ts"), "--only", "scrub"], {
      cwd: REPO,
      env: { ...process.env, ERIS_CI_REMOTE_CMD: "bun -e process.exit(7)", ERIS_IN_REMOTE_POD: "", GITHUB_ACTIONS: "" },
    });
    expect(r.exitCode).toBe(7);
  });

  it("refuses to offload again from inside the far side", () => {
    /** When ERIS_IN_REMOTE_POD=1 is ignored, the offloaded run re-delegates; here it must reach the local arg parser instead. */
    const r = Bun.spawnSync(["bun", join(REPO, "scripts/ci-local.ts"), "--only", "nope"], {
      cwd: REPO,
      env: { ...process.env, ERIS_CI_REMOTE_CMD: "bun -e process.exit(7)", ERIS_IN_REMOTE_POD: "1" },
    });
    expect(r.exitCode).toBe(2);
  });
});
