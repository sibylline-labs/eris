/**
 * The widgets plugin's handler, loaded only when `eris widgets ...` dispatches.
 */

import { groupArgs, readArgs, renderFailureBlock, type VerbHandler } from "../../../src/cli/plugin";
import plugin from "./index";

const { rows } = plugin;

const USAGE = `Usage: eris widgets <command>

Commands:
  ping [--name <value>]   Reply with a pong
  count <n>               Print N widgets
`;

export const runWidgets: VerbHandler = async (args, ctx) => {
  const g = groupArgs(rows, "widgets", args);
  if (g.kind === "bare" || g.kind === "help") {
    ctx.stdout.write(USAGE);
    return 0;
  }
  if (g.kind === "unknown") {
    ctx.stderr.write(`ERROR Unknown widgets command: ${g.sub}\n`);
    return 1;
  }
  if (g.sub === "ping") {
    const a = readArgs(rows, "widgets ping", g.rest, ctx);
    if (a === null) return 0;
    const name = a.flags["--name"] ?? "world";
    ctx.stdout.write(ctx.format === "json" ? `${JSON.stringify({ pong: name })}\n` : `pong ${name}\n`);
    return 0;
  }
  const a = readArgs(rows, "widgets count", g.rest, ctx);
  if (a === null) return 0;
  const n = Number(a.pos[0]);
  if (!Number.isInteger(n) || n < 0) {
    ctx.stderr.write(
      renderFailureBlock({ slug: "widgets-count-invalid", what: `'${a.pos[0] ?? ""}' is not a count`, fix: "pass a whole number: eris widgets count 3" }, ctx.erisDir),
    );
    return 1;
  }
  for (let i = 1; i <= n; i++) ctx.stdout.write(`widget ${i}\n`);
  return 0;
};
