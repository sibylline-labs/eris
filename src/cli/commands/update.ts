/**
 * update.ts — `eris update`: say how to get the latest release. eris ships as
 * an npm package, run by bun (docs/UPDATE.md), so there is nothing to replace in
 * place: the package manager that installed it is what updates it. The verb
 * reads nothing and fetches nothing; it prints the commands and exits 0.
 *
 * `--output json` prints `{current, commands}`: this build's version (`dev` in
 * a checkout) and the same commands, in the same order.
 *
 * A distribution that publishes compiled binaries swaps in the in-place verb,
 * `RELEASE_UPDATE` (./update/opt-in.ts).
 */

import type { VerbHandler } from "../../main";
import { VERSION } from "../../runtime/home";
import { readVerbArgs } from "../args";

/** The package's npm name: what every command below installs or runs. */
export const PACKAGE = "@sibylline-labs/eris";

/** How to get the latest release, in the order they are printed. */
export const UPDATE_COMMANDS: readonly string[] = [`npx ${PACKAGE}@latest <command>`, `bunx ${PACKAGE}@latest <command>`, `bun add -g ${PACKAGE}@latest`];

const USAGE = `Usage: eris update

Print how to get the latest eris release. eris is an npm package run by bun;
the package manager that installed it updates it, so this command changes
nothing.

Flags:
  --help, -h    Print this usage text

--output json prints {current, commands}.
`;

export const runUpdate: VerbHandler = async (args, ctx) => {
  if (readVerbArgs("update", args, ctx, { help: USAGE }) === null) return 0;
  if (ctx.format === "json") {
    ctx.stdout.write(`${JSON.stringify({ current: VERSION, commands: UPDATE_COMMANDS })}\n`);
    return 0;
  }
  const [npx, bunx, global] = UPDATE_COMMANDS;
  ctx.stdout.write(
    `eris ${VERSION}. Run the latest release with:\n  ${npx}\n  ${bunx}\nor install it globally (bun runs it, so bun must be on PATH):\n  ${global}\n`,
  );
  return 0;
};
