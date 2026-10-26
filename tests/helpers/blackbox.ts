/**
 * blackbox.ts — the real `eris` entrypoint as a subprocess, asserted only on what an outside caller sees — exit status,
 * stdout and stderr captured SEPARATELY as raw bytes, files left on disk with
 * their modes, the argv a PATH fake recorded, and the requests a loopback
 * fixture received.
 *
 * The rules:
 *   - PATH fakes (an executable on PATH), never in-process fakes: the system
 *     under test is a separate process.
 *   - stdout and stderr never merge.
 *   - stdin is /dev/null: a machine surface must never block on a prompt.
 *   - the sandbox path is PHYSICAL (macOS `$TMPDIR` sits under the /var →
 *     /private/var symlink, and eris prints physical paths).
 *   - colour never depends on the developer's terminal (NO_COLOR set,
 *     FORCE_COLOR / CLICOLOR_FORCE removed).
 *   - nothing reaches a developer's real Yaks endpoint: ERIS_YAKS_URL and
 *     ERIS_YAKS_TOKEN are removed.
 *
 * `run` is ASYNC on purpose: a fixture started in-process (a `Bun.serve`
 * loopback) answers on this process's event loop, which a spawnSync would
 * block for the child's whole life.
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { expect } from "bun:test";

export const REPO = realpathSync(join(import.meta.dir, "..", ".."));
/**
 * A compiled eris to test instead of the checkout: `ERIS_BIN=<binary>
 * bun test ./tests` is the binary's oracle. Unset, the program is the checkout's
 * `eris` shim.
 */
export const ERIS_BIN = process.env.ERIS_BIN ? realpathSync(process.env.ERIS_BIN) : null;
/** The program under test — ONE constant, so a replacement entrypoint is a one-line change. */
export const ERIS = ERIS_BIN ?? join(REPO, "eris");
/**
 * Every binary process in one oracle run shares one asset cache, so the
 * race-safe first-run write (src/runtime/home.ts) is exercised by the suites'
 * own parallelism. Under the repo's gitignored `.scratch/`.
 */
const ORACLE_CACHE = join(REPO, ".scratch", "oracle-cache");

/**
 * A skip guard for a test about the CHECKOUT itself (the shim, a copy of the
 * repo tree, the source on disk): it skips under ERIS_BIN. The reason is
 * required, so every skip in an oracle run is named at its call site
 * (`rg 'checkoutOnly\(' tests` lists them).
 */
export function checkoutOnly(reason: string): boolean {
  if (reason.trim() === "") throw new Error("checkoutOnly needs a reason");
  return ERIS_BIN !== null;
}

/** A skip guard for a test of a compiled binary's own behaviour: it runs only under ERIS_BIN. */
export function binaryOnly(reason: string): boolean {
  if (reason.trim() === "") throw new Error("binaryOnly needs a reason");
  return ERIS_BIN === null;
}

/**
 * The variables a hand-built child environment adds so a binary shares the
 * oracle's asset cache instead of writing one under that test's HOME. `{}`
 * against the checkout. `sandbox()` environments carry it already.
 */
export function oracleEnv(): Record<string, string> {
  return ERIS_BIN === null ? {} : { ERIS_CACHE_DIR: ORACLE_CACHE };
}

/**
 * The install root the program under test resolves: the checkout, or the
 * binary's asset home in the oracle cache (one build id per binary).
 */
export function installRoot(): string {
  if (ERIS_BIN === null) return REPO;
  const homes = readdirSync(ORACLE_CACHE).filter((e) => !e.includes(".tmp-"));
  if (homes.length !== 1) throw new Error(`expected one asset home in ${ORACLE_CACHE}, found: ${homes.join(", ") || "none"}`);
  return join(ORACLE_CACHE, homes[0]!);
}

const READY = Symbol.for("eris.oracle-cache.ready");
if (ERIS_BIN !== null && !(globalThis as Record<symbol, unknown>)[READY]) {
  (globalThis as Record<symbol, unknown>)[READY] = true;
  // Once per run, before any test spawns: a home left by another build would make installRoot() ambiguous.
  rmSync(ORACLE_CACHE, { recursive: true, force: true });
  mkdirSync(ORACLE_CACHE, { recursive: true });
  const r = spawnSync(ERIS_BIN, ["--help"], { env: { ...process.env, ERIS_CACHE_DIR: ORACLE_CACHE }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ERIS_BIN=${ERIS_BIN} --help exited ${r.status}: ${r.stderr}`);
}
export interface Run {
  status: number;
  /** stdout bytes as text, NOT trailing-newline-stripped (a newline is a contract question). */
  stdout: string;
  stderr: string;
  stdoutBytes: Buffer;
  stderrBytes: Buffer;
}

export interface Sandbox {
  /** Physical root of the sandbox. */
  dir: string;
  fakes: string;
  home: string;
  tmp: string;
  /** The environment every `run` starts from; mutate to add variables for the rest of the test. */
  env: Record<string, string>;
  /** Default cwd for `run`. */
  cwd: string;
  fake(bin: string, body?: string): void;
  /** Every recorded invocation of a fake, one argv line each ("" if none). */
  argv(bin: string): string;
  calls(bin: string): number;
  hideReal(bin: string): void;
  run(args: string[], opts?: { cwd?: string; env?: Record<string, string | undefined>; stdin?: string; program?: string; timeoutMs?: number }): Promise<Run>;
  cleanup(): void;
}

const STRIP_ENV = [
  "FORCE_COLOR",
  "CLICOLOR_FORCE",
  "BUN_CONFIG_VERBOSE_FETCH",
  // A developer's own Yaks credentials: a sandboxed `eris yak` must never file a real report.
  "ERIS_YAKS_URL",
  "ERIS_YAKS_TOKEN",
];

export function sandbox(prefix = "eris-bb-"): Sandbox {
  // `.env` is created at 0666 & ~umask: pin it so a mode is a fact of the test.
  process.umask(0o022);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const fakes = join(dir, "fakes");
  const argvDir = join(dir, "argv");
  const home = join(dir, "home");
  const tmp = join(dir, "tmp");
  for (const d of [fakes, argvDir, home, tmp]) mkdirSync(d, { recursive: true });

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP_ENV.includes(k)) env[k] = v;
  env.PATH = `${fakes}${delimiter}${process.env.PATH ?? ""}`;
  env.HOME = home;
  env.TMPDIR = tmp;
  env.NO_COLOR = "1";
  if (ERIS_BIN !== null) env.ERIS_CACHE_DIR = ORACLE_CACHE;

  const sb: Sandbox = {
    dir,
    fakes,
    home,
    tmp,
    env,
    cwd: dir,
    fake(bin, body = "") {
      const shim = `#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> ${JSON.stringify(join(argvDir, `${bin}.txt`))}\n${body}\n`;
      writeFileSync(join(fakes, bin), shim);
      chmodSync(join(fakes, bin), 0o755);
    },
    argv(bin) {
      const f = join(argvDir, `${bin}.txt`);
      return existsSync(f) ? readFileSync(f, "utf8") : "";
    },
    calls(bin) {
      const t = sb.argv(bin);
      return t === "" ? 0 : t.split("\n").length - 1;
    },
    hideReal(bin) {
      rmSync(join(fakes, bin), { force: true });
      let n = 0;
      const out: string[] = [];
      for (const d of (env.PATH ?? "").split(delimiter)) {
        const p = join(d, bin);
        let hit = false;
        try {
          hit = d !== "" && existsSync(p) && !statSync(p).isDirectory();
        } catch {
          hit = false;
        }
        if (!hit) {
          out.push(d);
          continue;
        }
        n += 1;
        const shadow = join(dir, "path-shadow", `${bin}.${n}`);
        mkdirSync(shadow, { recursive: true });
        for (const e of readdirSync(d)) if (e !== bin) symlinkSync(join(d, e), join(shadow, e));
        out.push(shadow);
      }
      env.PATH = out.join(delimiter);
      const still = spawnSync("sh", ["-c", `command -v ${bin}`], { env: { PATH: env.PATH }, encoding: "utf8" }).stdout.trim();
      if (still !== "") throw new Error(`hideReal: '${bin}' still resolves to ${still}`);
    },
    run(args, opts = {}) {
      const e: Record<string, string> = { ...env };
      for (const [k, v] of Object.entries(opts.env ?? {})) {
        if (v === undefined) delete e[k];
        else e[k] = v;
      }
      return new Promise((resolve, reject) => {
        const child = spawn(opts.program ?? ERIS, args, { cwd: opts.cwd ?? sb.cwd, env: e, stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        child.stdout?.on("data", (d: Buffer) => out.push(d));
        child.stderr?.on("data", (d: Buffer) => err.push(d));
        if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`eris ${args.join(" ")} did not exit within ${opts.timeoutMs ?? 60_000}ms`));
        }, opts.timeoutMs ?? 60_000);
        child.on("error", reject);
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          const stdoutBytes = Buffer.concat(out);
          const stderrBytes = Buffer.concat(err);
          resolve({
            status: code ?? 128 + (signal ? (({ SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }) as Record<string, number>)[signal] ?? 0 : 0),
            stdout: stdoutBytes.toString("utf8"),
            stderr: stderrBytes.toString("utf8"),
            stdoutBytes,
            stderrBytes,
          });
        });
      });
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return sb;
}

// --- assertions (oracle::assert_*) ---------------------------------------------

function report(r: Run, why: string): string {
  return `${why}\n--- status ---\n${r.status}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
}

/**
 * The whole OUTPUT-CONTRACT §4 grammar in one assertion: exactly one `ERROR `
 * line, exactly one `slug: ` line carrying <slug>, exactly two `docs: ` lines
 * (local, then GitHub), order ERROR < slug < every fix < docs, the prefixes
 * INCLUDING their single trailing space, exit 1, and nothing on stdout. The
 * GitHub line is under `docsBase`: core's, unless a distribution ran.
 */
export function expectFailBlock(r: Run, slug: string, docsBase = "https://github.com/sibylline-labs/eris/blob/main"): void {
  const lines = r.stderr.split("\n");
  const idx = (p: string) => lines.map((l, i) => (l.startsWith(p) ? i : -1)).filter((i) => i >= 0);
  const errs = idx("ERROR ");
  const slugs = idx("slug: ");
  const docs = idx("docs: ");
  const fixes = idx("fix: ");
  const problems: string[] = [];
  if (errs.length !== 1) problems.push(`expected exactly 1 'ERROR ' line, got ${errs.length}`);
  if (slugs.length !== 1) problems.push(`expected exactly 1 'slug: ' line, got ${slugs.length}`);
  if (docs.length !== 2) problems.push(`expected exactly 2 'docs: ' lines, got ${docs.length}`);
  if (!lines.includes(`slug: ${slug}`)) problems.push(`expected 'slug: ${slug}'`);
  if (errs.length && slugs.length && docs.length) {
    if (!(errs[0]! < slugs[0]!)) problems.push("ERROR must precede slug:");
    if (!(slugs[0]! < docs[0]!)) problems.push("slug: must precede docs:");
    const lastFix = fixes.at(-1);
    if (lastFix !== undefined && !(slugs[0]! < lastFix && lastFix < docs[0]!)) problems.push("fix: lines must sit between slug: and docs:");
  }
  if (!lines.some((l) => l.startsWith(`docs: ${docsBase}/`))) problems.push("expected the GitHub docs: line");
  if (r.status !== 1) problems.push(`expected exit 1, got ${r.status}`);
  if (r.stdoutBytes.length !== 0) problems.push("expected empty stdout");
  expect(problems, report(r, problems.join("; "))).toEqual([]);
}

/** Byte-exact: a lone newline on stdout is still contamination for `v=$(eris …); [ -z "$v" ]`. */
export function expectStdoutEmpty(r: Run): void {
  expect(r.stdoutBytes.length, report(r, "expected empty stdout")).toBe(0);
}

export function expectStderrEmpty(r: Run): void {
  expect(r.stderrBytes.length, report(r, "expected empty stderr")).toBe(0);
}

export function expectNoAnsi(text: string, r?: Run): void {
  expect(text.includes("\x1b"), r ? report(r, "expected no ANSI escapes") : "expected no ANSI escapes").toBe(false);
}

/** stdout parses as ONE JSON document and is nothing but JSON. */
export function expectStdoutJson(r: Run): unknown {
  let v: unknown;
  try {
    v = JSON.parse(r.stdout);
  } catch {
    throw new Error(report(r, "expected stdout to be a single JSON document"));
  }
  return v;
}

export function expectStatus(r: Run, status: number): void {
  expect(r.status, report(r, `expected exit ${status}`)).toBe(status);
}

// --- files ----------------------------------------------------------------------

export function modeOf(path: string): string {
  return (statSync(path).mode & 0o777).toString(8);
}

/** "<mode> <relpath>" per regular file under <dir>, byte-sorted (oracle::manifest). */
export function manifest(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b)))).map((f) => `${modeOf(join(dir, f))} ${f}`);
}

export function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** `git init` with an identity, so a commit in a fixture never depends on the host's config. */
export function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "bb@example.invalid");
  git(dir, "config", "user.name", "bb");
}

export function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

export const HAVE = (bin: string): boolean => Bun.which(bin) !== null;
