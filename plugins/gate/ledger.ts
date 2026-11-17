/**
 * ledger.ts — what the unlock leg reads off a surface's ledger issue (`ledger:` in the registry):
 * whether the surface is locked, how much of its change budget is spent, and which heads an
 * `unlocked-<action>` announcement names. Reads only: this build records no lock and no announcement.
 *
 * A lock is a `surface-lock` receipt on the ledger, and the latest one decides. It reads fail-closed:
 * the lock reader never judges the receipt's artifact, only an `AMENDED` receipt carrying a human grant
 * lifts it, and a payload that names the gate and ledger but does not decode is a lock nothing lifts.
 */

import { decodePayload, isHumanGrant, type ListedReceipt, type UNLOCK_ACTIONS } from "eris/gates-contract";

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

/** `issue`'s `unlocked-<action>` announcements on `ledger` created after `since`, one entry of heads per receipt. */
export function announcedHeads(receipts: ReadonlyArray<ListedReceipt>, ledger: string, action: UnlockAction, issue: string, since: string): string[][] {
  return receipts.flatMap((c) => {
    if (c.createdAt <= since) return [];
    const heads = headsOf(c, UNLOCKED_GATES[action], issue, ledger);
    return heads.length > 0 ? [heads] : [];
  });
}
