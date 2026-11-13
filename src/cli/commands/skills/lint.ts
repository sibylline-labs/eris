/**
 * lint.ts — `eris skills lint [<dir>]`: check every skill under `<dir>`
 * against its kind's contract (src/runtime/skills-lint.ts, docs/SKILLS.md).
 *
 * Findings are the payload, one `skill: rule: message` line each on stdout;
 * the count goes to stderr. Findings exit 1 in both renderings, so a CI job or
 * a hook can gate on the status alone.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { renderFailureBlock } from "../../../../ts/lib/eris-fail";
import type { VerbHandler } from "../../../main";
import { lintSkills } from "../../../runtime/skills-lint";
import { CliExit, readVerbArgs } from "../../args";
import { sanitizeDisplay } from "../../output";

const USAGE = `Usage: eris skills lint [<dir>]

Check every skill under <dir> (default: the current directory) against the
contract of the kind its SKILL.md declares. Skills are read from
<dir>/skills/*/SKILL.md and <dir>/.claude/skills/*/SKILL.md; rubric
producers from the skills: frontmatter of <dir>/agents/*.md,
<dir>/.claude/agents/*.md and every SKILL.md.

Prints one 'skill: rule: message' line per finding, and the count on stderr.
Exits 1 when there is any finding, 0 when there is none.

Example:
  eris skills lint .

Flags:
  --help, -h    Print this usage text

--output json prints {skills, findings: [{skill, rule, message}]}. See docs/SKILLS.md.
`;

export const runSkillsLint: VerbHandler = async (args, ctx) => {
  const parsed = readVerbArgs("skills lint", args, ctx, { help: USAGE });
  if (parsed === null) return 0;
  const dir = resolve(parsed.pos[0] ?? ".");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    ctx.stderr.write(
      renderFailureBlock(
        { slug: "skills-lint-unreadable", what: `${sanitizeDisplay(dir)} is not a directory`, fix: "eris skills lint <dir>    name a directory holding skills/ or .claude/skills/" },
        ctx.erisDir,
      ),
    );
    throw new CliExit(1);
  }

  const { skills, findings } = lintSkills(dir);
  if (ctx.format === "json") ctx.stdout.write(`${JSON.stringify({ skills, findings })}\n`);
  else {
    ctx.stdout.write(findings.map((f) => `${sanitizeDisplay(f.skill)}: ${f.rule}: ${sanitizeDisplay(f.message)}\n`).join(""));
    ctx.stderr.write(`${findings.length} finding(s) over ${skills} skills\n`);
  }
  return findings.length > 0 ? 1 : 0;
};
