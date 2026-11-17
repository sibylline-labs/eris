/**
 * git.ts — the git reads the gate verbs make, through the SDK's `runCommand` (argv only, a deadline
 * on every call): where a checkout's top is, what a ref names, what changed since a base, which
 * worktree has a branch, a remote's `owner/name`, and the clone-root map (`~/.eris/clones.json`) that
 * says where a repo slug is checked out.
 *
 * Every call is directory-scoped with `-C`. Outcomes are values: a failed git read is null or an
 * empty list, and the verb decides what that means.
 */

// lift-candidate: git-read-helpers — checkout top, rev-parse, merge-base, changed paths, worktree-for-branch, remote slug

import { readFileSync, statSync } from "node:fs";
import { runCommand, type RunResult } from "../../src/cli/plugin";

export type Env = Record<string, string | undefined>;

/** How git is run: a command line and its environment. Tests read git for real; `memoReads` shares identical reads. */
export interface Git {
  readonly env: Env;
  run(argv: readonly string[], opts?: { readonly env?: Env; readonly timeoutMs?: number }): Promise<RunResult>;
}

const TIMEOUT_MS = 600_000;
const INSPECT_TIMEOUT_MS = 60_000;

/** Git through the SDK's subprocess adapter. */
export function liveGit(env: Env): Git {
  return { env, run: (argv, opts) => runCommand(argv, { env: opts?.env ?? env, timeoutMs: opts?.timeoutMs ?? TIMEOUT_MS }) };
}

/**
 * `g` with each distinct git invocation run once: a later identical call (same argv, `g`'s own env)
 * shares the first one's result. For a verb that only reads git while it runs (`gate check`, whose
 * artifact checks probe the same repo once per receipt); never for one that writes.
 */
export function memoReads(g: Git): Git {
  const seen = new Map<string, Promise<RunResult>>();
  return {
    env: g.env,
    run: (argv, opts) => {
      if (opts?.env !== undefined && opts.env !== g.env) return g.run(argv, opts);
      const key = JSON.stringify(argv);
      let r = seen.get(key);
      if (r === undefined) {
        r = g.run(argv, opts);
        seen.set(key, r);
      }
      return r;
    },
  };
}

/** `$( … )`: every trailing newline removed. */
const captured = (b: Buffer): string => b.toString("utf8").replace(/\n+$/, "");

export const ok = (r: RunResult): boolean => r.kind === "ok";

/** `git -C <dir> …`, or plain `git …` for an empty dir. */
export function run(g: Git, dir: string, args: readonly string[]): Promise<RunResult> {
  return g.run(dir !== "" ? ["git", "-C", dir, ...args] : ["git", ...args]);
}

/** A read that takes no repository lock. */
function inspect(g: Git, dir: string, args: readonly string[]): Promise<RunResult> {
  return g.run(["git", "-C", dir, ...args], { env: { ...g.env, GIT_OPTIONAL_LOCKS: "0" }, timeoutMs: INSPECT_TIMEOUT_MS });
}

/** The enclosing checkout's physical toplevel, or null. */
export async function repoRoot(g: Git, dir = "."): Promise<string | null> {
  const r = await run(g, dir, ["rev-parse", "--show-toplevel"]);
  return ok(r) ? captured(r.stdout) : null;
}

/** The full sha of `rev`, or null when it does not resolve. */
export async function revParse(g: Git, rev: string, dir = "."): Promise<string | null> {
  const r = await run(g, dir, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  if (!ok(r)) return null;
  const out = captured(r.stdout);
  return out === "" ? null : out;
}

/** The best common ancestor of `a` and `b`, or null when they share none. */
export async function mergeBase(g: Git, dir: string, a: string, b: string): Promise<string | null> {
  const r = await inspect(g, dir, ["merge-base", a, b]);
  if (!ok(r)) return null;
  const out = captured(r.stdout);
  return out === "" ? null : out;
}

/** Every path the working tree changes against `rev` (deletes and both sides of a rename), or null when git failed. */
export async function changedPaths(g: Git, dir: string, rev: string): Promise<string[] | null> {
  const r = await inspect(g, dir, ["-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", "-z", "--no-ext-diff", "--ignore-submodules=all", rev, "--"]);
  return ok(r) ? r.stdout.toString("utf8").split("\0").filter((p) => p !== "") : null;
}

/** Untracked, non-ignored paths relative to `dir` (the toplevel), or null when git failed. */
export async function untrackedFiles(g: Git, dir: string): Promise<string[] | null> {
  const r = await inspect(g, dir, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return ok(r) ? r.stdout.toString("utf8").split("\0").filter((p) => p !== "") : null;
}

/** Every path git knows under `dir` (tracked, or untracked and not ignored), or null when git failed. */
export async function knownFiles(g: Git, dir: string): Promise<string[] | null> {
  const r = await inspect(g, dir, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  return ok(r) ? r.stdout.toString("utf8").split("\0").filter((p) => p !== "") : null;
}

/** The worktree with `branch` checked out, or null. */
export async function worktreeForBranch(g: Git, repo: string, branch: string): Promise<{ readonly path: string } | null> {
  const r = await run(g, repo, ["worktree", "list", "--porcelain"]);
  if (!ok(r)) return null;
  let path = "";
  let hit = false;
  for (const line of r.stdout.toString("utf8").split("\n")) {
    if (line === "") {
      if (hit) return { path };
      path = "";
      continue;
    }
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) hit = true;
  }
  return hit ? { path } : null;
}

/** The last path component of a slug or remote URL, minus `.git`, lowercased. */
export function repoName(raw: string): string {
  let s = raw.replace(/\/+$/, "");
  if (s.endsWith(".git")) s = s.slice(0, -4);
  s = s.replace(/\/+$/, "");
  s = s.slice(s.lastIndexOf("/") + 1);
  s = s.slice(s.lastIndexOf(":") + 1);
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * `owner/name` from a hosted remote URL (https, ssh://, scp-like `[user@]host:`), or null. The path
 * must be exactly `owner/name`, or end `/git/owner/name` (a git proxy); a local path has no owner.
 */
export function remoteSlug(url: string): string | null {
  const u = url.trim();
  const path = /^(?:https?|ssh|git):\/\/[^/]+\/(.+)$/.exec(u)?.[1] ?? /^(?:[^/@\s]+@)?[^/:\s]+:([^/].*)$/.exec(u)?.[1];
  if (path === undefined) return null;
  const parts = path
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter((p) => p !== "");
  if (parts.length !== 2 && !(parts.length > 2 && parts[parts.length - 3] === "git")) return null;
  const slug = parts.slice(-2).join("/");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug) ? slug : null;
}

const isCheckout = (p: string): boolean => {
  try {
    statSync(`${p}/.git`);
    return true;
  } catch {
    return false;
  }
};

/** The clone-root map's path: `ERIS_CLONES_FILE`, else `~/.eris/clones.json`. */
const clonesFile = (env: Env): string => env.ERIS_CLONES_FILE || `${env.HOME ?? ""}/.eris/clones.json`;

/** The clone-root map's `slug -> path` rows, or none when the file is absent or not a map. */
function cloneRows(env: Env): Array<[string, string]> {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(clonesFile(env), "utf8"));
  } catch {
    return [];
  }
  const clones = doc !== null && typeof doc === "object" && !Array.isArray(doc) ? (doc as { clones?: unknown }).clones : undefined;
  if (clones === null || typeof clones !== "object" || Array.isArray(clones)) return [];
  const rows = Object.entries(clones as Record<string, unknown>);
  return rows.every(([, v]) => typeof v === "string") ? (rows as Array<[string, string]>) : [];
}

/** The recorded checkout of `slug` (its exact key, else the one entry with the same repo name), or null. */
export function cloneRoot(env: Env, slug: string): string | null {
  if (slug === "") return null;
  const rows = cloneRows(env);
  let path = rows.find(([k]) => k === slug)?.[1].replace(/\n+$/, "") ?? "";
  if (path === "" || path === "null") {
    const want = repoName(slug);
    const matches = want === "" ? [] : rows.filter(([k]) => repoName(k) === want);
    if (matches.length !== 1) return null;
    path = matches[0]![1];
  }
  if (path === "" || path === "null") return null;
  return isCheckout(path) ? path : null;
}
