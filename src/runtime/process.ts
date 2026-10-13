/**
 * process.ts — the subprocess adapter.
 *
 * Every external binary the TS side runs goes through a `Runner`, so tests
 * inject a fake (`createFakeRunner`, testing/fake-runner.ts) instead of stubbing
 * PATH, and the safety rules live in ONE place:
 *
 *   - argv arrays only, never a shell string (`shell` is never set).
 *   - stdout/stderr captured as Buffers. The ONLY stderr a result exposes is
 *     the one passed through `redact`, so a caller echoing it into a failure
 *     block cannot leak what the hook removes (a tool's `--log-http` mode
 *     streams request bodies to stderr).
 *   - `BUN_CONFIG_VERBOSE_FETCH` is stripped from every child env: under it
 *     bun prints request bodies and `Authorization` headers to stderr.
 *   - an explicit timeout on every call; on expiry the WHOLE tree dies.
 *   - the result distinguishes ok / exit / signal / timeout / spawn-failed,
 *     so "could not tell" never reads as a clean non-zero.
 *
 * WHY THE TREE IS ENUMERATED:
 * a child spawned `detached` leads its own process group, but that is not
 * sufficient — any wrapped tool may `setpgid` into a group of its own (GNU
 * `timeout` does), and a group kill cannot reach it. It then reparents to
 * PID 1 holding the capture pipe, and the reader never sees EOF. So the tree
 * is read out of ONE `ps` snapshot taken BEFORE the first signal (a killed
 * parent's children reparent within milliseconds and become unreachable by
 * ppid), and every group found is signalled except our own, then every pid.
 * TERM first; KILL after `killGraceMs`; and if the pipes still have not closed
 * after that, they are destroyed and the result says so (`forcedClose`), so
 * the call always settles and a leaked kill is never reported as clean.
 *
 * WHY A SIGNAL REGISTRY: a `detached` child is outside the terminal's
 * foreground group, so a Ctrl-C no longer reaches it — bun would die and the
 * child would run on under PID 1 holding the pipe (an orphan seen in practice). While
 * any child is live, SIGINT/SIGTERM/SIGHUP are forwarded to every tracked
 * tree, and when ours is the only listener the signal is re-raised so the
 * default 128+n death is preserved. `detached: false` opts out, for a child
 * that must share the caller's group and owns its own signal handling.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { resolveConcurrency, runPool } from "../../ts/lib/pool";

export interface RunOptions {
  /** Hard deadline in ms. Required: an unbounded wait is how CLIs hang. */
  timeoutMs: number;
  /** TERM → KILL escalation delay once the deadline fires. Default 2000. */
  killGraceMs?: number;
  cwd?: string;
  /** Child env. Defaults to process.env. BUN_CONFIG_VERBOSE_FETCH is always removed. */
  env?: Record<string, string | undefined>;
  /** Written to the child's stdin, which is then closed. Absent → stdin is /dev/null. */
  input?: string | Buffer;
  /** Applied to captured stderr before it is exposed on the result. */
  redact?: (stderr: string) => string;
  /** Own process group (default true). See the file header before turning it off. */
  detached?: boolean;
}

interface Captured {
  stdout: Buffer;
  /** Already redacted. There is no raw copy. */
  stderr: Buffer;
}

export type RunResult =
  | (Captured & { kind: "ok"; code: 0 })
  | (Captured & { kind: "exit"; code: number })
  | (Captured & { kind: "signal"; signal: string })
  | (Captured & {
      kind: "timeout";
      timeoutMs: number;
      /** TERM was not enough; the tree was sent KILL. */
      escalated: boolean;
      /** The pipes were still open after KILL and were destroyed. Something
       *  outside the enumerated tree may still hold them. */
      forcedClose: boolean;
    })
  | (Captured & { kind: "spawn-failed"; errno: string; message: string });

export interface Runner {
  run(argv: readonly string[], opts: RunOptions): Promise<RunResult>;
}

const STRIPPED_ENV = ["BUN_CONFIG_VERBOSE_FETCH"];
const FORCE_CLOSE_MS = 1000;

export function childEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !STRIPPED_ENV.includes(k)) out[k] = v;
  }
  return out;
}

// --- tree enumeration -------------------------------------------------------------

interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
}

/** (pid, ppid, pgid) for every process — POSIX `ps`, same columns on procps
 *  and BSD. Empty on failure (the caller falls back to the roots alone). */
function psSnapshot(): PsRow[] {
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" });
  if (r.status !== 0 || typeof r.stdout !== "string") return [];
  const rows: PsRow[] = [];
  for (const line of r.stdout.split("\n")) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid !== undefined && pgid !== undefined && !Number.isNaN(ppid) && !Number.isNaN(pgid)) {
      rows.push({ pid, ppid, pgid });
    }
  }
  return rows;
}

/** Every pid in the subtrees rooted at `roots` (roots included). */
function subtree(rows: PsRow[], roots: Iterable<number>): Set<number> {
  const all = new Set(roots);
  let frontier = new Set(all);
  while (frontier.size > 0) {
    const next = new Set<number>();
    for (const row of rows) {
      if (frontier.has(row.ppid) && !all.has(row.pid)) {
        all.add(row.pid);
        next.add(row.pid);
      }
    }
    frontier = next;
  }
  return all;
}

function trySignal(target: number, sig: NodeJS.Signals): void {
  try {
    process.kill(target, sig);
  } catch {
    // Already gone (ESRCH) or not ours (EPERM): nothing to reap.
  }
}

/**
 * Signal every process in the trees rooted at `roots`, plus `known` pids
 * enumerated earlier (they may have reparented to PID 1 since). Groups first
 * (reaching anything spawned into a target's group after the snapshot), never
 * our own group or 0/1; then every pid. Returns the pids it found, for a later
 * escalation to include.
 */
export function signalTree(
  roots: Iterable<number>,
  sig: NodeJS.Signals | readonly NodeJS.Signals[],
  known: Iterable<number> = [],
): Set<number> {
  const sigs = typeof sig === "string" ? [sig] : sig;
  const rows = psSnapshot();
  const live = new Set(rows.map((r) => r.pid));
  const targets = subtree(rows, roots);
  for (const pid of known) if (live.has(pid)) targets.add(pid);
  if (rows.length === 0) {
    for (const pid of roots) targets.add(pid);
  }
  const selfPgid = rows.find((r) => r.pid === process.pid)?.pgid;
  const groups = new Set<number>();
  for (const row of rows) if (targets.has(row.pid)) groups.add(row.pgid);
  for (const s of sigs) {
    for (const g of groups) {
      if (g > 1 && g !== selfPgid) trySignal(-g, s);
    }
    for (const pid of targets) if (pid > 1 && pid !== process.pid) trySignal(pid, s);
  }
  return targets;
}

// --- live-child registry (signal forwarding) --------------------------------------

const FORWARDED: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const liveRoots = new Set<number>();
const handlers = new Map<NodeJS.Signals, () => void>();
let exitHook: (() => void) | undefined;

const SIGNAL_GRACE_MS = 1000;
let pending: { sig: NodeJS.Signals; known: Set<number>; timer: ReturnType<typeof setTimeout> } | undefined;

/**
 * Forward the signal AND a TERM to every tracked tree: a background job in a
 * non-interactive bash runs with SIGINT ignored, so the signal alone leaves
 * exactly the orphan this exists to prevent (observed: a `perl … &` grandchild
 * survived a forwarded SIGINT). Then give the trees `SIGNAL_GRACE_MS` to close
 * — their `run` calls settle normally — KILL whatever is left, and, when ours
 * is the only listener, re-raise so the caller dies by the default 128+n. A
 * second signal during the grace escalates immediately.
 */
function onSignal(sig: NodeJS.Signals): void {
  if (pending) {
    finishSignal();
    return;
  }
  const known = signalTree(liveRoots, sig === "SIGTERM" ? ["SIGTERM"] : [sig, "SIGTERM"]);
  pending = { sig, known, timer: setTimeout(finishSignal, SIGNAL_GRACE_MS) };
  if (liveRoots.size === 0) finishSignal();
}

function finishSignal(): void {
  if (!pending) return;
  const { sig, known, timer } = pending;
  pending = undefined;
  clearTimeout(timer);
  signalTree(liveRoots, "SIGKILL", known);
  if (process.listenerCount(sig) === 1 && handlers.get(sig)) {
    // Ours is the only listener: restore the default disposition and die by
    // the same signal, so the caller sees 128+n exactly as without us.
    uninstall();
    process.kill(process.pid, sig);
    return;
  }
  if (liveRoots.size === 0) uninstall();
}

function install(): void {
  if (handlers.size > 0) return;
  for (const sig of FORWARDED) {
    const h = () => onSignal(sig);
    handlers.set(sig, h);
    process.on(sig, h);
  }
  exitHook = () => {
    if (liveRoots.size > 0) signalTree(liveRoots, "SIGTERM");
  };
  process.on("exit", exitHook);
}

function uninstall(): void {
  for (const [sig, h] of handlers) process.removeListener(sig, h);
  handlers.clear();
  if (exitHook) process.removeListener("exit", exitHook);
  exitHook = undefined;
}

function track(pid: number): void {
  liveRoots.add(pid);
  install();
}

/** `pid` is undefined for a run that never produced a child (spawn failed): it only disarms. */
function untrack(pid: number | undefined): void {
  if (pid !== undefined) liveRoots.delete(pid);
  if (liveRoots.size > 0) return;
  if (pending) finishSignal();
  else uninstall();
}

// --- the real runner ---------------------------------------------------------------

export const nodeRunner: Runner = {
  run(argv, opts) {
    return new Promise<RunResult>((resolveResult) => {
      const [cmd, ...args] = argv;
      const detached = opts.detached ?? true;
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const captured = (): Captured => ({
        stdout: Buffer.concat(out),
        // Decode only when there is a hook: an identity round-trip through
        // UTF-8 would rewrite non-UTF-8 bytes.
        stderr: opts.redact
          ? Buffer.from(opts.redact(Buffer.concat(err).toString("utf8")), "utf8")
          : Buffer.concat(err),
      });

      let settled = false;
      let child: ChildProcess;
      const timers: ReturnType<typeof setTimeout>[] = [];
      let timedOut = false;
      let escalated = false;
      let forcedClose = false;
      let enumerated = new Set<number>();

      const settle = (r: RunResult) => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        untrack(child?.pid);
        resolveResult(r);
      };

      if (!cmd) {
        settle({ kind: "spawn-failed", errno: "EINVAL", message: "empty argv", ...captured() });
        return;
      }

      // Armed BEFORE the spawn: the child is running from inside spawn(), which
      // can take milliseconds to return on a cold process, and a signal in that
      // window would find no handler and kill us by the default disposition,
      // orphaning the tree. A JS handler only runs once the synchronous
      // spawn + track below has finished, so a signal never sees a live child
      // that is not yet tracked. A spawn that yields no pid (ENOENT) stays armed
      // with nothing tracked until its `error` settles; a signal in that gap
      // takes finishSignal's no-live-roots path, which re-raises it.
      install();
      try {
        child = spawn(cmd, args, {
          cwd: opts.cwd,
          env: childEnv(opts.env ?? process.env),
          stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
          detached,
        });
      } catch (e) {
        const ex = e as NodeJS.ErrnoException;
        settle({ kind: "spawn-failed", errno: ex.code ?? "UNKNOWN", message: ex.message, ...captured() });
        return;
      }

      child.stdout?.on("data", (d: Buffer) => out.push(d));
      child.stderr?.on("data", (d: Buffer) => err.push(d));
      if (child.pid) track(child.pid);

      child.on("error", (e: NodeJS.ErrnoException) => {
        // A spawn failure fires `error` (then `close`); an error after a
        // successful spawn is left to `close`, which still reports the exit.
        if (!child.pid) settle({ kind: "spawn-failed", errno: e.code ?? "UNKNOWN", message: e.message, ...captured() });
      });

      child.on("close", (code, signal) => {
        if (timedOut) {
          settle({ kind: "timeout", timeoutMs: opts.timeoutMs, escalated, forcedClose, ...captured() });
        } else if (signal) {
          settle({ kind: "signal", signal, ...captured() });
        } else if (code === 0) {
          settle({ kind: "ok", code: 0, ...captured() });
        } else if (code !== null) {
          settle({ kind: "exit", code, ...captured() });
        }
      });

      if (opts.input !== undefined && child.stdin) {
        child.stdin.on("error", () => {}); // EPIPE when the child ignores stdin
        child.stdin.end(opts.input);
      }

      const pid = child.pid;
      timers.push(
        setTimeout(() => {
          if (settled || !pid) return;
          timedOut = true;
          enumerated = signalTree([pid], "SIGTERM");
          timers.push(
            setTimeout(() => {
              if (settled) return;
              escalated = true;
              enumerated = signalTree([pid], "SIGKILL", enumerated);
              timers.push(
                setTimeout(() => {
                  if (settled) return;
                  forcedClose = true;
                  child.stdout?.destroy();
                  child.stderr?.destroy();
                  settle({ kind: "timeout", timeoutMs: opts.timeoutMs, escalated, forcedClose, ...captured() });
                }, FORCE_CLOSE_MS),
              );
            }, opts.killGraceMs ?? 2000),
          );
        }, opts.timeoutMs),
      );
    });
  },
};

// --- fan-out -------------------------------------------------------------

export interface RunJob {
  argv: readonly string[];
  opts: RunOptions;
}

/**
 * Run `jobs` at most N in flight, results in input order. N is
 * `ERIS_BATCH_CONCURRENCY`, CLAMPED to 8 when unset/invalid (ts/lib/pool.ts)
 * — a typo must never turn a batch into an unbounded fan-out.
 */
export function runMany(
  jobs: readonly RunJob[],
  opts: { runner?: Runner; env?: Record<string, string | undefined> } = {},
): Promise<RunResult[]> {
  const runner = opts.runner ?? nodeRunner;
  const env = opts.env ?? process.env;
  return runPool(jobs, resolveConcurrency(env.ERIS_BATCH_CONCURRENCY), (job) => runner.run(job.argv, job.opts));
}
