/**
 * launch.ts — `eris loop launch`: start an org-authored loop on an issue as a detached Claude Code
 * background session that holds the issue's claim.
 *
 * Order: normalise every operand (refusals before any request or spawn) → resolve a yak id → `claude`
 * on PATH → the live-session check (unless `--force`) → `--force` releases the ledger's prior claim →
 * reserve the claim (unless `--unclaimed`) → the org's tree, pulled when the claim names a newer bundle
 * → the loop body → the prompt → spawn → bind → In Progress → the receipt.
 *
 * Invariants:
 *  - any failure after the reserve releases it (`aborted`, the reason as its body) before the verb stops;
 *  - an unclaimed launch writes no tracker state: the In Progress move follows the claim;
 *  - the receipt is `delegated <ISSUE>[ (yak <8>)] → loop <slug> · <session>[ · model <model>]`.
 */

import type { GatesEndpoint } from "eris/gates-contract";
import { readLoopBody } from "./body";
import { bindClaim, readClaim, releaseClaim, type Reserved, reserveClaim, RUNTIME } from "./claims";
import { claudeOnPath, liveSessions, spawnClaude } from "./claude";
import { endpoint, type Run, treeOf } from "./deps";
import { LoopFailure, usage } from "./failure";
import type { LoopDefaults } from "./index";
import { checkCwd, HAND_BACK_MAX, normaliseCaller, normaliseContext, normaliseModel, normaliseReportTo, normaliseSlug, sessionName } from "./names";
import { composePrompt } from "./prompt";
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
}

export interface Launched {
  readonly issue: string;
  readonly slug: string;
  readonly session: string;
  readonly runtime: string;
  readonly model: string;
  readonly claimId?: string;
  readonly yak?: string;
}

/** `delegated <ISSUE>[ (yak <8>)] → loop <slug> · <session>[ · model <model>]`. */
export const launchReceipt = (r: Launched): string =>
  `delegated ${r.issue}${r.yak !== undefined ? ` (yak ${r.yak.slice(0, 8)})` : ""} → loop ${r.slug} · ${r.session} · model ${r.model}`;

/** A reserve refused for any reason but another holder says the launch can run unclaimed. */
function withUnclaimedFix(e: unknown): never {
  if (e instanceof LoopFailure && e.failure.slug !== "linear-issue-claimed" && e.failure.slug !== "loop-claim-ledger-unwritable") {
    throw new LoopFailure({ ...e.failure, what: `could not claim the issue (${e.failure.slug}: ${e.failure.what})`, fix: `${e.failure.fix} Or relaunch with --unclaimed to run the loop with no claim.` });
  }
  throw e;
}

export async function launchLoop(run: Run, defaults: LoopDefaults, input: LaunchInput): Promise<Launched> {
  if (input.loop === undefined || input.issue === undefined) usage("launch requires <loop> <ISSUE|YAK-ID>");
  if (input.cwd === undefined) usage("launch requires --cwd <abs>: the target repo the session runs in");
  const slug = normaliseSlug(input.loop);
  const cwd = checkCwd(input.cwd, run.home);
  const context = normaliseContext(input.context);
  const reportTo = normaliseReportTo(input.reportTo);
  const caller = normaliseCaller(input.caller);
  const model = normaliseModel(input.model);
  const claude = claudeOnPath(run);
  const { issue, yak } = await resolveTarget(run, input.issue, cwd);
  if (!input.force) {
    // An unclaimed follow-on loop only collides with its own slug; a claimed launch with any loop on the issue.
    const live = liveSessions(run.home, issue, input.unclaimed ? slug : undefined);
    if (live.length > 0) usage(`${issue} already has a live loop session: ${live.join("; ")}`, "Message it, stop it ('eris loop stop <id>'), or relaunch with --force.");
  }
  let ep: GatesEndpoint | undefined;
  let reserved: Reserved | undefined;
  if (!input.unclaimed) {
    ep = await endpoint(run, cwd);
    const prior = input.force ? readClaim(run.home, issue) : null;
    if (prior !== null) await releaseClaim(ep, { home: run.home, issue, claimId: prior.claim_id, outcome: "aborted", body: "eris loop: superseded by a forced relaunch on this issue.", warn: run.warn });
    reserved = await reserveClaim(ep, { home: run.home, issue, slug, now: run.now() }).catch(withUnclaimedFix);
  }
  const claimId = reserved?.claimId;
  const name = sessionName(slug, issue);
  let session: string;
  try {
    const tree = await treeOf(defaults, run, { cwd, claimSha: reserved?.bundleSha });
    const body = readLoopBody(tree, slug);
    const prompt = composePrompt({ slug, issue, body, context, yak, reportTo, caller, model, claimId });
    session = await spawnClaude(run, { claude, prompt, name, cwd, model });
  } catch (e) {
    if (ep !== undefined && claimId !== undefined) {
      const why = e instanceof LoopFailure ? e.failure.what : String(e);
      await releaseClaim(ep, { home: run.home, issue, claimId, outcome: "aborted", body: `eris loop: the launch failed before the loop started: ${why}`.slice(0, HAND_BACK_MAX), warn: run.warn });
    }
    throw e;
  }
  if (ep !== undefined && claimId !== undefined) {
    await bindClaim(ep, { home: run.home, issue, claimId, slug, session, sleep: run.sleep, warn: run.warn });
    await startIssue(ep, issue, run.warn);
  }
  return { issue, slug, session, runtime: RUNTIME, model, ...(claimId !== undefined ? { claimId } : {}), ...(yak !== undefined ? { yak } : {}) };
}
