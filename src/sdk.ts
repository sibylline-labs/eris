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
 *   - the gate plugin (`gatePlugin`, with `GateDefaults`: the door-class ladder file, the pulled
 *     tree, and `reviews`, the `GateReviews` skill registry and freshness reader) and the loop plugin
 *     (`loopPlugin`, with `LoopDefaults`), and the readers of the org's pulled, verified policy tree
 *     they take as defaults (`pulledTree`, `freshTree`, loaded on their first call), so a distribution
 *     composes the public gate, doctrine and loop verbs from here alone;
 *   - the loop plugin's distribution seams (docs/LOOP.md#distribution-seams): the runtime contract
 *     (`LoopRuntime`, `LoopRuntimeEnv`, `LoopRuntimeSession`), the prompt-lines input
 *     (`ComposePromptInput`), `LoopFailure` (how a runtime refuses), and `launchLoopSession`, a
 *     launch without argv for a distribution verb that starts a loop itself (loaded on its first call);
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
import type { GateDeps } from "../plugins/gate/gate";
import type { Recorded } from "../plugins/gate/record";
import type { GateMonotoneInput, GateRecordReceiptInput } from "../plugins/gate/sdk-helpers";
import type { LoopDefaults } from "../plugins/loop";
import type { LoopDeps } from "../plugins/loop/deps";
import type { Launched, LaunchInput } from "../plugins/loop/launch";
import type { DoorLadder, GateReceipt, ListedReceipt, MonotoneSignoff } from "eris/gates-contract";

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
export type {
  BurdenCrossed,
  BurdenSurfacesRequest,
  GateActorRequest,
  GateDefaults,
  GateReviews,
  GateRows,
  GateSubcommand,
  PulledTree,
  PulledTreeRequest,
  ReceiptLink,
  ResolvedGateActor,
  ReviewFreshness,
  ReviewFreshnessRequest,
} from "../plugins/gate";
export { gatePlugin, gateRows } from "../plugins/gate";
export { GateFailure } from "../plugins/gate/failure";
export type { GateDeps } from "../plugins/gate/gate";
export type { EvidenceInput as GateEvidenceInput, Recorded as GateRecorded } from "../plugins/gate/record";
export type { GateMonotoneInput, GateRecordReceiptInput } from "../plugins/gate/sdk-helpers";
export type { GateReviewReport, ReviewMainState } from "eris/gates-contract";
export type { LoopDefaults, LoopLegacy, LoopTree, PolicyRequest } from "../plugins/loop";
export { loopPlugin } from "../plugins/loop";
export type { LoopDeps } from "../plugins/loop/deps";
export { LoopFailure } from "../plugins/loop/failure";
export type { Launched, LaunchInput } from "../plugins/loop/launch";
export type { ComposePromptInput } from "../plugins/loop/prompt";
export type { LoopRuntime, LoopRuntimeEnv, LoopRuntimeFlag, LoopRuntimeFlags, LoopRuntimeSession } from "../plugins/loop/runtime";
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

/**
 * Launch a loop as `eris loop launch` does, from a distribution verb that has no argv for it: the same
 * order, refusals and claim handling (plugins/loop/launch.ts), with `defaults` as the build supplies
 * them. A failure is thrown as a `LoopFailure`; its code loads on the first call.
 */
export async function launchLoopSession(ctx: VerbContext, defaults: LoopDefaults, input: LaunchInput, deps: LoopDeps = {}): Promise<Launched> {
  const [{ runOf }, { launchLoop }] = await Promise.all([import("../plugins/loop/deps"), import("../plugins/loop/launch")]);
  return launchLoop(runOf(ctx, defaults, deps), input);
}

/** `eris gate`'s handler with distribution defaults and optional test deps; its code loads on the first call. */
export function gateHandler(defaults: GateDefaults = {}, deps: GateDeps = {}): VerbHandler {
  return async (args, ctx) => (await import("../plugins/gate/gate")).gateHandler(defaults, deps)(args, ctx);
}

/** `eris surface`'s handler with distribution defaults and optional test deps; its code loads on the first call. */
export function surfaceHandler(defaults: GateDefaults = {}, deps: GateDeps = {}): VerbHandler {
  return async (args, ctx) => (await import("../plugins/gate/surface-verb")).surfaceHandler(defaults, deps)(args, ctx);
}

/** Record one gate receipt programmatically using `defaults`'s pulled tree, actor resolver, and receipt link; loads on first call. */
export async function recordGateReceipt(ctx: VerbContext, defaults: GateDefaults, input: GateRecordReceiptInput, deps: GateDeps = {}): Promise<Recorded> {
  return (await import("../plugins/gate/sdk-helpers")).recordGateReceipt(ctx, defaults, input, deps);
}

/** List an issue's gate receipts programmatically with the gate plugin's store auth, policy-sha and 429 retry; loads on first call. */
export async function listGateReceipts(
  ctx: VerbContext,
  defaults: GateDefaults,
  issue: string,
  deps: GateDeps = {},
): Promise<{ readonly receipts: ReadonlyArray<ListedReceipt>; readonly invalid: number }> {
  return (await import("../plugins/gate/sdk-helpers")).listGateReceipts(ctx, defaults, issue, deps);
}

/** Read the latest passing human-granted receipt for `gate` on `issue`; loads on first call. */
export async function gateHumanSignoff(ctx: VerbContext, defaults: GateDefaults, issue: string, gate: string, deps: GateDeps = {}): Promise<MonotoneSignoff> {
  return (await import("../plugins/gate/sdk-helpers")).gateHumanSignoff(ctx, defaults, issue, gate, deps);
}

/** Run the monotone surface bar check against `input.base`, optionally verifying `surface-widen` on `input.issue`; loads on first call. */
export async function judgeGateMonotone(ctx: VerbContext, defaults: GateDefaults, input: GateMonotoneInput, deps: GateDeps = {}): Promise<void> {
  return (await import("../plugins/gate/sdk-helpers")).judgeGateMonotone(ctx, defaults, input, deps);
}

/** Read and validate a door-class ladder YAML file, or null when absent; loads on first call. */
export async function readGateLadder(file: string): Promise<DoorLadder | null> {
  return (await import("../plugins/gate/sdk-helpers")).readGateLadder(file);
}

/** Render one receipt's comment prose (with optional prior receipts and optional `{link}` line); loads on first call. */
export async function renderGateProse(r: GateReceipt, priors: ReadonlyArray<GateReceipt> = [], link = ""): Promise<string> {
  return (await import("../plugins/gate/sdk-helpers")).renderGateProse(r, priors, link);
}
