/**
 * usage.ts — bare `eris`, `eris -h` and `eris --help`: the top-level usage (the
 * former Bash entrypoint's `_eris_usage`).
 *
 * A composed build lists each plugin group after the built-in commands, a
 * locked one marked, every summary in one column (src/cli/compose.ts). The `--output` paragraph names every
 * json surface of the composed CLI, plugin rows included;
 * tests/cli-router.test.ts holds it against the `json` rows.
 */

import { CLI, type CliContext } from "../../main";
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
${fill(words)}
Run 'eris <command> --help' for command-specific usage.
`;
}

/** The top-level usage of one session's composed CLI. */
export function usageText(session: Session): string {
  return `${HEADER}${commandLines(session)}${globals(session.cli)}`;
}

/** This build's top-level usage (core plus plugins/index.ts), default entitlements. */
export const ERIS_USAGE = usageText({ cli: CLI, entitled: NO_ENTITLEMENTS });

export async function runUsage(_args: string[], ctx: CliContext & { session?: Session }): Promise<number> {
  ctx.stdout.write(ctx.session === undefined ? ERIS_USAGE : usageText(ctx.session));
  return 0;
}
