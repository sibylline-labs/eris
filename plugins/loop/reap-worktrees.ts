/**
 * reap-worktrees.ts — the worktree half of `eris loop reap`.
 *
 * Invariants:
 *  - a worktree is removed only when it is a directory, no process has its cwd inside it, no working
 *    loop runs in it, `git status --porcelain` is clean, no pull request on its branch is open, and its
 *    branch has a closed or merged pull request or its HEAD is an ancestor of `origin/main` or `main`;
 *  - removal is `git worktree remove <path>`, never `--force`, so git itself refuses a dirty or locked tree;
 *  - a worktree path that is gone is counted `pruned_missing` and pruned (`git worktree prune`), never removed;
 *  - per-worktree inspection runs through the SDK's bounded `runPool`; removals and prunes run one at a
 *    time, in listing order.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import * as Schema from "effect/Schema";
import { readEnv, resolveConcurrency, runPool } from "../../src/cli/plugin";
import { type AgentRow, listJobs } from "./claude";
import { type Run, runChild, which } from "./deps";
import { decodeOr, decodeRows } from "./status";

export interface WorktreeReapSummary {
  removed: number;
  failed: number;
  pruned_missing: number;
  kept_dirty: number;
  kept_open_pr: number;
  kept_busy: number;
  kept_working_loop: number;
  kept_unmerged: number;
}

/** `path` resolved, or `path` itself when it cannot be. */
export const realpathOr = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const kindOf = (path: string): "dir" | "file" | "denied" | "missing" => {
  try {
    const st = statSync(path);
    return st.isDirectory() ? "dir" : st.isFile() ? "file" : "missing";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "EACCES" || code === "EPERM" ? "denied" : "missing";
  }
};

/** The primary checkout `path` belongs to: itself when it holds a `.git` dir, its main repo when its `.git` file points into `<root>/.git/worktrees/`. */
export function primaryRepoRoot(path: string): string | null {
  const dotGit = join(path, ".git");
  const k = kindOf(dotGit);
  if (k === "dir") return realpathOr(path);
  if (k !== "file") return null;
  let first: string;
  try {
    first = (readFileSync(dotGit, "utf8").split(/\r?\n/)[0] ?? "").trim();
  } catch {
    return null;
  }
  if (!first.startsWith("gitdir:")) return null;
  const raw = first.slice("gitdir:".length).trim();
  const gitdir = realpathOr(isAbsolute(raw) ? raw : join(path, raw));
  const parent = dirname(gitdir);
  if (!parent.endsWith(`${sep}worktrees`) || !dirname(parent).endsWith(`${sep}.git`)) return null;
  const primary = dirname(dirname(parent));
  return kindOf(join(primary, ".git")) === "dir" ? realpathOr(primary) : null;
}

const Clones = Schema.Struct({ clones: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) });

/**
 * The primary repos to reap: the (already checked) `--repo` dirs when given, else the clones eris
 * recorded (`~/.eris/clones.json`) and the repos of every job's and agent's cwd. Sorted, deduplicated
 * by real path.
 */
export function discoverRepoRoots(run: Run, explicit: ReadonlyArray<string>, rows: ReadonlyArray<AgentRow>): ReadonlyArray<string> {
  if (explicit.length > 0) return [...new Set(explicit.map(realpathOr))].sort();
  const roots = new Set<string>();
  const add = (p: unknown) => {
    const primary = typeof p === "string" && p !== "" ? primaryRepoRoot(p) : null;
    if (primary !== null) roots.add(primary);
  };
  let clones: unknown = null;
  try {
    clones = JSON.parse(readFileSync(join(run.home, ".eris", "clones.json"), "utf8"));
  } catch {
    clones = null;
  }
  for (const p of Object.values(decodeOr(Clones, clones)?.clones ?? {})) add(p);
  for (const job of listJobs(run.home)) add(job.state.cwd);
  for (const row of rows) add(row.cwd);
  return [...roots].sort();
}

/** A child's exit code and output; one that never ran reads as code 1 with its reason on stderr. */
async function git(run: Run, argv: readonly string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const r = await runChild(run, argv, cwd !== undefined ? { cwd } : {});
  return r.kind === "exited" ? r : { code: 1, stdout: "", stderr: r.why };
}

/** The real cwd of every process `lsof -d cwd -Fn` lists; empty when lsof is absent or says nothing. */
export async function busyProcessCwds(run: Run): Promise<ReadonlyArray<string>> {
  const lsof = which("lsof", run.env);
  if (lsof === null) return [];
  const r = await git(run, [lsof, "-d", "cwd", "-Fn"]);
  return r.stdout.split(/\r?\n/).flatMap((l) => (l.startsWith("n/") ? [realpathOr(l.slice(1))] : []));
}

/** `owner/repo` from a GitHub remote URL, or null. */
export function githubSlug(url: string): string | null {
  const u = url.trim();
  const at = u.indexOf("github.com");
  if (at < 0) return null;
  const tail = u
    .slice(at + "github.com".length)
    .replace(/^[:/]+/, "")
    .replace(/\.git$/, "")
    .replace(/^\/+|\/+$/g, "");
  return tail.includes("/") ? tail : null;
}

/** `git worktree list --porcelain` as one record per worktree. */
export function parseWorktreesPorcelain(text: string): ReadonlyArray<Readonly<Record<string, string>>> {
  const entries: Array<Record<string, string>> = [];
  let cur: Record<string, string> = {};
  for (const line of [...text.split(/\r?\n/), ""]) {
    if (line === "") {
      if (Object.keys(cur).length > 0) entries.push(cur);
      cur = {};
      continue;
    }
    const at = line.indexOf(" ");
    cur[at < 0 ? line : line.slice(0, at)] = at < 0 ? "" : line.slice(at + 1);
  }
  return entries;
}

const within = (candidate: string, root: string): boolean => candidate === root || candidate.startsWith(root + sep);
const PrRow = Schema.Struct({ state: Schema.optionalKey(Schema.NullOr(Schema.String)) });

async function prStates(run: Run, gh: string | null, slug: string | null, branch: string, cwd: string): Promise<ReadonlyArray<string>> {
  if (gh === null || slug === null || branch === "") return [];
  const r = await git(run, [gh, "pr", "list", "--repo", slug, "--head", branch, "--state", "all", "--json", "state"], cwd);
  if (r.code !== 0 || r.stdout.trim() === "") return [];
  let raw: unknown;
  try {
    raw = JSON.parse(r.stdout);
  } catch {
    return [];
  }
  return decodeRows(PrRow, raw).flatMap((p) => ((p.state ?? "") !== "" ? [p.state!.trim().toUpperCase()] : []));
}

async function isAncestorOfMain(run: Run, wt: string): Promise<boolean> {
  for (const ref of ["origin/main", "main"]) if ((await git(run, ["git", "merge-base", "--is-ancestor", "HEAD", ref], wt)).code === 0) return true;
  return false;
}

type Kept = Exclude<keyof WorktreeReapSummary, "removed" | "failed">;
type Verdict = { readonly keep: Kept } | { readonly remove: string } | null;

interface InspectCtx {
  readonly gh: string | null;
  readonly slug: string | null;
  readonly root: string;
  readonly busy: ReadonlyArray<string>;
  readonly working: ReadonlyArray<string>;
}

async function inspect(run: Run, wt: Readonly<Record<string, string>>, ctx: InspectCtx): Promise<Verdict> {
  const path = wt.worktree ?? "";
  if (path === "") return null;
  const k = kindOf(path);
  if (k === "denied") return { keep: "kept_dirty" };
  if (k !== "dir") return { keep: "pruned_missing" };
  const real = realpathOr(path);
  if (ctx.busy.some((b) => within(b, real))) return { keep: "kept_busy" };
  if (ctx.working.some((w) => within(w, real))) return { keep: "kept_working_loop" };
  const st = await git(run, ["git", "status", "--porcelain"], path);
  if (st.code !== 0 || st.stdout.trim() !== "") return { keep: "kept_dirty" };
  const states = await prStates(run, ctx.gh, ctx.slug, (wt.branch ?? "").replace(/^refs\/heads\//, ""), ctx.root);
  if (states.includes("OPEN")) return { keep: "kept_open_pr" };
  if (states.length > 0) return { remove: `pr:${states.join(",")}` };
  return (await isAncestorOfMain(run, path)) ? { remove: "on-main" } : { keep: "kept_unmerged" };
}

/** Remove (or, dry-run, list) every finished worktree under `roots`; each action is a line on `out`. */
export async function reapWorktrees(
  run: Run,
  input: { readonly roots: ReadonlyArray<string>; readonly busy: ReadonlyArray<string>; readonly working: ReadonlyArray<string>; readonly dryRun: boolean; readonly out: string[] },
): Promise<WorktreeReapSummary> {
  const n: WorktreeReapSummary = { removed: 0, failed: 0, pruned_missing: 0, kept_dirty: 0, kept_open_pr: 0, kept_busy: 0, kept_working_loop: 0, kept_unmerged: 0 };
  const gh = which("gh", run.env);
  const concurrency = resolveConcurrency(readEnv(run.env, "ERIS_BATCH_CONCURRENCY"));
  for (const root of input.roots) {
    const list = await git(run, ["git", "worktree", "list", "--porcelain"], root);
    if (list.code !== 0) continue;
    const slug = githubSlug((await git(run, ["git", "remote", "get-url", "origin"], root)).stdout);
    const wts = parseWorktreesPorcelain(list.stdout).slice(1);
    const ctx: InspectCtx = { gh, slug, root, busy: input.busy, working: input.working };
    const verdicts = await runPool(wts, concurrency, (wt) => inspect(run, wt, ctx));
    let prune = false;
    for (const [i, v] of verdicts.entries()) {
      if (v === null) continue;
      if ("keep" in v) {
        n[v.keep] += 1;
        if (v.keep === "pruned_missing") prune = true;
        continue;
      }
      const wt = wts[i]!;
      const label = `${wt.worktree} (${(wt.branch ?? "").replace(/^refs\/heads\//, "") || "detached"}, ${v.remove})`;
      if (input.dryRun) {
        input.out.push(`dry-run: remove worktree ${label}`);
        n.removed += 1;
        continue;
      }
      const rm = await git(run, ["git", "worktree", "remove", wt.worktree!], root);
      if (rm.code === 0) {
        input.out.push(`removed worktree ${label}`);
        n.removed += 1;
        prune = true;
      } else {
        n.failed += 1;
        run.warn(`eris loop: could not remove worktree ${wt.worktree}: ${rm.stderr.trim().slice(0, 200)}`);
      }
    }
    if (prune && !input.dryRun) await git(run, ["git", "worktree", "prune"], root);
  }
  return n;
}
