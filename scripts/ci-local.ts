/**
 * ci-local.ts — run ci.yml's gates on this checkout, before a push.
 *
 *   bun scripts/ci-local.ts [--only <gate,…>] [--skip <gate,…>]
 *
 * One gate per ci.yml job, named by the job id, in the workflow's order: `bun`,
 * `binary-oracle`, `ast-grep`, `shellcheck`, `scrub`, `npm-pack`. Every gate runs
 * even after one fails, as CI's independent jobs do, and the verdict comes last;
 * exit 1 when any failed, 2 on misuse.
 *
 * What keeps it in step with CI:
 *
 *   - Each gate runs ci.yml's `run:` text verbatim under `bash -eo pipefail`;
 *     tests/ci-local.test.ts fails when that text leaves ci.yml or ci.yml grows a
 *     job no gate covers. The `npm-pack` gate runs every step of its job, with
 *     `RUNNER_TEMP` and `GITHUB_OUTPUT` pointed at a scratch directory under
 *     `data/scratch/` that is removed on exit.
 *   - `bun` removes the gitignored `dist/` first, as CI's fresh checkout has none:
 *     the shim would run a stale binary found there.
 *   - `binary-oracle` builds with `bun scripts/build.ts` and runs the whole suite
 *     with `ERIS_BIN` set. It runs after `bun`, never beside it.
 *   - `scrub` adds `--denylist <file>` when `ERIS_SCRUB_DENYLIST` names one, for a
 *     maintainer's private names that never live in this repository.
 *   - A local tool whose version differs from ci.yml's `env:` pin is named on
 *     stderr before the gates run; the run continues.
 *
 * Offload: when `ERIS_CI_REMOTE_CMD` is set, this script runs that command
 * instead and exits with its status. The command is split on whitespace (no
 * shell) and receives this script's own arguments, run from the repository root;
 * with `ERIS_CI_REMOTE_REPO_ARG=1` it receives `--repo <repoRoot>` first. The
 * hook is inert when `ERIS_IN_REMOTE_POD=1` or `GITHUB_ACTIONS=true`, so the
 * command can run this script again on the far side without recursing.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const REPO = join(import.meta.dir, "..");
export const CI_YML = join(REPO, ".github/workflows/ci.yml");
const SCRATCH = join(REPO, "data", "scratch");

/** A gate, the ci.yml job it stands in for, and the `run:` lines it executes verbatim. */
export interface Gate {
  name: string;
  job: string;
  ciRun: string[];
  run: (ciText: string) => boolean;
}

interface Step {
  id?: string;
  run?: string;
  env?: Record<string, string>;
}
interface CiDoc {
  env?: Record<string, string>;
  jobs?: Record<string, { steps?: Step[] }>;
}

const parseCi = (ciText: string): CiDoc => Bun.YAML.parse(ciText) as CiDoc;

/**
 * Where GATES and ci.yml disagree, one line each: a ci.yml job no gate stands
 * in for, a gate naming a job ci.yml lacks, or a gate's `run:` line absent from
 * its job's steps. Empty when they agree.
 */
export function gateDrift(ciText: string, gates: Gate[]): string[] {
  const jobs = parseCi(ciText).jobs ?? {};
  const covered = new Set(gates.map((g) => g.job));
  const drift = Object.keys(jobs)
    .filter((job) => !covered.has(job))
    .map((job) => `ci.yml job \`${job}\` has no gate`);
  for (const gate of gates) {
    const job = Object.hasOwn(jobs, gate.job) ? jobs[gate.job] : undefined;
    if (!job) {
      drift.push(`gate \`${gate.name}\` names ci.yml job \`${gate.job}\`, which does not exist`);
      continue;
    }
    const lines = new Set((job.steps ?? []).flatMap((s) => (s.run ?? "").split("\n").map((l) => l.trim())));
    for (const cmd of gate.ciRun) {
      if (!lines.has(cmd)) drift.push(`gate \`${gate.name}\` runs \`${cmd}\`, which job \`${gate.job}\` does not`);
    }
  }
  return drift;
}

/**
 * The command the offload hook runs, or null when this run stays local: the hook
 * is unset, or the run already is the far side (`ERIS_IN_REMOTE_POD=1`) or CI.
 */
export function remoteDelegation(
  env: Record<string, string | undefined>,
  argv: string[],
  repoRoot: string,
): { cmd: string; args: string[]; cwd: string } | null {
  const raw = env.ERIS_CI_REMOTE_CMD?.trim();
  if (!raw || env.ERIS_IN_REMOTE_POD === "1" || env.GITHUB_ACTIONS === "true") return null;
  const [cmd, ...head] = raw.split(/\s+/);
  const repo = env.ERIS_CI_REMOTE_REPO_ARG === "1" ? ["--repo", repoRoot] : [];
  return { cmd: cmd!, args: [...head, ...repo, ...argv], cwd: repoRoot };
}

function sh(cmd: string, env: Record<string, string> = {}): boolean {
  const r = spawnSync("bash", ["-eo", "pipefail", "-c", cmd], {
    cwd: REPO,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  return r.status === 0;
}

function fail(msg: string): false {
  console.error(`ci-local: ${msg}`);
  return false;
}

function byName(name: string): Gate {
  return GATES.find((g) => g.name === name)!;
}

/** Fill `${{ steps.<id>.outputs.<name> }}` from the outputs earlier steps wrote. */
function expand(text: string, outputs: Record<string, string>): string {
  return text.replace(/\$\{\{\s*steps\.([\w-]+)\.outputs\.([\w-]+)\s*\}\}/g, (_, id, k) => outputs[`${id}.${k}`] ?? "");
}

/** A job's steps, run verbatim in order with CI's `RUNNER_TEMP` and `GITHUB_OUTPUT` standing in. */
function runJobSteps(ciText: string, job: string): boolean {
  const steps = (parseCi(ciText).jobs?.[job]?.steps ?? []).filter((s) => s.run !== undefined);
  mkdirSync(SCRATCH, { recursive: true });
  const tmp = join(SCRATCH, `ci-local-${job}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const outFile = join(tmp, "github-output");
  const outputs: Record<string, string> = {};
  try {
    for (const step of steps) {
      writeFileSync(outFile, "");
      const env: Record<string, string> = { RUNNER_TEMP: tmp, GITHUB_OUTPUT: outFile };
      for (const [k, v] of Object.entries(step.env ?? {})) env[k] = expand(String(v), outputs);
      // `env --version` only prints GNU env's version for the log; macOS's env has no such flag.
      const text = process.platform === "linux" ? step.run! : step.run!.replace(/^env --version \| sed -n 1p\n/m, "");
      const ok = sh(text, env);
      if (step.id) {
        for (const line of readFileSync(outFile, "utf8").split("\n")) {
          const eq = line.indexOf("=");
          if (eq > 0) outputs[`${step.id}.${line.slice(0, eq)}`] = line.slice(eq + 1);
        }
      }
      if (!ok) return false;
    }
    return true;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const TEST = "bun test --parallel=6 --no-orphans ./tests";

export const GATES: Gate[] = [
  {
    name: "bun",
    job: "bun",
    ciRun: ["bun install --frozen-lockfile", "bunx tsc --noEmit", "bunx tsc --noEmit -p packages/socrates-core", TEST],
    run: () => {
      if (existsSync(join(REPO, "dist"))) {
        console.error("ci-local: removing dist/ (CI's checkout has none; the shim would run a binary found there)");
        rmSync(join(REPO, "dist"), { recursive: true, force: true });
      }
      return sh(byName("bun").ciRun.join("\n"));
    },
  },
  {
    name: "binary-oracle",
    job: "binary-oracle",
    ciRun: ["bun install --frozen-lockfile", "bin=$(bun scripts/build.ts)", TEST],
    run: () => {
      if (!sh(byName("binary-oracle").ciRun[0]!)) return false;
      const built = spawnSync("bun", ["scripts/build.ts"], {
        cwd: REPO,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      });
      const bin = (built.stdout ?? "").split("\n")[0]?.trim();
      if (built.status !== 0 || !bin) return fail("bun scripts/build.ts failed");
      console.error(`ci-local: ERIS_BIN=${bin}`);
      return sh(TEST, { ERIS_BIN: resolve(REPO, bin) });
    },
  },
  {
    name: "ast-grep",
    job: "ast-grep",
    ciRun: ["ast-grep scan", "ast-grep test --skip-snapshot-tests"],
    run: () => byName("ast-grep").ciRun.every((cmd) => sh(cmd)),
  },
  {
    name: "shellcheck",
    job: "shellcheck",
    ciRun: ["shellcheck -s sh -S warning eris"],
    run: () => sh(byName("shellcheck").ciRun[0]!),
  },
  {
    name: "scrub",
    job: "scrub",
    ciRun: ["bun scripts/scrub-check.ts --history"],
    run: () => {
      const denylist = process.env.ERIS_SCRUB_DENYLIST;
      const cmd = byName("scrub").ciRun[0]!;
      return sh(denylist ? `${cmd} --denylist "$ERIS_SCRUB_DENYLIST"` : cmd);
    },
  },
  {
    name: "npm-pack",
    job: "npm-pack",
    ciRun: [],
    run: (ciText) => runJobSteps(ciText, "npm-pack"),
  },
];

/** `<tool> <version>` lines where the local tool differs from ci.yml's pin. */
function versionDrift(env: Record<string, string>): string[] {
  const probe = (cmd: string, args: string[], pattern: RegExp): string | null => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    return r.status === 0 ? ((r.stdout ?? "").match(pattern)?.[1] ?? null) : null;
  };
  const bunPin = existsSync(join(REPO, ".bun-version")) ? readFileSync(join(REPO, ".bun-version"), "utf8").trim() : undefined;
  const want: [string, string | undefined, string | null][] = [
    ["shellcheck", env.SHELLCHECK_VERSION?.replace(/^v/, ""), probe("shellcheck", ["--version"], /version:\s*(\S+)/)],
    ["bun", bunPin, probe("bun", ["--version"], /^(\S+)/)],
    ["ast-grep", env.ASTGREP_VERSION, probe("ast-grep", ["--version"], /(\d+\.\d+\.\d+)/)],
  ];
  return want
    .filter(([, pin, have]) => pin && have !== pin)
    .map(([tool, pin, have]) => `${tool}: pinned ${pin}, local is ${have ?? "absent"}`);
}

function main(argv: string[]): number {
  const remote = remoteDelegation(process.env, argv, REPO);
  if (remote) {
    const r = spawnSync(remote.cmd, remote.args, { cwd: remote.cwd, stdio: "inherit" });
    if (r.error) return fail(`ERIS_CI_REMOTE_CMD: ${r.error.message}`) || 1;
    return r.status ?? 1;
  }
  let values: { only?: string; skip?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        only: { type: "string" },
        skip: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    console.error(`ci-local: ${(e as Error).message}`);
    return 2;
  }
  const names = new Set(GATES.map((g) => g.name));
  if (values.help) {
    console.error(`usage: bun scripts/ci-local.ts [--only <gate,…>] [--skip <gate,…>]\ngates: ${[...names].join(", ")}`);
    return 0;
  }
  const list = (s?: string) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);
  const only = list(values.only);
  const skip = new Set(list(values.skip));
  const unknown = [...only, ...skip].filter((n) => !names.has(n));
  if (unknown.length) {
    console.error(`ci-local: unknown gate(s) ${unknown.join(", ")}; gates: ${[...names].join(", ")}`);
    return 2;
  }
  const chosen = new Set(only.length ? only : names);

  const ciText = readFileSync(CI_YML, "utf8");
  for (const line of [...gateDrift(ciText, GATES), ...versionDrift(parseCi(ciText).env ?? {})]) {
    console.error(`ci-local: warning: ${line}`);
  }

  const results: [string, string][] = [];
  for (const gate of GATES) {
    if (!chosen.has(gate.name) || skip.has(gate.name)) {
      results.push([gate.name, "skipped"]);
      continue;
    }
    console.error(`\n━━━ ${gate.name} (ci.yml job \`${gate.job}\`)`);
    const t0 = Date.now();
    let ok: boolean;
    try {
      ok = gate.run(ciText);
    } catch (e) {
      ok = fail(`${gate.name}: ${(e as Error).message}`);
    }
    results.push([gate.name, `${ok ? "pass" : "FAIL"} (${Math.round((Date.now() - t0) / 1000)}s)`]);
  }
  console.error("\n━━━ verdict");
  for (const [name, outcome] of results) console.error(`  ${name.padEnd(15)}${outcome}`);
  const failed = results.some(([, o]) => /^FAIL/.test(o));
  console.error(failed ? "ci-local: FAILED" : "ci-local: passed");
  return failed ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
