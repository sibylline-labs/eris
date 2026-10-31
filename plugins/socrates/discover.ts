/**
 * discover.ts — `eris socrates discover`, loaded only when `eris socrates
 * discover` dispatches (./submit.ts routes the group).
 *
 * Lists the candidate sources in the git repo holding the working directory
 * that come after its processed-source cursor. A source is a first-parent
 * commit of HEAD: a merged PR is one, and the plans, retros and notes a repo
 * keeps arrive through them. The cursor is one commit per repo, kept in
 * `~/.eris/socrates/cursors.json`; `--advance <rev>` moves it once the listed
 * sources are processed.
 *
 * Invariants:
 *   - Listing never writes the cursor, `--since` included: a targeted run
 *     never advances it. The same repo state and cursor print the same bytes.
 *   - The cursor moves only by `--advance`, only to a commit HEAD contains, and
 *     never back past the stored one while that one still resolves.
 *   - Over `--limit` after a cursor, the oldest sources are listed, so list,
 *     advance to the last one, list again walks the range without a gap. With
 *     no cursor the newest `--limit` are the window, and older history is
 *     named in a WARN and `truncated`, never skipped silently.
 *   - A line of `git log` output is a source only when it opens with a sha, so
 *     a user's git config (signature lines) cannot add one.
 *   - The file is replaced whole (tmp + rename), never written in place. Two
 *     concurrent advances can lose one write; every loss leaves a cursor older
 *     or absent, so a later run re-lists sources and never skips one.
 *   - Every `git` call goes through the SDK's subprocess adapter with a
 *     deadline, one at a time.
 *   - A remote url's credentials never reach the cursor file or the output.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { readArgs, renderWarnLines, runCommand, type VerbContext } from "../../src/cli/plugin";
import { fail, printable, type SocratesDeps } from "./client";
import plugin from "./index";

/** WARN lines this module prints; each has a docs/ERRORS.md heading. */
export type DiscoverWarnSlug = "socrates-discover-truncated";

const GIT_TIMEOUT_MS = 10_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export const DISCOVER_USAGE = `Usage: eris socrates discover [--since <rev>] [--limit <n>]
       eris socrates discover --advance <rev>

List the commits on HEAD's first-parent line, in the git repo holding this
directory, that come after the processed-source cursor, oldest first:
'<sha> <date> <subject>', one per line. Nothing new prints nothing. Listing
never moves the cursor, so a re-run with no new commits prints the same lines.
--output json prints {repo, cursor, head, sources: [{kind, sha, committed_at,
subject}], truncated}.

  --since <rev>    list after this commit instead of the cursor; the cursor
                   is left where it is
  --limit <n>      at most n sources, 1-${MAX_LIMIT} (default ${DEFAULT_LIMIT}). Over it, the oldest
                   are listed and a WARN says so: advance, then list again
  --advance <rev>  move the cursor forward to this commit once its sources
                   are processed, and print it. --output json prints
                   {repo, cursor}

With no cursor yet, the last <limit> commits are listed, and a WARN says when
history goes back further. The cursor is kept per repo in
~/.eris/socrates/cursors.json.
`;

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** A field separator git's `%x1f` writes and no commit subject carries. */
const FS = "\u001f";

const CursorFile = z.object({ version: z.literal(1), repos: z.record(z.string(), z.string().regex(SHA)) });
type CursorFile = z.infer<typeof CursorFile>;

interface Source {
  kind: "commit";
  sha: string;
  committed_at: string;
  subject: string;
}

type Git = (args: readonly string[]) => Promise<{ ok: true; out: string } | { ok: false; code: number | null; why: string }>;

function gitIn(ctx: VerbContext, cwd: string): Git {
  return async (args) => {
    const r = await runCommand(["git", ...args], { env: ctx.env, timeoutMs: GIT_TIMEOUT_MS, cwd });
    if (r.kind === "ok") return { ok: true, out: r.stdout.toString("utf8") };
    if (r.kind === "exit") return { ok: false, code: r.code, why: `git exited ${r.code}` };
    if (r.kind === "timeout") return { ok: false, code: null, why: `git gave no answer within ${GIT_TIMEOUT_MS / 1000}s` };
    if (r.kind === "signal") return { ok: false, code: null, why: `git was killed by ${r.signal}` };
    return { ok: false, code: null, why: `git could not run (${r.errno})` };
  };
}

/** The commit `rev` names, or null when it names none here. A git that could not answer is a failure block. */
async function commitOf(ctx: VerbContext, git: Git, rev: string): Promise<string | null> {
  const r = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]);
  if (r.ok) return r.out.trim();
  if (r.code !== null) return null;
  fail(ctx, "socrates-not-a-repo", r.why, "check that git runs here, then run the command again");
}

async function isAncestor(ctx: VerbContext, git: Git, older: string, newer: string): Promise<boolean> {
  const r = await git(["merge-base", "--is-ancestor", older, newer]);
  if (r.ok) return true;
  if (r.code === 1) return false;
  fail(ctx, "socrates-not-a-repo", r.why, "check that git runs here, then run the command again");
}

/** The repo's key in the cursor file: its origin url without credentials, else its root. */
async function repoKey(git: Git, root: string): Promise<string> {
  const r = await git(["config", "--get", "remote.origin.url"]);
  const url = r.ok ? r.out.trim() : "";
  return url === "" ? root : url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, "$1");
}

function cursorPath(ctx: VerbContext, deps: SocratesDeps): string {
  return join(deps.home ?? ctx.env.HOME ?? homedir(), ".eris", "socrates", "cursors.json");
}

async function readCursors(ctx: VerbContext, file: string): Promise<CursorFile> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return { version: 1, repos: {} };
    fail(ctx, "socrates-cursor-invalid", `cannot read ${file}: ${printable((err as Error).message)}`, "fix the file's permissions, or remove it to start over");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const decoded = CursorFile.safeParse(parsed);
  if (!decoded.success) fail(ctx, "socrates-cursor-invalid", `${file} is not a cursor file`, "remove it to start over; the next discover lists from the last commits");
  return decoded.data;
}

async function writeCursor(ctx: VerbContext, file: string, key: string, sha: string): Promise<void> {
  // Read again right before the write, so another repo's cursor written meanwhile is kept.
  const cursors = await readCursors(ctx, file);
  const next: CursorFile = { version: 1, repos: { ...cursors.repos, [key]: sha } };
  const dir = join(file, "..");
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    fail(ctx, "socrates-cursor-invalid", `cannot write ${file}: ${printable((err as Error).message)}`, "fix the directory's permissions, then run the command again");
  }
}

function parseLog(out: string): Source[] {
  return out
    .split("\n")
    .filter((line) => SHA.test(line.split(FS, 1)[0]!))
    .map((line) => {
      const [sha = "", committed_at = "", ...rest] = line.split(FS);
      return { kind: "commit", sha, committed_at, subject: rest.join(FS) };
    });
}

export async function runDiscover(args: string[], ctx: VerbContext, deps: SocratesDeps = {}): Promise<number> {
  const a = readArgs(plugin.rows, "socrates discover", args, ctx, { help: DISCOVER_USAGE });
  if (a === null) return 0;
  const { "--since": since, "--limit": limitArg, "--advance": advance } = a.flags;
  if (advance !== undefined && (since !== undefined || limitArg !== undefined)) {
    fail(ctx, "socrates-discover-invalid", "--advance moves the cursor and lists nothing, so it takes no --since or --limit", "eris socrates discover --advance <rev>");
  }
  if (limitArg !== undefined && !(/^[1-9][0-9]*$/.test(limitArg) && Number(limitArg) <= MAX_LIMIT)) {
    fail(ctx, "socrates-discover-invalid", `--limit takes a whole number from 1 to ${MAX_LIMIT}, not '${printable(limitArg)}'`, `eris socrates discover --limit ${DEFAULT_LIMIT}`);
  }
  const limit = limitArg === undefined ? DEFAULT_LIMIT : Number(limitArg);

  const git = gitIn(ctx, deps.cwd ?? process.cwd());
  const top = await git(["rev-parse", "--show-toplevel"]);
  if (!top.ok) fail(ctx, "socrates-not-a-repo", top.code === null ? top.why : "this directory is not inside a git repo", top.code === null ? "check that git runs here, then run the command again" : "run discover from inside the repo whose sources you want");
  const root = top.out.trim();
  const head = await commitOf(ctx, git, "HEAD");
  if (head === null) fail(ctx, "socrates-not-a-repo", `${root} has no commits yet`, "commit something, then run discover again");
  const repo = await repoKey(git, root);
  const file = cursorPath(ctx, deps);
  const repos = (await readCursors(ctx, file)).repos;
  const stored = Object.hasOwn(repos, repo) ? repos[repo] : undefined;

  if (advance !== undefined) {
    const to = await commitOf(ctx, git, advance);
    if (to === null) fail(ctx, "socrates-cursor-invalid", `'${printable(advance)}' names no commit in ${root}`, "pass a sha or ref that 'eris socrates discover' listed");
    if (!(await isAncestor(ctx, git, to, head))) fail(ctx, "socrates-cursor-invalid", `${to} is not in HEAD's history`, "advance to a commit 'eris socrates discover' listed on this branch");
    const from = stored === undefined ? null : await commitOf(ctx, git, stored);
    if (from !== null && !(await isAncestor(ctx, git, from, to))) {
      fail(ctx, "socrates-cursor-invalid", `${to} does not come after the cursor (${from}); the cursor only moves forward`, "advance to a commit after the cursor, or list with --since <rev> to look back");
    }
    if (from !== to) await writeCursor(ctx, file, repo, to);
    ctx.stdout.write(ctx.format === "json" ? `${JSON.stringify({ repo, cursor: to })}\n` : `cursor: ${to}\n`);
    return 0;
  }

  let after: string | null = null;
  if (since !== undefined) {
    after = await commitOf(ctx, git, since);
    if (after === null) fail(ctx, "socrates-cursor-invalid", `--since '${printable(since)}' names no commit in ${root}`, "pass a sha or ref in this repo");
  } else if (stored !== undefined) {
    after = await commitOf(ctx, git, stored);
    if (after === null) fail(ctx, "socrates-cursor-invalid", `the cursor for ${repo} (${stored}) names no commit here; history was rewritten or the repo replaced`, "eris socrates discover --advance <rev> moves it to a commit in this history");
  }

  const format = `--format=%H${"%x1f"}%cI${"%x1f"}%s`;
  const log = await git(after === null ? ["log", "--first-parent", "--no-color", "--no-show-signature", `--max-count=${limit + 1}`, format, head] : ["log", "--first-parent", "--no-color", "--no-show-signature", "--reverse", format, `${after}..${head}`]);
  if (!log.ok) fail(ctx, "socrates-not-a-repo", log.why, "check that git runs here, then run the command again");
  const all = parseLog(log.out);
  // With a cursor the range is walked oldest first, so the oldest are kept; with none, the
  // newest `limit` are the window and one more was read only to tell whether history goes back further.
  const sources = after === null ? all.slice(0, limit).reverse() : all.slice(0, limit);
  const truncated = all.length > sources.length;
  if (truncated) {
    const slug: DiscoverWarnSlug = "socrates-discover-truncated";
    const why =
      after === null
        ? `no cursor yet: listed the last ${sources.length} commits, and older history is not listed; pass --since <rev> to start further back`
        : `listed the oldest ${sources.length} of ${all.length} commits; advance to the last one listed, then run discover again`;
    ctx.stderr.write(renderWarnLines(why, slug));
  }

  if (ctx.format === "json") {
    ctx.stdout.write(`${JSON.stringify({ repo, cursor: after, head, sources, truncated })}\n`);
    return 0;
  }
  ctx.stdout.write(sources.map((s) => `${s.sha.slice(0, 12)} ${s.committed_at.slice(0, 10)} ${printable(s.subject)}\n`).join(""));
  return 0;
}
