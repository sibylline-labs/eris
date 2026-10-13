/**
 * build.ts — compile this repository's eris into one executable.
 *
 *   bun scripts/build.ts [--outfile <path>] [--tag <release tag>]
 *
 * Writes `dist/eris-<os>-<arch>` (gitignored) for the HOST's own target, and
 * prints its path and build id. Each target builds on its own runner.
 *
 * The binary is `src/main.ts` composed with this build's plugins
 * (plugins/index.ts), compiled by `build()` (src/build.ts), which says what the
 * binary carries. A distribution calls the same `build()` from `eris/sdk` with
 * its own entry.
 */

import { join, relative } from "node:path";
import { parseArgs as parseCliArgs } from "node:util";
import { PLUGINS } from "../plugins";
import { build } from "../src/build";

const REPO = join(import.meta.dir, "..");

function parseArgs(argv: string[]): { outfile?: string; tag?: string } {
  try {
    const { values } = parseCliArgs({
      args: argv,
      options: { outfile: { type: "string" }, tag: { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
    return { outfile: values.outfile, tag: values.tag };
  } catch (e) {
    throw new Error(`usage: bun scripts/build.ts [--outfile <path>] [--tag <release tag>] (${(e as Error).message})`);
  }
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const r = await build({ entry: join(REPO, "src/main.ts"), root: REPO, plugins: PLUGINS, ...args });
    process.stdout.write(`${relative(process.cwd(), r.outfile) || r.outfile}\n`);
    process.stderr.write(`INFO build ${r.buildId}, ${r.assets} assets\n`);
  } catch (e) {
    process.stderr.write(`ERROR ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
