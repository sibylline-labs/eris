/**
 * surface-digest.ts — `eris surface digest`: the roll-up of unlocked one-way actions the TPM pulse
 * prints. One row per registry surface: the `unlocked-<action>` receipts on its ledger inside the
 * window, and whether it is locked.
 */

import { decodePayload, listReceipts, type GatesEndpoint, type SurfacesFile, UNLOCK_ACTIONS } from "eris/gates-contract";
import { lockState, monDd, UNLOCKED_GATES, type UnlockAction } from "./ledger";
import { type RetryOpts, retryRateLimited } from "./store";

export interface DigestRow {
  readonly name: string;
  readonly ledger: string | undefined;
  readonly counts: Readonly<Record<UnlockAction, number>>;
  readonly lock: "locked" | "open" | "-";
}

export interface Digest {
  readonly rows: ReadonlyArray<DigestRow>;
  /** The one line the pulse prints. */
  readonly line: string;
}

/** The registry's surfaces against their ledgers, for receipts created at or after `now - sinceMs`. */
export async function surfaceDigest(ep: GatesEndpoint, retry: RetryOpts, registry: SurfacesFile, sinceMs: number, now: Date): Promise<Digest> {
  const from = now.getTime() - sinceMs;
  const rows: DigestRow[] = [];
  for (const [name, spec] of Object.entries(registry.surfaces).sort(([a], [b]) => a.localeCompare(b))) {
    const counts: Record<UnlockAction, number> = { merge: 0, deploy: 0, effect: 0 };
    if (spec.ledger === undefined) {
      rows.push({ name, ledger: undefined, counts, lock: "-" });
      continue;
    }
    const { receipts } = await retryRateLimited(() => listReceipts(ep, spec.ledger!), retry);
    for (const c of receipts) {
      if (Date.parse(c.createdAt) < from) continue;
      const parsed = decodePayload(c.version, c.payload);
      if (parsed.kind !== "receipt" || parsed.receipt.issue !== spec.ledger) continue;
      const action = UNLOCK_ACTIONS.find((a) => UNLOCKED_GATES[a] === parsed.receipt.gate);
      if (action !== undefined) counts[action] += 1;
    }
    rows.push({ name, ledger: spec.ledger, counts, lock: lockState(spec.ledger, receipts).locked ? "locked" : "open" });
  }
  const total = rows.reduce((n, r) => n + r.counts.merge + r.counts.deploy + r.counts.effect, 0);
  const by = (a: UnlockAction) => rows.reduce((n, r) => n + r.counts[a], 0);
  const split = UNLOCK_ACTIONS.filter((a) => by(a) > 0).map((a) => `${a} ${by(a)}`);
  const where = rows.filter((r) => r.counts.merge + r.counts.deploy + r.counts.effect > 0).map((r) => r.name);
  const locked = rows.filter((r) => r.lock === "locked").map((r) => r.name);
  const line =
    `unlocked one-way since ${monDd(new Date(from).toISOString(), now)}: ${total === 0 ? "none" : `${total} (${split.join(", ")}) on ${where.join(", ")}`}` +
    `; locked: ${locked.length === 0 ? "none" : locked.join(", ")}`;
  return { rows, line };
}
