/**
 * deps.ts — what every loop verb runs on: the home, directory, clock and fetch (a test's, else the
 * process's), the gates endpoint on the `eris login` bearer of the org a directory acts as, and the
 * subprocess seam every child goes through (the SDK's `runCommand`: argv only, a deadline, the whole
 * tree killed on expiry).
 *
 * Invariants:
 *  - every child runs with `childEnv`: the caller's env minus its Claude Code session markers, eris's
 *    own bearer (`ERIS_YAKS_TOKEN`) and every name the build scrubs (`LoopDefaults.scrubEnv`), so a
 *    loop never inherits its launcher's session or token; a runtime a build supplies is handed that
 *    same env (`runtimeEnv`), never the caller's;
 *  - a child that cannot run, times out or is killed is a value, never a throw; the verb words it.
 */

import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isatty } from "node:tty";
import { type GatesEndpoint, gatesEndpoint, type RetryOpts } from "eris/gates-contract";
import { readEnv, RESOLVER_OWN_HEADING_SLUGS, resolveOrgBearer, runCommand, type VerbContext } from "../../src/cli/plugin";
import { type Ledger, ledgerOf } from "./claims";
import { stop, unwrap } from "./failure";
import { type LoopDefaults, type LoopTree, runtimesOf } from "./index";
import type { LoopRuntime, LoopRuntimeEnv } from "./runtime";

/** What a test injects; the process's own when absent. */
export interface LoopDeps {
  readonly home?: string;
  /** The directory the verb acts from (its org's bearer); `launch` uses its `--cwd`. */
  readonly cwd?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Wall-clock epoch milliseconds. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** `hand-back`'s body instead of fd 0. */
  readonly stdin?: string;
  /** `hand-back`'s 429 retry. */
  readonly retry?: RetryOpts;
}

/** A verb's resolved world. */
export interface Run {
  readonly ctx: VerbContext;
  readonly home: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof globalThis.fetch | undefined;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly deps: LoopDeps;
  /** One WARN line on stderr. */
  readonly warn: (line: string) => void;
  /** What the build supplies. */
  readonly defaults: LoopDefaults;
  /** The claim ledger: the primary directory, then the build's legacy ones. */
  readonly ledger: Ledger;
  /** The build's legacy session-name prefixes (`[]` for none); every `loopOf` reads them. */
  readonly legacyPrefixes: ReadonlyArray<string>;
  /** The env names (and `X*` prefixes) no child inherits, beside the built-in ones. */
  readonly scrub: ReadonlyArray<string>;
  /** The runtimes beside the built-in `claude`, in the build's order. */
  readonly runtimes: ReadonlyArray<readonly [string, LoopRuntime]>;
}

export function runOf(ctx: VerbContext, defaults: LoopDefaults, deps: LoopDeps): Run {
  const home = deps.home ?? ctx.env.HOME ?? homedir();
  return {
    ctx,
    home,
    cwd: deps.cwd ?? process.cwd(),
    env: ctx.env,
    fetch: deps.fetch,
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? ((ms) => Bun.sleep(ms)),
    deps,
    warn: (line) => void ctx.stderr.write(`WARN ${line}\n`),
    defaults,
    ledger: ledgerOf(home, defaults.legacy?.claimDirs(home) ?? []),
    legacyPrefixes: defaults.legacy?.sessionPrefixes ?? [],
    scrub: defaults.scrubEnv ?? [],
    runtimes: runtimesOf(defaults),
  };
}

/** What a supplied runtime runs on, acting from `cwd`: the run's clock and the scrubbed child env. */
export function runtimeEnv(run: Run, cwd = run.cwd): LoopRuntimeEnv {
  return { home: run.home, cwd, env: childEnv(run.env, run.scrub), fetch: run.fetch, now: run.now, sleep: run.sleep, warn: run.warn };
}

/** The gates endpoint on the `eris login` bearer of the org `cwd` acts as; no login stops with `eris-login-required`. */
export async function endpoint(run: Run, cwd = run.cwd): Promise<GatesEndpoint> {
  const bearer = await resolveOrgBearer({ home: run.home, env: run.env, cwd });
  if ("reason" in bearer) {
    const slug = RESOLVER_OWN_HEADING_SLUGS.has(bearer.slug) ? bearer.slug : "eris-login-required";
    const fix = slug === "eris-login-required" ? "Run 'eris login' once on this machine (or set ERIS_YAKS_TOKEN to a sib_ service token), then re-run." : bearer.fix;
    return stop({ slug, what: bearer.reason, fix, docs: `docs/ERRORS.md#${slug}`, exit: 3 });
  }
  return unwrap(gatesEndpoint(bearer.value.url, bearer.value.token, { fetch: run.fetch }));
}

/** eris's own bearer, which no loop child inherits. */
const SCRUBBED_ENV = new Set(["ERIS_YAKS_TOKEN"]);

/**
 * A loop child's env: the caller's, minus `CLAUDECODE`, `CLAUDE_CODE_*`, eris's bearer and each name in
 * `scrub` (an entry ending `*` drops every name it prefixes; `[]` for none).
 */
export function childEnv(env: Readonly<Record<string, string | undefined>>, scrub: ReadonlyArray<string>): Record<string, string> {
  const names = new Set(scrub.filter((s) => !s.endsWith("*")));
  const prefixes = scrub.filter((s) => s.endsWith("*") && s.length > 1).map((s) => s.slice(0, -1));
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(env)) {
    if (val === undefined || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || SCRUBBED_ENV.has(k)) continue;
    if (names.has(k) || prefixes.some((p) => k.startsWith(p))) continue;
    out[k] = val;
  }
  return out;
}

/** The executable `name` resolves to on the env's PATH, or null. */
export function which(name: string, env: Readonly<Record<string, string | undefined>>): string | null {
  for (const dir of (readEnv(env, "PATH") ?? "").split(":")) {
    if (dir === "") continue;
    const p = join(dir, name);
    try {
      if (statSync(p).isFile()) {
        accessSync(p, constants.X_OK);
        return p;
      }
    } catch {
      // not here
    }
  }
  return null;
}

/** `claude --bg` and `claude stop` return as soon as the job is registered or stopped. */
export const CHILD_TIMEOUT_MS = 60_000;
/** The longest child output a failure quotes. */
const DETAIL_MAX = 2000;

/** A child's outcome: it exited (any code), or it never produced one. */
export type ChildRun = { readonly kind: "exited"; readonly code: number; readonly stdout: string; readonly stderr: string } | { readonly kind: "failed"; readonly why: string };

/** Run `argv` to completion, stdin closed, under a deadline; never throws. */
export async function runChild(run: Run, argv: readonly string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<ChildRun> {
  const timeoutMs = opts.timeoutMs ?? CHILD_TIMEOUT_MS;
  let res;
  try {
    res = await runCommand(argv, { env: childEnv(run.env, run.scrub), timeoutMs, ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}) });
  } catch (e) {
    return { kind: "failed", why: `could not run ${argv[0] ?? ""}: ${(e as Error).message}` };
  }
  switch (res.kind) {
    case "ok":
    case "exit":
      return { kind: "exited", code: res.code, stdout: res.stdout.toString("utf8"), stderr: res.stderr.toString("utf8") };
    case "timeout":
      return { kind: "failed", why: `timed out after ${timeoutMs / 1000}s` };
    case "signal":
      return { kind: "failed", why: `killed by ${res.signal}` };
    case "spawn-failed":
      return { kind: "failed", why: `could not run ${argv[0] ?? ""}: ${res.message}` };
  }
}

/** What a failed child said: stderr, else stdout, trimmed. */
export const childDetail = (r: { readonly stdout: string; readonly stderr: string }): string => (r.stderr.trim() || r.stdout.trim()).slice(0, DETAIL_MAX);

/** `hand-back`'s body: the injected text, else stdin; a terminal with nothing piped is no body, never a prompt. */
export const readStdin = (deps: LoopDeps): string => deps.stdin ?? (isatty(0) ? "" : readFileSync(0, "utf8"));

/** The org's verified tree for `req`, through what the build supplies; a build that supplies none refuses. */
export async function treeOf(defaults: LoopDefaults, run: Run, req: { cwd: string; claimSha?: string | undefined }): Promise<LoopTree> {
  if (defaults.policy === undefined) {
    return stop({
      slug: "doctrine-file-missing",
      what: "this eris build supplies no org policy tree, so it has no loop bodies to read",
      fix: "Use a build that composes the doctrine plugin's pulled tree into the loop plugin (plugins/index.ts), then 'eris doctrine pull'.",
      docs: "docs/ERRORS.md#doctrine-file-missing",
      exit: 3,
    });
  }
  return unwrap(await defaults.policy(run.ctx, { cwd: req.cwd, home: run.home, claimSha: req.claimSha, fetch: run.fetch }));
}
