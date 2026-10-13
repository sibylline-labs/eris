/**
 * bash.ts — `eris completion bash`: the bash completion script on stdout.
 */

import type { CliContext } from "../../../main";
import type { Session } from "../../compose";
import { runShell } from "./shell";

const USAGE = `Usage: eris completion bash

Emit the bash completion script to stdout. Load it into the current shell
or make it permanent:

  source <(eris completion bash)                          # this shell only
  echo 'source <(eris completion bash)' >> ~/.bashrc      # every shell

The emitted script embeds a snapshot of the eris command tree, generated from
the verb registry; sourcing via process substitution (as above) keeps it
current automatically. See docs/COMPLETION.md.
`;

export function runBash(args: string[], ctx: CliContext & { session?: Session }): number {
  return runShell("bash", USAGE, args, ctx);
}
