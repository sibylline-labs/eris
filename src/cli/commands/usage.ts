/**
 * usage.ts — bare `eris`, `eris -h` and `eris --help`: the top-level usage (the
 * former Bash entrypoint's `_eris_usage`).
 *
 * A composed build lists each plugin group after the built-in commands, a
 * locked one marked, every summary in one column (src/cli/compose.ts). The `--output` paragraph names every
 * json surface of the composed CLI, plugin rows included;
 * tests/cli-router.test.ts holds it against the `json` rows. A build whose bare
 * program is a distribution's menu says so in the last line.
 */

import { type CliContext, defaultCli } from "../../main";
import { type Cli, commandLines, NO_ENTITLEMENTS, type Session } from "../compose";

const HEADER = `Usage: eris <command> [args]

Commands:
`;

const FLAG_COLUMN = " ".repeat(23);
/** The widest line of the `--output` paragraph. */
const WIDTH = 78;

/** Words filled greedily into lines of at most `WIDTH`; a word never breaks. */
function fill(words: readonly string[]): string {
  const lines: string[] = [];
  let line = "  --output text|json   ";
  let fresh = true;
  for (const w of words) {
    if (!fresh && line.length + 1 + w.length > WIDTH) {
      lines.push(line);
      line = FLAG_COLUMN;
      fresh = true;
    }
    line += fresh ? w : ` ${w}`;
    fresh = false;
  }
  return [...lines, line].map((l) => `${l}\n`).join("");
}

/** The global flags, the `--output` paragraph naming each json surface `cli` composes. */
function globals(cli: Cli): string {
  const surfaces = Object.entries(cli.jsonSurfaces).map(([g, s]) => (s === true ? g : `${g} ${s.join("|")}`));
  const words = [
    ..."Output format. 'json' is the machine rendering, accepted by:".split(" "),
    ...surfaces.map((s, i) => `${s}${i === surfaces.length - 1 ? "." : ","}`),
    ..."Any other verb refuses the flag (docs/OUTPUT-CONTRACT.md). Default: text.".split(" "),
  ];
  return `
Global flags:
${fill(words)}  --version            Print this build's version and release repository.

Run 'eris <command> --help' for command-specific usage.
${cli.hasMenu ? "Run 'eris' without arguments for interactive mode.\n" : ""}`;
}

/**
 * The first-run order: each step is a verb and what it is for. A step whose verb this composed CLI
 * does not carry is left out, and the block is left out when fewer than two steps remain, so a
 * distribution with other plugins never names a verb it lacks.
 */
const START_HERE: readonly { readonly verb: string; readonly run?: string; readonly what: string }[] = [
  { verb: "login", what: "sign this machine in to your org (one login serves org, socrates, doctrine and gate)" },
  { verb: "org connect-linear", what: "connect the org's Linear workspace" },
  { verb: "org connect-github", what: "install the GitHub App on your GitHub org and bind it" },
  { verb: "doctrine settings", what: "Gates: read the org's settings, then set the ones you need (login already pulled the policy)" },
  { verb: "socrates settings", what: "Socrates: enrol projects, choose the Canon doc and the review team" },
  { verb: "org webhooks", run: "org webhooks logfire", what: "print the alert webhook URL to paste into Logfire" },
];

/** The "Start here" block of one composed CLI, or "" when it carries too few of the steps. */
function startHere(cli: Cli): string {
  const steps = START_HERE.filter((s) => Object.hasOwn(cli.registry, s.verb));
  if (steps.length < 2) return "";
  const width = Math.max(...steps.map((s) => (s.run ?? s.verb).length));
  const rows = steps.map((s, i) => `  ${i + 1}. eris ${(s.run ?? s.verb).padEnd(width)}  ${s.what}\n`).join("");
  return `
Start here (first run, in order):
${rows}  Check where you are: 'eris whoami' (signed in?), 'eris doctrine settings', 'eris socrates settings health'.
`;
}

/** The top-level usage of one session's composed CLI. */
export function usageText(session: Session): string {
  return `${HEADER}${commandLines(session)}${startHere(session.cli)}${globals(session.cli)}`;
}

/** This build's top-level usage (core plus plugins/index.ts), default entitlements. */
export const erisUsage = (): string => usageText({ cli: defaultCli(), entitled: NO_ENTITLEMENTS });

export async function runUsage(_args: string[], ctx: CliContext & { session?: Session }): Promise<number> {
  ctx.stdout.write(ctx.session === undefined ? erisUsage() : usageText(ctx.session));
  return 0;
}
