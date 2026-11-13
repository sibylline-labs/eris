/**
 * skills-lint.ts — the skill-kind contract check (`eris skills lint`,
 * docs/SKILLS.md#eris-skills-lint).
 *
 * Every `<root>/skills/*\/SKILL.md` and `<root>/.claude/skills/*\/SKILL.md`
 * declares one `kind:` in its frontmatter, and each kind carries a contract:
 *
 *   - `tool`: ships a non-empty `scripts/`.
 *   - `rubric`: at most `RUBRIC_MAX_LINES` lines, preloaded in the `skills:`
 *     frontmatter of an agent or skill (its producer), and named by a `gate`
 *     skill (its judge).
 *   - `reference`: no numbered procedure outside fenced code.
 *   - `workflow`: over `WORKFLOW_INLINE_MAX_LINES` lines, its stages live in a
 *     `references/` holding at least one `.md`.
 *   - `gate`, `mode`: no structural contract.
 *
 * This is a port of a Python lint, and stays finding-for-finding identical to
 * it: the same rule ids, messages and order. Where the two languages differ, the
 * Python semantics are reproduced here: `str.splitlines()` separators,
 * `str.strip()` whitespace, Unicode `\d` and `\w`, and the universal-newline
 * read that turns `\r\n` and a lone `\r` into `\n`.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const SKILL_KINDS = ["tool", "gate", "rubric", "workflow", "reference", "mode"] as const;
export type SkillKind = (typeof SKILL_KINDS)[number];

export interface SkillFinding {
  readonly skill: string;
  readonly rule: string;
  readonly message: string;
}

export type SkillKindRead = { readonly kind: SkillKind; readonly error: null } | { readonly kind: null; readonly error: "kind-missing" | "kind-duplicate" | "kind-unknown" };

export const RUBRIC_MAX_LINES = 60;
export const WORKFLOW_INLINE_MAX_LINES = 200;
export const SKILL_ROOTS = ["skills", ".claude/skills"] as const;
export const AGENT_ROOTS = ["agents", ".claude/agents"] as const;

const FRONTMATTER = /^---\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)/s;
const KIND_LINE = /^kind:(.*)$/s;
const ORDERED_ITEM = /^ {0,3}\p{Nd}+[.)] /u;
const STEP_HEADING = /^#{1,6} +(?:Step|Phase) +\p{Nd}/u;
const FENCE = /^ {0,3}(?:```|~~~)/;
/** `str.splitlines()`'s separators. */
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
/** `str.strip()`'s whitespace: `str.isspace()`, which is not JavaScript's `trim()` set. */
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");
/** Python's `\w` plus `-`: a character that continues a skill name. */
const NAME_CHAR_END = /[\p{L}\p{N}_-]$/u;
const KIND_LIST = `[${[...SKILL_KINDS].sort().map((k) => `'${k}'`).join(", ")}]`;

const pyStrip = (s: string): string => s.replace(PY_STRIP, "");

/** `s.strip(chars)` for a set of literal characters. */
function stripChars(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a]!)) a++;
  while (b > a && chars.includes(s[b - 1]!)) b--;
  return s.slice(a, b);
}

/** `str.splitlines()`: no trailing empty entry for a final separator. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(LINE_BREAK);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** A file as Python's `read_text()` sees it: `\r\n` and a lone `\r` read as `\n`. */
const readText = (path: string): string => readFileSync(path, "utf8").replace(/\r\n?/g, "\n");

const dropBom = (text: string): string => text.replace(/^\ufeff+/, "");

function frontmatter(text: string): string | null {
  return FRONTMATTER.exec(dropBom(text))?.[1] ?? null;
}

function stripValue(raw: string): string {
  const val = pyStrip(raw);
  if (val !== "" && (val[0] === '"' || val[0] === "'")) return val.length >= 2 && val[val.length - 1] === val[0] ? val.slice(1, -1) : val;
  return pyStrip(val.split(" #", 1)[0]!);
}

/** The top-level `kind:` a SKILL.md's frontmatter declares, or why it declares none. */
export function readSkillKind(text: string): SkillKindRead {
  const fm = frontmatter(text);
  if (fm === null) return { kind: null, error: "kind-missing" };
  const values = splitLines(fm).flatMap((line) => {
    const m = KIND_LINE.exec(line.replace(/\r+$/, ""));
    return m ? [stripValue(m[1]!)] : [];
  });
  if (values.length > 1) return { kind: null, error: "kind-duplicate" };
  const kind = values[0];
  if (kind === undefined || kind === "") return { kind: null, error: "kind-missing" };
  if (!(SKILL_KINDS as readonly string[]).includes(kind)) return { kind: null, error: "kind-unknown" };
  return { kind: kind as SkillKind, error: null };
}

const isDir = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

/** Every `SKILL.md` under the skill roots, each root's in directory-name order; symlinked dirs followed. */
function skillFiles(root: string): string[] {
  return SKILL_ROOTS.flatMap((rel) => {
    const base = join(root, rel);
    if (!isDir(base)) return [];
    return readdirSync(base)
      .sort()
      .map((name) => join(base, name, "SKILL.md"))
      .filter((p) => existsSync(p));
  });
}

/** `Path.rglob("*.md")` (Python 3.13+): every entry named `*.md` at any depth, symlinked dirs not descended. */
function mdFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const p = join(dir, name);
      const here = name.endsWith(".md") ? [p] : [];
      return lstatSync(p).isDirectory() ? [...here, ...mdFiles(p)] : here;
    });
}

/** True when the text outside fenced code holds 2+ ordered items or a `Step N` / `Phase N` heading. */
function hasNumberedProcedure(text: string): boolean {
  let inFence = false;
  let items = 0;
  for (const line of splitLines(text)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (STEP_HEADING.test(line)) return true;
    if (ORDERED_ITEM.test(line) && ++items >= 2) return true;
  }
  return false;
}

/** Every name in a column-0 `skills:` frontmatter line of an agent or a skill: the rubric producers. */
function preloads(root: string): Set<string> {
  const agents = AGENT_ROOTS.flatMap((rel) => {
    const base = join(root, rel);
    return isDir(base) ? readdirSync(base).filter((n) => n.endsWith(".md")).sort().map((n) => join(base, n)) : [];
  });
  const out = new Set<string>();
  for (const path of [...agents, ...skillFiles(root)]) {
    for (const line of splitLines(frontmatter(readText(path)) ?? "")) {
      if (!line.startsWith("skills:")) continue;
      const raw = stripChars(pyStrip(line.slice(line.indexOf(":") + 1)), "[]");
      for (const s of raw.split(",")) if (pyStrip(s) !== "") out.add(stripChars(pyStrip(s), `"'`));
    }
  }
  return out;
}

/** `name` (or `name@N`) in `text`, not inside a longer name: neither side touches a word character or `-`. */
function namesSkill(text: string, name: string): boolean {
  const re = new RegExp(`${name.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")}(?:@\\p{Nd}+)?(?![\\p{L}\\p{N}_-])`, "gu");
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (!NAME_CHAR_END.test(text.slice(Math.max(0, m.index - 2), m.index))) return true;
    re.lastIndex = m.index + 1;
  }
  return false;
}

/** A skill's name: its directory's. */
const skillName = (file: string): string => basename(dirname(file));

const finding = (skill: string, rule: string, message: string): SkillFinding => ({ skill, rule, message });

/** Every kind-contract violation under `root`'s skill roots, and how many skills were read. */
export function lintSkills(root: string): { readonly skills: number; readonly findings: readonly SkillFinding[] } {
  const files = skillFiles(root);
  const findings: SkillFinding[] = [];
  const kinds = new Map<string, SkillKind>();
  for (const file of files) {
    const read = readSkillKind(readText(file));
    if (read.kind === null) findings.push(finding(skillName(file), read.error, `declare one of ${KIND_LIST}`));
    else kinds.set(file, read.kind);
  }

  let producers: Set<string> | null = null;
  let gateTexts: string[] | null = null;
  for (const [file, kind] of kinds) {
    const name = skillName(file);
    const dir = dirname(file);
    const text = readText(file);
    if (kind === "tool") {
      const scripts = join(dir, "scripts");
      if (!isDir(scripts) || readdirSync(scripts).length === 0) findings.push(finding(name, "tool-without-scripts", "a tool ships scripts/"));
    } else if (kind === "reference") {
      if (hasNumberedProcedure(dropBom(text).replace(FRONTMATTER, ""))) {
        findings.push(finding(name, "reference-has-procedure", "a reference holds no numbered procedure: use bullets, or kind: workflow"));
      }
    } else if (kind === "workflow") {
      const lines = splitLines(text).length;
      const refs = join(dir, "references");
      if (lines > WORKFLOW_INLINE_MAX_LINES && !(isDir(refs) && mdFiles(refs).length > 0)) {
        findings.push(finding(name, "workflow-stages-inline", `${lines} lines, over ${WORKFLOW_INLINE_MAX_LINES}, with no references/: move each stage to references/<stage>.md`));
      }
    } else if (kind === "rubric") {
      const lines = splitLines(text).length;
      if (lines > RUBRIC_MAX_LINES) findings.push(finding(name, "rubric-too-long", `${lines} lines, at most ${RUBRIC_MAX_LINES}`));
      producers ??= preloads(root);
      if (!producers.has(name)) findings.push(finding(name, "rubric-no-producer", "no agent or skill preloads it in `skills:`"));
      gateTexts ??= [...kinds].filter(([, k]) => k === "gate").flatMap(([f]) => mdFiles(dirname(f)).map(readText));
      if (!gateTexts.some((t) => namesSkill(t, name))) findings.push(finding(name, "rubric-no-judge", "no kind: gate skill names it"));
    }
  }
  return { skills: files.length, findings };
}
