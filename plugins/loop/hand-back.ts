/**
 * hand-back.ts — `eris loop hand-back`: post a loop's hand-back as the org's app. With `--claim` (the
 * id the prompt's `Claim:` line carries) it is the release response of that claim; otherwise, or when
 * the claim no longer holds the issue, it is a comment on the issue. `--report-to` also comments there.
 *
 * Invariants:
 *  - the body is refused before anything is sent: blank, over `HAND_BACK_MAX` characters, or holding a
 *    secret a vendored gitleaks rule matches (`loop-secret-detected`, the same scan `gate record` runs);
 *  - a release that answered (released or not) drops the ledger entry while it still names the claim;
 *    a stale claim (`superseded`, `not_claimed`) or a failed release falls back to the comment;
 *  - each target gets one write, retried only on a 429 (shed before the route ran, so never doubled),
 *    bounded; a target that got nothing fails the verb `loop-hand-back-failed` (exit 1) after every
 *    receipt line for what landed was printed.
 */

import { commentIssue, releaseIssue, type RetryOpts, retryRateLimited } from "eris/gates-contract";
import { scanStrings } from "eris/outbound-scan";
import { dropClaim } from "./claims";
import { endpoint, type Run } from "./deps";
import { block, stop, usage } from "./failure";
import { CLAIM_ID_RE, HAND_BACK_MAX, normaliseIssue, normaliseReportTo } from "./names";

export const HAND_BACK_OUTCOMES = ["handed_back", "aborted"] as const;

/** Waits for a write the gateway shed (429) when it names no `Retry-After`; the length is the bound. */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];
const RETRY_MAX_WAIT_MS = 60_000;

export interface HandBackInput {
  readonly issue: string | undefined;
  readonly claim: string | undefined;
  readonly reportTo: string | undefined;
  readonly outcome: string | undefined;
  readonly body: string;
}

export interface HandBackResult {
  /** One receipt line per write that landed. */
  readonly lines: ReadonlyArray<string>;
  /** The targets that got nothing. */
  readonly failed: ReadonlyArray<string>;
}

/** Post the hand-back; the receipt lines and the targets that got nothing. */
export async function handBack(run: Run, input: HandBackInput): Promise<HandBackResult> {
  if (input.issue === undefined) usage("hand-back requires <ISSUE>");
  const issue = normaliseIssue(input.issue);
  const reportTo = normaliseReportTo(input.reportTo);
  const claimId = input.claim?.trim();
  if (claimId !== undefined && !CLAIM_ID_RE.test(claimId)) usage(`--claim ${JSON.stringify(claimId)} is not a claim id (8-64 letters, digits or '-')`);
  const outcome = HAND_BACK_OUTCOMES.find((o) => o === (input.outcome ?? "handed_back"));
  if (outcome === undefined) usage(`--outcome ${JSON.stringify(input.outcome)} must be handed_back or aborted`);
  const body = input.body;
  if (body.trim() === "") usage("hand-back reads the hand-back on stdin, and stdin was empty", "Pipe the hand-back body on stdin: eris loop hand-back <ISSUE> < <file>.");
  const chars = [...body].length;
  if (chars > HAND_BACK_MAX) usage(`the hand-back is ${chars} characters; the tracker takes at most ${HAND_BACK_MAX}`, "Shorten the hand-back and re-run.");
  const leaked = [...new Set(scanStrings(body).map((h) => h.rule))];
  if (leaked.length > 0) {
    stop(block("loop-secret-detected", `the hand-back holds a secret (${leaked.join(", ")}); nothing was sent`, "Remove the secret from the hand-back and re-run; this check cannot be overridden.", 2));
  }

  const ep = await endpoint(run);
  const retry: RetryOpts = run.deps.retry ?? {
    delaysMs: RETRY_DELAYS_MS,
    maxWaitMs: RETRY_MAX_WAIT_MS,
    sleep: run.sleep,
    jitter: Math.random,
    onRetry: (waitMs, attempt) => run.warn(`eris loop: the gateway rate-limited the hand-back; retry ${attempt}/${RETRY_DELAYS_MS.length} in ${Math.round(waitMs / 1000)}s`),
  };
  const lines: string[] = [];
  let posted = false;
  if (claimId !== undefined) {
    const res = await retryRateLimited(() => releaseIssue(ep, issue, { claimId, outcome, body }), retry);
    if (!res.ok) {
      run.warn(`eris loop: could not release ${issue}'s claim: ${res.failure.slug}: ${res.failure.what}`);
    } else {
      dropClaim(run.home, issue, claimId);
      if (res.value.released) {
        posted = true;
        lines.push(`handed back ${issue} · released claim ${claimId.slice(0, 8)} with the hand-back as its response`);
      } else {
        run.ctx.stderr.write(`eris loop: claim ${claimId.slice(0, 8)} no longer holds ${issue} (${res.value.reason ?? "not held"}); commenting instead\n`);
      }
    }
  }
  const targets = [...(posted ? [] : [issue]), ...(reportTo !== undefined && reportTo !== issue ? [reportTo] : [])];
  const failed: string[] = [];
  for (const target of targets) {
    const res = await retryRateLimited(() => commentIssue(ep, target, body), retry);
    if (!res.ok) {
      run.warn(`eris loop: could not post the hand-back on ${target}: ${res.failure.slug}: ${res.failure.what}`);
      failed.push(target);
    } else {
      lines.push(`handed back ${issue} · comment ${res.value.id} on ${target}`);
    }
  }
  return { lines, failed };
}
