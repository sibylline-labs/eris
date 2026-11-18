/**
 * sdk.ts — `eris/sdk`, the one module through which another repository reaches
 * core: a distribution's entry, its plugins and the libraries they share
 * (docs/dev/PLUGINS.md#distributions). The package's `exports` map names it,
 * `eris/sdk/testing` (the test helpers, testing/, which this module does not
 * export, so no binary carries them), `eris/yak-contract` (the Yaks wire
 * contract, a workspace package of its own rather than core),
 * `eris/outbound-scan` (the outbound secret scan and redaction pass, another
 * workspace package), `eris/gates-contract` (the doctrine `policy:` contract,
 * a workspace package with no CLI runtime), `eris/yak-redact` (that package's redaction pass,
 * packages/outbound-scan/src/redact.ts, which imports nothing) and nothing deeper, so a core file can move without breaking a
 * distribution.
 *
 * What it carries:
 *
 *   - the plugin SDK (src/cli/plugin.ts): `definePlugin`, `readArgs`,
 *     `groupArgs` (over a plugin's own rows), `readEnv`, the failure block;
 *   - composition: core's rows (`REGISTRY`) and handlers (`HANDLERS`), this
 *     build's plugin list (`PLUGINS`), `composeCli` and its `menu` option, and
 *     `RELEASE_UPDATE`, the in-place `eris update` a distribution that
 *     publishes binaries composes in place of core's;
 *   - the program: `runProgram({ cli })`, a distribution's process entry, and
 *     `main`, the seam a test drives;
 *   - argv and output helpers a handler shares with core's verbs, the global
 *     `--output` / `--json` pre-pass (`parseGlobal`, `GlobalFlagError`) and the
 *     help renderers (`helpText`, `helpJson`, `resolveHelpPath`, `asksForHelp`)
 *     included;
 *   - the outbound secret scan's rules and string scan (`secretRules`,
 *     `scanStrings`, the vendored gitleaks set eris/outbound-scan owns), so a
 *     distribution scans what it sends with the rules core sends under;
 *   - the runtime: subprocesses (the only way eris spawns), the bounded pool
 *     (`runPool`, and the `ERIS_BATCH_*` readers), the diagnostics, the
 *     install root, and the build's identity (`BUILD_ID`, `releaseRepo()`, the
 *     `DistributionIdentity` that `build()` and `runProgram` take, and `VERSION`,
 *     the version `eris --version` prints);
 *   - the skill-kind contract lint (`lintSkills`, `readSkillKind`,
 *     `SKILL_KINDS`), the check `eris skills lint` runs, for a repository that
 *     runs it over its own skills in-process;
 *   - the doctrine plugin with a distribution's own defaults (`doctrinePlugin`)
 *     and its handler (`doctrineHandler`, loaded on its first call), so a
 *     distribution points `eris doctrine` at its organisation's doctrine file
 *     (docs/DOCTRINE.md#a-distributions-defaults);
 *   - the gate plugin (`gatePlugin`, with `GateDefaults`: the door-class ladder file and the pulled
 *     tree) and the loop plugin (`loopPlugin`, with `LoopDefaults`), and the readers of the org's
 *     pulled, verified policy tree they take as defaults (`pulledTree`, `freshTree`, loaded on their
 *     first call), so a distribution composes the public gate, doctrine and loop verbs from here alone;
 *   - `build()`, which compiles a distribution (src/build.ts), loaded on its
 *     first call so a plugin manifest importing this module stays light on the
 *     completion path.
 *
 * This package's own plugins import src/cli/plugin.ts, not this module.
 */

import type { BuildOptions, BuildResult } from "./build";
import type { VerbContext, VerbHandler } from "./cli/plugin";
import type { DoctrineDefaultsSource } from "../plugins/doctrine";
import type { PullDeps } from "../plugins/doctrine/pull";
import type { GateDefaults } from "../plugins/gate";
import type { LoopDefaults } from "../plugins/loop";

export * from "./cli/plugin";
export type { VerbPath } from "./cli/registry";
export { flagsOf, REGISTRY, rowsOfGroup } from "./cli/registry";
export type { ArgError, HelpJson, HelpJsonFlag, SubOf } from "./cli/args";
export { argErrorWhat, asksForHelp, GlobalFlagError, helpJson, helpText, parseGlobal, readVerbArgs, refuseArg, resolveHelpPath, usageLine } from "./cli/args";
export { sanitizeDisplay } from "./cli/output";
export type { SecretHit } from "eris/outbound-scan";
export { scanStrings, secretRules } from "eris/outbound-scan";
export { onPath } from "./cli/ts-verb";
export { RELEASE_UPDATE } from "./cli/commands/update/opt-in";
export type { Cli, ComposeOptions, Session } from "./cli/compose";
export { composeCli, NO_ENTITLEMENTS, PluginCompositionError } from "./cli/compose";
export type { MainOptions, ProgramOptions } from "./main";
export { HANDLERS, main, runProgram } from "./main";
export { PLUGINS } from "../plugins";
export type { DoctrineDefaults, DoctrineDefaultsSource } from "../plugins/doctrine";
export { doctrinePlugin } from "../plugins/doctrine";
export type { PullDeps } from "../plugins/doctrine/pull";
export type { GateDefaults, PulledTree } from "../plugins/gate";
export { gatePlugin } from "../plugins/gate";
export type { LoopDefaults, LoopTree, PolicyRequest } from "../plugins/loop";
export { loopPlugin } from "../plugins/loop";
export type { RunJob, RunOptions, RunResult, Runner } from "./runtime/process";
export { childEnv, nodeRunner, runMany, signalTree } from "./runtime/process";
export { resolveConcurrency, resolveDeadlineMs, runPool } from "../ts/lib/pool";
export { info, ok, warn } from "./runtime/logging";
export type { DistributionIdentity } from "./runtime/home";
export { BUILD_ID, installRoot, installRootIsUnwritten, isCompiled, releaseRepo, VERSION } from "./runtime/home";
export type { SkillFinding, SkillKind, SkillKindRead } from "./runtime/skills-lint";
export { lintSkills, readSkillKind, SKILL_KINDS } from "./runtime/skills-lint";
export type { ErisFailureInput } from "../ts/lib/eris-fail";
export type { BuildOptions, BuildResult, BuildStub } from "./build";

/** Compile a distribution into one executable (src/build.ts). */
export async function build(opts: BuildOptions): Promise<BuildResult> {
  return (await import("./build")).build(opts);
}

/** `eris doctrine`'s handler, reading `defaults` when a verb's file flag is absent; its code loads on the first call. */
export function doctrineHandler(defaults: DoctrineDefaultsSource = {}): VerbHandler {
  return async (args, ctx) => (await import("../plugins/doctrine/doctrine")).doctrineHandler(defaults)(args, ctx);
}

/** The org's pulled, verified tree for `GateDefaults.pulled` (null: none pulled); its code loads on the first call. */
export async function pulledTree(ctx: VerbContext, deps: PullDeps = {}): ReturnType<NonNullable<GateDefaults["pulled"]>> {
  return (await import("../plugins/doctrine/pull")).pulledTree(ctx, deps);
}

/** The org's tree, pulled again when `claimSha` names a newer bundle, for `LoopDefaults.policy`; its code loads on the first call. */
export async function freshTree(ctx: VerbContext, claimSha: string | undefined, deps: PullDeps = {}): ReturnType<NonNullable<LoopDefaults["policy"]>> {
  return (await import("../plugins/doctrine/pull")).freshTree(ctx, claimSha, deps);
}
