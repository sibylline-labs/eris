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
 *     a qualifier this build cannot judge never passes, and review-report evidence reads blocking;
 *   the surface's ledger issue holds a passing `audit-surfaces` receipt younger than `audit_ttl`, fewer
 *     than `change_budget` `unlocked-merge` receipts since it, and an announcement for this head;
 *   the surface is not locked;
 *   the diff touches no governance file: the registry, a registered vocabulary or a registered review
 *     skill (either side). Such a diff sets the bar itself, so it always reads human, and the monotone
 *     rows against the merge-base are printed and named in the reason; a wider row no human
 *     `surface-widen` receipt covers is its own reason.
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
  type DoctrineRead,
  GATE_REVIEW_EFFORTS,
  type GateArtifact,
  type GateReceipt,
  type GatesEndpoint,
  decodePayload,
  isGateReviewReportEvidence,
  type ListedReceipt,
  listReceipts,
  RAISE_ALL,
  type SurfacesFile,
} from "eris/gates-contract";
import { type Checking, humanGrantGap, type Judged, type Latest, statusOf } from "./check";
import { precondition } from "./failure";
import { changedPaths, type CommitBound, commitBoundToHead, type Git, mergeBase, ok, repoRoot, revParse, run, untrackedFiles } from "./git";
import { DOOR_SIGNOFF } from "./ladder";
import { announcedHeads, countUnlocked, lockState, monDd, UNLOCKED_GATES } from "./ledger";
import { classifyMonotone, type Dim, inSkillDir, named, readMonotoneSides, rowLine, type Signoff, uncovered } from "./monotone";
import { issuesText, type MatchedSurface, matchSurfaces, surfacesInvalid, validateSurfacesYaml, vocabularyPath } from "./registry";
import { type RetryOpts, retryRateLimited } from "./store";

/** Every bar holds posture-check: the diff itself passed the surface posture gate. */
export const ALWAYS_UNLOCK_GATES = ["posture-check"] as const;

/** The gate an audit-surfaces baseline is recorded under, on the surface's ledger issue. */
export const AUDIT_GATE = "audit-surfaces";

/** The qualifier that requires a strict `PASS`: an `AMENDED` pass is not clean. */
export const CLEAN_QUALIFIER = "clean";

/** The R0 gate whose human-granted artifact approves the wider monotone rows it carries verbatim. */
export const SURFACE_WIDEN = "surface-widen";

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

/**
 * One bar gate's status before head binding. `:<effort>` passes only on a receipt carrying a review
 * report at that effort, which this build reads as blocking, so it never passes here; `:clean` only on
 * a `PASS`; any other qualifier never passes.
 */
async function judgeBarGate(gate: string, qualifier: string | undefined, latest: Latest | undefined, judge: () => Promise<Judged>): Promise<{ readonly status: string; readonly why?: string | undefined }> {
  const effort = (GATE_REVIEW_EFFORTS as readonly string[]).includes(qualifier ?? "") ? qualifier : undefined;
  if (qualifier !== undefined && effort === undefined && qualifier !== CLEAN_QUALIFIER) {
    return { status: "unjudged", why: `the :${qualifier} qualifier is not one eris judges (${[...GATE_REVIEW_EFFORTS, CLEAN_QUALIFIER].join(", ")}), so it never unlocks` };
  }
  const judged = await judge();
  if (judged.status !== "pass" || latest === undefined) return judged;
  if (effort !== undefined && !latest.receipt.evidence.some(isGateReviewReportEvidence)) {
    return { status: "no-report", why: `the receipt carries no review-report@1; record ${gate} with a review report at effort ${effort} or above` };
  }
  if (qualifier === CLEAN_QUALIFIER && latest.receipt.verdict !== "PASS") return { status: "not-clean", why: `the latest receipt is ${latest.receipt.verdict}, not PASS; re-run it clean and record PASS` };
  return judged;
}

/** The issue's latest receipt for `gate` and, when it is a passing human-granted one, its artifact bytes. */
export async function humanSignoff(input: Pick<UnlockInput, "ep" | "g" | "cwd" | "readRetry">, issue: string, gate: string): Promise<Signoff> {
  const listing = await retryRateLimited(() => listReceipts(input.ep, issue), input.readRetry);
  const l = latestByGate(issue, listing.receipts).get(gate);
  if (l === undefined) return { why: "missing" };
  const judged = await statusOf({ input: { ep: input.ep, g: input.g, cwd: input.cwd, issue }, digests: new Map(), gitRepos: [] }, l, null);
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
  const listing = await retryRateLimited(() => listReceipts(input.ep, input.issue), input.readRetry);
  const latest = latestByGate(input.issue, listing.receipts);
  const digests: Checking["digests"] = new Map();
  const judgeOn = (issue: string): Checking => ({ input: { ep: input.ep, g, cwd: input.cwd, issue }, digests, gitRepos: [] });

  const posture = activePosture(read);
  if (posture?.policy?.signoff?.unlock !== "on") reasons.push(`doctrine ${posture?.slug ?? "(none)"} does not set signoff.unlock: on`);
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

  for (const name of names) {
    const surface = fromBase.find((s) => s.name === name);
    const files = (surface ?? fromHead.find((s) => s.name === name))!.matched_files.length;
    input.out(`@surface\t${name}\t${files}`);
    if (surface === undefined) {
      reasons.push(`${name}: not on the base registry yet (a surface the PR adds unlocks after it merges)`);
      continue;
    }
    const ledgerReceipts = surface.ledger === undefined ? undefined : (await retryRateLimited(() => listReceipts(input.ep, surface.ledger!), input.readRetry)).receipts;
    const lock = surface.ledger === undefined || ledgerReceipts === undefined ? { locked: false } : lockState(surface.ledger, ledgerReceipts);
    input.out(`@lock\t${lock.locked ? "locked" : "open"}\t${name}`);
    if (lock.locked) {
      const l = lock as { actor?: string; at?: string; reason?: string };
      reasons.push(`${name}: locked${l.actor !== undefined ? ` by ${l.actor}` : ""}${l.at !== undefined ? ` on ${monDd(l.at, input.now)}` : ""}${l.reason !== undefined ? ` (${l.reason})` : ""}`);
      continue;
    }
    const bar = unlockBar(surface, input.action, raise);
    if (bar.unlisted) reasons.push(`${name}: one_way_unlock.${input.action} is not listed, so ${input.action} stays human-signed`);
    for (const gate of bar.gates) {
      const [gateName, qualifier] = gate.split(":") as [string, string | undefined];
      const l = latest.get(gateName);
      const judged = await judgeBarGate(gateName, qualifier, l, () => statusOf(judgeOn(input.issue), l, read));
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

  if (reasons.length === 0) {
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
  input.out(`@unlock\thuman\t${input.action}`);
  return precondition(
    "gate-unlock-human",
    `${input.action} on ${input.issue} needs a human sign-off: ${reasons.join("; ")}`,
    `A human signs at the PR head: 'eris gate record door-signoff --issue <KEY> --verdict PASS --artifact <committed plan or note> --evidence "door: ${input.action}" --authorized "<name> asked: <request>"'.\n` +
      "Or close each reason: record the missing gate on the PR head; re-run the surface audit and record audit-surfaces on the ledger;\n" +
      "set signoff.unlock: on in the org's hosted posture and re-run the job.",
  );
}
