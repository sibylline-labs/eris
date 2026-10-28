/**
 * yak-context.ts — best-effort provenance gather for `eris yak`.
 *
 * Produces a `YakProvenance` record (`@sibylline-labs/yak-contract`) — six
 * optional categories, each a permissive record:
 * `execution`, `harness`, `device`, `process`, `repo`, `git`. NEVER a gate,
 * NEVER a delay a caller should notice: every individual probe is wrapped so
 * one failure drops exactly that key, and the WHOLE gather is time-capped so
 * a slow filesystem or a hung `git` cannot make `eris yak` itself hang.
 *
 * Explicitly OUT of this module, because a provenance probe must never spawn
 * work it cannot bound or reap, or prompt the user:
 *
 *   - no cloud CLI, no keychain read
 *   - no config merge (no root/leaf deep-merge, excludes or overrides) —
 *     `repo.service` below is a raw single-file peek at the nearest
 *     `eris.yaml`
 *   - no unbounded fan-out — exactly five bounded, individually-reaped `git`
 *     subprocesses (`gatherGit`), run in parallel, each capped at
 *     `GIT_PROBE_TIMEOUT_MS`
 *
 * `provenance` is redacted too: an origin URL can carry a token. That
 * redaction pass is `packages/outbound-scan/src/redact.ts`, applied by the submission
 * core (`yak-submit.ts`), which is where the whole payload — `summary`, `body`,
 * `evidence`, AND this provenance record — gets one redaction pass before
 * key derivation. This module only gathers; it does not redact.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import type { YakProvenance } from "eris/yak-contract";
import { asText, runBounded, type Runner } from "./yak-identity";

const GIT_PROBE_TIMEOUT_MS = 500;
/** Overall wall-clock budget for the whole gather. Generous headroom over
 *  the five GIT_PROBE_TIMEOUT_MS probes (which run in PARALLEL, so their
 *  worst case is ~one timeout, not five) plus the synchronous/fs-only
 *  categories, while still being "an agent won't notice this" fast for a
 *  mid-task CLI call. If this fires, every category still in flight is
 *  simply omitted — never awaited to completion, never thrown. */
const OVERALL_GATHER_TIMEOUT_MS = 1_500;
/** Filesystem-root backstop for the `repo.service` walk-up. A real checkout
 *  never nests this deep; this exists so a symlink cycle or an unexpectedly
 *  deep tree can't turn a "cheap peek" into an unbounded walk. */
const REPO_WALK_MAX_DEPTH = 64;

export type ProvenanceOptions = {
  env?: Record<string, string | undefined>;
  cwd?: string;
  pid?: number;
  ppid?: number;
  run?: Runner;
};

/**
 * Gather best-effort provenance. Never throws, never exceeds
 * `OVERALL_GATHER_TIMEOUT_MS` in wall time regardless of how slow any single
 * probe is, and every category it returns has at least one key (an empty
 * category is omitted rather than emitted as `{}`: absent means nothing was
 * measured, so an empty object would claim a measurement that never happened).
 */
export async function gatherProvenance(opts: ProvenanceOptions = {}): Promise<YakProvenance> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const pid = opts.pid ?? process.pid;
  const ppid = opts.ppid ?? process.ppid;
  const run = opts.run ?? runBounded;

  const provenance: YakProvenance = {};

  const categories: Array<[keyof YakProvenance, Promise<Record<string, unknown> | undefined>]> = [
    ["execution", Promise.resolve(safeRecord(() => gatherExecution(env)))],
    ["harness", Promise.resolve(safeRecord(() => gatherHarness(env)))],
    ["device", Promise.resolve(safeRecord(() => gatherDevice()))],
    ["process", Promise.resolve(safeRecord(() => gatherProcess(env, cwd, pid, ppid)))],
    ["repo", safeRecordAsync(() => gatherRepo(cwd))],
    ["git", safeRecordAsync(() => gatherGit(cwd, run))],
  ];

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, OVERALL_GATHER_TIMEOUT_MS);
  });

  try {
    await Promise.race([
      Promise.allSettled(
        categories.map(([key, p]) =>
          p.then((rec) => {
            if (rec !== undefined) provenance[key] = rec;
          }),
        ),
      ),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  return provenance;
}

// --- per-field helpers --------------------------------------------------------

/** Set `rec[key]` only when `producer()` returns a defined value; a thrown
 *  error or an `undefined` return drops exactly this ONE field and nothing
 *  else in the record. */
function trySet<T>(rec: Record<string, unknown>, key: string, producer: () => T | undefined): void {
  try {
    const value = producer();
    if (value !== undefined) rec[key] = value;
  } catch {
    // this field drops; every other field in the same record is unaffected
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

/** Wrap a whole category producer: catch anything it throws, and treat a
 *  zero-key result as ABSENT (omit the category) rather than emitting `{}` —
 *  a category nobody could speak to is different from a category that spoke
 *  and said nothing, and only the record's own fields (via `trySet`) can
 *  legitimately be empty of content. */
function safeRecord(producer: () => Record<string, unknown>): Record<string, unknown> | undefined {
  try {
    const rec = producer();
    return Object.keys(rec).length > 0 ? rec : undefined;
  } catch {
    return undefined;
  }
}

async function safeRecordAsync(
  producer: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown> | undefined> {
  try {
    const rec = await producer();
    return Object.keys(rec).length > 0 ? rec : undefined;
  } catch {
    return undefined;
  }
}

// --- execution / harness / device / process (sync, no I/O) ------------------

/** Session identity — what task this yak belongs to, mirroring the
 *  `resolveExecutionId` ladder's own rungs (`yak-identity.ts`) as raw facts
 *  rather than the one resolved value, so a reader can see which rungs were
 *  actually populated in this process's environment. */
function gatherExecution(env: Record<string, string | undefined>): Record<string, unknown> {
  const rec: Record<string, unknown> = {};
  trySet(rec, "claude_code_session_id", () => nonEmpty(env.CLAUDE_CODE_SESSION_ID));
  trySet(rec, "claude_code_host_session_id", () => nonEmpty(env.CLAUDE_CODE_HOST_SESSION_ID));
  trySet(rec, "entrypoint", () => nonEmpty(env.CLAUDE_CODE_ENTRYPOINT));
  return rec;
}

/** Which harness is running, and what version of it — the three env vars
 *  actually OBSERVED set in a live Claude Code session (`CLAUDECODE=1`,
 *  `AI_AGENT=claude-code_2-1-222_agent`, `CLAUDE_AGENT_SDK_VERSION=0.3.222`),
 *  not a guessed name. `AI_AGENT`'s value already embeds a version-shaped
 *  string; `CLAUDE_AGENT_SDK_VERSION` is a second, more literal version
 *  fact when the harness sets it. */
function gatherHarness(env: Record<string, string | undefined>): Record<string, unknown> {
  const rec: Record<string, unknown> = {};
  trySet(rec, "claudecode", () => nonEmpty(env.CLAUDECODE));
  trySet(rec, "ai_agent", () => nonEmpty(env.AI_AGENT));
  trySet(rec, "claude_agent_sdk_version", () => nonEmpty(env.CLAUDE_AGENT_SDK_VERSION));
  return rec;
}

function gatherDevice(): Record<string, unknown> {
  const rec: Record<string, unknown> = {};
  trySet(rec, "hostname", () => nonEmpty(hostname()));
  trySet(rec, "platform", () => nonEmpty(process.platform));
  trySet(rec, "arch", () => nonEmpty(process.arch));
  return rec;
}

function gatherProcess(
  env: Record<string, string | undefined>,
  cwd: string,
  pid: number,
  ppid: number,
): Record<string, unknown> {
  const rec: Record<string, unknown> = {};
  trySet(rec, "cwd", () => nonEmpty(cwd));
  trySet(rec, "pid", () => pid);
  trySet(rec, "ppid", () => ppid);
  trySet(rec, "shell", () => nonEmpty(env.SHELL));
  return rec;
}

// --- repo (a raw single-file peek, never a config merge) -------------------

async function gatherRepo(cwd: string): Promise<Record<string, unknown>> {
  const rec: Record<string, unknown> = {};
  const service = await findNearestErisYamlService(cwd);
  if (service !== undefined) rec.service = service;
  return rec;
}

/**
 * Walk up from `startDir` looking for the nearest `eris.yaml` and read its
 * top-level `service:` field directly — no root/leaf merge, no
 * excludes/overrides. Bounded two ways: a hard iteration ceiling
 * (`REPO_WALK_MAX_DEPTH`) and stopping at the enclosing git checkout's root
 * (a `.git` entry, file or directory), so this cheap peek never wanders into
 * a sibling repo above the one it was invoked from.
 */
async function findNearestErisYamlService(startDir: string): Promise<string | undefined> {
  let dir = startDir;
  for (let i = 0; i < REPO_WALK_MAX_DEPTH; i++) {
    const candidate = join(dir, "eris.yaml");
    try {
      const raw = await fs.readFile(candidate, "utf8");
      const parsed = Bun.YAML.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const service = (parsed as Record<string, unknown>).service;
        if (typeof service === "string" && service.length > 0) return service;
      }
      // A manifest exists here but has no usable `service:` — it is still
      // the NEAREST one, so stop rather than walking past it.
      return undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return undefined; // unreadable — drop, never throw
    }

    if (await isGitCheckoutRoot(dir)) return undefined; // reached the repo root with no manifest

    const parent = dirname(dir);
    if (parent === dir) return undefined; // filesystem root
    dir = parent;
  }
  return undefined;
}

async function isGitCheckoutRoot(dir: string): Promise<boolean> {
  try {
    await fs.access(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

// --- git (five bounded, individually-reaped subprocesses) -------------------

async function gatherGit(cwd: string, run: Runner): Promise<Record<string, unknown>> {
  const rec: Record<string, unknown> = {};

  const [root, origin, branch, sha, status] = await Promise.all([
    run(["git", "rev-parse", "--show-toplevel"], cwd, GIT_PROBE_TIMEOUT_MS),
    run(["git", "config", "--get", "remote.origin.url"], cwd, GIT_PROBE_TIMEOUT_MS),
    run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd, GIT_PROBE_TIMEOUT_MS),
    run(["git", "rev-parse", "HEAD"], cwd, GIT_PROBE_TIMEOUT_MS),
    run(["git", "status", "--porcelain"], cwd, GIT_PROBE_TIMEOUT_MS),
  ]);

  const rootText = asText(root);
  if (rootText !== undefined) rec.root = rootText;
  const originText = asText(origin);
  if (originText !== undefined) rec.origin_url = originText;
  const branchText = asText(branch);
  if (branchText !== undefined) rec.branch = branchText;
  const shaText = asText(sha);
  if (shaText !== undefined) rec.head_sha = shaText;

  // `dirty` is a BOOLEAN fact, not free text: absent only when the PROBE
  // itself failed (no `git`, not a repo, timeout) — never when the tree is
  // simply clean, which is a legitimate `false` produced by EMPTY stdout on
  // exit 0. Routing this through `asText` (which treats empty as absent)
  // would make a dirty tree indistinguishable from an unmeasured one.
  if (status.ok) rec.dirty = status.stdout.trim().length > 0;

  return rec;
}
