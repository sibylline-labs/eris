/**
 * skills.ts — `eris skills <command>`: the agent skills this build publishes
 * (docs/SKILLS.md). `install` is ./skills/install.ts.
 */

import type { VerbContext } from "../../main";
import { groupArgs } from "../args";
import { sanitizeDisplay } from "../output";

const USAGE = `Usage: eris skills <command>

Commands:
  install [<skill>...]    Install published skills for your coding agents
                          (every skill when none is named)

Run 'eris skills install --help' for details. See docs/SKILLS.md.
`;

export async function runSkills(args: string[], ctx: VerbContext): Promise<number> {
  const g = groupArgs("skills", args);
  if (g.kind === "sub") return (await import("./skills/install")).runSkillsInstall(g.rest, ctx);
  if (g.kind === "bare" || g.kind === "help") {
    ctx.stdout.write(USAGE);
    return 0;
  }
  ctx.stderr.write(`ERROR Unknown skills command: ${sanitizeDisplay(g.sub)}. Run 'eris skills --help'\n`);
  return 1;
}
