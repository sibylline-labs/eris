/**
 * The example distribution's entry: core composed with this repository's plugin
 * list plus its own plugin, owning the bare program with a menu, naming its own
 * directory as its install root and reporting its own identity
 * (docs/dev/PLUGINS.md#distributions). A
 * distribution in another repository has the same shape: it depends on this
 * package and imports `eris/sdk` alone.
 *
 * tests/distribution.test.ts drives `DISTRIBUTION` through `main`, and the binary
 * ./build.ts compiles from this file. It is not part of this repository's build.
 */

import { composeCli, type DistributionIdentity, type ErisPlugin, HANDLERS, PLUGINS, REGISTRY, runProgram } from "eris/sdk";
import demo from "./plugins/demo";

/**
 * Who this distribution is: ./build.ts bakes it into the binary, and the entry
 * hands it to `runProgram`, so a run from source reports the same `--version`,
 * release repository and docs base as the binary.
 */
export const IDENTITY: DistributionIdentity = {
  releaseRepo: "example-org/eris-distribution",
  versionExtra: "example distribution 1.0",
  docsBase: "https://github.com/example-org/eris-distribution/blob/main",
};

export const DISTRIBUTION_PLUGINS: readonly ErisPlugin[] = [...PLUGINS, demo];

export const DISTRIBUTION = composeCli(REGISTRY, HANDLERS, DISTRIBUTION_PLUGINS, {
  menu: async () => (await import("./menu")).runMenu,
  completionNote: "Also completes the names 'eris demo hello' greets (see the demo plugin).",
});

// This directory is the distribution's root (./build.ts builds from it too).
if (import.meta.main) runProgram({ cli: DISTRIBUTION, installRoot: import.meta.dir, identity: IDENTITY });
