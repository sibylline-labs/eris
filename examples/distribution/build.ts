/**
 * The example distribution's build.
 *
 *   bun examples/distribution/build.ts
 *
 * Writes `dist/eris-distribution-<os>-<arch>` (in this repository's dist/) with
 * `build()` from `eris/sdk`: the entry ./main.ts, its plugin list (composed
 * again here, so a refused plugin fails the build), its assets, a stubbed
 * module and an identity of its own (release repository, version line, docs
 * base). The distribution's root is this directory, which ./main.ts hands
 * `runProgram` as `installRoot` too, and the identity is ./main.ts's `IDENTITY`,
 * which it hands `runProgram` as `identity`, so a run from source and the binary
 * read the same relative paths and report the same identity. A distribution in
 * another repository writes the same call with its own paths; left out, its root
 * is the nearest directory at or above the entry with a package.json.
 */

import { join, relative } from "node:path";
import { build, type BuildOptions } from "eris/sdk";
import { DISTRIBUTION_PLUGINS, IDENTITY } from "./main";

export const BUILD: BuildOptions = {
  entry: join(import.meta.dir, "main.ts"),
  root: import.meta.dir,
  plugins: DISTRIBUTION_PLUGINS,
  sourceRoots: ["."],
  assetRoots: ["assets"],
  stubs: [{ match: /^\.\/heavy$/, reason: "demo-heavy-needs-checkout" }],
  ...IDENTITY,
};

if (import.meta.main) {
  const r = await build({ ...BUILD, outfile: join(import.meta.dir, "..", "..", "dist", `eris-distribution-${process.platform}-${process.arch}`) });
  process.stdout.write(`${relative(process.cwd(), r.outfile) || r.outfile}\n`);
  process.stderr.write(`INFO build ${r.buildId}, ${r.assets} assets, releases from ${r.releaseRepo}\n`);
}
