/**
 * The example distribution's build.
 *
 *   bun examples/distribution/build.ts
 *
 * Writes `dist/eris-distribution-<os>-<arch>` with `build()` from `eris/sdk`: the
 * entry ./main.ts, its plugin list (composed again here, so a refused plugin
 * fails the build), its assets, a stubbed module and a release repository of
 * its own. A distribution in another repository writes the same call with its
 * own paths; its root is found from the entry (the nearest package.json).
 */

import { join, relative } from "node:path";
import { build, type BuildOptions } from "eris/sdk";
import { DISTRIBUTION_PLUGINS } from "./main";

export const BUILD: BuildOptions = {
  entry: join(import.meta.dir, "main.ts"),
  plugins: DISTRIBUTION_PLUGINS,
  sourceRoots: ["examples/distribution"],
  assetRoots: ["examples/distribution/assets"],
  stubs: [{ match: /^\.\/heavy$/, reason: "demo-heavy-needs-checkout" }],
  releaseRepo: "example-org/eris-distribution",
};

if (import.meta.main) {
  const r = await build({ ...BUILD, outfile: join("dist", `eris-distribution-${process.platform}-${process.arch}`) });
  process.stdout.write(`${relative(process.cwd(), r.outfile) || r.outfile}\n`);
  process.stderr.write(`INFO build ${r.buildId}, ${r.assets} assets, releases from ${r.releaseRepo}\n`);
}
