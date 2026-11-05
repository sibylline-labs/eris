/**
 * fragment.ts — the evidence `eris socrates submit --evidence <path>#L<x>[-L<y>]` reads: a line
 * range of a file committed in the git repo holding the working directory, as one
 * `{kind, provenance, content}` entry.
 *
 * Invariants:
 *   - The content is the committed blob's lines, never the working tree's: HEAD is resolved once,
 *     and every later read names that sha, so the provenance `<repo>@<sha>:<path>#L<x>-L<y>`
 *     names the commit the content came from. A path that is untracked, or differs from that
 *     commit, is refused rather than sent under a provenance that does not hold it.
 *   - Nothing is scanned here, and nothing leaves the machine. The caller runs every entry's text
 *     through `eris/outbound-scan` with the candidate's fields before any request.
 *   - Every `git` call goes through the SDK's subprocess adapter with a deadline, one at a time.
 *   - A refusal is `socrates-evidence-invalid` and names the reference, never the file's text.
 *   - The repo part of the provenance carries no remote credentials.
 */

import { runCommand, type VerbContext } from "../../src/cli/plugin";
import { fail, printable, type SocratesDeps } from "./client";
import { SOCRATES_EVIDENCE_MAX_LENGTH, SocratesProvenance, type SocratesUnfitEvidence } from "./socrates-contract.v1";

const GIT_TIMEOUT_MS = 10_000;

/** What a reference reads as: `<path>#L<x>`, `<path>#L<x>-L<y>` or `<path>#L<x>-<y>`. */
const REF = /^(.+)#L([1-9][0-9]*)(?:-L?([1-9][0-9]*))?$/;

/** Extensions whose text is prose, so the fragment's kind is `doc`; any other file is `code`. */
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc"]);

const FIX = "pass <path>#L<x>-L<y>: a line range of a file committed in this repo, e.g. src/retry.ts#L10-L24";

export interface EvidenceRef {
  readonly path: string;
  readonly from: number;
  readonly to: number;
}

/** A reference's path and line range, or the reason it is not one. */
export function parseEvidenceRef(ref: string): EvidenceRef | { reason: string } {
  const m = REF.exec(ref);
  if (m === null) return { reason: "it is not <path>#L<x> or <path>#L<x>-L<y>" };
  const [, path = "", x = "", y] = m;
  if (/[\s#]/.test(path)) return { reason: "the path holds whitespace or '#', which a provenance link cannot carry" };
  const from = Number(x);
  const to = y === undefined ? from : Number(y);
  if (to < from) return { reason: `the range ends (L${to}) before it starts (L${from})` };
  return { path, from, to };
}

type GitOutcome = { ok: true; out: string } | { ok: false; code: number | null; why: string };

function gitIn(ctx: VerbContext, cwd: string): (args: readonly string[]) => Promise<GitOutcome> {
  return async (args) => {
    const r = await runCommand(["git", ...args], { env: ctx.env, timeoutMs: GIT_TIMEOUT_MS, cwd });
    if (r.kind === "ok") return { ok: true, out: r.stdout.toString("utf8") };
    if (r.kind === "exit") return { ok: false, code: r.code, why: `git exited ${r.code}` };
    if (r.kind === "timeout") return { ok: false, code: null, why: `git gave no answer within ${GIT_TIMEOUT_MS / 1000}s` };
    if (r.kind === "signal") return { ok: false, code: null, why: `git was killed by ${r.signal}` };
    return { ok: false, code: null, why: `git could not run (${r.errno})` };
  };
}

/** `owner/name` from a remote url (https, ssh or scp-like), credentials and `.git` dropped; null when it has no such path. */
export function repoOfRemote(url: string): string | null {
  const path = url
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "")
    .replace(/^[^/:]*@?[^/:]*:/, "")
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "");
  const parts = path.split("/").filter((p) => p !== "");
  if (parts.length < 2) return null;
  const repo = parts.slice(-2).join("/");
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo) ? repo : null;
}

function kindOf(path: string): "code" | "doc" {
  const dot = path.lastIndexOf(".");
  const ext = dot > path.lastIndexOf("/") ? path.slice(dot).toLowerCase() : "";
  return DOC_EXTENSIONS.has(ext) ? "doc" : "code";
}

/** The entry each reference names, in order, read from the commit HEAD resolves to now. */
export async function readFragments(ctx: VerbContext, deps: SocratesDeps, refs: readonly string[]): Promise<SocratesUnfitEvidence[]> {
  if (refs.length === 0) return [];
  const parsed = refs.map((ref) => {
    const r = parseEvidenceRef(ref);
    if ("reason" in r) fail(ctx, "socrates-evidence-invalid", `--evidence '${printable(ref)}': ${r.reason}`, FIX);
    return { ref, ...r };
  });

  const git = gitIn(ctx, deps.cwd ?? process.cwd());
  function gitFailed(o: { why: string }): never {
    fail(ctx, "socrates-evidence-invalid", `--evidence needs git, and ${o.why}`, "check that git runs here, then run the command again");
  }
  const top = await git(["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    if (top.code === null) gitFailed(top);
    fail(ctx, "socrates-evidence-invalid", "--evidence reads a committed file, and this directory is not inside a git repo", "run the command from inside the repo the evidence comes from");
  }
  const root = top.out.trim();
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!head.ok) {
    if (head.code === null) gitFailed(head);
    fail(ctx, "socrates-evidence-invalid", `${printable(root)} has no commits yet, so a fragment has no commit to name`, "commit the file, then run the command again");
  }
  const sha = head.out.trim();
  const remote = await git(["config", "--get", "remote.origin.url"]);
  const base = root.split("/").filter((p) => p !== "").pop() ?? "";
  const repo = (remote.ok ? repoOfRemote(remote.out) : null) ?? base;

  const out: SocratesUnfitEvidence[] = [];
  for (const { ref, path, from, to } of parsed) {
    const where = `--evidence '${printable(ref)}'`;
    const listed = await git(["ls-files", "--full-name", "--error-unmatch", "--", path]);
    if (!listed.ok) {
      if (listed.code === null) gitFailed(listed);
      fail(ctx, "socrates-evidence-invalid", `${where}: the file is not tracked in ${printable(root)}`, "pass a file committed in this repo; source stays local, so only a committed line range is sent");
    }
    const full = listed.out.split("\n")[0]?.trim() ?? "";
    if (full === "" || listed.out.trim().includes("\n")) fail(ctx, "socrates-evidence-invalid", `${where}: names more than one file`, FIX);
    const diff = await git(["diff", "--quiet", sha, "--", full]);
    if (!diff.ok) {
      if (diff.code !== 1) gitFailed(diff);
      fail(ctx, "socrates-evidence-invalid", `${where}: ${printable(full)} has changes that are not in ${sha.slice(0, 12)}, so the provenance would not name the text sent`, "commit the file (or discard the changes), then run the command again");
    }
    const blob = await git(["show", `${sha}:${full}`]);
    if (!blob.ok) gitFailed(blob);
    if (blob.out.includes("\u0000")) fail(ctx, "socrates-evidence-invalid", `${where}: ${printable(full)} is a binary file`, "pass a line range of a text file");
    const lines = blob.out.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (to > lines.length) fail(ctx, "socrates-evidence-invalid", `${where}: ${printable(full)} has ${lines.length} lines at ${sha.slice(0, 12)}, so L${to} is past its end`, FIX);
    const content = lines.slice(from - 1, to).join("\n");
    if (content.trim() === "") fail(ctx, "socrates-evidence-invalid", `${where}: the lines are blank`, "pass a range that holds the evidence");
    if (content.length > SOCRATES_EVIDENCE_MAX_LENGTH) fail(ctx, "socrates-evidence-invalid", `${where}: the range is ${content.length} characters, over ${SOCRATES_EVIDENCE_MAX_LENGTH}`, "pass a shorter range");
    const provenance = `${repo}@${sha}:${full}#L${from}${to === from ? "" : `-L${to}`}`;
    if (!SocratesProvenance.safeParse(provenance).success) fail(ctx, "socrates-evidence-invalid", `${where}: the provenance '${printable(provenance)}' is not a repo@sha:path#L<n> link`, "pass a path of letters, digits and . _ / - only");
    out.push({ kind: kindOf(full), provenance, content });
  }
  return out;
}
