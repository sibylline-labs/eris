/**
 * The example distribution's bare `eris`: one line naming the plugin groups,
 * standing in for a launcher. Loaded only when the bare program runs.
 */

import type { VerbHandler } from "eris/sdk";

export const runMenu: VerbHandler = async (_args, ctx) => {
  const groups = ctx.session?.cli.groups.map((g) => g.group) ?? [];
  ctx.stdout.write(`example distribution: ${groups.join(", ")} (eris --help for usage)\n`);
  return 0;
};
