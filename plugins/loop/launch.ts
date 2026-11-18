/**
 * launch.ts — `eris loop launch`: start an org-authored loop on an issue as a detached background
 * session (Claude Code, or a runtime the build supplies) that holds the issue's claim.
 *
 * Order: normalise every operand, `--runtime` and its flags included, the runtime's `prepare` last
 * (refusals before any request or spawn) → resolve a yak id → `claude` on PATH (the built-in runtime)
 * → the live-session check over every runtime (unless `--force`) → `--force` releases the ledger's
 * prior claim → reserve the claim (unless `--unclaimed` or a claimless slug) → the org's tree, pulled
 * when the claim names a newer bundle → the loop body → the prompt (the build's lines after the
 * `Hand-back:` line) → spawn → bind → In Progress → the receipt.
 *
 * Invariants:
 *  - any failure after the reserve releases it (`aborted`, the reason as its body) before the verb stops;
 *  - an unclaimed launch writes no tracker state: the In Progress move follows the claim;
 *  - a runtime flag is accepted only with the runtime that declares it;
 *  - the ledger and the receipt name the runtime the session runs on;
 *  - the receipt is `delegated <ISSUE>[ (yak <8>)] → loop <slug> · <session>[ · model <model>]`.
 */

import type { GatesEndpoint } from "eris/gates-contract";
import { readLoopBody } from "./body";
import { bindClaim, heldClaim, releaseClaim, type Reserved, reserveClaim, RUNTIME } from "./claims";
import { claudeOnPath, liveSessions, spawnClaude } from "./claude";
import { endpoint, type Run, runtimeEnv, treeOf } from "./deps";
import { LoopFailure, usage } from "./failure";
import { checkCwd, HAND_BACK_MAX, normaliseCaller, normaliseContext, normaliseModel, normaliseReportTo, normaliseSlug, sessionName } from "./names";
import { type ComposePromptInput, composePrompt } from "./prompt";
import type { LoopRuntime, LoopRuntimeFlags } from "./runtime";
import { resolveTarget } from "./target";
import { startIssue } from "./transitions";

export interface LaunchInput {
  readonly loop: string | undefined;
  readonly issue: string | undefined;
  readonly cwd: string | undefined;
  readonly model: string | undefined;
  readonly reportTo: string | undefined;
  readonly caller: string | undefined;
  readonly context: string | undefined;
  readonly force: boolean;
  readonly unclaimed: boolean;
  /** `--runtime`: `claude` (the default) or a runtime the build supplies. */
  readonly runtime?: string | undefined;
  /** The runtime-declared launch flags, by name (`--pool`), as passed (absent: undefined). */
  readonly runtimeFlags?: LoopRuntimeFlags | undefined;
}

export interface Launched {
  readonly issue: string;
  readonly slug: string;
  readonly session: string;
  readonly runtime: string;
  /** The model the session runs ("" when the runtime names none). */
  readonly model: string;
  readonly claimId?: string;
  readonly yak?: string;
}

/** `delegated <ISSUE>[ (yak <8>)] → loop <slug> · <session>[ · model <model>]`. */
export const launchReceipt = (r: Launched): string =>
  `delegated ${r.issue}${r.yak !== undefined ? ` (yak ${r.yak.slice(0, 8)})` : ""} → loop ${r.slug} · ${r.session}${r.model !== "" ? ` · model ${r.model}` : ""}`;

/** A reserve refused for any reason but another holder says the launch can run unclaimed. */
function withUnclaimedFix(e: unknown): never {
  if (e instanceof LoopFailure && e.failure.slug !== "linear-issue-claimed" && e.failure.slug !== "loop-claim-ledger-unwritable") {
    throw new LoopFailure({ ...e.failure, what: `could not claim the issue (${e.failure.slug}: ${e.failure.what})`, fix: `${e.failure.fix} Or relaunch with --unclaimed to run the loop with no claim.` });
  }
  throw e;
}

/** The runtime `--runtime` names (null: the built-in `claude`); any other name is `loop-usage`. */
function runtimeNamed(run: Run, raw: string | undefined): LoopRuntime | null {
  const name = raw ?? RUNTIME;
  if (name === RUNTIME) return null;
  const rt = run.runtimes.find(([n]) => n === name)?.[1];
  if (rt === undefined) usage(`--runtime ${JSON.stringify(raw)} is not a runtime this build runs (${[RUNTIME, ...run.runtimes.map(([n]) => n)].join(", ")})`);
  return rt;
}

/** The selected runtime's flags, by name; a flag passed for another runtime is `loop-usage`. */
function flagsFor(run: Run, runtime: string, rt: LoopRuntime | null, passed: LoopRuntimeFlags): LoopRuntimeFlags {
  const declared = rt?.flags ?? [];
  for (const [flag, value] of Object.entries(passed)) {
    if (value === undefined || declared.some((f) => f.name === flag)) continue;
    const owners = run.runtimes.filter(([, r]) => (r.flags ?? []).some((f) => f.name === flag)).map(([n]) => n);
    usage(`${flag} is read only by --runtime ${owners.join(" or ")}, not ${runtime}`, `Drop ${flag}, or relaunch with --runtime ${owners[0] ?? "<name>"}.`);
  }
  return Object.fromEntries(declared.map((f) => [f.name, Object.hasOwn(passed, f.name) ? passed[f.name] : undefined]));
}

export async function launchLoop(run: Run, input: LaunchInput): Promise<Launched> {
  if (input.loop === undefined || input.issue === undefined) usage("launch requires <loop> <ISSUE|YAK-ID>");
  if (input.cwd === undefined) usage("launch requires --cwd <abs>: the target repo the session runs in");
  const slug = normaliseSlug(input.loop);
  const cwd = checkCwd(input.cwd, run.home);
  const context = normaliseContext(input.context);
  const reportTo = normaliseReportTo(input.reportTo);
  const caller = normaliseCaller(input.caller);
  const runtime = input.runtime ?? RUNTIME;
  const rt = runtimeNamed(run, input.runtime);
  const flags = flagsFor(run, runtime, rt, input.runtimeFlags ?? {});
  const model = rt === null ? normaliseModel(input.model) : (await rt.prepare(runtimeEnv(run, cwd), { model: input.model, flags })).model;
  const claude = rt === null ? claudeOnPath(run) : null;
  const unclaimed = input.unclaimed || (run.defaults.claimless ?? []).includes(slug);
  const { issue, yak } = await resolveTarget(run, input.issue, cwd);
  if (!input.force) {
    // An unclaimed follow-on loop only collides with its own slug; a claimed launch with any loop on the issue.
    const only = unclaimed ? slug : undefined;
    const live = [...liveSessions(run.home, run.legacyPrefixes, issue, only)];
    for (const [, r] of run.runtimes) live.push(...(await r.live(runtimeEnv(run, cwd), issue, only)));
    if (live.length > 0) usage(`${issue} already has a live loop session: ${live.join("; ")}`, "Message it, stop it ('eris loop stop <id>'), or relaunch with --force.");
  }
  let ep: GatesEndpoint | undefined;
  let reserved: Reserved | undefined;
  if (!unclaimed) {
    ep = await endpoint(run, cwd);
    const prior = input.force ? heldClaim(run.ledger, issue) : null;
    if (prior !== null) {
      await releaseClaim(ep, { ledger: run.ledger, issue, claimId: prior.record.claim_id, outcome: "aborted", body: "eris loop: superseded by a forced relaunch on this issue.", warn: run.warn });
    }
    reserved = await reserveClaim(ep, { ledger: run.ledger, issue, slug, runtime, now: run.now() }).catch(withUnclaimedFix);
  }
  const claimId = reserved?.claimId;
  const name = sessionName(slug, issue);
  let session: string;
  try {
    const tree = await treeOf(run.defaults, run, { cwd, claimSha: reserved?.bundleSha });
    const body = readLoopBody(tree, slug);
    const header: ComposePromptInput = { slug, issue, body, context, yak, reportTo, caller, model, claimId };
    const prompt = composePrompt(header, run.defaults.promptLines?.({ ...header, cwd }) ?? []);
    session = rt === null ? await spawnClaude(run, { claude: claude!, prompt, name, cwd, model }) : await rt.spawn(runtimeEnv(run, cwd), { prompt, name, cwd, model, flags });
  } catch (e) {
    if (ep !== undefined && claimId !== undefined) {
      const why = e instanceof LoopFailure ? e.failure.what : String(e);
      await releaseClaim(ep, { ledger: run.ledger, issue, claimId, outcome: "aborted", body: `eris loop: the launch failed before the loop started: ${why}`.slice(0, HAND_BACK_MAX), warn: run.warn });
    }
    throw e;
  }
  if (ep !== undefined && claimId !== undefined) {
    await bindClaim(ep, { ledger: run.ledger, issue, claimId, slug, runtime, session, sleep: run.sleep, warn: run.warn });
    await startIssue(ep, issue, run.warn);
  }
  return { issue, slug, session, runtime, model, ...(claimId !== undefined ? { claimId } : {}), ...(yak !== undefined ? { yak } : {}) };
}
