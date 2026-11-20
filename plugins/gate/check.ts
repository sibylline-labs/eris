/**
 * check.ts — `eris gate check`: read the issue's receipts and judge each named gate by its latest
 * receipt, by the server's `created_at` (never the local clock; a tie goes to the later row):
 *
 *   no receipt                                   → missing           (fails)
 *   an evidence digest that does not hold        → bad-digest        (fails)
 *   review-report evidence                       → blocking (public default with no reviews seam), or judged via reviews (blocking / drift / review-stale / pass)
 *   BLOCKING                                     → blocking          (fails)
 *   SKIPPED on a `doctrine:<posture>` grant      → skipped, or doctrine-stale when the posture no longer bears it out
 *   SKIPPED on `repo:no-eris-yaml`               → skipped, or doctrine-stale once the repo gains an eris.yaml
 *   SKIPPED stamped with a mandate (v3)          → skipped
 *   SKIPPED on another grant (or a v1 doctrine skip) → skipped
 *   SKIPPED with no grant                        → unauthorized-skip (fails)
 *   PASS/AMENDED, artifact not found anywhere    → unresolved        (fails)
 *   PASS/AMENDED, artifact re-hashed differently → drift             (fails)
 *   PASS/AMENDED, same sha256                    → pass
 *
 * The live artifact decides when it can be read; only when it is unresolved or gone does a stored
 * copy answer (the receipt's own, else the store's under its sha256), and only when its bytes re-hash.
 *
 * Then, in order: forbidden gates (`absent`/`forbidden`), the `burden` line, the user-impact floor
 * (each requirement as a row, then `@floor`, then `@door` with its rung), `@remediate` when the
 * issue has a remediation receipt (`ok`, `pending`, `violated`, or `hand-off`), and `@asks` for a
 * terminal gate. Any failing row fails the check with one `gate-check-failed` block.
 *
 * With `applyModes` (`--profile`) each gate's mode comes from the active posture: an `off` gate with
 * no receipt (or a doctrine-stale one) gets a doctrine SKIPPED written by `skipGate`, a `once-at-end`
 * gate reads `deferred` until `final-gates` is checked, and `define-future` with no receipt in a repo
 * with no root eris.yaml gets a `repo:no-eris-yaml` SKIPPED. `readOnly` (`--dry-run`) prints those
 * skips and writes nothing.
 *
 * The store's reads lag its writes: `expect` names comment ids that must all be in the listing check
 * evaluates, re-read on `expectDelaysMs`, else `gate-receipt-unseen`.
 */

import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  activePosture,
  ASKS_LIST_MAX,
  type AskRow,
  artifactCopy,
  assetDigest,
  type AssetDigest,
  DEFINE_FUTURE_GATE,
  DOCTRINE_GRANT,
  decodePayload,
  deriveReviewPass,
  doctrineActor,
  doctrineGrantPosture,
  doctrineShaped,
  doctrineSkipBlocker,
  type DoctrineRead,
  FLOOR_GATES,
  GATE_RECEIPT_SCHEMA_V3,
  type GateArtifact,
  type GateArtifactCopy,
  type GateEvidence,
  type GateReceipt,
  type GateReviewEffort,
  type GateReviewReport,
  type GatesEndpoint,
  gateMode,
  invalidDoctrine,
  isGateMediaEvidence,
  isGateReviewReportEvidence,
  isHumanGrant,
  type ListedReceipt,
  listAsks,
  listReceipts,
  modeSource,
  NO_ERIS_YAML_GRANT,
  noErisYamlSkipBlocker,
  REQUIREMENTS,
  type ReviewDiffSource,
  type ReviewHeadSource,
  repoGrantShaped,
  requirementsFor,
  reviewReportDigest,
  sameActor,
  sha256Hex,
  staleness,
  type RetryOpts,
  retryRateLimited,
} from "eris/gates-contract";
import { resolveArtifact, resolveTargetHead, targetRoot } from "./artifact";
import { type BurdenRubric, burdenOf, type EvidenceKind, owedBy, unmet } from "./burden";
import { precondition, stop, unwrap } from "./failure";
import { effectiveClass } from "./floor";
import { type Git, repoRoot } from "./git";
import type { GateReviews } from "./index";
import { BLEED_REDUCING, type DoorLadder, DOOR_SIGNOFF, doorRung, RUNG_MEANS } from "./ladder";
import { knownActors, skipGate, validateTarget } from "./record";
import { gitSurfaceBar, remediateRow, stateOf, type SurfaceBar } from "./remediate";
import type { Crossed } from "./surfaces";

export type GateStatus =
  | "missing"
  | "bad-digest"
  | "blocking"
  | "unresolved"
  | "drift"
  | "pass"
  | "skipped"
  | "unauthorized-skip"
  | "doctrine-stale"
  | "review-stale"
  | "deferred"
  | "forbidden"
  | "absent";

const FAILING: ReadonlySet<GateStatus> = new Set(["missing", "bad-digest", "blocking", "unresolved", "drift", "unauthorized-skip", "doctrine-stale", "review-stale", "forbidden"]);

/** The gates that end a run: checking one also refuses an open blocking ask. */
export const TERMINAL_GATES: ReadonlyArray<string> = ["final-gates"];

/** About 31 s across 8 reads: the store's observed read lag is seconds to about a minute. */
export const EXPECT_RETRY_DELAYS_MS: ReadonlyArray<number> = [250, 500, 1000, 2000, 4000, 8000, 15000];

export interface CheckInput {
  readonly ep: GatesEndpoint;
  readonly issue: string;
  readonly gates: ReadonlyArray<string>;
  readonly forbid?: ReadonlyArray<string> | undefined;
  readonly cwd: string;
  readonly g: Git;
  readonly out: (line: string) => void;
  readonly warn: (line: string) => void;
  readonly expect?: ReadonlyArray<string> | undefined;
  readonly expectDelaysMs?: ReadonlyArray<number> | undefined;
  readonly sleep: (ms: number) => Promise<void>;
  /** The 429 policy of the receipt reads. */
  readonly readRetry: RetryOpts;
  /** The 429 policy of a doctrine skip's write. */
  readonly writeRetry: RetryOpts;
  /** The burden: its rubric, and the crossing its surfaces are looked up in (resolved before the store is read). */
  readonly burden?: { readonly rubric: BurdenRubric; readonly crossing: () => Promise<Crossed> } | undefined;
  /** The doctrine file and its read (null: no file). Absent: no doctrine, so every `doctrine:` skip is stale. */
  readonly doctrine?: { readonly file: string; readonly read: () => DoctrineRead | null } | undefined;
  /** The ladder's read (null: no file, every class R1); with a floor gate, adds the `@door` row. Absent: no `@door` row (`gate ci`). */
  readonly ladder?: { readonly read: () => DoorLadder | null } | undefined;
  readonly applyModes?: boolean | undefined;
  readonly readOnly?: true | undefined;
  /** Distribution review-report judging (`gatePlugin({ reviews })`); absent fails closed as `blocking`. */
  readonly reviews?: GateReviews | undefined;
  /** Merge-base `review_skills` from `.claude/surfaces.yml` (unlock leg): a report naming any other skill reads `blocking`. */
  readonly reviewSkills?: ReadonlyArray<string> | undefined;
  /** Minimum effort required of `review-report@1` evidence (`--effort`). */
  readonly requiredEffort?: GateReviewEffort | undefined;
  /** Explicit PR head / diff sha256 to check `review-report@1` targets against (`--head-sha` / `--diff-sha256`). */
  readonly head?:
    | {
        readonly headSha?: string | undefined;
        readonly headSource?: ReviewHeadSource | undefined;
        readonly diffSha256?: string | undefined;
        readonly base?: string | undefined;
      }
    | undefined;
  /** The issue's decoded receipts, which `knownActors` reads per gate; `checkGates` populates this from its listing. */
  readonly issueReceipts?: ReadonlyArray<GateReceipt> | undefined;
  readonly now: Date;
  readonly asks?: { readonly pr?: number | undefined; readonly json?: boolean | undefined } | undefined;
  /** The remediation surface bar (default: `gitSurfaceBar(g, cwd)`). */
  readonly surfaceBar?: SurfaceBar | undefined;
}

/** The receipt deciding a gate, with the marker version it was parsed from. */
export interface Latest {
  readonly receipt: GateReceipt;
  readonly version: "v1" | "v2";
  readonly at: string;
}

export interface Judged {
  readonly status: GateStatus;
  readonly why?: string;
  /** The artifact bytes a `pass` was judged on, live or the stored copy. */
  readonly bytes?: Uint8Array;
}

type DigestCache = Map<string, AssetDigest>;

/** What judging one issue's receipts reads: the store, git, the directory, the issue, and optional review-report config. */
export type JudgeOn = Pick<CheckInput, "ep" | "g" | "cwd" | "issue" | "reviews" | "reviewSkills" | "requiredEffort" | "head" | "issueReceipts"> & {
  readonly warn?: ((line: string) => void) | undefined;
};

/** One check: its input plus what it has read so far. */
export interface Checking {
  readonly input: JudgeOn;
  readonly digests: DigestCache;
  /** Per-check cache handed to `reviews.freshness`. */
  readonly fresh?: Map<string, unknown> | undefined;
  /** Cached distribution `reviews.skills` list shared across calls in one check. */
  readonly skills?: { value?: ReadonlyArray<string> } | undefined;
  /** The git checkouts the issue's `git` artifacts live in (for a `repo:no-eris-yaml` skip), resolved once. */
  gitRepos: ReadonlyArray<string>;
  roots?: ReadonlyArray<string>;
}

/** A listing's decoded receipts. */
export const receiptsOfListing = (records: ReadonlyArray<ListedReceipt>): GateReceipt[] =>
  records.flatMap((c) => {
    const p = decodePayload(c.version, c.payload);
    return p.kind === "receipt" ? [p.receipt] : [];
  });

/** Why a review-report on `r` is not bound to the receipt that records it, or null. */
function unboundReviewer(report: GateReviewReport, r: GateReceipt): string | null {
  if (sameActor(report.reviewer.actor, r.actor)) return null;
  return `review-report reviewer ${report.reviewer.actor} is not the recording actor ${r.actor} (not-independent): the reviewer records its own receipt`;
}

function gitMetadataArtifact(top: string): string {
  const dotGit = join(top, ".git");
  const head = join(dotGit, "HEAD");
  return existsSync(head) ? head : dotGit;
}

async function issueRoots(c: Checking): Promise<ReadonlyArray<string>> {
  if (c.roots !== undefined) return c.roots;
  const roots: string[] = [];
  if (c.gitRepos.length > 0) {
    for (const repo of c.gitRepos) {
      const root = await targetRoot(c.input.g, c.input.cwd, repo);
      if (root === null) return (c.roots = []);
      if (!roots.includes(root)) roots.push(root);
    }
    return (c.roots = roots);
  }
  const top = await repoRoot(c.input.g, c.input.cwd);
  if (top !== null) roots.push(top);
  return (c.roots = roots);
}

/** The first evidence item whose digest does not hold, and why, or null. A failure to read a digest is not a verdict: it stops the check. */
async function badDigest(c: Checking, evidence: ReadonlyArray<GateEvidence>): Promise<string | null> {
  for (const [i, e] of evidence.entries()) {
    if (isGateReviewReportEvidence(e)) {
      if (reviewReportDigest(e.report, e.body) !== e.sha256) return `evidence[${i}] (review-report) does not match its sha256`;
      continue;
    }
    if (!isGateMediaEvidence(e)) {
      if (sha256Hex(e.content) !== e.sha256) return `evidence[${i}] (${e.kind}) does not match its sha256`;
      continue;
    }
    let stored = c.digests.get(e.asset_url);
    if (stored === undefined) {
      stored = unwrap(await assetDigest(c.input.ep, e.asset_url));
      c.digests.set(e.asset_url, stored);
    }
    if (stored._tag === "Gone") return `evidence[${i}] (${e.kind}): ${stored.why}`;
    if (stored.sha256 !== e.sha256 || stored.bytes !== e.bytes) return `evidence[${i}] (${e.kind}) does not match the stored asset's digest`;
  }
  return null;
}

/** A copy's bytes, or null when its content does not decode. */
function decodeCopy(copy: GateArtifactCopy): Buffer | null {
  try {
    return gunzipSync(Buffer.from(copy.content, "base64"));
  } catch {
    return null;
  }
}

/** A copy's bytes when they decode to its recorded length and the artifact's sha256, else null. */
export function verifiedCopy(copy: GateArtifactCopy, sha256: string): Buffer | null {
  const bytes = decodeCopy(copy);
  return bytes !== null && bytes.byteLength === copy.bytes && sha256Hex(bytes) === sha256 ? bytes : null;
}

/**
 * The bytes a receipt's artifact was recorded over: its carried copy, the store's copy, or the live
 * artifact while it still hashes to the receipt's sha256. Null when none verifies; a later byte
 * change to the live file is never read as what was recorded.
 */
export async function recordedBytes(
  ep: GatesEndpoint,
  g: Git,
  cwd: string,
  issue: string,
  artifact: GateArtifact,
  readRetry?: RetryOpts,
): Promise<Uint8Array | null> {
  if (artifact.copy !== undefined) {
    const carried = verifiedCopy(artifact.copy, artifact.sha256);
    if (carried !== null) return carried;
  }
  const stored = unwrap(readRetry !== undefined ? await retryRateLimited(() => artifactCopy(ep, artifact.sha256), readRetry) : await artifactCopy(ep, artifact.sha256));
  const copied = stored._tag === "NotStored" ? null : verifiedCopy(stored.copy, artifact.sha256);
  if (copied !== null) return copied;
  const found = await resolveArtifact(g, cwd, artifact, issue);
  return found?.kind === "bytes" && sha256Hex(found.bytes) === artifact.sha256 ? found.bytes : null;
}

export async function statusOf(c: Checking, latest: Latest | undefined, doctrine: DoctrineRead | null): Promise<Judged> {
  if (latest === undefined) return { status: "missing" };
  const r = latest.receipt;
  const bad = await badDigest(c, r.evidence);
  if (bad !== null) return { status: "bad-digest", why: bad };
  const accepted: string[] = [];
  for (const e of r.evidence) {
    if (!isGateReviewReportEvidence(e)) continue;
    const reviews = c.input.reviews;
    if (reviews === undefined) {
      return { status: "blocking", why: "review-report evidence is judged only by an eris build that registers review skills; this build reads it as blocking" };
    }
    const skill = e.report.reviewer.skill.name;
    if (c.input.reviewSkills !== undefined && !c.input.reviewSkills.includes(skill)) {
      const listed = c.input.reviewSkills.length > 0 ? c.input.reviewSkills.join(", ") : "none";
      return { status: "blocking", why: `review skill ${skill} is not a registered review skill (review_skills at the merge-base: ${listed}); a human registers it` };
    }
    if (reviews.skills !== undefined) {
      const slot = c.skills ?? {};
      if (slot.value === undefined) {
        slot.value = typeof reviews.skills === "function" ? await reviews.skills({ cwd: c.input.cwd, env: c.input.g.env }) : reviews.skills;
      }
      if (!slot.value.includes(skill)) {
        const listed = slot.value.length > 0 ? slot.value.join(", ") : "none";
        return { status: "blocking", why: `review skill ${skill} is not a registered review skill (registered: ${listed}); a human registers it` };
      }
    }
    const unbound = unboundReviewer(e.report, r);
    if (unbound !== null) return { status: "blocking", why: unbound };
    const resolved = await resolveTargetHead(c.input.g, c.input.cwd, e.report.target.repo, c.input.head?.base, c.input.head?.headSha, e.report.target.head_sha, e.report.target.pr);
    const fresh = await reviews.freshness({
      report: e.report,
      cwd: c.input.cwd,
      env: c.input.g.env,
      targetRoot: () => targetRoot(c.input.g, c.input.cwd, e.report.target.repo),
      cache: c.fresh ?? new Map(),
    });
    for (const note of fresh.notes ?? []) c.input.warn?.(note);
    const headSource: ReviewHeadSource = c.input.head?.headSource ?? (c.input.head?.headSha !== undefined ? "--head-sha" : "checkout HEAD");
    const diffSource: ReviewDiffSource = c.input.head?.diffSha256 !== undefined ? "--diff-sha256" : headSource;
    const derived = deriveReviewPass(e.report, {
      requiredEffort: c.input.requiredEffort,
      headSha: resolved?.headSha ?? c.input.head?.headSha,
      headSource,
      diffSha256: c.input.head?.diffSha256 ?? resolved?.diffSha256,
      diffSource,
      vocabularyClasses: fresh.classes,
      known: knownActors(c.input.issue, r.gate, c.input.issueReceipts ?? []),
    });
    if (!derived.pass) return { status: derived.status, why: derived.why };
    // A stale or unverifiable skill/vocabulary falls back to human approval, never to a pass.
    const stale = staleness(e.report, fresh.main);
    if (stale.length === 0) continue;
    if (!isHumanGrant(r.authorized)) return { status: "review-stale", why: `${stale.join("; ")}; needs human approval` };
    accepted.push(...stale);
  }
  if (r.verdict === "BLOCKING") return { status: "blocking" };
  if (r.verdict === "SKIPPED" && r.authorized !== undefined && doctrineShaped(r.authorized)) {
    const posture = doctrineGrantPosture(r.authorized);
    if (posture === null) return { status: "unauthorized-skip", why: `--authorized ${r.authorized} is not doctrine:<posture>; re-record the skip with 'eris gate skip'` };
    const blocker = doctrineSkipBlocker(doctrine, posture, r.gate);
    if (blocker === null) return { status: "skipped" };
    return { status: "doctrine-stale", why: `${r.authorized} no longer pre-authorizes skipping ${r.gate}: ${blocker}` };
  }
  if (r.verdict === "SKIPPED" && r.authorized !== undefined && repoGrantShaped(r.authorized)) {
    if (r.authorized !== NO_ERIS_YAML_GRANT) return { status: "unauthorized-skip", why: `--authorized ${r.authorized} is not ${NO_ERIS_YAML_GRANT}; re-record the skip with 'eris gate skip'` };
    if (r.gate !== DEFINE_FUTURE_GATE) return { status: "unauthorized-skip", why: `--authorized ${NO_ERIS_YAML_GRANT} only pre-authorizes skipping ${DEFINE_FUTURE_GATE}, not ${r.gate}` };
    const blocker = noErisYamlSkipBlocker(await issueRoots(c), r.gate);
    if (blocker === null) return { status: "skipped" };
    return { status: "doctrine-stale", why: `${r.authorized} no longer pre-authorizes skipping ${r.gate}: ${blocker}` };
  }
  // A gateway-stamped mandate use is the skip's grant; a prose grant beside it is context.
  if (r.verdict === "SKIPPED" && r.schema === GATE_RECEIPT_SCHEMA_V3 && r.mandate !== undefined) return { status: "skipped" };
  if (r.verdict === "SKIPPED") {
    // A v1 doctrine skip predates the grant field; it carried the grant as evidence prose.
    if (isHumanGrant(r.authorized) || (latest.version === "v1" && r.doctrine !== undefined)) return { status: "skipped" };
    return { status: "unauthorized-skip", why: "a SKIPPED receipt with no --authorized grant; record it with 'eris gate skip'" };
  }
  const acceptance = accepted.length > 0 ? `${accepted.join("; ")}; accepted by human grant "${r.authorized}"` : undefined;
  const found = await resolveArtifact(c.input.g, c.input.cwd, r.artifact, c.input.issue);
  if (found?.kind === "bytes") {
    if (sha256Hex(found.bytes) !== r.artifact.sha256) return { status: "drift" };
    return acceptance !== undefined ? { status: "pass", why: acceptance, bytes: found.bytes } : { status: "pass", bytes: found.bytes };
  }
  // The live artifact always wins; a stored copy answers only when it cannot be read.
  const live: Judged = found === null ? { status: "drift", why: "the artifact is gone" } : { status: "unresolved", why: found.why };
  let copy = r.artifact.copy;
  if (copy === undefined) {
    const stored = unwrap(await artifactCopy(c.input.ep, r.artifact.sha256));
    if (stored._tag === "NotStored") return found === null ? { status: "drift" } : live;
    copy = stored.copy;
  }
  const bytes = verifiedCopy(copy, r.artifact.sha256);
  if (bytes !== null) {
    return { status: "pass", why: `read from the stored copy (${live.why})${acceptance !== undefined ? `; ${acceptance}` : ""}`, bytes };
  }
  return { status: live.status, why: `${live.why}; the stored copy did not verify` };
}

/** Why a human sign-off receipt does not hold, or null: it exists, passes, and carries a human grant. */
export function humanGrantGap(latest: Latest | undefined, status: GateStatus): string | null {
  if (latest === undefined) return "missing";
  if (status !== "pass") return status;
  return isHumanGrant(latest.receipt.authorized) ? null : "no human grant";
}

/** The issue's listing, re-read on `delays` until it holds every `expect` id, or `gate-receipt-unseen`. */
async function readListing(input: CheckInput): Promise<{ receipts: ReadonlyArray<ListedReceipt>; invalid: number }> {
  const delays = input.expectDelaysMs ?? EXPECT_RETRY_DELAYS_MS;
  const expect = input.expect ?? [];
  const read = async () => unwrap(await retryRateLimited(() => listReceipts(input.ep, input.issue), input.readRetry));
  let listing = await read();
  let unseen = expect.filter((id) => !listing.receipts.some((c) => c.id === id));
  for (let i = 0; unseen.length > 0 && i < delays.length; i++) {
    if (delays[i]! > 0) await input.sleep(delays[i]!);
    listing = await read();
    unseen = expect.filter((id) => !listing.receipts.some((c) => c.id === id));
  }
  if (unseen.length > 0) {
    precondition(
      "gate-receipt-unseen",
      `${unseen.length} expected receipt(s) not in ${input.issue}'s comments after ${delays.length + 1} reads: ${unseen.join(", ")}`,
      "The store's reads lag its writes; re-run the same 'eris gate check ... --expect <ids>' in a minute.\n" +
        "Still unseen: check each id is a comment on this issue ('eris gate record' printed it).",
    );
  }
  return listing;
}

/**
 * The open blocking asks bound to the issue, or to `pr`, by id in first-seen order. Every row is kept
 * only when its `binds` match the read and it is open and blocking, so a server that ignored a filter
 * cannot pass an ask through. A full page fails closed: asks past it may be open.
 */
async function openBlockingAsks(ep: GatesEndpoint, issue: string, pr: number | undefined): Promise<AskRow[]> {
  const read = async (q: { issue?: string }): Promise<ReadonlyArray<AskRow>> => {
    const rows = unwrap(await listAsks(ep, { ...q, state: "open", blocking: true, limit: ASKS_LIST_MAX }));
    if (rows.length >= ASKS_LIST_MAX) {
      precondition(
        "asks-listing-truncated",
        `the asks listing returned a full page of ${rows.length}; asks past that page may be open, so the check fails closed`,
        "Answer or withdraw stale asks to bring the open blocking set under the page, or page the asks route and update eris.",
      );
    }
    return rows;
  };
  const live = (a: AskRow) => a.state === "open" && a.blocking;
  const rows = (await read({ issue })).filter((a) => live(a) && a.binds.issue === issue);
  if (pr !== undefined) rows.push(...(await read({})).filter((a) => live(a) && a.binds.pr === pr));
  const open = new Map<string, AskRow>();
  for (const a of rows) if (!open.has(a.id)) open.set(a.id, a);
  return [...open.values()];
}

const CHECK_FIX =
  "missing: run the gate, then 'eris gate record <gate> --issue <KEY> --verdict <v> --artifact <path>'.\n" +
  "blocking: resolve the findings, re-run the gate and record its new verdict.\n" +
  "drift: the artifact changed after it passed; re-run the gate on it and record again.\n" +
  "unresolved: run check from a checkout of the artifact's repo (or list that clone in ~/.eris/clones.json), or commit the artifact on the issue's branch;\n" +
  "  a receipt with no verifying stored copy can only be recorded again.\n" +
  "bad-digest: the receipt's evidence no longer matches its digest; re-run the gate and record again.\n" +
  "burden: record the gate again with the missing evidence (--test-run, --e2e, --log, --screenshot, ... <file>).\n" +
  "  A define-future over a non-empty delta owes its picture: eris graph diff <baseline.json> <target.delta.json> --image diff.png,\n" +
  "  then record define-future again with --screenshot diff.png.\n" +
  "doctrine-stale: the active posture no longer turns the gate off; run the gate and record it.\n" +
  "review-stale: the review skill or surface vocabulary moved on main after the report was written (or could not be verified);\n" +
  "  re-run the review on main's skill and vocabulary and record it, or record with a human --authorized grant.\n" +
  "unauthorized-skip: re-record the skip with 'eris gate skip <gate> --reason <why> --authorized <grant>'.\n" +
  "forbidden: this profile must not run that gate; re-recording never clears it. Check the issue with the profile\n" +
  "  that runs it (close: next, not terminus), or a human deletes the receipt comment if the run was wrong.\n" +
  "floor unmet: run the work skill's floor-evidence stage: record a PASS for each named requirement gate on its artifact\n" +
  "  ('eris gate record revert-path --issue <KEY> --verdict PASS --artifact <note>'; SKIPPED never meets the floor),\n" +
  "  or lower the class with a receipt carrying --authorized <grant>.\n" +
  "unclassified: apply user-impact@1 and record a gate (understand-scope) with --impact U0|U1|U2|U3.\n" +
  "@remediate violated: a re-review broke actor separation, reused the launch head, or the remediation diff widened a\n" +
  "  surface; a different reviewer re-reviews the new head, or a human signs the widening. hand-off: max_rounds reached;\n" +
  "  a human signs off ('eris gate record remediate --verdict PASS --authorized \"<name> asked: <request>\"').\n" +
  "asks: an open blocking ask holds the terminal gate: answer it or withdraw it;\n" +
  "  only a human withdraws a one-way ask. Answers are read live, so re-run check once it is answered.\n" +
  "door R0: a human signs off before the run closes: 'eris gate record door-signoff --issue <KEY> --verdict PASS\n" +
  "  --artifact <plan> --authorized \"<name> asked: <request>\"' (a doctrine: grant never signs a door).";

/** Judge every named gate, print one row each and the derived rows, and stop with `gate-check-failed` unless all pass. */
export async function checkGates(input: CheckInput): Promise<void> {
  validateTarget(input.gates, input.issue);
  // The asks read depends on nothing below, so it starts now; it is awaited where `@asks` prints.
  const wantAsks = input.gates.some((g) => TERMINAL_GATES.includes(g)) || input.asks?.json === true;
  const asksRead = wantAsks
    ? openBlockingAsks(input.ep, input.issue, input.asks?.pr).then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      )
    : undefined;
  const crossed = input.burden === undefined ? undefined : await input.burden.crossing();
  const listing = await readListing(input);
  const latest = new Map<string, Latest>();
  const floorChecked = input.gates.some((g) => (FLOOR_GATES as readonly string[]).includes(g));
  const forbid = input.forbid ?? [];
  const wanted = new Set<string>([...input.gates, ...forbid, ...(floorChecked ? [...REQUIREMENTS, DOOR_SIGNOFF, BLEED_REDUCING] : [])]);
  const classed: { receipt: GateReceipt; at: string }[] = [];
  const issueReceipts: GateReceipt[] = [];
  const gitRepos = new Set<string>();
  let invalid = listing.invalid;
  for (const row of listing.receipts) {
    const parsed = decodePayload(row.version, row.payload);
    if (parsed.kind === "invalid") {
      invalid += 1;
      continue;
    }
    const r = parsed.receipt;
    if (r.issue !== input.issue) continue;
    issueReceipts.push(r);
    if (r.artifact._tag === "git") gitRepos.add(r.artifact.repo);
    if (r.user_impact !== undefined) classed.push({ receipt: r, at: row.createdAt });
    if (!wanted.has(r.gate)) continue;
    const prev = latest.get(r.gate);
    if (prev === undefined || row.createdAt >= prev.at) latest.set(r.gate, { receipt: r, version: parsed.version, at: row.createdAt });
  }
  const c: Checking = { input: { ...input, issueReceipts: input.issueReceipts ?? issueReceipts }, digests: new Map(), fresh: new Map(), skills: {}, gitRepos: [...gitRepos] };
  if (invalid > 0) input.warn(`WARN ${invalid} comment(s) on ${input.issue} carry a gate-receipt marker that does not decode; ignored`);

  const needsDoctrine = input.applyModes === true || floorChecked || [...latest.values()].some((l) => l.receipt.authorized !== undefined && doctrineGrantPosture(l.receipt.authorized) !== null);
  const doctrine = input.doctrine === undefined || !needsDoctrine ? null : input.doctrine.read();
  if (input.applyModes === true && input.doctrine !== undefined && doctrine !== null) {
    const bad = invalidDoctrine(input.doctrine.file, doctrine);
    if (bad !== null) stop(bad);
  }
  const posture = input.applyModes === true ? activePosture(doctrine) : undefined;
  const finalChecked = input.gates.includes("final-gates");

  const failing: string[] = [];
  const carried: GateEvidence[] = [];
  const owed: { gate: string; kinds: EvidenceKind[]; lacking: EvidenceKind[] }[] = [];
  const writeRun = (cwd: string) => ({ ep: input.ep, g: input.g, cwd, now: input.now, retry: input.writeRetry });
  for (const gate of input.gates) {
    const mode = gateMode(posture?.policy, gate);
    if (mode === "once-at-end" && gate !== "final-gates" && !finalChecked) {
      input.out(`${gate}\tdeferred\t-`);
      continue;
    }
    let l = latest.get(gate);
    let s = await statusOf(c, l, doctrine);
    if (mode === "off" && posture !== undefined && input.doctrine !== undefined && (s.status === "missing" || s.status === "doctrine-stale")) {
      const reason = `doctrine ${posture.slug} sets ${modeSource(posture.policy, gate)?.key ?? `gates.${gate}`}: off`;
      if (input.readOnly === true) {
        input.out(`${gate}\tskipped\t${reason}`);
        continue;
      }
      const written = await skipGate(writeRun(input.cwd), {
        gate,
        issue: input.issue,
        artifact: input.doctrine.file,
        reason,
        authorized: `${DOCTRINE_GRANT}${posture.slug}`,
        doctrine: input.doctrine.file,
        actor: doctrineActor(posture),
      });
      input.warn(`doctrine: recorded ${gate} SKIPPED as ${written.receipt.actor} (${written.commentId})`);
      l = { receipt: written.receipt, version: "v2", at: written.receipt.recorded_at };
      latest.set(gate, l);
      s = await statusOf(c, l, doctrine);
    }
    if (input.applyModes === true && gate === DEFINE_FUTURE_GATE && (s.status === "missing" || s.status === "doctrine-stale")) {
      const roots = await issueRoots(c);
      if (noErisYamlSkipBlocker(roots, gate) === null) {
        const top = roots[0]!;
        const reason = `repo ${basename(top)} has no root eris.yaml (no eris estate)`;
        if (input.readOnly === true) {
          input.out(`${gate}\tskipped\t${reason}`);
          continue;
        }
        const doctrinePath =
          input.doctrine === undefined || doctrine === null
            ? undefined
            : resolve(top, input.doctrine.file) === resolve(input.cwd, input.doctrine.file)
              ? input.doctrine.file
              : resolve(input.cwd, input.doctrine.file);
        const written = await skipGate(writeRun(top), {
          gate,
          issue: input.issue,
          artifact: gitMetadataArtifact(top),
          reason,
          authorized: NO_ERIS_YAML_GRANT,
          ...(doctrinePath !== undefined ? { doctrine: doctrinePath } : {}),
          actor: NO_ERIS_YAML_GRANT,
        });
        input.warn(`profile: recorded ${gate} SKIPPED as ${written.receipt.actor} (${written.commentId})`);
        l = { receipt: written.receipt, version: "v2", at: written.receipt.recorded_at };
        latest.set(gate, l);
        s = await statusOf(c, l, doctrine);
      }
    }
    const r = l?.receipt;
    input.out(`${gate}\t${s.status}\t${r?.verdict ?? "-"}`);
    if (s.why !== undefined) input.warn(`WARN ${gate}: ${s.status}: ${s.why}`);
    if (FAILING.has(s.status)) failing.push(`${gate} (${s.status})`);
    if (s.status === "pass" && r !== undefined) {
      carried.push(...r.evidence);
      const kinds = s.bytes === undefined ? [] : owedBy(gate, s.bytes);
      if (kinds.length > 0) owed.push({ gate, kinds, lacking: unmet(kinds, r.evidence) });
    }
  }
  for (const gate of forbid) {
    const r = latest.get(gate)?.receipt;
    input.out(`${gate}\t${r === undefined ? "absent" : "forbidden"}\t${r?.verdict ?? "-"}`);
    if (r !== undefined) failing.push(`${gate} (forbidden: this profile never records it)`);
  }

  const burdenLine = (input.burden !== undefined && crossed !== undefined) || owed.length > 0;
  if (burdenLine) {
    const required = new Set<EvidenceKind>();
    const missing = new Set<EvidenceKind>();
    if (input.burden !== undefined && crossed !== undefined) {
      const { rubric } = input.burden;
      const stray = Object.keys(rubric.surfaces).filter((s) => !crossed.known.includes(s));
      if (stray.length > 0) input.warn(`WARN burden: rubric surface(s) no discover.paths claim names: ${stray.join(", ")}`);
      const kinds = burdenOf(rubric, crossed.surfaces);
      const lacking = unmet(kinds, carried);
      for (const k of kinds) required.add(k);
      for (const k of lacking) missing.add(k);
      if (lacking.length > 0) input.warn(`WARN burden: ${crossed.changed.length} changed path(s) cross ${crossed.surfaces.join(", ")}; no passing receipt carries ${lacking.join(", ")}`);
    }
    for (const o of owed) {
      for (const k of o.kinds) required.add(k);
      for (const k of o.lacking) missing.add(k);
      if (o.lacking.length > 0) {
        input.warn(
          `WARN burden: ${o.gate}'s artifact is a non-empty target delta; its receipt carries no ${o.lacking.join(", ")} ` +
            "(eris graph diff <baseline.json> <target.delta.json> --image <png>, then record it again with --screenshot <png>)",
        );
      }
    }
    const req = [...required].sort();
    const miss = [...missing].sort();
    input.out(`burden\t${miss.length === 0 ? "pass" : "unmet"}\t${req.join(",") || "-"}`);
    if (miss.length > 0) failing.push(`burden (unmet: ${miss.join(", ")})`);
  }

  if (floorChecked) {
    classed.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const { cls, ignored } = effectiveClass(classed.map((x) => x.receipt));
    for (const i of ignored) input.warn(`WARN ${i.gate} receipt lowers ${input.issue} from ${i.from} to ${i.to} without --authorized; ignored`);
    if (cls === undefined) {
      input.out("@floor\tunclassified\t-");
      failing.push("no user-impact class proposed (apply user-impact@1 and record understand-scope with --impact U0|U1|U2|U3)");
    } else {
      const passing = new Set<string>();
      const statuses = new Map<string, GateStatus>();
      for (const req of REQUIREMENTS) {
        const status = (await statusOf(c, latest.get(req), doctrine)).status;
        statuses.set(req, status);
        if (status === "pass") passing.add(req);
      }
      // Each requirement of the class reads as its own row; one already named in the gates printed above.
      const raise = posture?.policy?.user_impact?.[cls];
      const required = requirementsFor(cls, raise);
      for (const req of required) if (!input.gates.includes(req)) input.out(`${req}\t${statuses.get(req)}\t${latest.get(req)?.receipt.verdict ?? "-"}`);
      const lacking = required.filter((req) => !passing.has(req));
      input.out(`@floor\t${lacking.length === 0 ? "pass" : "unmet"}\t${cls}`);
      const raisedBy = required.length > requirementsFor(cls).length ? ` (raised by doctrine ${posture?.slug})` : "";
      if (lacking.length > 0) failing.push(`${cls} floor unmet${raisedBy}: ${lacking.map((req) => `${req} (${statuses.get(req)})`).join(", ")}`);
      const ladder = input.ladder;
      if (ladder !== undefined) {
        const active = activePosture(doctrine);
        const bleedReducing = (await statusOf(c, latest.get(BLEED_REDUCING), doctrine)).status === "pass";
        const d = doorRung({ ladder: ladder.read(), policy: active?.policy, posture: active?.slug, u: cls, crossings: crossed?.surfaces ?? [], bleedReducing });
        input.out(`@door\t${d.rung}\t${d.door}`);
        const how = `${d.liftedBy !== undefined ? `, lifted by ${d.liftedBy}` : ""}${d.cappedBy !== undefined ? `, capped by ${d.cappedBy}` : ""}`;
        input.warn(`door: ${d.door} at ${d.rung} (${RUNG_MEANS[d.rung]}); ladder states ${d.stated}${how}`);
        if (d.rung === "R0") {
          const signoff = latest.get(DOOR_SIGNOFF);
          const why = humanGrantGap(signoff, (await statusOf(c, signoff, doctrine)).status);
          if (why !== null) failing.push(`door R0 (${d.door}): no passing ${DOOR_SIGNOFF} receipt with a human --authorized grant (${why})`);
        }
      }
    }
  }

  const remediation = await remediateRow(stateOf(input.issue, listing.receipts), input.surfaceBar ?? gitSurfaceBar(input.g, input.cwd));
  if (remediation !== undefined) {
    input.out(`@remediate\t${remediation.status}\t${remediation.round}`);
    for (const why of remediation.why) input.warn(`WARN @remediate: ${remediation.status}: ${why}`);
    if (remediation.status === "violated" || remediation.status === "hand-off") failing.push(`@remediate (${remediation.status}: ${remediation.why.join("; ")})`);
  }

  if (asksRead !== undefined) {
    const pr = input.asks?.pr;
    const res = await asksRead;
    if (!res.ok) throw res.e;
    const open = res.v;
    input.out(`@asks\t${open.length === 0 ? "clear" : "open"}\t${open.length}`);
    // The id and question are the asker's text: quoted, so a newline cannot forge a failure-block line.
    for (const a of open) input.warn(`ask ${JSON.stringify(a.id)} (${a.door}): ${JSON.stringify(a.question)}`);
    if (input.asks?.json === true) {
      const view = open.map((a) => ({ id: a.id, question: a.question, door: a.door, binds: a.binds }));
      input.out(JSON.stringify({ asks: { issue: input.issue, ...(pr !== undefined ? { pr } : {}), state: open.length === 0 ? "clear" : "open", open: view } }));
    }
    if (open.length > 0) failing.push(`open blocking ask(s): ${open.map((a) => `${a.id} ${JSON.stringify(a.question)}`).join(", ")}`);
  }

  if (failing.length > 0) {
    precondition("gate-check-failed", `${failing.length} of ${input.gates.length + forbid.length + (burdenLine ? 1 : 0)} gate(s) do not pass on ${input.issue}: ${failing.join(", ")}`, CHECK_FIX);
  }
}
