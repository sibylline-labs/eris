/**
 * The example distribution's entry: core composed with this repository's plugin
 * list plus its own plugin, owning the bare program with a menu and naming its
 * own directory as its install root (docs/dev/PLUGINS.md#distributions). A
 * distribution in another repository has the same shape: it depends on this
 * package and imports `eris/sdk` alone.
 *
 * tests/distribution.test.ts drives `DISTRIBUTION` through `main`, and the binary
 * ./build.ts compiles from this file. It is not part of this repository's build.
 */

import { composeCli, type ErisPlugin, HANDLERS, PLUGINS, REGISTRY, runProgram } from "eris/sdk";
import demo from "./plugins/demo";

export const DISTRIBUTION_PLUGINS: readonly ErisPlugin[] = [...PLUGINS, demo];

export const DISTRIBUTION = composeCli(REGISTRY, HANDLERS, DISTRIBUTION_PLUGINS, {
  menu: async () => (await import("./menu")).runMenu,
});

// This directory is the distribution's root (./build.ts builds from it too).
if (import.meta.main) runProgram({ cli: DISTRIBUTION, installRoot: import.meta.dir });
