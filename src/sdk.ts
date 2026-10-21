/**
 * sdk.ts — `eris/sdk`, the one module through which another repository reaches
 * core: a distribution's entry, its plugins and the libraries they share
 * (docs/dev/PLUGINS.md#distributions). The package's `exports` map names it,
 * `eris/sdk/testing` (the test helpers, testing/, which this module does not
 * export, so no binary carries them), `eris/yak-contract` (the Yaks wire
 * contract, a workspace package of its own rather than core) and nothing
 * deeper, so a core file can move without breaking a distribution.
 *
 * What it carries:
 *
 *   - the plugin SDK (src/cli/plugin.ts): `definePlugin`, `readArgs`,
 *     `groupArgs` (over a plugin's own rows), `readEnv`, the failure block;
 *   - composition: core's rows (`REGISTRY`) and handlers (`HANDLERS`), this
 *     build's plugin list (`PLUGINS`), `composeCli` and its `menu` option;
 *   - the program: `runProgram({ cli })`, a distribution's process entry, and
 *     `main`, the seam a test drives;
 *   - argv and output helpers a handler shares with core's verbs, the global
 *     `--output` pre-pass (`parseGlobal`, `GlobalFlagError`) included;
 *   - the runtime: subprocesses (the only way eris spawns), the bounded pool
 *     (`runPool`, and the `ERIS_BATCH_*` readers), the diagnostics, the
 *     install root, and the build's identity (`BUILD_ID`, `releaseRepo()`, the
 *     `DistributionIdentity` that `build()` and `runProgram` take);
 *   - `build()`, which compiles a distribution (src/build.ts), loaded on its
 *     first call so a plugin manifest importing this module stays light on the
 *     completion path.
 *
 * This package's own plugins import src/cli/plugin.ts, not this module.
 */

import type { BuildOptions, BuildResult } from "./build";

export * from "./cli/plugin";
export type { VerbPath } from "./cli/registry";
export { flagsOf, REGISTRY, rowsOfGroup } from "./cli/registry";
export type { ArgError, SubOf } from "./cli/args";
export { argErrorWhat, GlobalFlagError, parseGlobal, readVerbArgs, refuseArg, usageLine } from "./cli/args";
export { sanitizeDisplay } from "./cli/output";
export { onPath } from "./cli/ts-verb";
export type { Cli, ComposeOptions, Session } from "./cli/compose";
export { composeCli, NO_ENTITLEMENTS, PluginCompositionError } from "./cli/compose";
export type { MainOptions, ProgramOptions } from "./main";
export { HANDLERS, main, runProgram } from "./main";
export { PLUGINS } from "../plugins";
export type { RunJob, RunOptions, RunResult, Runner } from "./runtime/process";
export { childEnv, nodeRunner, runMany, signalTree } from "./runtime/process";
export { resolveConcurrency, resolveDeadlineMs, runPool } from "../ts/lib/pool";
export { info, ok, warn } from "./runtime/logging";
export type { DistributionIdentity } from "./runtime/home";
export { BUILD_ID, installRoot, installRootIsUnwritten, isCompiled, releaseRepo } from "./runtime/home";
export type { ErisFailureInput } from "../ts/lib/eris-fail";
export type { BuildOptions, BuildResult, BuildStub } from "./build";

/** Compile a distribution into one executable (src/build.ts). */
export async function build(opts: BuildOptions): Promise<BuildResult> {
  return (await import("./build")).build(opts);
}
