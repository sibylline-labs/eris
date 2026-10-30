/**
 * `eris socrates discover`: the first-parent commits after a per-repo cursor,
 * and `--advance` to move it.
 *
 * Drives the group handler in-process against a real `git` repo made in a
 * sandbox, with HOME in the sandbox too, so every listing reads real history
 * and the cursor file is observed on disk.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runSocrates } from "../plugins/socrates/submit";
import { CliExit } from "../src/cli/ts-verb";
import { type Sandbox, sandbox } from "./helpers/blackbox";

const REPO = resolve(import.meta.dir, "..");

let sb: Sandbox;
let repo: string;
let cursors: string;

function git(...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...sb.env, GIT_AUTHOR_DATE: "2026-10-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-01T00:00:00Z" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function commit(subject: string): string {
  git("commit", "--allow-empty", "-q", "-m", subject);
  return git("rev-parse", "HEAD");
}

beforeEach(() => {
  sb = sandbox("eris-socrates-discover-");
  repo = join(sb.dir, "repo");
  mkdirSync(repo);
  sb.env.GIT_CONFIG_GLOBAL = join(sb.dir, "gitconfig");
  writeFileSync(sb.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = t\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
  git("init", "-q");
  git("remote", "add", "origin", "https://user:pw@example.com/acme/app.git");
  cursors = join(sb.home, ".eris", "socrates", "cursors.json");
});

async function drive(args: string[], opts: { format?: "text" | "json"; cwd?: string } = {}) {
  let stdout = "";
  let stderr = "";
  const ctx = {
    erisDir: REPO,
    env: sb.env,
    format: opts.format ?? "text",
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: (s: string) => ((stderr += s), true) },
  };
  let rc: number;
  try {
    rc = await runSocrates(["discover", ...args], ctx, { home: sb.home, cwd: opts.cwd ?? repo });
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    rc = e.code;
  }
  const slug = stderr.split("\n").find((l) => l.startsWith("slug: "))?.slice("slug: ".length);
  return { rc, stdout, stderr, slug };
}

const line = (sha: string, subject: string) => `${sha.slice(0, 12)} 2026-10-01 ${subject}\n`;

describe("eris socrates discover", () => {
  it("lists the commits after the cursor, oldest first, and prints the same bytes on a re-run with nothing new", async () => {
    /** When listing moves the cursor or reorders, a re-sweep skips or repeats sources; observed as identical stdout and an untouched cursor file. */
    const a = commit("feat: a");
    const b = commit("feat: b");
    expect(await drive([])).toMatchObject({ rc: 0, stdout: line(a, "feat: a") + line(b, "feat: b"), stderr: "" });
    expect(existsSync(cursors)).toBe(false);

    expect(await drive(["--advance", a])).toMatchObject({ rc: 0, stdout: `cursor: ${a}\n` });
    const file = readFileSync(cursors, "utf8");
    const after = await drive([]);
    expect(after).toMatchObject({ rc: 0, stdout: line(b, "feat: b") });
    expect(await drive([])).toEqual(after);

    expect(await drive(["--advance", b])).toMatchObject({ rc: 0 });
    const empty = await drive([]);
    expect(empty).toMatchObject({ rc: 0, stdout: "", stderr: "" });
    expect(await drive([])).toEqual(empty);
    expect(readFileSync(cursors, "utf8")).not.toBe(file);
  });

  it("keys the cursor by the origin url without its credentials, and never writes on a listing", async () => {
    /** When the remote's password reaches the cursor file or the output, a credential sits in a plain file; when --since writes, a targeted run advances the cutoff. */
    const a = commit("feat: a");
    commit("feat: b");
    await drive(["--advance", a]);
    const file = readFileSync(cursors, "utf8");
    expect(JSON.parse(file)).toEqual({ version: 1, repos: { "https://example.com/acme/app.git": a } });
    const json = await drive(["--since", "HEAD~1"], { format: "json" });
    expect(json.stdout).not.toContain("pw");
    expect(JSON.parse(json.stdout)).toMatchObject({ repo: "https://example.com/acme/app.git", cursor: a, truncated: false, sources: [{ kind: "commit", subject: "feat: b" }] });
    await drive(["--since", "HEAD"]);
    expect(readFileSync(cursors, "utf8")).toBe(file);
  });

  it("lists only the first-parent line: a merged branch is one source", async () => {
    /** When a merged PR's own commits list too, one PR becomes many sources and a re-sweep re-reads work it already processed. */
    const base = commit("feat: base");
    git("checkout", "-q", "-b", "topic");
    commit("wip: one");
    commit("wip: two");
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "-m", "Merge topic", "topic");
    const merge = git("rev-parse", "HEAD");
    expect((await drive(["--since", base])).stdout).toBe(line(merge, "Merge topic"));
  });

  it("lists the oldest over --limit with a WARN, so advancing to the last one walks the range without a gap", async () => {
    /** When the newest are kept instead, advancing past them skips the older sources for good. */
    const root = commit("feat: root");
    const shas = ["one", "two", "three"].map((s) => commit(`feat: ${s}`));
    await drive(["--advance", root]);
    const first = await drive(["--limit", "2"]);
    expect(first).toMatchObject({ rc: 0, stdout: line(shas[0]!, "feat: one") + line(shas[1]!, "feat: two") });
    expect(first.stderr).toContain("slug: socrates-discover-truncated");
    await drive(["--advance", shas[1]!]);
    expect(await drive(["--limit", "2"])).toMatchObject({ rc: 0, stdout: line(shas[2]!, "feat: three"), stderr: "" });
  });

  it("moves the cursor only forward and only along HEAD's history", async () => {
    /** When the cursor can move back or onto another branch, a listing repeats processed sources or names commits HEAD does not hold. */
    const a = commit("feat: a");
    const b = commit("feat: b");
    git("checkout", "-q", "-b", "side", a);
    const side = commit("feat: side");
    git("checkout", "-q", "main");
    await drive(["--advance", b]);
    expect(await drive(["--advance", a])).toMatchObject({ rc: 1, stdout: "", slug: "socrates-cursor-invalid" });
    expect(await drive(["--advance", side])).toMatchObject({ rc: 1, slug: "socrates-cursor-invalid" });
    expect(await drive(["--advance", "no-such-ref"])).toMatchObject({ rc: 1, slug: "socrates-cursor-invalid" });
    expect(await drive(["--advance", b])).toMatchObject({ rc: 0, stdout: `cursor: ${b}\n` });
    expect(JSON.parse(readFileSync(cursors, "utf8")).repos["https://example.com/acme/app.git"]).toBe(b);
  });

  it("refuses outside a repo, on an empty repo, on a malformed cursor file and on bad flags", async () => {
    /** When these read as an empty listing, a user is told there is nothing to process when discover could not look. */
    expect(await drive([], { cwd: sb.home })).toMatchObject({ rc: 1, stdout: "", slug: "socrates-not-a-repo" });
    expect(await drive([])).toMatchObject({ rc: 1, slug: "socrates-not-a-repo" });
    commit("feat: a");
    mkdirSync(join(sb.home, ".eris", "socrates"), { recursive: true });
    writeFileSync(cursors, "{not json");
    expect(await drive([])).toMatchObject({ rc: 1, slug: "socrates-cursor-invalid" });
    writeFileSync(cursors, JSON.stringify({ version: 1, repos: { "https://example.com/acme/app.git": "0".repeat(40) } }));
    expect(await drive([])).toMatchObject({ rc: 1, slug: "socrates-cursor-invalid" });
    for (const bad of [["--limit", "0"], ["--limit", "501"], ["--limit", "x"], ["--advance", "HEAD", "--limit", "2"], ["--advance", "HEAD", "--since", "HEAD"]]) {
      expect({ bad, slug: (await drive(bad)).slug }).toEqual({ bad, slug: "socrates-discover-invalid" });
    }
  });
});
