/**
 * artifact.ts — where a receipt's artifact lives, independent of the directory a verb runs in.
 *
 * record: a file inside a checkout whose `origin` is a hosted remote becomes `{git, repo: <owner/name>,
 * ref: <branch, or HEAD's sha when detached>, commit, path: <repo-relative>}`, after checking its bytes
 * are committed at HEAD and HEAD is pushed; anything else is `{file, path: <absolute>}`.
 *
 * check reads the bytes back the same way from any cwd. `ref` only locates them; drift is judged on
 * the bytes:
 *   1. candidate checkouts of `repo`: the cwd's checkout, the clone-root map's clone
 *      (`~/.eris/clones.json`), and the harness clone (`ERIS_HARNESS_CLONE`, else `~/.eris/harness`),
 *      each verified to have origin slug `repo`, ranked so a checkout holding `commit` (or a newer tip
 *      on `ref`, or dirty edits on `ref`) leads a stale checkout on another branch;
 *   2. at `ref` across ranked checkouts: a worktree with `ref` checked out gives its working file
 *      (unless clean and strictly behind `origin/<ref>`, where `origin/<ref>` answers); otherwise
 *      `git show` of `ref` (`origin/<ref>` before a stale local branch that is its strict ancestor);
 *   3. only when `ref` holds no file at `path` in any checkout: the checkout's working file and each
 *      of the issue's branches (a local or `origin/` branch whose name has the issue key after `/` or
 *      at its start and before `-` or its end). Every copy found must carry the recorded sha256: one
 *      that differs is returned, so it reads `drift` whatever the branch names.
 * Nothing found is `unresolved`, never a guess.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { type GateArtifact, sha256Hex } from "eris/gates-contract";
import { precondition } from "./failure";
import { cloneRoot, type Git, ok, remoteSlug, repoRoot, revParse, run, worktreeForBranch } from "./git";

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

async function originSlug(g: Git, dir: string): Promise<string | null> {
  const r = await run(g, dir, ["remote", "get-url", "origin"]);
  return ok(r) ? remoteSlug(r.stdout.toString("utf8")) : null;
}

async function isAncestor(g: Git, dir: string, ancestor: string, descendant: string): Promise<boolean> {
  return ok(await run(g, dir, ["merge-base", "--is-ancestor", ancestor, descendant]));
}

const statusArgs = (path: string) => ["-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=all", "--", path];

/** record's view of `path`: a `git` locator for a committed, pushed file in a hosted checkout, else an absolute `file`. */
export async function locateArtifact(g: Git, cwd: string, path: string, sha256: string): Promise<GateArtifact> {
  const abs = real(isAbsolute(path) ? path : resolve(cwd, path));
  const root = await repoRoot(g, dirname(abs));
  const slug = root === null ? null : await originSlug(g, root);
  const rel = root === null ? "" : relative(real(root), abs).split("\\").join("/");
  if (root === null || slug === null || rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel === ".git" || rel.startsWith(".git/")) {
    return { _tag: "file", path: abs, sha256 };
  }
  const commit = await revParse(g, "HEAD", root);
  const status = commit === null ? null : await run(g, root, statusArgs(rel));
  const blob = commit === null ? null : await run(g, root, ["show", `HEAD:${rel}`]);
  if (commit === null || status === null || !ok(status) || status.stdout.toString("utf8").trim() !== "" || blob === null || !ok(blob) || sha256Hex(blob.stdout) !== sha256) {
    return precondition(
      "gate-artifact-uncommitted",
      `--artifact ${path}: in-repo artifact ${rel} is not committed at HEAD (commit and push first)`,
      `Commit and push first:\n  git add ${rel} && git commit -m "..." && git push`,
    );
  }
  const pushed = await run(g, root, ["for-each-ref", `--contains=${commit}`, "--format=%(refname)", "refs/remotes/origin"]);
  if (!ok(pushed) || pushed.stdout.toString("utf8").trim() === "") {
    return precondition(
      "gate-artifact-uncommitted",
      `--artifact ${path}: commit ${commit.slice(0, 12)} holding ${rel} is not pushed to origin (commit and push first)`,
      "Commit and push first:\n  git push -u origin HEAD",
    );
  }
  const branch = await run(g, root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const b = ok(branch) ? branch.stdout.toString("utf8").trim() : "";
  return { _tag: "git", repo: slug, ref: b !== "" ? b : commit, commit, path: rel, sha256 };
}

export type Resolved = { readonly kind: "bytes"; readonly bytes: Uint8Array } | { readonly kind: "unresolved"; readonly why: string };

const readOr = (p: string): Uint8Array | null => {
  try {
    return readFileSync(p);
  } catch {
    return null;
  }
};

const nonEmpty = (v: string | undefined): string | undefined => (v !== undefined && v.trim() !== "" ? v : undefined);

/** The harness clone the installer keeps: `ERIS_HARNESS_CLONE`, else `~/.eris/harness`. */
const harnessClone = (env: Record<string, string | undefined>): string => nonEmpty(env.ERIS_HARNESS_CLONE) ?? join(nonEmpty(env.HOME) ?? homedir(), ".eris", "harness");

/** Distinct local checkouts of `repo`, in priority order: the cwd's, the clone-root map's, then the harness clone. */
export async function candidateRoots(g: Git, cwd: string, repo: string): Promise<ReadonlyArray<string>> {
  const toAbs = (p: string | null): string | null => (p === null || p.trim() === "" ? null : isAbsolute(p) ? p : isAbsolute(cwd) ? resolve(cwd, p) : null);
  const hc = toAbs(harnessClone(g.env));
  const raw = [cwd.trim() !== "" ? await repoRoot(g, cwd) : null, cloneRoot(g.env, repo), hc !== null && existsSync(join(hc, ".git")) ? hc : null];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const candidate of raw) {
    const dir = toAbs(candidate);
    if (dir === null) continue;
    const key = real(dir);
    if (seen.has(key)) continue;
    if (!sameRepo((await originSlug(g, dir)) ?? "", repo)) continue;
    seen.add(key);
    roots.push(dir);
  }
  return roots;
}

/** Candidate refs for `ref`: `origin/<ref>` leads when the local branch is its strict ancestor (an unpulled fast-forward). */
async function orderedBranchRevs(g: Git, root: string, ref: string): Promise<ReadonlyArray<string>> {
  const local = `refs/heads/${ref}`;
  const remote = `refs/remotes/origin/${ref}`;
  const localSha = await revParse(g, local, root);
  const remoteSha = await revParse(g, remote, root);
  if (localSha !== null && remoteSha !== null && localSha !== remoteSha && (await isAncestor(g, root, localSha, remoteSha))) return [remote, local, ref];
  return [local, remote, ref];
}

/** The bytes at `path` as `branch` (or `explicitRevs`) holds them, per step 2; null when it holds no file there. */
async function atRef(g: Git, root: string, branch: string, path: string, explicitRevs?: readonly string[]): Promise<Uint8Array | null> {
  const wt = await worktreeForBranch(g, root, branch);
  if (wt !== null) {
    if (explicitRevs === undefined) {
      const remoteSha = await revParse(g, `refs/remotes/origin/${branch}`, root);
      if (remoteSha !== null) {
        const wtHead = await revParse(g, "HEAD", wt.path);
        if (wtHead !== null && wtHead !== remoteSha && (await isAncestor(g, root, wtHead, remoteSha))) {
          const status = await run(g, wt.path, statusArgs(path));
          if (ok(status) && status.stdout.toString("utf8").trim() === "") {
            const remoteBlob = await run(g, root, ["show", `refs/remotes/origin/${branch}:${path}`]);
            return ok(remoteBlob) ? remoteBlob.stdout : null;
          }
        }
      }
    }
    return readOr(join(wt.path, path));
  }
  for (const rev of explicitRevs ?? (await orderedBranchRevs(g, root, branch))) {
    if ((await revParse(g, rev, root)) === null) continue;
    const r = await run(g, root, ["show", `${rev}:${path}`]);
    return ok(r) ? r.stdout : null;
  }
  return null;
}

/** Ranks several checkouts of one repo by (holds `commit` at or before its tip, tip dominance, has a worktree on `ref`, has `commit`, order). */
async function rankRoots(g: Git, roots: ReadonlyArray<string>, ref: string, path: string, commit?: string) {
  if (roots.length <= 1) return { roots, dirtyWorktreePaths: [] as ReadonlyArray<string> };
  const scored: Array<{ root: string; idx: number; wtPath: string | null; tipSha: string | null; dirtyWorktree: boolean; atOrAfterCommit: boolean; dominatedBy: number; hasWorktree: boolean; hasCommit: boolean }> = [];
  for (const [idx, root] of roots.entries()) {
    const wt = await worktreeForBranch(g, root, ref);
    let dirtyWorktree = false;
    let tipSha: string | null = null;
    if (wt !== null) {
      const wtHead = await revParse(g, "HEAD", wt.path);
      const remoteSha = await revParse(g, `refs/remotes/origin/${ref}`, root);
      const status = await run(g, wt.path, statusArgs(path));
      dirtyWorktree = ok(status) && status.stdout.toString("utf8").trim() !== "";
      tipSha = !dirtyWorktree && wtHead !== null && remoteSha !== null && wtHead !== remoteSha && (await isAncestor(g, root, wtHead, remoteSha)) ? remoteSha : wtHead;
    } else {
      for (const rev of await orderedBranchRevs(g, root, ref)) {
        tipSha = await revParse(g, rev, root);
        if (tipSha !== null) break;
      }
    }
    const hasCommit = commit !== undefined && (await revParse(g, `${commit}^{commit}`, root)) !== null;
    const atOrAfterCommit = commit !== undefined && hasCommit && tipSha !== null && (tipSha === commit || (await isAncestor(g, root, commit, tipSha)));
    scored.push({ root, idx, wtPath: wt?.path ?? null, tipSha, dirtyWorktree, atOrAfterCommit, dominatedBy: 0, hasWorktree: wt !== null, hasCommit });
  }
  for (let i = 0; i < scored.length; i++) {
    for (let j = 0; j < scored.length; j++) {
      if (i === j) continue;
      const older = scored[j]!;
      const newer = scored[i]!;
      if (older.tipSha !== null && newer.tipSha !== null && older.tipSha !== newer.tipSha && (await isAncestor(g, newer.root, older.tipSha, newer.tipSha))) older.dominatedBy++;
    }
  }
  scored.sort(
    (x, y) =>
      Number(y.atOrAfterCommit) - Number(x.atOrAfterCommit) ||
      x.dominatedBy - y.dominatedBy ||
      Number(y.hasWorktree) - Number(x.hasWorktree) ||
      Number(y.hasCommit) - Number(x.hasCommit) ||
      x.idx - y.idx,
  );
  const dirtyWorktreePaths = scored
    .filter((s) => s.dirtyWorktree && s.wtPath !== null && (commit !== undefined ? s.atOrAfterCommit : s.dominatedBy === 0))
    .map((s) => join(s.wtPath!, path));
  return { roots: scored.map((s) => s.root) as ReadonlyArray<string>, dirtyWorktreePaths: dirtyWorktreePaths as ReadonlyArray<string> };
}

/** The issue's branches, local before `origin/`, each in refname order. */
async function issueBranches(g: Git, root: string, issue: string): Promise<ReadonlyArray<{ readonly branch: string; readonly ref: string }>> {
  const r = await run(g, root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"]);
  if (!ok(r)) return [];
  const key = issue.toLowerCase().replace(/[^a-z0-9-]/g, "");
  const keyed = new RegExp(`(^|/)${key}(-|$)`, "i");
  const out: Array<{ branch: string; ref: string }> = [];
  for (const prefix of ["refs/heads/", "refs/remotes/origin/"]) {
    for (const ref of r.stdout.toString("utf8").split("\n").filter((l) => l.startsWith(prefix)).sort()) {
      const branch = ref.slice(prefix.length);
      if (branch !== "HEAD" && keyed.test(branch)) out.push({ branch, ref });
    }
  }
  return out;
}

/** check's read of an artifact's current bytes. A `file` path that is gone is null (drift's business). */
export async function resolveArtifact(g: Git, cwd: string, a: GateArtifact, issue: string): Promise<Resolved | null> {
  if (a._tag === "file") {
    const bytes = readOr(isAbsolute(a.path) ? a.path : resolve(cwd, a.path));
    return bytes === null ? null : { kind: "bytes", bytes };
  }
  const roots = await candidateRoots(g, cwd, a.repo);
  if (roots.length === 0) return { kind: "unresolved", why: `no checkout of ${a.repo} here or in the clone-root map` };
  const { roots: ranked, dirtyWorktreePaths } = await rankRoots(g, roots, a.ref, a.path, a.commit);
  for (const root of ranked) {
    const atRecorded = await atRef(g, root, a.ref, a.path);
    if (atRecorded !== null) {
      if (sha256Hex(atRecorded) === a.sha256) {
        for (const dirtyFile of dirtyWorktreePaths) {
          const dirtyBytes = readOr(dirtyFile);
          if (dirtyBytes !== null && sha256Hex(dirtyBytes) !== a.sha256) return { kind: "bytes", bytes: dirtyBytes };
        }
      }
      return { kind: "bytes", bytes: atRecorded };
    }
  }
  const copies: Uint8Array[] = [];
  for (const root of ranked) {
    const checkout = readOr(join(root, a.path));
    if (checkout !== null) copies.push(checkout);
    for (const b of await issueBranches(g, root, issue)) {
      const bytes = await atRef(g, root, b.branch, a.path, [b.ref]);
      if (bytes !== null) copies.push(bytes);
    }
  }
  if (copies.length > 0) return { kind: "bytes", bytes: copies.find((c) => sha256Hex(c) !== a.sha256) ?? copies[0]! };
  return { kind: "unresolved", why: `${a.path} is not at ${a.ref} in ${ranked[0]!}, nor in its checkout or an ${issue} branch` };
}

/** The primary checkout of `repo` (the first candidate), or null. */
export async function targetRoot(g: Git, cwd: string, repo: string): Promise<string | null> {
  return (await candidateRoots(g, cwd, repo))[0] ?? null;
}
