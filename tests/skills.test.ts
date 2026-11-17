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
import yak from "../plugins/yak/index";

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

const SOCRATES_SKILLS = ["eris-socrates", "socrates-capture", "socrates-consult", "socrates-resolve"] as const;
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
      const tokens = cmd.split(/\s+/).map((t) => t.replace(/^[[(]+|(?:[\])]+|\.{3})+$/g, "")).filter((t) => t && !t.startsWith("<"));
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
    expect(f.description).toMatch(/\basks? (you )?to (log|record)\b/i);
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

  // admits: the capture flow's routes are prose over verb calls; only the calls and flags it names can be checked.
  test("the capture body reads the docs before classifying and names every route a candidate can take", () => {
    // When capture classifies without reading the living docs, `already recorded` and contradictions go unseen; when it
    // drops --unfit, --kind prd or conflict, or the evidence flags, those candidates are forced into the wrong shape or
    // file with no evidence — observed as the missing call or flag, or consult coming after classify.
    const cap = socratesInvocations(skillText("socrates-capture")).join("\n");
    const consult = cap.search(/eris socrates consult --brief/);
    expect(consult).toBeGreaterThanOrEqual(0);
    expect(consult).toBeLessThan(cap.search(/eris socrates classify\b/));
    for (const flag of ["--unfit", "--hypothesis", "--kind prd", "--kind conflict", "--evidence", "--fragment", "--project"]) expect(cap).toContain(flag);
  });

  // admits: a resolve skill that cannot fire never resolves; only its description and verbs can be checked.
  test("socrates-resolve fires when a review Epic closes and walks the hosted check and resolve", () => {
    // When the resolve skill is missing, gated off the model, or loses its closed-Epic trigger, a closed Epic waits for a
    // command nobody gives; when it drops the policy check or the resolve call, it cannot tell the hosted path from its own
    // — observed as the missing file, key, phrase or verb.
    const file = join(SKILLS, "socrates-resolve", "SKILL.md");
    expect(existsSync(file)).toBe(true);
    const f = fm("socrates-resolve");
    expect(f["disable-model-invocation"]).toBeUndefined();
    expect(f.description).toMatch(/review Epic/i);
    expect(f.description).toMatch(/\bclos(e|es|ed)\b/i);
    const res = socratesInvocations(skillText("socrates-resolve")).join("\n");
    expect(res).toMatch(/eris socrates settings policy/);
    expect(res).toMatch(/eris socrates resolve\b/);
    expect(res).toContain("--amend");
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
    for (const dir of SOCRATES_SKILLS) expect(lines.some((l) => l.includes(`--skill ${dir}`))).toBe(true);
    expect(skillText("eris-socrates")).toMatch(/project scope[^\n]*(writes|repo)/i);
  });
});

const YAK_ROWS = yak.rows as Record<string, Row>;

/** Every `eris yak ...` command in a markdown body: inline code spans and fenced lines, `$ ` stripped. */
function yakInvocations(markdown: string): string[] {
  return socratesInvocations(markdown.replace(/eris yak/g, "eris socrates")).map((c) => c.replace(/^eris socrates/, "eris yak"));
}

describe("the Yaks usage skill", () => {
  const yakSkill = () => join(SKILLS, "yak-filing", "SKILL.md");

  // admits: a skill that cannot fire is never offered; only the description decides, and no type or lint reads it.
  test("yak-filing fires when the agent's own tooling fights back", () => {
    // When the usage skill is missing, gated off the model, or its description loses the friction trigger, a
    // session whose repo has no AGENTS.md block never reaches for `eris yak` on friction — observed here as the
    // missing file, the disable-model-invocation key or the missing trigger phrase.
    expect(existsSync(yakSkill())).toBe(true);
    const f = frontmatterOf(readFileSync(yakSkill(), "utf8"));
    expect(f["disable-model-invocation"]).toBeUndefined();
    expect(f.description).toMatch(/fights? back|errors?|blocks?/i);
    expect(f.description).toMatch(/\bmid-task\b|\bwhen\b/i);
  });

  // admits: the setup skill keeps firing on friction phrases if its description still names them.
  test("eris-yaks fires on setup only", () => {
    // When the setup skill's description claims filing friction, it competes with the usage skill and buries
    // its trigger in install steps — observed as the matched phrase.
    const f = frontmatterOf(skillText("eris-yaks"));
    expect(f.description).toMatch(/\bset up\b/i);
    expect(f.description).not.toMatch(/fights? back|file a yak/i);
  });

  // admits: a verb or flag renamed in the registry leaves the skill naming a command that fails; no type reaches markdown code spans.
  test("yak-filing names only verbs and flags the registry has", () => {
    // When a verb or flag is renamed in plugins/yak/index.ts and the skill is not, an agent that follows it runs
    // a command that exits unknown — observed here as the unmatched command.
    expect(existsSync(yakSkill())).toBe(true);
    const text = readFileSync(yakSkill(), "utf8");
    const bad: string[] = [];
    const commands = yakInvocations(text);
    for (const cmd of commands) {
      const tokens = cmd.split(/\s+/).map((t) => t.replace(/^[[(]+|(?:[\])]+|\.{3})+$/g, "")).filter((t) => t && !t.startsWith("<"));
      const verb = tokens[2] && !tokens[2].startsWith("-") ? `yak ${tokens[2]}` : "yak";
      const row = YAK_ROWS[verb];
      if (!row) {
        bad.push(`${cmd}: no registry row "${verb}"`);
        continue;
      }
      const known = new Set([...(row.flags ?? []).map((f) => f.name), "--help", "--output"]);
      for (const t of tokens) if (t.startsWith("--") && !known.has(t)) bad.push(`${cmd}: ${t} is not a flag of "${verb}"`);
    }
    expect(commands.length).toBeGreaterThan(0);
    expect(bad).toEqual([]);
    expect(text.split("\n").length).toBeLessThanOrEqual(60);
  });

  // admits: a project-scope install writes .agents/, .claude/skills and skills-lock.json into the current repo; no type sees a docs line.
  test("every documented `npx skills add` of a Yaks skill is global, and steps 7 and 8 name user scope first", () => {
    // When a doc line installs a Yaks skill without -g, or step 7 or 8 puts the repo ahead of the user's own
    // files, filing is on in one repo and silent in every other — observed here as the line without -g or the
    // out-of-order scope.
    const setup = skillText("eris-yaks");
    const lines = [README, setup, ...(existsSync(yakSkill()) ? [readFileSync(yakSkill(), "utf8")] : [])]
      .flatMap((t) => t.match(/npx skills add[^\n]*/g) ?? [])
      .filter((l) => /--skill (eris-yaks|yak-filing)/.test(l));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.filter((l) => !/\s-g\b/.test(l))).toEqual([]);
    expect(lines.some((l) => /--skill yak-filing/.test(l))).toBe(true);
    expect(setup).toMatch(/project scope[^\n]*(writes|repo)/i);
    const step7 = setup.slice(setup.indexOf("## 7."), setup.indexOf("## 8."));
    const step8 = setup.slice(setup.indexOf("## 8."), setup.indexOf("## Done"));
    expect(step7.search(/global|user-level|user's/i)).toBeGreaterThanOrEqual(0);
    expect(step7.search(/global|user-level|user's/i)).toBeLessThan(step7.search(/repo's|per-repo/i));
    expect(step8.indexOf("~/.claude/settings.json")).toBeGreaterThanOrEqual(0);
    expect(step8.indexOf("~/.claude/settings.json")).toBeLessThan(step8.search(/repo's\s+`\.claude\/settings\.json`/));
  });
});
