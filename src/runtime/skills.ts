/**
 * skills.ts — the agent skills an install root publishes, and installing one
 * for the user's coding agents (`eris skills install`, docs/SKILLS.md).
 *
 * A published skill is a directory `skills/<name>/` holding a `SKILL.md`, the
 * layout the skills CLI (`npx skills add`) discovers. `build()` (src/build.ts)
 * carries every published skill into the binary's asset home; a run from source
 * reads them from the checkout. Given several roots, the first that holds a name
 * wins, so a distribution's own skill shadows core's of the same name.
 *
 * Install writes the layout `npx skills add <repo> -g --skill <name>` writes:
 * the skill at `~/.agents/skills/<name>/`, the directory the skills CLI calls
 * universal (Codex, Cursor, Amp, Cline and others read it), and, when
 * `~/.claude` is a directory, Claude Code's `~/.claude/skills/<name>` as a
 * relative symlink to it. It does not write the skills CLI's own
 * `~/.agents/.skill-lock.json`: that file is the skills CLI's state.
 *
 * A target is replaced only when it is recognisably this skill: a directory whose
 * SKILL.md is named for it (at the canonical path, or a copy-mode install at the
 * Claude Code path), or a link at the Claude Code path that already resolves to the
 * canonical copy. Anything else, a parent that is not a directory included, is an
 * `OccupiedError`, raised before anything is written. The write is race-safe as
 * src/runtime/home.ts's is: the tree goes to a private dot directory beside the
 * target and is renamed into place.
 */

import { randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

/** A skill name: the directory name, as the skills CLI's `--skill` takes it. */
const NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface PublishedSkill {
  readonly name: string;
  /** The directory holding the skill: `<root>/skills/<name>`. */
  readonly dir: string;
  /** Every file under `dir`, relative to it, sorted; dot entries skipped. */
  readonly files: readonly string[];
}

function filesUnder(base: string, rel = ""): string[] {
  return readdirSync(join(base, rel))
    .filter((e) => !e.startsWith("."))
    .flatMap((e) => {
      const r = rel === "" ? e : join(rel, e);
      return statSync(join(base, r)).isDirectory() ? filesUnder(base, r) : [r];
    })
    .sort();
}

/** The skills `roots` publish, by name in name order; the first root holding a name wins. */
export function publishedSkills(roots: readonly string[]): Map<string, PublishedSkill> {
  const found = new Map<string, PublishedSkill>();
  for (const root of roots) {
    const base = join(root, "skills");
    if (!existsSync(base) || !statSync(base).isDirectory()) continue;
    for (const name of readdirSync(base)) {
      const dir = join(base, name);
      if (found.has(name) || !NAME.test(name) || !statSync(dir).isDirectory() || !existsSync(join(dir, "SKILL.md"))) continue;
      found.set(name, { name, dir, files: filesUnder(dir) });
    }
  }
  return new Map([...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export type SkillState = "installed" | "updated" | "unchanged";
export type LinkState = "linked" | "replaced" | "unchanged";

export interface LinkResult {
  readonly agent: "claude-code";
  readonly path: string;
  readonly state: LinkState;
}

export interface SkillInstall {
  readonly name: string;
  readonly path: string;
  readonly state: SkillState;
  readonly links: readonly LinkResult[];
}

/** A target holds something this skill's install does not recognise as its own. */
export class OccupiedError extends Error {
  constructor(
    readonly path: string,
    readonly holds: string,
  ) {
    super(`${path} ${holds}`);
  }
}

/** A filesystem operation failed mid-install. */
export class InstallError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path}: ${reason}`);
  }
}

/** Where `name` is installed under `home`: the canonical copy and Claude Code's link. */
export function targetsOf(home: string, name: string): { canonical: string; claudeDir: string; claudeLink: string } {
  return { canonical: join(home, ".agents", "skills", name), claudeDir: join(home, ".claude"), claudeLink: join(home, ".claude", "skills", name) };
}

/** A directory, following a symlink: `~/.claude` may itself be one. */
const isDirFollowed = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const exists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** `p` with its deepest existing ancestor resolved through symlinks: where the OS will find it. */
function realish(p: string): string {
  const abs = resolve(p);
  for (let dir = abs, rest = ""; ; rest = rest === "" ? basename(dir) : join(basename(dir), rest), dir = dirname(dir)) {
    try {
      return join(realpathSync(dir), rest);
    } catch {
      if (dirname(dir) === dir) return abs;
    }
  }
}

/**
 * The relative target of Claude Code's link: from the link's real directory to the
 * canonical copy's. With `~/.claude` a plain directory it is `../../.agents/skills/<name>`,
 * the link `npx skills add -g` writes; a symlinked `~/.claude` gets the path that resolves
 * from where it really is.
 */
export const linkTarget = (link: string, canonical: string): string => relative(realish(dirname(link)), realCanonical(canonical));

/** The canonical path through its parent's real directory: stable while a peer swaps the skill directory itself. */
const realCanonical = (canonical: string): string => join(realish(dirname(canonical)), basename(canonical));

/** Whether directory `dir` holds exactly `skill`'s files, byte for byte; any read error is "no". */
function sameTree(dir: string, skill: PublishedSkill): boolean {
  try {
    const files = filesUnder(dir);
    if (files.length !== skill.files.length || files.some((f, i) => f !== skill.files[i])) return false;
    return files.every((f) => readFileSync(join(dir, f)).equals(readFileSync(join(skill.dir, f))));
  } catch {
    return false;
  }
}

/** The `name:` of a SKILL.md's frontmatter, or undefined. */
function frontmatterName(file: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return undefined;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") return undefined;
    const m = /^name:\s*(.+?)\s*$/.exec(line);
    if (m) return m[1]!.replace(/^["']|["']$/g, "");
  }
  return undefined;
}

/** What a target path holds: nothing, this skill (`ours`: the canonical copy or the link to it), a copy-mode install, or something else. */
type Occupant = { kind: "absent" } | { kind: "ours" } | { kind: "copy" } | { kind: "foreign"; holds: string };

/** A directory is this skill when its SKILL.md is named for it. */
const namedFor = (dir: string, name: string): boolean => frontmatterName(join(dir, "SKILL.md")) === name;

/** A concurrent install swaps the directory between the stat and the SKILL.md read: a foreign
 *  directory verdict is re-read a bounded number of times before it stands. */
function canonicalOccupant(canonical: string, name: string): Occupant {
  let o = canonicalOccupantOnce(canonical, name);
  for (let n = 1; n < 3 && o.kind === "foreign" && o.holds.startsWith("is a directory"); n++) {
    o = canonicalOccupantOnce(canonical, name);
  }
  return o;
}

function canonicalOccupantOnce(canonical: string, name: string): Occupant {
  let st;
  try {
    st = lstatSync(canonical);
  } catch {
    return { kind: "absent" };
  }
  if (st.isSymbolicLink()) return { kind: "foreign", holds: `is a symlink to ${readlinkSync(canonical)}` };
  if (!st.isDirectory()) return { kind: "foreign", holds: "is a file" };
  return namedFor(canonical, name) ? { kind: "ours" } : { kind: "foreign", holds: `is a directory that is not the ${name} skill` };
}

function claudeOccupant(link: string, canonical: string, name: string): Occupant {
  let st;
  try {
    st = lstatSync(link);
  } catch {
    return { kind: "absent" };
  }
  if (st.isSymbolicLink()) {
    const to = readlinkSync(link);
    return resolve(realish(dirname(link)), to) === realCanonical(canonical) ? { kind: "ours" } : { kind: "foreign", holds: `is a symlink to ${to}` };
  }
  if (st.isDirectory()) return namedFor(link, name) ? { kind: "copy" } : { kind: "foreign", holds: `is a directory that is not the ${name} skill` };
  return { kind: "foreign", holds: "is a file" };
}

/** A path on the way to a target that exists but is not a directory. */
function blockedParent(target: string, stop: string): string | undefined {
  for (let dir = dirname(target); dir.startsWith(stop) && dir !== stop; dir = dirname(dir)) {
    if (exists(dir) && !isDirFollowed(dir)) return dir;
  }
  return undefined;
}

/** Refuse, before anything is written, any target `skill` would not recognise as its own. */
export function checkTargets(home: string, skill: PublishedSkill): void {
  const t = targetsOf(home, skill.name);
  const parent = blockedParent(t.canonical, home) ?? (isDirFollowed(t.claudeDir) ? blockedParent(t.claudeLink, t.claudeDir) : undefined);
  if (parent !== undefined) throw new OccupiedError(parent, "is not a directory");
  const c = canonicalOccupant(t.canonical, skill.name);
  if (c.kind === "foreign") throw new OccupiedError(t.canonical, c.holds);
  if (isDirFollowed(t.claudeDir)) {
    const o = claudeOccupant(t.claudeLink, t.canonical, skill.name);
    if (o.kind === "foreign") throw new OccupiedError(t.claudeLink, o.holds);
  }
}

const scratchName = (parent: string, name: string, what: string): string => join(parent, `.${name}.${what}-${process.pid}-${randomBytes(4).toString("hex")}`);

const failed = (path: string, e: unknown): InstallError => new InstallError(path, e instanceof Error ? e.message : String(e));

const code = (e: unknown): string | undefined => (typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined);

/** Cleanup that never masks the error being reported. */
function quietly(fn: () => void): void {
  try {
    fn();
  } catch {
    // the outcome is already decided; a leftover dot directory is harmless
  }
}

/**
 * Write `skill` to its canonical directory; `unchanged` when it already holds the same tree.
 * A recognised install is replaced whole, local edits included. Concurrent installs of the
 * same skill end with this skill's tree in place, whichever wins the rename.
 */
function writeCanonical(canonical: string, skill: PublishedSkill): SkillState {
  const had = exists(canonical);
  if (had && sameTree(canonical, skill)) return "unchanged";
  const parent = dirname(canonical);
  const tmp = scratchName(parent, skill.name, "tmp");
  const olds: string[] = [];
  /** Move whatever is at the canonical path aside; a peer may already have. */
  const moveAside = (): void => {
    const old = scratchName(parent, skill.name, "old");
    try {
      renameSync(canonical, old);
      olds.push(old);
    } catch (e) {
      if (code(e) !== "ENOENT") throw e;
    }
  };
  try {
    mkdirSync(parent, { recursive: true });
    for (const f of skill.files) {
      mkdirSync(dirname(join(tmp, f)), { recursive: true });
      cpSync(join(skill.dir, f), join(tmp, f));
    }
    if (had) moveAside();
    // A concurrent install of the same skill can land its tree between our move and rename:
    // its tree stands if it is this one, else it is moved aside too. Bounded.
    for (let attempt = 1; ; attempt++) {
      try {
        renameSync(tmp, canonical);
        return had ? "updated" : "installed";
      } catch (e) {
        if (code(e) !== "EEXIST" && code(e) !== "ENOTEMPTY") throw e;
        if (sameTree(canonical, skill)) return "unchanged";
        if (attempt === RENAME_ATTEMPTS) throw e;
        moveAside();
      }
    }
  } catch (e) {
    // Put the previous install back rather than leave the skill missing.
    quietly(() => {
      if (!exists(canonical) && olds[0] !== undefined) renameSync(olds[0], canonical);
    });
    throw failed(canonical, e);
  } finally {
    quietly(() => rmSync(tmp, { recursive: true, force: true }));
    for (const old of olds) quietly(() => rmSync(old, { recursive: true, force: true }));
  }
}

/** How many times a rename that lost to a concurrent install is retried. */
const RENAME_ATTEMPTS = 8;

/** Point Claude Code's `~/.claude/skills/<name>` at the canonical copy. */
function writeClaudeLink(t: ReturnType<typeof targetsOf>, name: string): LinkState {
  const o = claudeOccupant(t.claudeLink, t.canonical, name);
  if (o.kind === "ours") return "unchanged";
  if (o.kind === "foreign") throw new OccupiedError(t.claudeLink, o.holds);
  const parent = dirname(t.claudeLink);
  const old = scratchName(parent, name, "old");
  try {
    mkdirSync(parent, { recursive: true });
    if (o.kind === "copy") renameSync(t.claudeLink, old);
    try {
      symlinkSync(linkTarget(t.claudeLink, t.canonical), t.claudeLink);
    } catch (e) {
      // A concurrent install linked it first: keep it if it is ours.
      if (code(e) !== "EEXIST" || claudeOccupant(t.claudeLink, t.canonical, name).kind !== "ours") throw e;
      return "unchanged";
    }
    return o.kind === "copy" ? "replaced" : "linked";
  } catch (e) {
    quietly(() => {
      if (!exists(t.claudeLink) && exists(old)) renameSync(old, t.claudeLink);
    });
    throw failed(t.claudeLink, e);
  } finally {
    quietly(() => rmSync(old, { recursive: true, force: true }));
  }
}

/** Install `skill` under `home`. Call `checkTargets` for every skill first. */
export function installSkill(home: string, skill: PublishedSkill): SkillInstall {
  const t = targetsOf(home, skill.name);
  const state = writeCanonical(t.canonical, skill);
  const links: LinkResult[] = isDirFollowed(t.claudeDir) ? [{ agent: "claude-code", path: t.claudeLink, state: writeClaudeLink(t, skill.name) }] : [];
  return { name: skill.name, path: t.canonical, state, links };
}
