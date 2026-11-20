/**
 * monotone.ts — pure monotone surface bar classification: compares two sides of `.claude/surfaces.yml`,
 * surface vocabularies and registered review-skill checklists, one row per dimension. Zero filesystem
 * or git I/O; the git reader and CLI driver live in the gate plugin.
 */

import { createHash } from "node:crypto";
import { CLASS_HEADING, classIds } from "./review-report";
import { DEFAULT_AUDIT_TTL, DEFAULT_CHANGE_BUDGET, DEFAULT_SEVERITY_FLOOR, SEVERITY_FLOORS, type SurfaceEntry, type SurfacesFile, UNLOCK_ACTIONS } from "./surfaces";
import { vocabularyPath } from "./surfaces-eval";

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

/** A human sign-off's gap (null: it holds) and, when it holds, the bytes of the artifact it signed. */
export interface MonotoneSignoff {
  readonly why: string | null;
  readonly bytes?: Uint8Array | undefined;
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
