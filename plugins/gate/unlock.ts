/**
 * unlock.ts — `gate ci`'s unlock leg: whether merging a change that crosses registered surfaces may
 * proceed without a human. It reads and never writes: no `unlocked-merge` announcement is recorded here.
 *
 * The bar for each crossed surface is the repo's `one_way_unlock.merge`, read from the registry at the
 * merge-base so a PR never sets its own bar, ∪ the active posture's `signoff.raise` (doctrine only
 * raises) ∪ `posture-check`. A surface that does not list merge stays human-signed, whatever the
 * posture raises. It unlocks when:
 *
 *   the posture sets `signoff.unlock: on`;
 *   every bar gate's latest receipt passes and is bound to the PR head: its `git` artifact's commit is
 *     the head, or an ancestor of it with only gate notes changed since (git.ts `commitBoundToHead`);
 *     a qualifier this build cannot judge never passes, and review-report evidence reads blocking
 *     unless `reviews` is supplied;
 *   the surface's ledger issue holds a passing `audit-surfaces` receipt younger than `audit_ttl`, fewer
 *     than `change_budget` `unlocked-merge` receipts since it, and an announcement for this head;
 *   the surface is not locked;
 *   the diff touches no governance file: the registry, a registered vocabulary or a registered review
 *     skill (either side). Such a diff sets the bar itself, so it always reads human, and the monotone
 *     rows against the merge-base are printed and named in the reason; a wider row no human
 *     `surface-widen` receipt covers is its own reason.
 *
 * A merge first reads the change's door (`mergeDoor`): the bar is for one-way doors only. A two-way
 * merge prints `@door two-way` and `@unlock not-needed` unless it is a governance diff, a crossed
 * surface is locked, or the posture holds two-way doors for a human. A one-way merge whose
 * `adversarial-review` has no receipt bound to the head prints, on the human path only, the
 * `@dispatch` row that launches that review loop (`REVIEW_DISPATCH`), so the merging actor runs it;
 * a review already recorded at the head, or naming no commit, is never re-dispatched.
 *
 * Anything short of that falls back to a human: the issue's latest `door-signoff` signs it when it
 * passes with a human `--authorized` grant (never `doctrine:`), is bound to the PR head as a bar gate is,
 * and carries a `door: merge` evidence line; else `gate-unlock-human`, naming every reason.
 */

import { posix } from "node:path";
import {
  activePosture,
  DEFAULT_AUDIT_TTL,
  DEFAULT_CHANGE_BUDGET,
  DEFINE_FUTURE_GATE,
  type DoctrinePolicy,
  type DoctrineRead,
  GATE_INLINE_KINDS,
  GATE_REVIEW_EFFORTS,
  type GateArtifact,
  type GateReceipt,
  type GateReviewEffort,
  type GatesEndpoint,
  decodePayload,
  isGateReviewReportEvidence,
  type ListedReceipt,
  listReceipts,
  RAISE_ALL,
  type SurfacesFile,
  type RetryOpts,
  retryRateLimited,
} from "eris/gates-contract";
import { targetChanges } from "./burden";
import { type CheckInput, type Checking, humanGrantGap, type Judged, type Latest, receiptsOfListing, recordedBytes, statusOf } from "./check";
import { precondition, unwrap } from "./failure";
import { effectiveClass } from "./floor";
import { changedPaths, type CommitBound, commitBoundToHead, type Git, mergeBase, ok, repoRoot, revParse, run, shellQuote, untrackedFiles } from "./git";
import type { GateReviews } from "./index";
import { DOOR_SIGNOFF, doorRung } from "./ladder";
import { announcedHeads, countUnlocked, lockState, monDd, UNLOCKED_GATES } from "./ledger";
import { classifyMonotone, type Dim, inSkillDir, named, readMonotoneSides, rowLine, type Signoff, uncovered } from "./monotone";
import { issuesText, type MatchedSurface, matchSurfaces, surfacesInvalid, validateSurfacesYaml, vocabularyPath } from "./registry";

/** Every bar holds posture-check: the diff itself passed the surface posture gate. */
export const ALWAYS_UNLOCK_GATES = ["posture-check"] as const;

/** The gate an audit-surfaces baseline is recorded under, on the surface's ledger issue. */
export const AUDIT_GATE = "audit-surfaces";

/** The qualifier that requires a strict `PASS`: an `AMENDED` pass is not clean. */
export const CLEAN_QUALIFIER = "clean";

/** The R0 gate whose human-granted artifact approves the wider monotone rows it carries verbatim. */
export const SURFACE_WIDEN = "surface-widen";

/** The gate whose receipt names the change's door (`door: one-way (+1 -0 ~1)`). */
export const DEFINE_FUTURE = DEFINE_FUTURE_GATE;

/** The review loop a one-way merge dispatches when its bar lacks it. */
export const REVIEW_DISPATCH = { gate: "adversarial-review", loop: "adversarial-review", runtime: "opencode", pool: "neon" } as const;

export interface MergeDoor {
  readonly door: "one-way" | "two-way";
  /** What decided it: `define-future`, `define-future <status>`, `rung <R> (<class>)` or `unclassified`. */
  readonly source: string;
}

/**
 * The door of a merge. Every signal can only close it, so it reads two-way only when all say
 * two-way:
 *
 *   the latest define-future, unless it is a valid doctrine/repo skip: one-way when it does not
 *     pass, when its verified artifact is a graph-target delta that removes or changes anything
 *     (or fails strict decode), or when a door line labels one-way or counts a removal or change;
 *   every define-future on the issue, whatever its verdict: one-way when the bytes it was recorded
 *     over cannot be verified, when they are a delta that removes or changes anything (or fails
 *     strict decode), or when an inline door line labels or counts one-way (a follow-up's later
 *     empty-target note never hides the issue's door);
 *   the issue's class: none is one-way; else the rung it reaches with no ladder file
 *     (`DEFAULT_RUNGS` under the posture's ceilings; local and CI read the same), R0 one-way.
 */
export function mergeDoor(input: {
  readonly defineFuture: { readonly receipt: GateReceipt; readonly status: string; readonly bytes?: Uint8Array | undefined } | undefined;
  /** Every define-future receipt on the issue, with the bytes it was recorded over (null: none verifies; a skip records none). */
  readonly defineFutures?: ReadonlyArray<{ readonly receipt: GateReceipt; readonly bytes: Uint8Array | null }> | undefined;
  readonly classed: ReadonlyArray<GateReceipt>;
  readonly policy: DoctrinePolicy | null | undefined;
  readonly posture: string | undefined;
  readonly crossings: ReadonlyArray<string>;
}): MergeDoor {
  const df = input.defineFuture?.status === "skipped" ? undefined : input.defineFuture;
  if (df !== undefined) {
    if (df.status !== "pass") return { door: "one-way", source: `${DEFINE_FUTURE} ${df.status}` };
    const delta = df.bytes === undefined ? null : targetChanges(df.bytes);
    if (delta?.kind === "invalid") return { door: "one-way", source: `${DEFINE_FUTURE} delta invalid` };
    if (delta !== null && delta.remove + delta.change > 0) return { door: "one-way", source: `${DEFINE_FUTURE} delta (-${delta.remove} ~${delta.change})` };
    if (doorLines(df.receipt).some(oneWayDoorLine)) return { door: "one-way", source: DEFINE_FUTURE };
  }
  for (const h of input.defineFutures ?? []) {
    if (h.bytes === null) return { door: "one-way", source: `${DEFINE_FUTURE} history unverified` };
    const delta = targetChanges(h.bytes);
    if (delta?.kind === "invalid") return { door: "one-way", source: `${DEFINE_FUTURE} history invalid` };
    if (delta !== null && delta.remove + delta.change > 0) return { door: "one-way", source: `${DEFINE_FUTURE} history (-${delta.remove} ~${delta.change})` };
    if (doorLines(h.receipt).some(oneWayDoorLine)) return { door: "one-way", source: `${DEFINE_FUTURE} history` };
  }
  const { cls } = effectiveClass(input.classed);
  if (cls === undefined) return { door: "one-way", source: "unclassified" };
  const d = doorRung({ ladder: null, policy: input.policy, posture: input.posture, u: cls, crossings: input.crossings, bleedReducing: false });
  const rung = `rung ${d.rung} (${d.door})`;
  if (d.rung === "R0") return { door: "one-way", source: rung };
  return { door: "two-way", source: df === undefined ? rung : `${DEFINE_FUTURE}, ${rung}` };
}

/** A receipt's inline evidence lines (text, log, test-run, e2e), trimmed. */
function doorLines(r: GateReceipt): string[] {
  const inline: ReadonlyArray<string> = GATE_INLINE_KINDS;
  return r.evidence.flatMap((e) => (inline.includes(e.kind) && "content" in e && typeof e.content === "string" ? e.content.split("\n").map((l) => l.trim()) : []));
}

/**
 * A define-future door line that names a one-way door: labelled `one-way`, or any of whose counts,
 * wherever they sit on the line (`(+1 -1 ~0)`, `(+1 −1 ~0)`, `(edges +3 -1 ~0, nodes +0 -0 ~0)`),
 * shows a removal or a change, whatever its label (`-`, `−` (U+2212), or `~` above 0).
 */
export function oneWayDoorLine(line: string): boolean {
  const m = /^door:\s*(one-way|two-way)\b(.*)$/i.exec(line);
  if (m === null) return false;
  if (m[1]!.toLowerCase() === "one-way") return true;
  return [...m[2]!.matchAll(/(?:^|[\s(,])[-\u2212~](\d+)\b/g)].some((c) => Number(c[1]) > 0);
}

/** The `eris loop launch` command a missing review on a one-way merge dispatches; `cwd` is shell-quoted. */
export function reviewDispatch(issue: string, cwd: string): string {
  const r = REVIEW_DISPATCH;
  return `eris loop launch ${r.loop} ${issue} --cwd ${shellQuote(cwd)} --runtime ${r.runtime} --pool ${r.pool} --unclaimed`;
}

/** The main clone a checkout belongs to: the git common dir's parent when it is a `.git`, else the checkout itself. */
async function mainClone(g: Git, top: string): Promise<string> {
  const r = await run(g, top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const common = ok(r) ? r.stdout.toString("utf8").trim() : "";
  return posix.basename(common) === ".git" ? posix.dirname(common) : top;
}

/** The one action `gate ci` judges. */
export type CiAction = "merge";

export interface UnlockInput {
  readonly ep: GatesEndpoint;
  readonly issue: string;
  readonly action: CiAction;
  /** The PR's base sha: the bar's registry is read at the merge-base of it and HEAD. */
  readonly base: string;
  /** The PR head the receipts must be bound to: the checkout's HEAD, or the PR parent of the merge commit CI checks out. */
  readonly headSha: string;
  /** The registry path, relative to the repo root. */
  readonly registry: string;
  readonly cwd: string;
  readonly g: Git;
  /** The posture's source: its name (the hosted bundle) and its read. */
  readonly doctrine: { readonly file: string; readonly read: DoctrineRead | null };
  /** Distribution review-report judging (`gatePlugin({ reviews })`); absent fails closed as `blocking`. */
  readonly reviews?: GateReviews | undefined;
  readonly now: Date;
  /** The 429 policy of the receipt reads. */
  readonly readRetry: RetryOpts;
  readonly out: (line: string) => void;
  readonly warn: (line: string) => void;
}

export type Decision = "unlocked" | "human-signed" | "not-needed";

/** The bar's gates for one surface, and whether the surface does not list the action at all. */
export function unlockBar(
  surface: Pick<MatchedSurface, "name" | "one_way_unlock">,
  action: CiAction,
  raise: Readonly<Record<string, Partial<Record<CiAction, ReadonlyArray<string>>>>> | undefined,
): { readonly gates: readonly string[]; readonly unlisted: boolean } {
  const repo = surface.one_way_unlock?.[action];
  const raised = [...(raise?.[surface.name]?.[action] ?? []), ...(raise?.[RAISE_ALL]?.[action] ?? [])];
  return { gates: [...new Set([...(repo ?? []), ...raised, ...ALWAYS_UNLOCK_GATES])], unlisted: repo === undefined };
}

/** `30d` / `720h` in milliseconds. */
export function ttlMs(ttl: string): number {
  const n = Number(ttl.slice(0, -1));
  return n * (ttl.endsWith("h") ? 3_600_000 : 86_400_000);
}

function unresolved(what: string, fix = "Check out the PR with fetch-depth: 0 so its base and head commits are present."): never {
  return precondition("gate-unlock-unresolved", what, fix);
}

/**
 * The registry committed at `rev`, decoded; null only when `rev`'s tree has no such path. Any other git
 * failure refuses (`gate-unlock-unresolved`): read as "no registry", it would pass a surface diff.
 */
export async function registryAt(g: Git, top: string, rev: string, path: string): Promise<SurfacesFile | null> {
  const listed = await run(g, top, ["ls-tree", "--name-only", rev, "--", path]);
  if (!ok(listed)) return unresolved(`git could not list ${path} at ${rev}`, "Re-run; check 'git ls-tree' works in this checkout.");
  if (listed.stdout.toString("utf8").trim() === "") return null;
  const shown = await run(g, top, ["show", `${rev}:${path}`]);
  if (!ok(shown)) return unresolved(`git could not read ${path} at ${rev}`, "Re-run; check 'git show' works in this checkout.");
  const v = validateSurfacesYaml(shown.stdout.toString("utf8"));
  return v.ok ? v.value : surfacesInvalid(`${path} at ${rev === "HEAD" ? rev : rev.slice(0, 12)}`, issuesText(v.issues));
}

/** Whether HEAD's tree is git's clean merge of `base` and `head` (`merge-tree --write-tree`); any conflict or error is no. */
async function cleanMergeTree(g: Git, top: string, base: string, head: string): Promise<boolean> {
  const [merged, tree] = await Promise.all([run(g, top, ["merge-tree", "--write-tree", base, head]), run(g, top, ["rev-parse", "--verify", "HEAD^{tree}"])]);
  if (!ok(merged) || !ok(tree)) return false;
  const oid = merged.stdout.toString("utf8").split("\n")[0]?.trim() ?? "";
  return oid !== "" && oid === tree.stdout.toString("utf8").trim();
}

/**
 * The event's head sha, resolved, when it is the checkout's HEAD or the PR parent of the merge commit
 * CI checks out: `HEAD^2` of a two-parent merge whose first parent is the base tip and whose tree is
 * git's clean merge of the two. Any other sha refuses, so the bar is never judged at a head that is not
 * the one checked out.
 */
async function verifiedHeadSha(g: Git, top: string, headSha: string, checkout: string, tip: string): Promise<string> {
  if (!/^[0-9a-f]{40}$/i.test(headSha)) return unresolved(`head ${headSha}: not a full 40-hex commit sha`);
  const named = await revParse(g, headSha.toLowerCase(), top);
  if (named !== null && named === checkout) return named;
  const [first, second, third] = await Promise.all([revParse(g, "HEAD^1", top), revParse(g, "HEAD^2", top), revParse(g, "HEAD^3", top)]);
  if (named !== null && named === second && first === tip && third === null && (await cleanMergeTree(g, top, tip, named))) return named;
  return unresolved(
    `head ${headSha.slice(0, 12)} is not the checkout HEAD ${checkout.slice(0, 12)} or the PR parent of a merge commit onto the base${named === null ? " (not a commit in this checkout)" : ""}`,
    "Check out the PR head (or the merge commit CI builds for it) with fetch-depth: 0.",
  );
}

/** Whether a receipt's artifact is bound to `head`: recorded at it, or at an ancestor with only gate notes since. */
function boundToHead(g: Git, top: string, artifact: GateArtifact, head: string): Promise<CommitBound> {
  if (artifact._tag !== "git" || artifact.commit === undefined) return Promise.resolve({ bound: false, why: "the receipt names no commit (a file artifact)" });
  return commitBoundToHead(g, top, artifact.commit, head);
}

/** Whether `receipt` carries a text evidence line exactly `line`. */
const carriesLine = (receipt: GateReceipt, line: string): boolean => receipt.evidence.some((e) => e.kind === "text" && "content" in e && e.content.split("\n").includes(line));

/**
 * The changed paths that set the bar rather than cross it: the registry, a vocabulary a surface points
 * at, or a registered review skill's directory or a file under it, on either registry side. Spellings
 * are normalised (`./x` is `x`) to match git's changed paths.
 */
function governancePaths(registry: string, sides: ReadonlyArray<SurfacesFile | null>, changed: readonly string[]): string[] {
  const files = new Set([posix.normalize(registry)]);
  const skills: string[] = [];
  for (const reg of sides) {
    if (reg === null) continue;
    for (const [name, spec] of Object.entries(reg.surfaces)) files.add(posix.normalize(vocabularyPath(name, spec)));
    skills.push(...Object.keys(reg.review_skills ?? {}));
  }
  return changed.filter((p) => files.has(p) || skills.some((s) => inSkillDir(p, s)));
}

/** The latest receipt per gate on `issue`'s listing, by the store's time. */
function latestByGate(issue: string, receipts: ReadonlyArray<ListedReceipt>): Map<string, Latest> {
  const latest = new Map<string, Latest>();
  for (const c of receipts) {
    const parsed = decodePayload(c.version, c.payload);
    if (parsed.kind !== "receipt" || parsed.receipt.issue !== issue) continue;
    const prev = latest.get(parsed.receipt.gate);
    if (prev === undefined || c.createdAt >= prev.at) latest.set(parsed.receipt.gate, { receipt: parsed.receipt, version: parsed.version, at: c.createdAt });
  }
  return latest;
}

/** `issue`'s receipts for `gate`, in listing order. */
function gateReceiptsOf(issue: string, gate: string, receipts: ReadonlyArray<ListedReceipt>): GateReceipt[] {
  return receipts.flatMap((c) => {
    const parsed = decodePayload(c.version, c.payload);
    return parsed.kind === "receipt" && parsed.receipt.issue === issue && parsed.receipt.gate === gate ? [parsed.receipt] : [];
  });
}

/** `issue`'s receipts that propose a user-impact class, oldest first (`effectiveClass` folds them in order). */
function classedOf(issue: string, receipts: ReadonlyArray<ListedReceipt>): GateReceipt[] {
  return receipts
    .map((c) => ({ c, parsed: decodePayload(c.version, c.payload) }))
    .flatMap(({ c, parsed }) => (parsed.kind === "receipt" && parsed.receipt.issue === issue && parsed.receipt.user_impact !== undefined ? [{ at: c.createdAt, r: parsed.receipt }] : []))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((x) => x.r);
}

/** The review-report@1 evidence on a receipt that reviewed `surface` against its own vocabulary. */
function reportsFor(receipt: GateReceipt, surface: Pick<MatchedSurface, "name" | "class_taxonomy">) {
  return receipt.evidence.filter(isGateReviewReportEvidence).filter((e) => e.report.surface === surface.name && e.report.reviewer.vocabulary.path === surface.class_taxonomy);
}

/**
 * One bar gate's status before head binding. `:<effort>` passes only on a receipt carrying a
 * review-report@1 for this surface at that effort or above; `:clean` only on a `PASS`; any other
 * qualifier never passes. A receipt that carries reports must carry one for this surface and its
 * vocabulary, qualified or not.
 */
async function judgeBarGate(
  surface: Pick<MatchedSurface, "name" | "class_taxonomy">,
  gate: string,
  qualifier: string | undefined,
  latest: Latest | undefined,
  judge: (requiredEffort: GateReviewEffort | undefined) => Promise<Judged>,
): Promise<{ readonly status: string; readonly why?: string | undefined }> {
  const effort = (GATE_REVIEW_EFFORTS as readonly string[]).includes(qualifier ?? "") ? (qualifier as GateReviewEffort) : undefined;
  if (qualifier !== undefined && effort === undefined && qualifier !== CLEAN_QUALIFIER) {
    return { status: "unjudged", why: `the :${qualifier} qualifier is not one eris judges (${[...GATE_REVIEW_EFFORTS, CLEAN_QUALIFIER].join(", ")}), so it never unlocks` };
  }
  const judged = await judge(effort);
  if (judged.status !== "pass" || latest === undefined) return judged;
  const reviewed = latest.receipt.evidence.some(isGateReviewReportEvidence);
  const fix = `record ${gate} with a review-report@1 for surface ${surface.name} (vocabulary ${surface.class_taxonomy})${effort !== undefined ? ` at effort ${effort} or above` : ""}`;
  if (effort !== undefined && !reviewed) return { status: "no-report", why: `the receipt carries no review-report@1; ${fix}` };
  if (reviewed && reportsFor(latest.receipt, surface).length === 0) {
    return { status: "wrong-surface", why: `no review-report@1 on the receipt names surface ${surface.name} and vocabulary ${surface.class_taxonomy}; ${fix}` };
  }
  if (qualifier === CLEAN_QUALIFIER && latest.receipt.verdict !== "PASS") return { status: "not-clean", why: `the latest receipt is ${latest.receipt.verdict}, not PASS; re-run it clean and record PASS` };
  return judged;
}

/** The issue's latest receipt for `gate` and, when it is a passing human-granted one, its artifact bytes. */
export async function humanSignoff(input: Pick<UnlockInput, "ep" | "g" | "cwd" | "readRetry" | "reviews">, issue: string, gate: string): Promise<Signoff> {
  const listing = unwrap(await retryRateLimited(() => listReceipts(input.ep, issue), input.readRetry));
  const l = latestByGate(issue, listing.receipts).get(gate);
  if (l === undefined) return { why: "missing" };
  const judged = await statusOf(
    {
      input: { ep: input.ep, g: input.g, cwd: input.cwd, issue, reviews: input.reviews, issueReceipts: receiptsOfListing(listing.receipts) },
      digests: new Map(),
      fresh: new Map(),
      gitRepos: [],
    },
    l,
    null,
  );
  return { why: humanGrantGap(l, judged.status), bytes: judged.bytes };
}

export async function checkUnlock(input: UnlockInput): Promise<Decision> {
  const g = input.g;
  const top = await repoRoot(g, input.cwd);
  if (top === null) return unresolved(`${input.cwd} is not inside a git checkout`, "Run gate ci from a checkout of the changed repo.");
  const tip = await revParse(g, input.base, top);
  if (tip === null) return unresolved(`base ${input.base}: does not name a commit in this checkout`);
  const fork = await mergeBase(g, top, tip, "HEAD");
  if (fork === null) return unresolved(`base ${input.base}: shares no history with HEAD`);
  const checkout = await revParse(g, "HEAD", top);
  if (checkout === null) return unresolved("HEAD does not resolve", "Run gate ci from a checkout with a commit.");
  const head = await verifiedHeadSha(g, top, input.headSha, checkout, tip);
  const tracked = await changedPaths(g, top, fork);
  const untracked = await untrackedFiles(g, top);
  if (tracked === null || untracked === null) return unresolved("git could not list the changes", "Re-run; check 'git status' works in this checkout.");
  const changed = [...new Set([...tracked, ...untracked])].sort();

  // The bar is the merge-base's registry; the head's is read only to find surfaces it adds.
  const baseRegistry = await registryAt(g, top, fork, input.registry);
  const headRegistry = await registryAt(g, top, "HEAD", input.registry);
  const fromBase = baseRegistry === null ? [] : matchSurfaces(baseRegistry, changed);
  const fromHead = headRegistry === null ? [] : matchSurfaces(headRegistry, changed);
  const names = [...new Set([...fromBase, ...fromHead].map((s) => s.name))].sort();
  const governed = governancePaths(input.registry, [baseRegistry, headRegistry], changed);
  if (names.length === 0 && governed.length === 0) {
    input.out(`@unlock\tnot-needed\t${input.action}`);
    return "not-needed";
  }

  const reasons: string[] = [];
  const read = input.doctrine.read;
  const listing = unwrap(await retryRateLimited(() => listReceipts(input.ep, input.issue), input.readRetry));
  const latest = latestByGate(input.issue, listing.receipts);
  const digests: Checking["digests"] = new Map();
  const fresh: NonNullable<Checking["fresh"]> = new Map();
  const skills: NonNullable<Checking["skills"]> = {};
  // A review report counts only under a review skill the merge-base registry names, never one the PR registers.
  const reviewSkills = Object.keys(baseRegistry?.review_skills ?? {}).sort();
  const issueReceipts = receiptsOfListing(listing.receipts);
  const atHead: CheckInput["head"] = { headSha: head, headSource: "--head-sha", base: input.base };
  const judgeOn = (issue: string, at?: CheckInput["head"], requiredEffort?: GateReviewEffort): Checking => ({
    input: {
      ep: input.ep,
      g,
      cwd: input.cwd,
      issue,
      warn: input.warn,
      reviews: input.reviews,
      reviewSkills,
      ...(at !== undefined ? { head: at } : {}),
      ...(requiredEffort !== undefined ? { requiredEffort } : {}),
      ...(issue === input.issue ? { issueReceipts } : {}),
    },
    digests,
    fresh,
    skills,
    gitRepos: [],
  });

  const posture = activePosture(read);
  const raise = posture?.policy?.signoff?.raise;

  if (governed.length > 0) {
    // Read only for a governance diff: the head side is the working tree, so a standing tree/disk
    // difference (an unchanged symlinked vocabulary) would otherwise cross on every diff.
    const sides = await readMonotoneSides({ cwd: input.cwd, base: input.base, registry: input.registry, g });
    const rows = classifyMonotone(sides.base, sides.head, sides.changed).filter((d) => d.verdict !== "same");
    for (const p of governed) input.out(`@governance\t${p}`);
    for (const d of rows) input.out(`@monotone\t${rowLine(d)}`);
    const tighter = rows.filter((d) => d.verdict === "tighter");
    const wider: Dim[] = rows.filter((d) => d.verdict === "wider");
    const summary = [...(tighter.length > 0 ? [`tighter: ${named(tighter)}`] : []), ...(wider.length > 0 ? [`wider: ${named(wider)}`] : [])];
    reasons.push(`governance: ${governed.join(", ")} changed in this diff: a registry, vocabulary or review-skill edit is always human-signed${summary.length > 0 ? ` (${summary.join("; ")})` : ""}`);
    if (wider.length > 0) {
      const l = latest.get(SURFACE_WIDEN);
      const judged = l === undefined ? undefined : await statusOf(judgeOn(input.issue), l, null);
      const gap = humanGrantGap(l, judged?.status ?? "missing");
      const missed = gap === null && judged?.bytes !== undefined ? uncovered(wider, new TextDecoder().decode(judged.bytes)) : wider;
      if (missed.length > 0) reasons.push(`governance: ${missed.length} wider row(s) without a human surface-widen receipt covering them (${gap ?? "its artifact lacks them"}): ${named(missed)}`);
    }
  }

  const df = latest.get(DEFINE_FUTURE);
  const judgedDf = df === undefined || input.action !== "merge" || names.length === 0 ? undefined : await statusOf(judgeOn(input.issue), df, read);
  const history: { receipt: GateReceipt; bytes: Uint8Array | null }[] = [];
  if (input.action === "merge" && names.length > 0) {
    for (const r of gateReceiptsOf(input.issue, DEFINE_FUTURE, listing.receipts)) {
      history.push({ receipt: r, bytes: r.verdict === "SKIPPED" ? new Uint8Array() : await recordedBytes(input.ep, g, input.cwd, input.issue, r.artifact, input.readRetry) });
    }
  }
  const door =
    input.action !== "merge" || names.length === 0
      ? undefined
      : mergeDoor({
          defineFuture: df === undefined || judgedDf === undefined ? undefined : { receipt: df.receipt, status: judgedDf.status, bytes: judgedDf.bytes },
          defineFutures: history,
          classed: classedOf(input.issue, listing.receipts),
          policy: posture?.policy,
          posture: posture?.slug,
          crossings: names,
        });
  if (door !== undefined) input.out(`@door\t${door.door}\t${door.source}`);
  // A two-way merge crossing a tier-1 surface merges on its own gates, with no review bar;
  // it still honours each surface's lock and a posture that holds two-way doors for a human.
  const twoWay = door?.door === "two-way" && governed.length === 0;
  if (twoWay && posture?.policy?.signoff?.["two-way"] === "human") {
    reasons.push(`doctrine ${posture.slug} sets signoff.two-way: human, so a two-way merge is human-signed`);
  }
  // The review bar's own switch: a two-way merge carries no bar, so it does not need it.
  if (!twoWay && posture?.policy?.signoff?.unlock !== "on") {
    reasons.push(`doctrine ${posture?.slug ?? "(none)"} does not set signoff.unlock: on`);
  }
  let dispatch = false;

  for (const name of names) {
    const surface = fromBase.find((s) => s.name === name);
    const files = (surface ?? fromHead.find((s) => s.name === name))!.matched_files.length;
    input.out(`@surface\t${name}\t${files}`);
    if (surface === undefined) {
      // A surface the PR adds sets no bar yet; a two-way merge owes it nothing.
      if (!twoWay) reasons.push(`${name}: not on the base registry yet (a surface the PR adds unlocks after it merges)`);
      continue;
    }
    const ledgerReceipts = surface.ledger === undefined ? undefined : unwrap(await retryRateLimited(() => listReceipts(input.ep, surface.ledger!), input.readRetry)).receipts;
    const lock = surface.ledger === undefined || ledgerReceipts === undefined ? { locked: false } : lockState(surface.ledger, ledgerReceipts);
    input.out(`@lock\t${lock.locked ? "locked" : "open"}\t${name}`);
    if (lock.locked) {
      const l = lock as { actor?: string; at?: string; reason?: string };
      reasons.push(`${name}: locked${l.actor !== undefined ? ` by ${l.actor}` : ""}${l.at !== undefined ? ` on ${monDd(l.at, input.now)}` : ""}${l.reason !== undefined ? ` (${l.reason})` : ""}; 'eris surface unlock ${name}' lifts it`);
      continue;
    }
    if (twoWay) continue;
    const bar = unlockBar(surface, input.action, raise);
    if (bar.unlisted) reasons.push(`${name}: one_way_unlock.${input.action} is not listed, so ${input.action} stays human-signed`);
    for (const gate of bar.gates) {
      const [gateName, qualifier] = gate.split(":") as [string, string | undefined];
      const l = latest.get(gateName);
      const judged = await judgeBarGate(surface, gateName, qualifier, l, (requiredEffort) => statusOf(judgeOn(input.issue, atHead, requiredEffort), l, read));
      let status = judged.status;
      if (status === "pass" && l !== undefined) {
        const b = await boundToHead(g, top, l.receipt.artifact, head);
        if (!b.bound) {
          status = "stale-head";
          reasons.push(`${name}: ${gate}: ${b.why}`);
        }
      } else if (status !== "pass") {
        reasons.push(`${name}: ${gate}: ${status}${judged.why !== undefined ? ` (${judged.why})` : ""}`);
      }
      input.out(`${gate}\t${status}\t${l?.receipt.verdict ?? "-"}`);
      if (gateName === REVIEW_DISPATCH.gate && status !== "pass" && door?.door === "one-way") {
        // Only a review the code has moved past is dispatched: none yet, or one recorded at an older commit.
        // One at this head (BLOCKING, no report), or naming no commit, goes back to a builder, never to a
        // second review on the same code (no verdict shopping).
        const a = l?.receipt.artifact;
        const named = a?._tag === "git" && a.commit !== undefined;
        const moved = l === undefined || (named && !(await boundToHead(g, top, a, head)).bound);
        if (moved) dispatch = true;
        else if (l !== undefined && !named) reasons.push(`${name}: ${gate} names no commit, so it is not re-dispatched here: re-record it over the PR head (a git artifact)`);
        else reasons.push(`${name}: ${gate} was recorded at this head: fix its findings in a builder pass at a new head; it is not re-dispatched here`);
      }
    }

    if (surface.ledger === undefined || ledgerReceipts === undefined) {
      input.out(`@baseline\tno-ledger\t${name}`);
      input.out(`@budget\t-\t${name}`);
      reasons.push(`${name}: no ledger issue in the registry holds its audit-surfaces baseline`);
      continue;
    }
    const ledger = surface.ledger;
    const audit = latestByGate(ledger, ledgerReceipts).get(AUDIT_GATE);
    const ttl = surface.audit_ttl ?? DEFAULT_AUDIT_TTL;
    const judged = audit === undefined ? undefined : await statusOf(judgeOn(ledger), audit, read);
    const age = audit === undefined ? Infinity : input.now.getTime() - Date.parse(audit.at);
    const baseline = audit === undefined ? "missing" : judged?.status !== "pass" ? "failing" : age > ttlMs(ttl) ? "stale" : "fresh";
    input.out(`@baseline\t${baseline}\t${name}`);
    if (baseline !== "fresh") reasons.push(`${name}: audit-surfaces baseline on ${ledger} is ${baseline}${baseline === "stale" ? ` (older than audit_ttl ${ttl})` : ""}`);
    if (audit === undefined) {
      input.out(`@budget\t-\t${name}`);
      continue;
    }
    const budget = surface.change_budget ?? DEFAULT_CHANGE_BUDGET;
    const spent = countUnlocked(ledger, ledgerReceipts, audit.at);
    // This head's own announcement is this merge's spend: counted once, never as a second spend.
    let own = 0;
    for (const heads of announcedHeads(ledgerReceipts, ledger, input.action, input.issue, audit.at)) {
      for (const h of heads) {
        if ((await commitBoundToHead(g, top, h, head)).bound) {
          own++;
          break;
        }
      }
    }
    const due = spent - Math.min(own, 1);
    input.out(`@budget\t${spent}/${budget}\t${name}`);
    if (due >= budget) reasons.push(`${name}: change budget exhausted (${due} of ${budget} unlocked actions since the baseline on ${ledger})`);
    input.out(`@announce\t${own > 0 ? "present" : "missing"}\t${name}`);
    if (own === 0) reasons.push(`${name}: no ${UNLOCKED_GATES[input.action]} announcement for head ${head.slice(0, 12)} on ${ledger}: the merging actor announces at this head (it spends the budget and re-reads the lock)`);
  }

  if (twoWay && reasons.length === 0) {
    input.out(`@unlock\tnot-needed\t${input.action}`);
    return "not-needed";
  }
  if (!twoWay && reasons.length === 0) {
    input.out(`@unlock\tunlocked\t${input.action}`);
    return "unlocked";
  }

  const signoff = latest.get(DOOR_SIGNOFF);
  const signed = signoff === undefined ? undefined : await statusOf(judgeOn(input.issue), signoff, read);
  const grant = humanGrantGap(signoff, signed?.status ?? "missing");
  let held: { readonly status: string; readonly why?: string | undefined } = { status: grant ?? "pass", ...(grant === null ? {} : { why: signed?.why }) };
  if (grant === null && signoff !== undefined) {
    const b = await boundToHead(g, top, signoff.receipt.artifact, head);
    if (!b.bound) held = { status: "stale-head", why: b.why };
    else if (!carriesLine(signoff.receipt, `door: ${input.action}`)) held = { status: "wrong-action", why: `it does not sign ${input.action} (no 'door: ${input.action}' evidence line)` };
  }
  if (signoff !== undefined) input.out(`${DOOR_SIGNOFF}\t${held.status}\t${signoff.receipt.verdict}`);
  if (held.status === "pass" && signoff !== undefined) {
    input.out(`@unlock\thuman-signed\t${input.action}`);
    return "human-signed";
  }
  if (signoff !== undefined) reasons.push(`${DOOR_SIGNOFF}: ${held.status === "wrong-action" ? held.why : `${held.status}${held.why !== undefined ? ` (${held.why})` : ""}`}`);
  if (dispatch) input.out(`@dispatch\t${REVIEW_DISPATCH.gate}\t${reviewDispatch(input.issue, await mainClone(g, top))}`);
  input.out(`@unlock\thuman\t${input.action}`);
  return precondition(
    "gate-unlock-human",
    `${input.action} on ${input.issue} needs a human sign-off: ${reasons.join("; ")}`,
    `A human signs at the PR head: 'eris gate record door-signoff --issue <KEY> --verdict PASS --artifact <committed plan or note> --evidence "door: ${input.action}" --authorized "<name> asked: <request>"'.\n` +
      "Or close each reason: record the missing gate on the PR head (a @dispatch row is the command that launches it); re-run the surface audit and record audit-surfaces on the ledger;\n" +
      "set signoff.unlock: on in the org's hosted posture and re-run the job.",
  );
}
