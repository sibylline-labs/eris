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

describe("skills/eris-socrates", () => {
  const file = join(SKILLS, "eris-socrates", "SKILL.md");
  const body = () => readFileSync(file, "utf8");

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

  test("stays thin: verb calls, no scoring logic", () => {
    // When rubric, threshold or answer-stamping steps are copied into the skill, they go stale against the CLI's
    // own help and the endpoint's policy, and two copies of the steering disagree — observed here as the
    // forbidden word or an over-long body.
    const text = body();
    expect(text.split("\n").length).toBeLessThanOrEqual(90);
    expect(text).not.toMatch(/rubric|threshold|scor(e|ing)|--answer|--override|load-bearing/i);
  });
});
