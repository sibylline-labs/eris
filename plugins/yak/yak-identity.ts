/**
 * yak-identity.ts — token/URL config resolution and caller identity for
 * `eris yak`.
 *
 * Owns the parts of a yak submission that are ABOUT THE CALLER, not about the
 * report: which Yaks endpoint to talk to, what bearer token authenticates the
 * call, a stable per-machine `device_id`, and the task-scoped `execution_id`.
 * `plugins/yak/yak-context.ts` (sibling
 * file, same phase) owns the richer best-effort PROVENANCE record and reuses
 * `runBounded` from here for its own bounded git probes.
 *
 * Every resolver returns a typed outcome — `{ value }` on success, `{ reason,
 * slug }` on failure — and NEVER throws. A caller composing several of these
 * tells them apart with one discriminant, `"reason" in result`. The exit split — agent misuse is a hard exit 1, an
 * environment/config/transport problem is a warn + exit 0 — is made by
 * `yak-submit.ts`/`yak.ts`, not here: this module only produces the typed
 * failure and its slug, and leaves the exit-code mapping to the layer that
 * knows the difference.
 *
 * Config file: ONE `~/.eris/yaks.json` holding
 * `{ url?, token? }`, `0600`. `~/.eris` itself is `0755` (observed)
 * — the FILE's mode is the only guard, so a group- or world-readable
 * `yaks.json` is refused outright, never parsed, never logged. The token
 * value itself never appears in any error message this module produces.
 *
 * `device-id`: minted once with
 * `crypto.randomUUID()` if absent, written `0600` EXPLICITLY via `chmod`
 * after creation — never inferred from the directory's `0755` mode or from
 * whatever the process umask happens to be. Concurrency note: two literally
 * simultaneous first-time callers may each mint their own uuid and race the
 * final `rename` — POSIX rename is atomic, so the file itself is never
 * corrupted, but the exact interleaving of "my rename finished" vs "the
 * other racer's rename finished" is not observable from inside either call,
 * so this is "concurrent-safe enough" (plan's own phrase) in the sense that
 * matters: the file always holds one well-formed uuid and every caller after
 * the dust settles reads the same value. It is not a distributed lock.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// --- Slugs ----------------------------------------------------------------

/**
 * The `docs/ERRORS.md` slugs this module emits. `tests/errors-doc.test.ts`
 * harvests the members of every `…Slug` union and fails when a `### <slug>`
 * heading is missing.
 */
export type YakIdentitySlug =
  | "yak-config-permissive"
  | "yak-config-malformed"
  | "yak-config-unwritable"
  | "yak-token-unresolved"
  | "yak-device-id-unwritable";

/** One resolver's failure: a human-facing reason and its slug, paired on one
 *  line. */
export type IdentityFailure<TSlug extends string = YakIdentitySlug> = {
  reason: string;
  slug: TSlug;
};

/** One resolver's success. */
export type IdentityOk<T> = { value: T };

/** `{ value }` on success, `{ reason, slug }` on failure — discriminated the
 *  same way `PragmaRead` is: `"reason" in outcome`. */
export type IdentityOutcome<T, TSlug extends string = YakIdentitySlug> =
  | IdentityOk<T>
  | IdentityFailure<TSlug>;

// --- Paths ------------------------------------------------------------------

export function yaksConfigPath(home: string = homedir()): string {
  return join(home, ".eris", "yaks.json");
}

export function deviceIdPath(home: string = homedir()): string {
  return join(home, ".eris", "device-id");
}

// --- Token/URL config file ---------------------------------------------------

export type YaksFileConfig = { url?: string; token?: string };

/**
 * Read `~/.eris/yaks.json`. An ABSENT file is not an error — `{ value: {} }`
 * lets `ERIS_YAKS_TOKEN`/`ERIS_YAKS_URL` alone supply what's needed. A group-
 * or world-READABLE file is refused before a single byte of its content is
 * read: `fs.stat` runs, the mode bits are checked, and only then does
 * `fs.readFile` run — so a permissive file's token can never reach a log
 * line or an error message by construction, not by discipline.
 */
export async function readYaksFileConfig(
  home: string = homedir(),
): Promise<IdentityOutcome<YaksFileConfig, "yak-config-permissive" | "yak-config-malformed">> {
  const path = yaksConfigPath(home);

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { value: {} };
    return {
      reason: `cannot stat ${path}: ${(err as Error).message}`,
      slug: "yak-config-malformed",
    };
  }

  // Group-read (0o040) or other-read (0o004) — same two bits a `chmod 0644`
  // sets. ~/.eris is 0755 (observed) so this is the only guard.
  const groupOrWorldReadable = (stat.mode & 0o044) !== 0;
  if (groupOrWorldReadable) {
    const mode = (stat.mode & 0o777).toString(8).padStart(3, "0");
    return {
      reason: `${path} is group- or world-readable (mode ${mode}) — refusing to read a bearer-token file with permissive bits`,
      slug: "yak-config-permissive",
    };
  }

  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    return {
      reason: `cannot read ${path}: ${(err as Error).message}`,
      slug: "yak-config-malformed",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reason: `${path} is not valid JSON`, slug: "yak-config-malformed" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { reason: `${path} must be a JSON object`, slug: "yak-config-malformed" };
  }

  const obj = parsed as Record<string, unknown>;
  const config: YaksFileConfig = {};
  if (typeof obj.url === "string" && obj.url.length > 0) config.url = obj.url;
  if (typeof obj.token === "string" && obj.token.length > 0) config.token = obj.token;
  return { value: config };
}

/**
 * Replace `~/.eris/yaks.json` with `config`, whole. The temp file sits in the
 * same directory and is CREATED at 0600 (`wx`: it never exists readable, and
 * an existing path is never followed), then renamed over the destination, so
 * a reader sees the old file or the new one and never a half-written or
 * readable one. `~/.eris` is created 0700 when absent. The failure names the
 * path, never a field's value. Returns the path written.
 */
export async function writeYaksFileConfig(
  config: YaksFileConfig,
  home: string = homedir(),
): Promise<IdentityOutcome<string, "yak-config-unwritable">> {
  const path = yaksConfigPath(home);
  const tmp = join(home, ".eris", `.yaks.json.tmp-${process.pid}-${crypto.randomUUID()}`);
  const body: YaksFileConfig = {};
  if (config.url !== undefined) body.url = config.url;
  if (config.token !== undefined) body.token = config.token;
  try {
    await fs.mkdir(join(home, ".eris"), { recursive: true, mode: 0o700 });
    await fs.writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(tmp, path);
    return { value: path };
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    return { reason: `cannot write ${path}: ${(err as NodeJS.ErrnoException).code ?? "error"}`, slug: "yak-config-unwritable" };
  }
}

/** `ERIS_YAKS_TOKEN` env → `yaks.json`'s `token`. Never includes
 *  the resolved token's own value in a failure message — there IS no token on
 *  the failure path, by construction. */
export function resolveToken(
  fileConfig: YaksFileConfig,
  env: Record<string, string | undefined> = process.env,
): IdentityOutcome<string, "yak-token-unresolved"> {
  const fromEnv = env.ERIS_YAKS_TOKEN;
  if (fromEnv && fromEnv.length > 0) return { value: fromEnv };
  if (fileConfig.token && fileConfig.token.length > 0) return { value: fileConfig.token };
  return {
    reason: "no yaks token: run 'eris login', or set ERIS_YAKS_TOKEN",
    slug: "yak-token-unresolved",
  };
}

/** Where a Yaks endpoint lives when nothing names another one. */
export const DEFAULT_YAKS_URL = "https://api.sibylline.group";

/**
 * The one Yaks base URL resolver, for `eris login` and every yak client:
 * `--url` (the caller passes the flag's value) → `ERIS_YAKS_URL` env →
 * `yaks.json`'s `url` → `DEFAULT_YAKS_URL`. An empty value at any step falls
 * through to the next, so a URL always resolves; `source` says which step won.
 */
export type YaksUrlSource = "flag" | "env" | "config" | "default";

export function resolveUrl(
  fileConfig: YaksFileConfig,
  env: Record<string, string | undefined> = process.env,
  flag?: string,
): { value: string; source: YaksUrlSource } {
  if (flag !== undefined && flag.length > 0) return { value: flag, source: "flag" };
  const fromEnv = env.ERIS_YAKS_URL;
  if (fromEnv && fromEnv.length > 0) return { value: fromEnv, source: "env" };
  if (fileConfig.url && fileConfig.url.length > 0) return { value: fileConfig.url, source: "config" };
  return { value: DEFAULT_YAKS_URL, source: "default" };
}

// --- device_id ----------------------------------------------------------------

/**
 * Read `~/.eris/device-id`, minting it once (uuid4, `0600`) if absent.
 * Written via temp-file-in-the-same-dir + rename (the atomic-install idiom),
 * so a
 * reader never observes a partially-written id, and the mode is set with an
 * explicit `chmod` after creation rather than trusted to `open()`'s mode
 * argument (which is still subject to umask at the syscall level) or to the
 * directory's `0755`.
 */
export async function resolveDeviceId(
  home: string = homedir(),
): Promise<IdentityOutcome<string, "yak-device-id-unwritable">> {
  const dir = join(home, ".eris");
  const finalPath = deviceIdPath(home);

  try {
    const existing = (await fs.readFile(finalPath, "utf8")).trim();
    if (existing.length > 0) return { value: existing };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        reason: `cannot read ${finalPath}: ${(err as Error).message}`,
        slug: "yak-device-id-unwritable",
      };
    }
  }

  const minted = crypto.randomUUID();
  const tmpPath = join(dir, `.device-id.tmp-${process.pid}-${crypto.randomUUID()}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmpPath, `${minted}\n`, { mode: 0o600 });
    await fs.chmod(tmpPath, 0o600); // explicit — never rely on umask or the 0755 directory mode
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    return {
      reason: `cannot mint device id at ${finalPath}: ${(err as Error).message}`,
      slug: "yak-device-id-unwritable",
    };
  }

  // Best-effort convergence: re-read whatever ended up on disk so this call's
  // return value matches the file even if another racer's rename landed
  // after ours (see header — this is not a distributed lock).
  try {
    const onDisk = (await fs.readFile(finalPath, "utf8")).trim();
    return { value: onDisk.length > 0 ? onDisk : minted };
  } catch {
    return { value: minted };
  }
}

// --- execution_id ---------------------------------------------------------

/**
 * `ERIS_YAK_EXECUTION_ID` → `CLAUDE_CODE_SESSION_ID` → `CLAUDE_CODE_HOST_SESSION_ID`
 * → `ERIS_YAK_SHELL_ID` → `sh:<ppid>` (the shell-session rung is explained
 * below). The rungs are NOT interchangeable values and
 * a fallback — they can hold genuinely different ids under
 * `CLAUDE_CODE_ENTRYPOINT=claude-desktop` (observed), which changes
 * the dedup GRAIN a yak submission lands at. `rung` is returned alongside
 * `value` so a caller that cares (logging, the receipt's provenance) can see
 * which one fired without re-deriving the ladder.
 *
 * The id should be "shared by all reports in that task". Outside Claude Code,
 * NEITHER `CLAUDE_CODE_SESSION_ID` nor `CLAUDE_CODE_HOST_SESSION_ID` is set,
 * so every plain-terminal `eris yak` call fell straight to `sh:<ppid>` — and
 * `ppid` there is `process.ppid` as OBSERVED BY `bun`, not by the human's
 * shell: whenever a launcher forks between that shell and bun, the observed
 * ppid is the fork's, fresh on EVERY invocation, so back-to-back `eris yak`
 * calls from one terminal mint different execution_ids and therefore
 * different idempotency keys, defeating dedup entirely. `ERIS_YAK_SHELL_ID`
 * is the pid of the shell that invoked `eris` — set by the `eris yak` verb
 * (`plugins/yak/handlers.ts`: the router's `process.ppid`, since the shim
 * `exec`s bun) — which stays constant
 * across every `eris yak` call from that terminal/session for as long as that
 * shell lives. It sits between the CLAUDE_CODE rungs and the final `sh:<ppid>`
 * fallback: still process-identity-based (a pid CAN theoretically be reused
 * after that shell exits, the same caveat every rung below "override"
 * already carries), but stable for exactly the unit wanted outside
 * Claude Code — one human's one terminal session — where the two rungs above
 * it are never set at all. The final `sh:<ppid>` rung is UNCHANGED and still
 * fires for a caller that bypasses the `eris yak` verb entirely (invoking
 * `yak.ts` directly, as this module's own tests do) — there, `ERIS_YAK_SHELL_ID`
 * is legitimately absent and no shell-session value exists to prefer.
 */
export type ExecutionIdRung = "override" | "session" | "host-session" | "shell-session" | "shell";

export function resolveExecutionId(
  env: Record<string, string | undefined> = process.env,
  ppid: number = process.ppid,
): { value: string; rung: ExecutionIdRung } {
  const override = env.ERIS_YAK_EXECUTION_ID;
  if (override && override.length > 0) return { value: override, rung: "override" };
  const session = env.CLAUDE_CODE_SESSION_ID;
  if (session && session.length > 0) return { value: session, rung: "session" };
  const hostSession = env.CLAUDE_CODE_HOST_SESSION_ID;
  if (hostSession && hostSession.length > 0) return { value: hostSession, rung: "host-session" };
  const shellId = env.ERIS_YAK_SHELL_ID;
  if (shellId && shellId.length > 0) return { value: `shell:${shellId}`, rung: "shell-session" };
  return { value: `sh:${ppid}`, rung: "shell" };
}

// --- Bounded subprocess runner (shared with yak-context.ts) -----------------

/**
 * A subprocess's outcome: `{ ok: true, stdout }` on a clean exit, `{ ok:
 * false }` on ANY failure (spawn error, non-zero exit, timeout kill). Kept
 * apart from "trimmed non-empty or undefined" on purpose — `git status
 * --porcelain` on a clean tree exits 0 with EMPTY stdout, and collapsing that
 * to "absent" the way an empty free-text field would be would confuse
 * "measured: clean" with "not measured".
 * Callers that want "empty means absent" (a git sha, an origin url) call
 * `asText` on the result; callers that need to tell
 * "clean" from "unmeasured" (a dirty flag) read `.ok` and `.stdout` directly.
 */
export type BoundedResult = { ok: true; stdout: string } | { ok: false };

export type Runner = (cmd: string[], cwd: string, timeoutMs: number) => Promise<BoundedResult>;

/**
 * Spawn `cmd`, capture stdout, and NEVER throw or hang past `timeoutMs`: the
 * process is killed on timeout and `proc.exited` is always awaited (in every
 * branch, including the timeout/error ones) so nothing is left backgrounded.
 * A process that is tracked by the wrong pid, or spawned and never reaped,
 * outlives its caller and can hold a pipe open forever. `Bun.spawn` here is
 * always awaited to exit before this function returns.
 */
export async function runBounded(cmd: string[], cwd: string, timeoutMs: number): Promise<BoundedResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  } catch {
    return { ok: false };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }, timeoutMs);

  try {
    // `stdout: "pipe"` above guarantees a ReadableStream at runtime; Bun's
    // overload resolution doesn't narrow `proc.stdout`'s type from a plain
    // `string[]` cmd argument, so this cast just states what we already
    // asked for.
    const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
    const code = await proc.exited;
    if (code !== 0 || timedOut) return { ok: false };
    return { ok: true, stdout };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
    // Reap unconditionally: on the happy path `proc.exited` above already
    // settled and this resolves immediately; on the throw path it may not
    // have been awaited yet, so this is what guarantees the child is never
    // left running past this function's return.
    try {
      proc.kill();
    } catch {
      // already exited
    }
    await proc.exited.catch(() => undefined);
  }
}

/** Convenience for the common "trimmed non-empty string, else absent" case —
 *  a git sha/branch/origin/root. See
 *  `BoundedResult`'s header for why the boolean-fact case (dirty) must NOT
 *  go through this. */
export function asText(result: BoundedResult): string | undefined {
  if (!result.ok) return undefined;
  const trimmed = result.stdout.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
