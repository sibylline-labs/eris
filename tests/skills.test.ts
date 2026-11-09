/**
 * skills/<name>/SKILL.md — the agent skills the skills CLI installs from this repo.
 * Seam: the files themselves, read as the skills CLI reads them (frontmatter) and
 * as an agent follows them (the `eris socrates` commands in code spans and fences),
 * checked against the registry rows in plugins/socrates/index.ts.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import socrates from "../plugins/socrates/index";

const SKILLS = join(import.meta.dir, "..", "skills");
const skillDirs = readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

/** The frontmatter keys of a SKILL.md (`key: value` lines between the first two `---` lines). */
function frontmatterOf(text: string): Record<string, string> {
  const lines = text.split("\n");
  if (lines[0] !== "---") return {};
  const end = lines.indexOf("---", 1);
  const out: Record<string, string> = {};
  for (const line of lines.slice(1, end < 0 ? 1 : end)) {
    const m = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** Every `eris socrates ...` command in a markdown body: inline code spans and fenced lines, `$ ` stripped. */
function socratesInvocations(markdown: string): string[] {
  const spans: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) spans.push(line.trim());
    else for (const m of line.matchAll(/`([^`]+)`/g)) spans.push(m[1]!);
  }
  return spans.map((s) => s.replace(/^\$\s+/, "")).filter((s) => /^eris socrates\b/.test(s));
}

type Row = { flags?: readonly { name: string }[] };
const ROWS = socrates.rows as Record<string, Row>;

describe("skills/", () => {
  // admits: a skill the skills CLI cannot discover installs as nothing; no type or lint sees a markdown file's frontmatter.
  test.each(skillDirs)("%s is discoverable by the skills CLI", (dir) => {
    // When a skill's directory has no SKILL.md, or its frontmatter name differs from the directory or its
    // description is empty, `npx skills add sibylline-labs/eris --skill <dir>` finds nothing to install —
    // observed here as the parsed frontmatter.
    const file = join(SKILLS, dir, "SKILL.md");
    expect(existsSync(file)).toBe(true);
    const fm = frontmatterOf(readFileSync(file, "utf8"));
    expect(fm.name).toBe(dir);
    expect((fm.description ?? "").length).toBeGreaterThan(20);
  });
});

const SOCRATES_SKILLS = ["eris-socrates", "socrates-capture", "socrates-consult"] as const;
const skillText = (dir: string) => readFileSync(join(SKILLS, dir, "SKILL.md"), "utf8");
const README = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");

describe.each(SOCRATES_SKILLS)("skills/%s", (dir) => {
  const body = () => skillText(dir);

  // admits: a verb or flag renamed in the registry leaves the skill naming a command that fails; no type reaches markdown code spans.
  test("names only verbs and flags the registry has", () => {
    // When a verb or flag is renamed in plugins/socrates/index.ts and this skill is not, an agent that follows
    // the skill runs a command that exits "unknown socrates command" — observed here as the unmatched command.
    const bad: string[] = [];
    const commands = socratesInvocations(body());
    for (const cmd of commands) {
      const tokens = cmd.split(/\s+/).filter((t) => !t.startsWith("<"));
      const rest = tokens.slice(1);
      const key = rest.length > 1 && !rest[1]!.startsWith("-") ? `socrates ${rest[1]}` : "socrates";
      const nested = rest.length > 2 && !rest[2]!.startsWith("-") && `${key} ${rest[2]}` in ROWS ? `${key} ${rest[2]}` : key;
      const row = ROWS[nested];
      if (!row) {
        bad.push(`${cmd}: no registry row "${nested}"`);
        continue;
      }
      const known = new Set([...(row.flags ?? []).map((f) => f.name), "--help", "--output"]);
      for (const t of tokens) if (t.startsWith("--") && !known.has(t)) bad.push(`${cmd}: ${t} is not a flag of "${nested}"`);
    }
    expect(commands.length).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  // admits: scoring steps copied into the skill drift from the CLI's help; "logic in prose" is only checkable as a size and vocabulary bound.
  test("stays thin: verb calls, no scoring logic", () => {
    // When rubric, threshold or answer-stamping steps are copied into the skill, they go stale against the CLI's
    // own help and the endpoint's policy, and two copies of the steering disagree — observed here as the
    // forbidden word or an over-long body.
    const text = body();
    expect(text.split("\n").length).toBeLessThanOrEqual(90);
    expect(text).not.toMatch(/rubric|threshold|scor(e|ing)|--answer|--override|load-bearing/i);
  });
});

describe("the Socrates skills' triggers", () => {
  const fm = (dir: string) => frontmatterOf(skillText(dir));

  // admits: a skill that cannot fire is never offered; only the description decides, and no type or lint reads it.
  test("socrates-capture fires when a stint ends and when a session decided something", () => {
    // When the capture skill is gated off the model, or its description loses the end-of-stint or decision
    // trigger, no session offers capture and decisions go unrecorded — observed here as the missing file,
    // the disable-model-invocation key or the missing trigger phrase.
    const file = join(SKILLS, "socrates-capture", "SKILL.md");
    expect(existsSync(file)).toBe(true);
    const f = fm("socrates-capture");
    expect(f["disable-model-invocation"]).toBeUndefined();
    expect(f.description).toMatch(/\b(stint|wrap(s|ping)? up|ends?)\b/i);
    expect(f.description).toMatch(/\bdecision/i);
  });

  // admits: same as above for the read side.
  test("socrates-consult fires before planning or deciding", () => {
    // When the consult skill is missing, gated off the model or loses its before-planning trigger, sessions
    // plan on an enrolled project without reading its docs — observed as the missing file, the key or the phrase.
    const file = join(SKILLS, "socrates-consult", "SKILL.md");
    expect(existsSync(file)).toBe(true);
    const f = fm("socrates-consult");
    expect(f["disable-model-invocation"]).toBeUndefined();
    expect(f.description).toMatch(/before[^.]*\b(plan|decid)/i);
  });

  // admits: the capture workflow is prose; only its verbs can be checked.
  test("the capture body walks discover, classify and submit; the consult body reads the brief and Canon", () => {
    // When the capture skill drops a verb of the discover -> classify -> submit chain, or consult drops the
    // brief or Canon read, the workflow the description promises cannot run — observed as the missing verb.
    const cap = socratesInvocations(skillText("socrates-capture")).join("\n");
    for (const v of ["status", "discover", "classify", "submit"]) expect(cap).toMatch(new RegExp(`eris socrates ${v}\\b`));
    const con = socratesInvocations(skillText("socrates-consult")).join("\n");
    expect(con).toMatch(/consult --brief/);
    expect(con).toMatch(/consult --canon/);
  });

  // admits: the setup skill keeps firing on capture and consult phrases if its description still names them.
  test("eris-socrates fires on setup only", () => {
    // When the setup skill's description still claims "record a decision" or "check a plan", it competes with
    // the two workflow skills and drowns their triggers in install steps — observed as the matched phrase.
    expect(fm("eris-socrates").description).not.toMatch(/record a decision|check a plan|before it decides/i);
  });
});

describe("the install path", () => {
  const SKILL_ADD = /npx skills add[^\n]*/g;

  // admits: a project-scope install writes .agents/, .claude/skills and skills-lock.json into the current repo; no type sees a docs line.
  test("every documented `npx skills add` of a Socrates skill is global, and the setup skill warns about project scope", () => {
    // When a doc line installs a Socrates skill without -g, an agent run from inside a repo writes the skill
    // into that repo's working tree — observed here as the line without -g or the missing warning.
    const lines = [README, ...SOCRATES_SKILLS.map(skillText)]
      .flatMap((t) => t.match(SKILL_ADD) ?? [])
      .filter((l) => /--skill (eris-socrates|socrates-)/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((l) => !/\s-g\b/.test(l))).toEqual([]);
    expect(skillText("eris-socrates")).toMatch(/project scope[^\n]*(writes|repo)/i);
  });
});
