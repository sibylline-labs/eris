/**
 * install.ts — `eris skills install [<skill>...]`: write the named skills, or
 * every skill this build publishes, to the paths `npx skills add <repo> -g`
 * writes (src/runtime/skills.ts, docs/SKILLS.md).
 *
 * The skills come from the install root (a compiled binary's asset home holds
 * the ones its build carried), then this package's checkout, so a distribution
 * run from source installs core's skills too. Every name and every target is
 * checked before anything is written: an unknown name or a target holding
 * something else refuses the whole command with nothing changed.
 */

import { homedir } from "node:os";
import { renderFailureBlock } from "../../../../ts/lib/eris-fail";
import type { VerbHandler } from "../../../main";
import { checkoutRoot } from "../../../runtime/home";
import { checkTargets, InstallError, installSkill, OccupiedError, publishedSkills, type PublishedSkill, type SkillInstall } from "../../../runtime/skills";
import { CliExit, readVerbArgs } from "../../args";
import { sanitizeDisplay } from "../../output";

const USAGE = `Usage: eris skills install [<skill>...]

Install agent skills this build publishes, each at ~/.agents/skills/<skill>
(read by Codex, Cursor, Amp, Cline and other agents) and, when ~/.claude
exists, linked at ~/.claude/skills/<skill> for Claude Code: the layout
'npx skills add sibylline-labs/eris -g --skill <skill>' writes. With no skill
named, installs every published skill. A rerun updates a changed skill and
leaves an unchanged one alone.

Example:
  eris skills install eris-socrates

Flags:
  --help, -h    Print this usage text

--output json prints {skills: [{name, path, state, links}]}. See docs/SKILLS.md.
`;

/** `~` for the home directory in a printed path. */
const tilde = (home: string, p: string): string => (p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

function render(home: string, done: readonly SkillInstall[]): string {
  return done
    .map((s) => `${s.state} ${s.name} -> ${tilde(home, s.path)}\n${s.links.map((l) => `  ${l.agent}: ${tilde(home, l.path)} (${l.state})\n`).join("")}`)
    .join("");
}

export const runSkillsInstall: VerbHandler = async (args, ctx) => {
  const parsed = readVerbArgs("skills install", args, ctx, { help: USAGE });
  if (parsed === null) return 0;
  const fail = (slug: string, what: string, fix: string): never => {
    ctx.stderr.write(renderFailureBlock({ slug, what, fix }, ctx.erisDir));
    throw new CliExit(1);
  };

  const published = publishedSkills([...new Set([ctx.erisDir, checkoutRoot()])]);
  const names = parsed.pos.length > 0 ? [...new Set(parsed.pos)] : [...published.keys()];
  const available = [...published.keys()].join(", ");
  if (published.size === 0) fail("skills-unknown", "this build publishes no skills", "reinstall eris: a complete build carries its skills/ directory");
  const unknown = names.filter((n) => !published.has(n));
  if (unknown.length > 0) {
    fail("skills-unknown", `no published skill named ${unknown.map((n) => `'${sanitizeDisplay(n)}'`).join(", ")}`, `published skills: ${available}\neris skills install <skill>    install one by name, or name none to install all`);
  }
  const skills: PublishedSkill[] = names.map((n) => published.get(n)!);

  const home = ctx.env.HOME || homedir();
  const install = (fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      if (e instanceof OccupiedError) {
        fail("skills-target-occupied", `${tilde(home, e.path)} ${e.holds}; nothing was installed`, `move or remove it, then run the command again:\n  rm -r ${e.path}`);
      }
      if (e instanceof InstallError) fail("skills-install-failed", `could not write ${tilde(home, e.path)}: ${sanitizeDisplay(e.reason)}`, "check that you can write ~/.agents and ~/.claude, then run the command again");
      throw e;
    }
  };

  install(() => skills.forEach((s) => checkTargets(home, s)));
  const done: SkillInstall[] = [];
  for (const s of skills) install(() => done.push(installSkill(home, s)));

  if (ctx.format === "json") ctx.stdout.write(`${JSON.stringify({ skills: done })}\n`);
  else ctx.stdout.write(render(home, done));
  return 0;
};
