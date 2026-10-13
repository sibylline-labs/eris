/**
 * zsh.ts — `eris completion zsh`: the zsh completion script on stdout.
 */

import type { CliContext } from "../../../main";
import type { Session } from "../../compose";
import { runShell } from "./shell";

const USAGE = `Usage: eris completion zsh

Emit the zsh completion script to stdout. Load it into the current shell
or make it permanent:

  source <(eris completion zsh)                           # this shell only
  echo 'source <(eris completion zsh)' >> ~/.zshrc        # every shell

Implementation: zsh loads the same completion body as bash through
bashcompinit (one body, two thin wrappers — the lower-maintenance route).
See docs/COMPLETION.md.
`;

export function runZsh(args: string[], ctx: CliContext & { session?: Session }): number {
  return runShell("zsh", USAGE, args, ctx);
}
