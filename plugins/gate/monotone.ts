/**
 * monotone.ts — the monotone surface bar: pure classification comes from `eris/gates-contract`; this
 * module adds the git merge-base/working-tree reader (`readMonotoneSides`) and CLI/CI judge
 * (`judgeMonotone`).
 */

import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import {
  CLASS_HEADING,
  classIds,
  classifyClasses,
  classifyMonotone,
  classifySurface,
  contentTag,
  type Dim,
  EFFORTS,
  type FileState,
  inSkillDir,
  type MonotoneScope,
  type MonotoneSide,
  type MonotoneSignoff,
  type MonotoneVerdict,
  named,
  neededPaths,
  rowLine,
  skillDir,
  type SurfacesFile,
  uncovered,
} from "eris/gates-contract";
import { precondition } from "./failure";
import { changedPaths, type Git, mergeBase, ok, repoRoot, revParse, run, untrackedFiles } from "./git";
import { issuesText, surfacesInvalid, validateSurfacesYaml } from "./registry";

export {
  CLASS_HEADING,
  classIds,
  classifyClasses,
  classifyMonotone,
  classifySurface,
  contentTag,
  type Dim,
  EFFORTS,
  type FileState,
  inSkillDir,
  type MonotoneScope,
  type MonotoneSide,
  type MonotoneVerdict,
  named,
  neededPaths,
  rowLine,
  skillDir,
  uncovered,
};

export type Signoff = MonotoneSignoff;

const ABSENT: FileState = { kind: "absent" };

function unresolved(what: string, fix: string): never {
  return precondition("gate-monotone-unresolved", what, fix);
}

export interface MonotoneSides {
  readonly top: string;
  readonly fork: string;
  readonly base: MonotoneSide;
  readonly head: MonotoneSide;
  readonly changed: ReadonlyArray<string>;
}

function decodeSide(label: string, path: string, text: string | null): SurfacesFile | null {
  if (text === null) return null;
  const v = validateSurfacesYaml(text);
  return v.ok ? v.value : surfacesInvalid(`${path} (${label})`, issuesText(v.issues));
}

/**
 * The merge-base side (blobs at the fork of `base` and HEAD) and the working-tree side of the registry
 * and every file it points at, plus the changed paths.
 */
export async function readMonotoneSides(input: { readonly cwd: string; readonly base: string; readonly registry: string; readonly g: Git }): Promise<MonotoneSides> {
  const { g } = input;
  const top = await repoRoot(g, input.cwd);
  if (top === null) return unresolved(`${input.cwd} is not inside a git checkout`, "Run gate ci from a checkout of the changed repo.");
  const tip = await revParse(g, input.base, top);
  if (tip === null) return unresolved(`base ${input.base}: does not name a commit in this checkout`, "Check out the PR with fetch-depth: 0 so its base commit is present.");
  const fork = await mergeBase(g, top, tip, "HEAD");
  if (fork === null) return unresolved(`base ${input.base}: shares no history with HEAD`, "Check out the PR with fetch-depth: 0 so its base and head share history.");

  const failed = (what: string) => unresolved(what, "Re-run; check 'git status' works in this checkout.");
  const atBase = async (path: string): Promise<FileState> => {
    const ls = await run(g, top, ["ls-tree", "-z", fork, "--", path]);
    if (!ok(ls)) return failed(`git ls-tree ${fork} -- ${path} failed`);
    const entry = ls.stdout.toString("utf8").split("\0")[0] ?? "";
    if (entry === "" || !entry.includes(" blob ")) return ABSENT;
    const shownBlob = await run(g, top, ["show", `${fork}:${path}`]);
    if (!ok(shownBlob)) return failed(`git show ${fork}:${path} failed`);
    const t = shownBlob.stdout.toString("utf8");
    return entry.startsWith("120000 ") ? { kind: "symlink", target: t } : { kind: "text", text: t };
  };
  const atHead = (path: string): FileState => {
    const abs = join(top, path);
    try {
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) return { kind: "symlink", target: readlinkSync(abs) };
      if (!st.isFile()) return ABSENT;
    } catch {
      return ABSENT;
    }
    return { kind: "text", text: readFileSync(abs, "utf8") };
  };

  const regBase = await atBase(input.registry);
  const regHead = atHead(input.registry);
  if (regBase.kind === "symlink" || regHead.kind === "symlink") return surfacesInvalid(input.registry, "a symlink; the registry must be a regular file");
  const baseReg = decodeSide("merge-base", input.registry, regBase.kind === "text" ? regBase.text : null);
  const headReg = decodeSide("working tree", input.registry, regHead.kind === "text" ? regHead.text : null);

  const paths = [...new Set([...neededPaths(baseReg), ...neededPaths(headReg)])].sort();
  const baseFiles = new Map<string, FileState>();
  const headFiles = new Map<string, FileState>();
  for (const p of paths) {
    baseFiles.set(p, await atBase(p));
    headFiles.set(p, atHead(p));
  }
  const tracked = await changedPaths(g, top, fork);
  const untracked = await untrackedFiles(g, top);
  if (tracked === null || untracked === null) return failed("git could not list the changes");
  const changed = [...new Set([...tracked, ...untracked])].sort();
  const skills = [...new Set([...Object.keys(baseReg?.review_skills ?? {}), ...Object.keys(headReg?.review_skills ?? {})])];
  const digests = new Map<string, string>();
  for (const p of changed.filter((c) => skills.some((s) => inSkillDir(c, s)))) {
    const f = atHead(p);
    digests.set(p, f.kind === "text" ? contentTag(readFileSync(join(top, p))) : contentTag(f));
  }
  return { top, fork, base: { registry: baseReg, files: baseFiles }, head: { registry: headReg, files: headFiles, digests }, changed };
}

/**
 * The monotone verdict: print every changed row, pass when none widens, or when `issue`'s human
 * `surface-widen` receipt carries every wider row verbatim; else stop with `gate-monotone-wider`.
 */
export async function judgeMonotone(input: {
  readonly cwd: string;
  readonly base: string;
  readonly registry: string;
  readonly issue?: string | undefined;
  readonly g: Git;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly signoff?: ((issue: string) => Promise<Signoff>) | undefined;
}): Promise<void> {
  const sides = await readMonotoneSides(input);
  const changed = classifyMonotone(sides.base, sides.head, sides.changed).filter((d) => d.verdict !== "same");
  for (const d of changed) input.out(rowLine(d));
  const wider = changed.filter((d) => d.verdict === "wider");
  input.err(`monotone: ${changed.length - wider.length} tighter, ${wider.length} wider (against ${sides.fork.slice(0, 12)})`);
  if (wider.length === 0) return;
  let gap = "no --issue";
  if (input.issue !== undefined && input.signoff !== undefined) {
    const s = await input.signoff(input.issue);
    const missed = s.why === null && s.bytes !== undefined ? uncovered(wider, new TextDecoder().decode(s.bytes)) : wider;
    if (s.why === null && missed.length === 0) {
      input.err(`WARN monotone: ${wider.length} wider row(s) approved by ${input.issue}'s surface-widen receipt (human grant)`);
      return;
    }
    gap = s.why !== null ? `${input.issue}'s surface-widen receipt: ${s.why}` : `${input.issue}'s surface-widen artifact lacks ${missed.length} wider row(s)`;
  }
  precondition(
    "gate-monotone-wider",
    `${wider.length} dimension(s) widen the surface bar (${gap}): ${named(wider, "; ")}`,
    "Tighten instead, or have a human approve the widening:\n" +
      "  save the '@monotone' rows this run printed, without the '@monotone<TAB>' prefix, to a file, then commit and push it;\n" +
      "  eris gate record surface-widen --issue <KEY> --verdict PASS --artifact <that file>\n" +
      '    --authorized "<name> asked: <request>" (a doctrine: grant never approves a widening);\n' +
      "  then re-run the check.",
  );
}
