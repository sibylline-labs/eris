/**
 * shell.ts — the one body behind `eris completion bash` and `eris completion
 * zsh`: `--help` prints the verb's usage, no argument prints the script, and
 * anything else is refused with nothing on stdout (a shell rc sources stdout).
 *
 * The tree is the session's composed registry (src/cli/compose.ts): core rows
 * plus plugin rows. Rows are data, so no plugin handler loads here.
 */

import { CliExit, readVerbArgs } from "../../args";
import type { CliContext } from "../../../main";
import type { Session } from "../../compose";
import { emitScript, type Shell } from "./emit";

export function runShell(shell: Shell, usage: string, args: string[], ctx: CliContext & { session?: Session }): number {
  try {
    if (readVerbArgs(`completion ${shell}`, args, ctx, { help: usage }) === null) return 0;
  } catch (e) {
    if (e instanceof CliExit) return e.code;
    throw e;
  }
  ctx.stdout.write(emitScript(shell, ctx.session?.cli.registry));
  return 0;
}
