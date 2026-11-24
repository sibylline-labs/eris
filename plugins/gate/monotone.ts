/**
 * monotone.ts — the monotone surface bar: pure classification comes from `eris/gates-contract`; this
 * module adds the git merge-base/working-tree reader (`readMonotoneSides`) and CLI/CI judge
 * (`judgeMonotone`). The reader also reads the root `eris.yaml`'s `ratchets:` and each declared JSON
 * file on both sides; anything it cannot read as declared stops with `gate-ratchet-invalid`.
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
  type RatchetFile,
  type RatchetSide,
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

function ratchetInvalid(what: string): never {
  return precondition(
    "gate-ratchet-invalid",
    what,
    "Fix the file so it parses (JSON for a ratchet, YAML for eris.yaml), or list only existing repo-relative files under eris.yaml `ratchets:`; a ratchet that cannot be read is never read as unchanged.",
  );
}

/** Drop a leading UTF-8 byte-order mark, which editors may save and neither parser accepts as content. */
const unBom = (t: string): string => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);

/** A repo-relative path a ratchet may name: no absolute path, no `..` or `.` segment, no backslash. */
const RATCHET_PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\\)[^\u0000]+$/;

/** The `ratchets:` list of one side's root `eris.yaml` text (none: `[]`). */
function declaredRatchets(label: string, state: FileState): string[] {
  if (state.kind === "absent") return [];
  if (state.kind === "symlink") return ratchetInvalid(`eris.yaml (${label}) is a symlink; the root eris.yaml must be a regular file`);
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(unBom(state.text));
  } catch (e) {
    return ratchetInvalid(`eris.yaml (${label}) is not YAML: ${e instanceof Error ? e.message : "parse failed"}`);
  }
  const list = typeof doc === "object" && doc !== null && !Array.isArray(doc) ? (doc as Record<string, unknown>).ratchets : undefined;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || !list.every((p): p is string => typeof p === "string" && RATCHET_PATH.test(p)) || new Set(list).size !== list.length) {
    return ratchetInvalid(`eris.yaml (${label}): ratchets must be a list of unique repo-relative file paths (no absolute path, '.' or '..' segment)`);
  }
  return list;
}

/** One declared ratchet file on one side, parsed. */
function ratchetFile(label: string, path: string, state: FileState): RatchetFile {
  if (state.kind === "absent") return { kind: "absent" };
  if (state.kind === "symlink") return ratchetInvalid(`${path} (${label}) is a symlink; a ratchet must be a regular file`);
  try {
    return { kind: "json", value: JSON.parse(unBom(state.text)) };
  } catch (e) {
    return ratchetInvalid(`${path} (${label}) is not JSON: ${e instanceof Error ? e.message : "parse failed"}`);
  }
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
  const declaredBase = declaredRatchets("merge-base", await atBase("eris.yaml"));
  const declaredHead = declaredRatchets("working tree", atHead("eris.yaml"));
  const ratchetBase = new Map<string, RatchetFile>();
  const ratchetHead = new Map<string, RatchetFile>();
  for (const p of [...new Set([...declaredBase, ...declaredHead])].sort()) {
    const b = ratchetFile("merge-base", p, await atBase(p));
    const h = ratchetFile("working tree", p, atHead(p));
    if (declaredBase.includes(p) && declaredHead.includes(p) && b.kind === "absent" && h.kind === "absent") {
      return ratchetInvalid(`${p} is declared under eris.yaml ratchets: but exists on neither side`);
    }
    ratchetBase.set(p, b);
    ratchetHead.set(p, h);
  }
  const ratchets = (declared: string[], files: Map<string, RatchetFile>): RatchetSide => ({ declared, files });

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
  return {
    top,
    fork,
    base: { registry: baseReg, files: baseFiles, ratchets: ratchets(declaredBase, ratchetBase) },
    head: { registry: headReg, files: headFiles, digests, ratchets: ratchets(declaredHead, ratchetHead) },
    changed,
  };
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
