/**
 * ledger.ts — what the unlock decision reads and writes off a surface's ledger issue (`ledger:` in
 * the registry): whether the surface is locked, how much of its change budget is spent, which heads
 * an `unlocked-<action>` announcement names, and `announceUnlocked` for `--unlock <action> --announce`.
 *
 * A lock is a `surface-lock` receipt on the ledger, and the latest one decides. It reads fail-closed:
 * the lock reader never judges the receipt's artifact, only an `AMENDED` receipt carrying a human grant
 * lifts it, and a payload that names the gate and ledger but does not decode is a lock nothing lifts.
 *
 * Announcements are idempotent two ways: a passing receipt since the ledger's baseline already
 * carrying an `issue:`/`head:` line for this head (or a head bound to it) is skipped, and the comment
 * id is derived from `(ledger, action, head, baseline)` via a name-based v5 UUID so two concurrent
 * announces collapse at the store's replay rule instead of both spending the budget.
 */

import { createHash } from "node:crypto";
import {
  decodePayload,
  type GateActor,
  type GateReceipt,
  type GatesEndpoint,
  isGateReviewReportEvidence,
  isHumanGrant,
  type ListedReceipt,
  listReceipts,
  type RetryOpts,
  retryRateLimited,
  type UNLOCK_ACTIONS,
} from "eris/gates-contract";
import { unwrap } from "./failure";
import { commitBoundToHead, type Git } from "./git";
import type { ReceiptLink } from "./index";
import { recordGate } from "./record";

/** The gate a lock or its lift is recorded under, on the surface's ledger. */
export const SURFACE_LOCK_GATE = "surface-lock";

export type UnlockAction = (typeof UNLOCK_ACTIONS)[number];

/** The receipts an unlocked action records on the ledger; each one spends the change budget. */
export const UNLOCKED_GATES: Readonly<Record<UnlockAction, string>> = {
  merge: "unlocked-merge",
  deploy: "unlocked-deploy",
  effect: "unlocked-effect",
};

export interface LockState {
  readonly locked: boolean;
  /** The store's timestamp of the deciding receipt; absent when the surface was never locked. */
  readonly at?: string | undefined;
  readonly actor?: string | undefined;
  readonly reason?: string | undefined;
}

/** A `surface-lock` receipt on `ledger`, and whether it lifts the lock; undefined for any other record. */
function lockReceiptOf(ledger: string, c: ListedReceipt): { readonly lifted: boolean; readonly actor?: string; readonly reason?: string } | undefined {
  const parsed = decodePayload(c.version, c.payload);
  if (parsed.kind === "receipt") {
    const r = parsed.receipt;
    if (r.issue !== ledger || r.gate !== SURFACE_LOCK_GATE) return undefined;
    const said = r.evidence.find((e) => e.kind === "text" && "content" in e);
    const reason = said !== undefined && "content" in said ? said.content.replace(/^(locked|lifted) \S+: /, "") : undefined;
    return { lifted: r.verdict === "AMENDED" && isHumanGrant(r.authorized), actor: r.actor, ...(reason !== undefined ? { reason } : {}) };
  }
  const raw = c.payload as { readonly gate?: unknown; readonly issue?: unknown } | null;
  return typeof raw === "object" && raw !== null && raw.gate === SURFACE_LOCK_GATE && raw.issue === ledger ? { lifted: false } : undefined;
}

/** Whether `ledger`'s surface is locked: its latest `surface-lock` receipt by the store's time; none is open. */
export function lockState(ledger: string, receipts: ReadonlyArray<ListedReceipt>): LockState {
  let latest: { readonly at: string; readonly lifted: boolean; readonly actor?: string; readonly reason?: string } | undefined;
  for (const c of receipts) {
    const seen = lockReceiptOf(ledger, c);
    if (seen === undefined) continue;
    // A tie on the store's timestamp reads locked: fail closed on the one order the store does not fix.
    if (latest === undefined || c.createdAt > latest.at || (c.createdAt === latest.at && latest.lifted)) latest = { at: c.createdAt, ...seen };
  }
  if (latest === undefined) return { locked: false };
  return { locked: !latest.lifted, at: latest.at, actor: latest.actor, reason: latest.reason };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** `Nov-09` (this year) or `Nov-09-2025`, the form a human reads a date in. */
export function monDd(iso: string, now: Date): string {
  const d = new Date(iso);
  const day = `${MONTHS[d.getUTCMonth()]}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return d.getUTCFullYear() === now.getUTCFullYear() ? day : `${day}-${d.getUTCFullYear()}`;
}

/** `unlocked-<action>` receipts on the ledger created after the baseline: the budget spent. */
export function countUnlocked(ledger: string, receipts: ReadonlyArray<ListedReceipt>, since: string): number {
  const spending = new Set(Object.values(UNLOCKED_GATES));
  return receipts.filter((c) => {
    if (c.createdAt <= since) return false;
    const parsed = decodePayload(c.version, c.payload);
    return parsed.kind === "receipt" && parsed.receipt.issue === ledger && spending.has(parsed.receipt.gate);
  }).length;
}

/** A head an announcement names binds only as a full sha: a ref, short sha or `HEAD` would bind every later head. */
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * The distinct full-sha heads a passing `gate` receipt on `ledger` names for `issue` (its
 * `issue: <KEY> head: <sha>` lines). A receipt that also names another issue's head is no one's spend.
 */
function headsOf(c: ListedReceipt, gate: string, issue: string, ledger: string): string[] {
  const parsed = decodePayload(c.version, c.payload);
  if (parsed.kind !== "receipt" || parsed.receipt.gate !== gate || parsed.receipt.issue !== ledger || parsed.receipt.verdict !== "PASS") return [];
  const lines = parsed.receipt.evidence.flatMap((e) => ("content" in e ? e.content.split("\n").filter((l) => l.startsWith("issue: ")) : []));
  const prefix = `issue: ${issue} head: `;
  if (lines.some((l) => !l.startsWith(prefix))) return [];
  return [...new Set(lines.map((l) => l.slice(prefix.length)).filter((h) => FULL_SHA.test(h)))];
}

const carries = (c: ListedReceipt, gate: string, issue: string, ledger: string, head: string): boolean => headsOf(c, gate, issue, ledger).includes(head);

/** `issue`'s `unlocked-<action>` announcements on `ledger` created after `since`, one entry of heads per receipt. */
export function announcedHeads(receipts: ReadonlyArray<ListedReceipt>, ledger: string, action: UnlockAction, issue: string, since: string): string[][] {
  return receipts.flatMap((c) => {
    if (c.createdAt <= since) return [];
    const heads = headsOf(c, UNLOCKED_GATES[action], issue, ledger);
    return heads.length > 0 ? [heads] : [];
  });
}

/** A name-based (v5) UUID: the same `name` always yields the same comment id. */
export function commentIdFor(name: string): string {
  const ns = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
  const h = createHash("sha1").update(ns).update(name).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export interface AnnouncedSurface {
  readonly name: string;
  readonly ledger: string;
  readonly budget: number;
  /** The store's timestamp of the ledger's `audit-surfaces` baseline: the budget counts from it. */
  readonly baselineAt: string;
}

export interface AnnounceInput {
  readonly ep: GatesEndpoint;
  readonly action: UnlockAction;
  readonly issue: string;
  readonly head: string;
  readonly surfaces: ReadonlyArray<AnnouncedSurface>;
  /** Every bar gate that passed, with the latest receipt that passed it. */
  readonly bar: ReadonlyArray<{ readonly gate: string; readonly id: string | undefined; readonly receipt: GateReceipt | undefined }>;
  readonly posture: string;
  /** The PR's registry, the artifact every announcement binds. */
  readonly registryFile: string;
  readonly actor: string;
  readonly actorInfo?: GateActor | undefined;
  readonly cwd: string;
  /** The repo root, where an earlier announcement's head is checked for binding to `head`. */
  readonly top: string;
  readonly g: Git;
  readonly now: Date;
  readonly readRetry: RetryOpts;
  readonly writeRetry: RetryOpts;
  readonly receiptLink?: ReceiptLink | null | undefined;
  readonly out: (line: string) => void;
  readonly warn: (line: string) => void;
}

export type Announced = { readonly kind: "recorded" } | { readonly kind: "locked"; readonly names: ReadonlyArray<string> };

/** The effort and skill@sha of the first review-report on the bar's receipts, or `-`. */
function reportLine(bar: AnnounceInput["bar"]): string {
  for (const b of bar) {
    const e = b.receipt?.evidence.find(isGateReviewReportEvidence);
    if (e !== undefined) return `report: effort=${e.report.effort} skill=${e.report.reviewer.skill.name}@${e.report.reviewer.skill.harness_sha.slice(0, 12)}`;
  }
  return "report: -";
}

/** Whether some `gate` receipt in `existing` created after `since` announces `issue` at `head` or at a head bound to it. */
async function announcedAt(
  existing: ReadonlyArray<ListedReceipt>,
  gate: string,
  issue: string,
  ledger: string,
  head: string,
  g: Git,
  top: string,
  since: string | undefined,
): Promise<boolean> {
  for (const c of existing) {
    if (since !== undefined && c.createdAt <= since) continue;
    for (const h of headsOf(c, gate, issue, ledger)) {
      if (h === head || (await commitBoundToHead(g, top, h, head)).bound) return true;
    }
  }
  return false;
}

/**
 * Records the announcement of an unlocked action. A lock recorded since the decision was read turns
 * it back into a refusal before anything is written (`locked`). After each ledger record the budget
 * is recounted: an overshoot (two checks both read n < budget) is warned, not undone.
 */
export async function announceUnlocked(input: AnnounceInput): Promise<Announced> {
  const gate = UNLOCKED_GATES[input.action];
  const readIssue = async (issue: string) => unwrap(await retryRateLimited(() => listReceipts(input.ep, issue), input.readRetry)).receipts;

  const listings = new Map<string, ReadonlyArray<ListedReceipt>>();
  for (const s of input.surfaces) listings.set(s.ledger, await readIssue(s.ledger));
  const locked = input.surfaces.filter((s) => lockState(s.ledger, listings.get(s.ledger) ?? []).locked).map((s) => s.name);
  if (locked.length > 0) return { kind: "locked", names: locked };

  const lines = (surface: string): string[] => [
    `unlocked one-way: ${input.action}`,
    `surface: ${surface}`,
    `issue: ${input.issue} head: ${input.head}`,
    ...input.bar.map((b) => `bar: ${b.gate}=${b.id ?? "-"}`),
    reportLine(input.bar),
    `doctrine: ${input.posture}`,
  ];
  const writeRun = { ep: input.ep, g: input.g, cwd: input.cwd, now: input.now, retry: input.writeRetry };
  const record = async (issue: string, surface: string, existing: ReadonlyArray<ListedReceipt>, since?: string): Promise<"already" | "recorded"> => {
    if (await announcedAt(existing, gate, input.issue, issue, input.head, input.g, input.top, since)) return "already";
    try {
      await recordGate(writeRun, {
        gate,
        issue,
        verdict: "PASS",
        artifact: input.registryFile,
        evidence: [{ kind: "text", content: lines(surface).join("\n") }],
        actor: input.actor,
        ...(input.actorInfo !== undefined ? { actorInfo: input.actorInfo } : {}),
        ...(input.receiptLink !== undefined ? { receiptLink: input.receiptLink } : {}),
        commentId: commentIdFor(`${issue}|${input.action}|${input.head}${since !== undefined ? `|${since}` : ""}`),
        allowReservedGate: true,
      });
      return "recorded";
    } catch (err) {
      // A concurrent announce at this head took the comment id with another timestamp: the store refuses the second as a conflict.
      const now = await readIssue(issue);
      if (now.some((c) => (since === undefined || c.createdAt > since) && carries(c, gate, input.issue, issue, input.head))) return "already";
      throw err;
    }
  };

  for (const s of input.surfaces) {
    const state = await record(s.ledger, s.name, listings.get(s.ledger) ?? [], s.baselineAt);
    input.out(`@announce\t${state}\t${s.name}`);
    if (state === "recorded") {
      const after = await readIssue(s.ledger);
      const spent = countUnlocked(s.ledger, after, s.baselineAt);
      if (spent > s.budget) {
        input.warn(`WARN ${s.name}: change budget overshot (${spent} of ${s.budget} unlocked actions since the baseline on ${s.ledger}): concurrent checks both read it as spare`);
      }
    }
  }
  if (!input.surfaces.some((s) => s.ledger === input.issue)) {
    const existing = await readIssue(input.issue);
    input.out(`@announce\t${await record(input.issue, input.surfaces.map((s) => s.name).join(","), existing)}\t${input.issue}`);
  }
  return { kind: "recorded" };
}
