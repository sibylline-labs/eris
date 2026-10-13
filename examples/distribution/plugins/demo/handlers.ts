/**
 * The demo plugin's handler, loaded only when `eris demo ...` dispatches.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { groupArgs, readArgs, releaseRepo, type VerbHandler } from "eris/sdk";
import plugin from "./index";

const { rows } = plugin;

const USAGE = `Usage: eris demo <command>

Commands:
  hello <tone> [<name>]   Greet a name, loud or quiet
  asset                   Print the asset this build carries
  release                 Print where this build's releases are published
  heavy                   Load a module a compiled binary carries only as a stub
`;

/** The asset, by its path under the install root: the distribution's own directory from source, a binary's asset home compiled. */
const ASSET = "assets/greeting.txt";

export const runDemo: VerbHandler = async (args, ctx) => {
  const g = groupArgs(rows, "demo", args);
  if (g.kind === "bare" || g.kind === "help") {
    ctx.stdout.write(USAGE);
    return 0;
  }
  if (g.kind === "unknown") {
    ctx.stderr.write(`ERROR Unknown demo command: ${g.sub}\n`);
    return 1;
  }
  switch (g.sub) {
    case "hello": {
      const a = readArgs(rows, "demo hello", g.rest, ctx);
      if (a === null) return 0;
      const [tone, name = "world"] = a.pos;
      if (tone !== "loud" && tone !== "quiet") {
        ctx.stderr.write("ERROR demo hello needs a tone: loud or quiet\n");
        return 1;
      }
      const text = `hello ${name}`;
      ctx.stdout.write(`${tone === "loud" ? text.toUpperCase() : text}\n`);
      return 0;
    }
    case "asset":
      if (readArgs(rows, "demo asset", g.rest, ctx) === null) return 0;
      ctx.stdout.write(readFileSync(join(ctx.erisDir, ASSET), "utf8"));
      return 0;
    case "release":
      if (readArgs(rows, "demo release", g.rest, ctx) === null) return 0;
      ctx.stdout.write(`${releaseRepo()}\n`);
      return 0;
  }
  // The last sub: `heavy`.
  if (readArgs(rows, "demo heavy", g.rest, ctx) === null) return 0;
  const { heavy } = await import("./heavy");
  ctx.stdout.write(`${heavy()}\n`);
  return 0;
};
