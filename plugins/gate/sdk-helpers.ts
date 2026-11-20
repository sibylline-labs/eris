/**
 * sdk-helpers.ts — programmatic entry points over the gate plugin's engines, exported lazily through
 * `eris/sdk` so a distribution's extra `gate` subcommands (`remediate`, `demote`, `monotone`,
 * `ladder`, ...) read and write receipts through the same store, retry, actor, link and policy-sha
 * path as public `eris gate` with zero duplicated gate code.
 */

import { type GateReceipt, type ListedReceipt, listReceipts, retryRateLimited } from "eris/gates-contract";
import type { VerbContext } from "../../src/cli/plugin";
import { unwrap } from "./failure";
import { CHECK_RATE_LIMIT_DELAYS_MS, CHECK_RATE_LIMIT_MAX_WAIT_MS, type GateDeps, resolveActorWith, verbFor, writeRun } from "./gate";
import { liveGit, memoReads } from "./git";
import type { GateDefaults } from "./index";
import { readLadder } from "./ladder";
import { judgeMonotone, type Signoff } from "./monotone";
import { recordGate, type Recorded, type RecordInput } from "./record";
import { renderProse } from "./render";
import { humanSignoff } from "./unlock";

/** Input for programmatic `recordGateReceipt` (actor and receiptLink default from `GateDefaults`). */
export type GateRecordReceiptInput = Omit<RecordInput, "actor" | "actorInfo" | "receiptLink"> & {
  readonly actor?: string | undefined;
  readonly actorInfo?: RecordInput["actorInfo"];
};

/** Input for programmatic `judgeGateMonotone`. */
export interface GateMonotoneInput {
  readonly base: string;
  readonly registry: string;
  readonly issue?: string | undefined;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Record one gate receipt programmatically using `defaults`'s pulled tree, actor resolver, and receipt link. */
export async function recordGateReceipt(
  ctx: VerbContext,
  defaults: GateDefaults,
  input: GateRecordReceiptInput,
  deps: GateDeps = {},
): Promise<Recorded> {
  const v = await verbFor(ctx, defaults, deps);
  const who =
    input.actor !== undefined && input.actorInfo !== undefined
      ? { actor: input.actor, actorInfo: input.actorInfo }
      : await resolveActorWith(defaults, { flag: input.actor, g: v.g, cwd: v.cwd });
  const link = defaults.receiptLink?.(ctx) ?? null;
  return recordGate(await writeRun(v), {
    ...input,
    doctrine: input.doctrine ?? v.pulled?.doctrineFile,
    actor: who.actor,
    actorInfo: who.actorInfo,
    receiptLink: link,
  });
}

/** List an issue's gate receipts programmatically with the gate plugin's store auth, policy-sha and 429 retry. */
export async function listGateReceipts(
  ctx: VerbContext,
  defaults: GateDefaults,
  issue: string,
  deps: GateDeps = {},
): Promise<{ readonly receipts: ReadonlyArray<ListedReceipt>; readonly invalid: number }> {
  const v = await verbFor(ctx, defaults, deps);
  const ep = await v.endpoint();
  const retry = v.retry(CHECK_RATE_LIMIT_DELAYS_MS, CHECK_RATE_LIMIT_MAX_WAIT_MS, (waitMs, attempt) =>
    ctx.stderr.write(`WARN rate-limited the receipt read; retry ${attempt}/${CHECK_RATE_LIMIT_DELAYS_MS.length} in ${Math.round(waitMs / 1000)}s\n`),
  );
  return unwrap(await retryRateLimited(() => listReceipts(ep, issue), retry));
}

/** Read the latest passing human-granted receipt for `gate` on `issue` (for example `surface-widen`). */
export async function gateHumanSignoff(
  ctx: VerbContext,
  defaults: GateDefaults,
  issue: string,
  gate: string,
  deps: GateDeps = {},
): Promise<Signoff> {
  const v = await verbFor(ctx, defaults, deps);
  const ep = await v.endpoint();
  const retry = v.retry(CHECK_RATE_LIMIT_DELAYS_MS, CHECK_RATE_LIMIT_MAX_WAIT_MS, (waitMs, attempt) =>
    ctx.stderr.write(`WARN rate-limited the receipt read; retry ${attempt}/${CHECK_RATE_LIMIT_DELAYS_MS.length} in ${Math.round(waitMs / 1000)}s\n`),
  );
  return humanSignoff({ ep, g: memoReads(liveGit(ctx.env)), cwd: v.cwd, readRetry: retry, reviews: defaults.reviews }, issue, gate);
}

/** Run the monotone surface bar check against `input.base`, optionally verifying `surface-widen` on `input.issue`. */
export async function judgeGateMonotone(ctx: VerbContext, defaults: GateDefaults, input: GateMonotoneInput, deps: GateDeps = {}): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const g = memoReads(liveGit(ctx.env));
  await judgeMonotone({
    cwd,
    base: input.base,
    registry: input.registry,
    ...(input.issue !== undefined ? { issue: input.issue } : {}),
    g,
    out: input.out,
    err: input.err,
    ...(input.issue !== undefined ? { signoff: (issue) => gateHumanSignoff(ctx, defaults, issue, "surface-widen", deps) } : {}),
  });
}

/** Read and validate a door-class ladder YAML file, or null when the file does not exist (`GateFailure` on invalid). */
export { readLadder as readGateLadder };

/** Render one receipt's comment prose (with optional prior receipts for unchanged-field omission and optional link line). */
export function renderGateProse(r: GateReceipt, priors: ReadonlyArray<GateReceipt> = [], link = ""): string {
  return renderProse(r, priors, link);
}
