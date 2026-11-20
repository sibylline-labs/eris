/**
 * monotone.ts — the monotone surface bar: any actor may tighten a surface; anything wider, on any
 * dimension and even when another dimension tightens, needs a human. `classifyMonotone` compares two
 * sides of `.claude/surfaces.yml`, the surface vocabularies and the registered review skill
 * directories, one row per dimension; `readMonotoneSides` reads the merge-base side from git and the
 * head side from the working tree; `judgeMonotone` is `gate ci`'s monotone leg.
 *
 * A vocabulary or class checklist tightens only by addition: after CRLF and trailing-newline
 * normalisation the base text must be a prefix of the head, and the tail must start at a class
 * heading and add only new class IDs. Anything else (an edit, a reorder, a demoted heading) is wider.
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { CLASS_HEADING, classIds, DEFAULT_AUDIT_TTL, DEFAULT_CHANGE_BUDGET, DEFAULT_SEVERITY_FLOOR, SEVERITY_FLOORS, type SurfaceEntry, type SurfacesFile, UNLOCK_ACTIONS } from "eris/gates-contract";
import { precondition } from "./failure";
import { changedPaths, type Git, mergeBase, ok, repoRoot, revParse, run, untrackedFiles } from "./git";
import { issuesText, surfacesInvalid, validateSurfacesYaml, vocabularyPath } from "./registry";

export { CLASS_HEADING, classIds };

export type MonotoneVerdict = "tighter" | "same" | "wider";
export type MonotoneScope = "surface" | "vocabulary" | "review-skill";

export interface Dim {
  readonly scope: MonotoneScope;
  readonly subject: string;
  readonly field: string;
  readonly verdict: MonotoneVerdict;
  readonly detail: string;
}

/** A file on one side: absent, a symlink (never followed; its target text), or its text. */
export type FileState = { readonly kind: "absent" } | { readonly kind: "symlink"; readonly target: string } | { readonly kind: "text"; readonly text: string };

export interface MonotoneSide {
  readonly registry: SurfacesFile | null;
  /** Every vocabulary and checklist path `neededPaths` names for either side. */
  readonly files: ReadonlyMap<string, FileState>;
  /** Head only: the content of each changed path under a review skill directory (`contentTag`). */
  readonly digests?: ReadonlyMap<string, string>;
}

/**
 * The head content a wider row names, so a `surface-widen` artifact approves these bytes and no later
 * edit of the same file: `sha256:<12 hex>`, `deleted`, or `symlink -> <target>`.
 */
export function contentTag(f: FileState | Uint8Array): string {
  if (f instanceof Uint8Array) return `sha256:${createHash("sha256").update(f).digest("hex").slice(0, 12)}`;
  if (f.kind === "absent") return "deleted";
  if (f.kind === "symlink") return `symlink -> ${f.target}`;
  return contentTag(new TextEncoder().encode(f.text));
}

/** The effort qualifiers of an unlock gate, weakest first. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const ABSENT: FileState = { kind: "absent" };

/** The tab-separated payload line a row prints as, and the line a `surface-widen` artifact must carry. */
export const rowLine = (d: Dim): string => `${d.scope}\t${d.subject}\t${d.field}\t${d.verdict}\t${d.detail}`;

export const skillDir = (name: string): string => `skills/${name}/`;

/** `path` is the skill's directory itself (replaced by a symlink or a file) or lies under it. */
export const inSkillDir = (path: string, name: string): boolean => path === `skills/${name}` || path.startsWith(skillDir(name));

/** The vocabulary and checklist paths a registry points at. */
export function neededPaths(reg: SurfacesFile | null): string[] {
  if (reg === null) return [];
  const vocab = Object.entries(reg.surfaces).map(([n, s]) => vocabularyPath(n, s));
  const lists = Object.entries(reg.review_skills ?? {}).map(([n, e]) => `${skillDir(n)}${e.checklist}`);
  return [...new Set([...vocab, ...lists])];
}

const ttlHours = (ttl: string): number => Number(ttl.slice(0, -1)) * (ttl.endsWith("d") ? 24 : 1);

const cmp = (base: number, head: number, lowerIsTighter: boolean): MonotoneVerdict => (base === head ? "same" : head < base === lowerIsTighter ? "tighter" : "wider");

const shown = (v: string | number | undefined, dflt: string | number): string => (v === undefined ? `${dflt} (default)` : String(v));

const list = (xs: readonly string[]): string => (xs.length === 0 ? "[]" : xs.join(","));

function splitGate(token: string): { name: string; q: string | undefined } {
  const i = token.indexOf(":");
  return i === -1 ? { name: token, q: undefined } : { name: token.slice(0, i), q: token.slice(i + 1) };
}

const effortRank = (q: string | undefined): number => (q === undefined ? -1 : (EFFORTS as readonly string[]).indexOf(q));

/** Head keeps a base gate: the same token, or the same gate at an effort no lower. */
function gateKept(base: string, head: readonly string[]): boolean {
  if (head.includes(base)) return true;
  const b = splitGate(base);
  const rb = effortRank(b.q);
  if (rb < 0) return false;
  return head.some((t) => {
    const h = splitGate(t);
    return h.name === b.name && effortRank(h.q) >= rb;
  });
}

function unlockDim(name: string, action: string, base: readonly string[] | undefined, head: readonly string[] | undefined): Dim {
  const at = (verdict: MonotoneVerdict, detail: string): Dim => ({ scope: "surface", subject: name, field: `one_way_unlock.${action}`, verdict, detail });
  if (base === undefined && head === undefined) return at("same", "human-signed");
  if (base === undefined) return at("wider", `human-signed -> unlockable with ${list([...new Set(head)].sort())}`);
  if (head === undefined) return at("tighter", `unlockable with ${list([...new Set(base)].sort())} -> human-signed`);
  const b = [...new Set(base)].sort();
  const h = [...new Set(head)].sort();
  const lost = b.filter((g) => !gateKept(g, h));
  if (lost.length > 0) return at("wider", `${list(b)} -> ${list(h)} (drops ${lost.join(",")})`);
  return b.join(",") === h.join(",") ? at("same", list(h)) : at("tighter", `${list(b)} -> ${list(h)}`);
}

function setDim(scope: MonotoneScope, subject: string, field: string, base: readonly string[], head: readonly string[]): Dim {
  const removed = [...new Set(base)].filter((p) => !head.includes(p)).sort();
  const added = [...new Set(head)].filter((p) => !base.includes(p)).sort();
  const parts = [...(removed.length > 0 ? [`removed ${removed.join(",")}`] : []), ...(added.length > 0 ? [`added ${added.join(",")}`] : [])];
  const verdict: MonotoneVerdict = removed.length > 0 ? "wider" : added.length > 0 ? "tighter" : "same";
  return { scope, subject, field, verdict, detail: parts.join("; ") || "unchanged" };
}

/** Every dimension of one surface present on both sides. */
export function classifySurface(name: string, base: SurfaceEntry, head: SurfaceEntry): Dim[] {
  const at = (field: string, verdict: MonotoneVerdict, detail: string): Dim => ({ scope: "surface", subject: name, field, verdict, detail });
  const rows: Dim[] = [setDim("surface", name, "paths", base.paths, head.paths)];
  for (const action of UNLOCK_ACTIONS) rows.push(unlockDim(name, action, base.one_way_unlock?.[action], head.one_way_unlock?.[action]));
  const ttlB = base.audit_ttl ?? DEFAULT_AUDIT_TTL;
  const ttlH = head.audit_ttl ?? DEFAULT_AUDIT_TTL;
  rows.push(at("audit_ttl", cmp(ttlHours(ttlB), ttlHours(ttlH), true), `${shown(base.audit_ttl, DEFAULT_AUDIT_TTL)} -> ${shown(head.audit_ttl, DEFAULT_AUDIT_TTL)}`));
  const budB = base.change_budget ?? DEFAULT_CHANGE_BUDGET;
  const budH = head.change_budget ?? DEFAULT_CHANGE_BUDGET;
  rows.push(at("change_budget", cmp(budB, budH, true), `${shown(base.change_budget, DEFAULT_CHANGE_BUDGET)} -> ${shown(head.change_budget, DEFAULT_CHANGE_BUDGET)}`));
  // SEVERITY_FLOORS runs critical..low, so a larger index is a lower floor, which grades more findings.
  const rank = (s: string): number => (SEVERITY_FLOORS as readonly string[]).indexOf(s);
  const sevB = rank(base.severity_floor ?? DEFAULT_SEVERITY_FLOOR);
  const sevH = rank(head.severity_floor ?? DEFAULT_SEVERITY_FLOOR);
  rows.push(at("severity_floor", cmp(sevB, sevH, false), `${shown(base.severity_floor, DEFAULT_SEVERITY_FLOOR)} -> ${shown(head.severity_floor, DEFAULT_SEVERITY_FLOOR)}`));
  const vB = vocabularyPath(name, base);
  const vH = vocabularyPath(name, head);
  rows.push(at("class_taxonomy", vB === vH ? "same" : "wider", vB === vH ? vB : `${vB} -> ${vH}`));
  const lB = base.ledger ?? "none";
  const lH = head.ledger ?? "none";
  rows.push(at("ledger", lB === lH ? "same" : "wider", lB === lH ? lB : `${lB} -> ${lH}`));
  return rows;
}

/** The `#` and `##` heading lines outside fenced blocks: in an appended tail each must open a class. */
function topHeadings(markdown: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && /^#{1,2}(?:[ \t]|$)/.test(line)) out.push(line);
  }
  return out;
}

const normalise = (t: string): string => t.replace(/\r\n/g, "\n").replace(/\n+$/, "");

/** An addition-only change to a vocabulary or class checklist is tighter; anything else is wider. */
export function classifyClasses(base: FileState, head: FileState): { verdict: MonotoneVerdict; detail: string } {
  const wide = (why: string) => ({ verdict: "wider" as const, detail: `${why} (head ${contentTag(head)})` });
  if (base.kind === "symlink" || head.kind === "symlink") return wide("a symlink (its target is not compared)");
  if (base.kind === "absent") return head.kind === "absent" ? { verdict: "same", detail: "absent" } : { verdict: "tighter", detail: `added (${classIds(normalise(head.text)).join(",") || "no classes"})` };
  if (head.kind === "absent") return wide("deleted");
  const b = normalise(base.text);
  const h = normalise(head.text);
  if (b === h) return { verdict: "same", detail: "unchanged" };
  if (b !== "" && !h.startsWith(`${b}\n`)) return wide("base text changed (not addition-only)");
  const tail = (b === "" ? h : h.slice(b.length + 1)).replace(/^\n+/, "");
  if (!CLASS_HEADING.test(tail.split("\n", 1)[0] ?? "") || topHeadings(tail).some((l) => !CLASS_HEADING.test(l))) return wide("text added outside a new class section");
  const all = classIds(h);
  const dup = all.filter((id, i) => all.indexOf(id) !== i);
  if (dup.length > 0) return wide(`duplicate class ${[...new Set(dup)].join(",")}`);
  return { verdict: "tighter", detail: `classes added ${classIds(tail).join(",")}` };
}

const fileOf = (side: MonotoneSide, path: string): FileState => side.files.get(path) ?? ABSENT;

/**
 * Every dimension across both sides, `same` rows included (callers print only the rest). `changed` is
 * every path the diff names, deletes and untracked files included, git-top-relative.
 */
export function classifyMonotone(base: MonotoneSide, head: MonotoneSide, changed: readonly string[]): Dim[] {
  const rows: Dim[] = [];
  const bS = base.registry?.surfaces ?? {};
  const hS = head.registry?.surfaces ?? {};
  if (base.registry !== null && head.registry === null) rows.push({ scope: "surface", subject: "*", field: "registry", verdict: "wider", detail: "the registry was deleted" });
  for (const name of [...new Set([...Object.keys(bS), ...Object.keys(hS)])].sort()) {
    const b = bS[name];
    const h = hS[name];
    if (b !== undefined && h !== undefined) rows.push(...classifySurface(name, b, h));
    else rows.push({ scope: "surface", subject: name, field: "surface", verdict: b === undefined ? "tighter" : "wider", detail: b === undefined ? "added" : "removed" });
  }
  const vocab = new Set<string>();
  for (const [n, s] of Object.entries(bS)) vocab.add(vocabularyPath(n, s));
  for (const [n, s] of Object.entries(hS)) vocab.add(vocabularyPath(n, s));
  for (const path of [...vocab].sort()) rows.push({ scope: "vocabulary", subject: path, field: "classes", ...classifyClasses(fileOf(base, path), fileOf(head, path)) });
  const bR = base.registry?.review_skills ?? {};
  const hR = head.registry?.review_skills ?? {};
  for (const name of [...new Set([...Object.keys(bR), ...Object.keys(hR)])].sort()) {
    const b = bR[name];
    const h = hR[name];
    const at = (field: string, verdict: MonotoneVerdict, detail: string): Dim => ({ scope: "review-skill", subject: name, field, verdict, detail });
    const dir = skillDir(name);
    if (b === undefined) rows.push(at("entry", "tighter", "registered"));
    else if (h === undefined) rows.push(at("entry", "wider", "unregistered"));
    else if (b.checklist !== h.checklist) rows.push(at("entry", "wider", `checklist ${b.checklist} -> ${h.checklist}`));
    else {
      const c = classifyClasses(fileOf(base, `${dir}${b.checklist}`), fileOf(head, `${dir}${h.checklist}`));
      rows.push(at("checklist", c.verdict, c.detail));
    }
    const lists = new Set([b, h].filter((e) => e !== undefined).map((e) => `${dir}${e!.checklist}`));
    const sameList = b !== undefined && h !== undefined && b.checklist === h.checklist;
    for (const p of [...new Set(changed)].filter((p) => inSkillDir(p, name)).sort()) {
      if (sameList && lists.has(p)) continue;
      const what = p.startsWith(dir) ? p.slice(dir.length) : "the directory itself";
      rows.push(at("file", "wider", `${what} changed (review skills are human-edited; head ${head.digests?.get(p) ?? "unread"})`));
    }
  }
  const order: Record<MonotoneScope, number> = { surface: 0, vocabulary: 1, "review-skill": 2 };
  // Code-point order, never locale order: a surface-widen artifact matches rows verbatim on any host.
  const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return rows.sort((x, y) => order[x.scope] - order[y.scope] || byCode(x.subject, y.subject) || byCode(x.field, y.field) || byCode(x.detail, y.detail));
}

/** The wider rows a `surface-widen` artifact's lines do not carry verbatim. */
export function uncovered(wider: readonly Dim[], artifact: string): Dim[] {
  const lines = new Set(normalise(artifact).split("\n"));
  return wider.filter((d) => !lines.has(rowLine(d)));
}

/** `rows` named as a reason or a failure lists them: `<subject> <field> (<detail>)`. */
export const named = (rows: readonly Dim[], sep = ", "): string => rows.map((d) => `${d.subject} ${d.field} (${d.detail})`).join(sep);

// --- the git sides ---------------------------------------------------------------

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

/** A human sign-off's gap (null: it holds) and, when it holds, the bytes of the artifact it signed. */
export interface Signoff {
  readonly why: string | null;
  readonly bytes?: Uint8Array | undefined;
}

/**
 * `gate ci`'s monotone leg: print each changed row, pass when none widens, or when `issue`'s human
 * `surface-widen` receipt carries every wider row verbatim; else `gate-monotone-wider`.
 */
export async function judgeMonotone(input: {
  readonly cwd: string;
  readonly base: string;
  readonly registry: string;
  readonly issue: string;
  readonly g: Git;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly signoff: (issue: string) => Promise<Signoff>;
}): Promise<void> {
  const sides = await readMonotoneSides(input);
  const changed = classifyMonotone(sides.base, sides.head, sides.changed).filter((d) => d.verdict !== "same");
  for (const d of changed) input.out(rowLine(d));
  const wider = changed.filter((d) => d.verdict === "wider");
  input.err(`monotone: ${changed.length - wider.length} tighter, ${wider.length} wider (against ${sides.fork.slice(0, 12)})`);
  if (wider.length === 0) return;
  const s = await input.signoff(input.issue);
  const missed = s.why === null && s.bytes !== undefined ? uncovered(wider, new TextDecoder().decode(s.bytes)) : wider;
  if (s.why === null && missed.length === 0) {
    input.err(`WARN monotone: ${wider.length} wider row(s) approved by ${input.issue}'s surface-widen receipt (human grant)`);
    return;
  }
  const gap = s.why !== null ? `${input.issue}'s surface-widen receipt: ${s.why}` : `${input.issue}'s surface-widen artifact lacks ${missed.length} wider row(s)`;
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
