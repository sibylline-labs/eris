/**
 * floor.ts — the user-impact class `eris gate check` holds an issue to. The requirement lists are
 * `USER_IMPACT_FLOOR` in eris/gates-contract, raised by the active posture through `requirementsFor`;
 * nothing here restates them.
 *
 * The agent proposes the class on its receipts (`--impact`). Folded oldest first, a higher class
 * always raises; a lower one lowers only from U0/U1, or on a receipt that carries a grant
 * (`authorized`). The tracker's authorship cannot tell a human from an agent, so the grant is the only
 * signal.
 */

import { GUARDED_CLASSES, type GateReceipt, U_CLASSES, type UClass } from "eris/gates-contract";

const rank = (u: UClass): number => U_CLASSES.indexOf(u);
const guarded = (u: UClass): boolean => (GUARDED_CLASSES as readonly UClass[]).includes(u);

export interface IgnoredLowering {
  readonly gate: string;
  readonly from: UClass;
  readonly to: UClass;
}

/** The issue's effective class from its receipts, oldest first, and the lowerings refused for want of a grant. */
export function effectiveClass(receipts: ReadonlyArray<GateReceipt>): { cls: UClass | undefined; ignored: IgnoredLowering[] } {
  let cls: UClass | undefined;
  const ignored: IgnoredLowering[] = [];
  for (const r of receipts) {
    const next = r.user_impact;
    if (next === undefined) continue;
    if (cls === undefined || rank(next) >= rank(cls) || !guarded(cls) || r.authorized !== undefined) cls = next;
    else ignored.push({ gate: r.gate, from: cls, to: next });
  }
  return { cls, ignored };
}
