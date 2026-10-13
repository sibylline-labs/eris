/**
 * completion.ts — `eris completion <shell>`: emit a shell tab-completion
 * script. The script is generated from the verb registry
 * (./completion/emit.ts); `bash` is ./completion/bash.ts, `zsh`
 * ./completion/zsh.ts.
 *
 * It runs on every shell start (`source <(eris completion bash)`), so its
 * import graph is the registry and nothing else: no other verb, and no Bash.
 */

import { groupArgs } from "../args";
import type { CliContext } from "../../main";
import type { Session } from "../compose";
import { runBash } from "./completion/bash";
import { runZsh } from "./completion/zsh";

const USAGE = `Usage: eris completion <shell>

Shells:
  bash    Emit the bash completion script (bash 3.2+ clean)
  zsh     Emit the zsh completion script (bashcompinit route)

Load into the current shell:  source <(eris completion bash)
Make permanent:               echo 'source <(eris completion bash)' >> ~/.bashrc
                              echo 'source <(eris completion zsh)'  >> ~/.zshrc

Completes command groups, verbs, flags and file-valued flags. A tab press
never runs eris and never touches the network.
See docs/COMPLETION.md.
`;

export async function runCompletion(args: string[], ctx: CliContext & { session?: Session }): Promise<number> {
  const g = groupArgs("completion", args);
  if (g.kind === "sub") return (g.sub === "bash" ? runBash : runZsh)(g.rest, ctx);
  if (g.kind === "bare" || g.kind === "help") {
    ctx.stdout.write(USAGE);
    return 0;
  }
  ctx.stderr.write(`ERROR Unknown completion shell: ${g.sub} (supported: bash, zsh)\n`);
  return 1;
}
