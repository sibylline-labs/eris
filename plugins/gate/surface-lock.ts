/**
 * surface-lock.ts — the per-surface kill switch behind `eris surface lock | unlock`: a lock is a
 * `surface-lock` receipt on the surface's ledger issue (`ledger:` in the registry), recorded through the
 * gates client like any gate receipt, and `lockState` (ledger.ts) reads the latest one fail-closed.
 *
 * Locking and lifting are both control writes, so both need a human `--authorized` grant: a `doctrine:`
 * grant, or none, is refused before anything is read or sent.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type GateActor, isBlankGrant, isHumanGrant, listReceipts, retryRateLimited } from "eris/gates-contract";
import { precondition, unwrap, usage } from "./failure";
import type { ReceiptLink } from "./index";
import { lockState, SURFACE_LOCK_GATE } from "./ledger";
import { recordGate, type WriteRun } from "./record";
import { issuesText, validateSurfacesYaml } from "./registry";

/** A surface of the registry at `registry` (relative to `cwd`) and the ledger that holds its lock, or a usage refusal. */
export function surfaceLedger(cwd: string, registry: string, name: string): { readonly file: string; readonly ledger: string } {
  const file = resolve(cwd, registry);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return usage(`--registry ${registry}: cannot read ${file}`, "Run from a checkout whose registry exists, or pass --registry <file>.");
  }
  const v = validateSurfacesYaml(text);
  if (!v.ok) return usage(`${registry}: ${issuesText(v.issues)}`, "Fix each violation the line names; the registry is strict about unknown keys.");
  const surface = v.value.surfaces[name];
  if (surface === undefined) return usage(`${name}: not a surface in ${registry}`, `The registry names: ${Object.keys(v.value.surfaces).sort().join(", ")}.`);
  if (surface.ledger === undefined) {
    return usage(`${name}: has no ledger in ${registry}, so no action on it ever unlocks`, "A surface without a ledger is already human-signed; there is nothing to lock.");
  }
  return { file, ledger: surface.ledger };
}

export interface SetLockInput {
  readonly name: string;
  readonly to: "locked" | "open";
  readonly reason: string;
  readonly authorized: string | undefined;
  readonly registry: string;
  readonly actor: string;
  readonly actorInfo?: GateActor | undefined;
  readonly receiptLink?: ReceiptLink | null | undefined;
}

export type SetLock =
  | { readonly kind: "noop"; readonly ledger: string }
  | {
      readonly kind: "recorded";
      readonly ledger: string;
      readonly commentId: string;
      readonly recordSha256?: string | undefined;
      readonly linkUrl?: string | undefined;
      readonly linkMismatch?: true | undefined;
    };

/** Locks or lifts one surface. A surface already in the target state records nothing (`noop`). */
export async function setLock(run: WriteRun, input: SetLockInput): Promise<SetLock> {
  const grant = input.authorized?.trim() ?? "";
  if (!isHumanGrant(grant)) {
    return precondition(
      "surface-lock-unauthorized",
      `surface ${input.to === "locked" ? "lock" : "unlock"} ${input.name}: ${isBlankGrant(grant) ? "no --authorized grant" : `--authorized ${grant} is not a human grant`}`,
      "A lock and its lift are human writes: --authorized 'Dan asked: <request>'. A doctrine: grant never signs.",
    );
  }
  const reason = input.reason.trim();
  if (reason === "") return usage("--reason is blank", "Say why, in words the next reader can check.");
  const { file, ledger } = surfaceLedger(run.cwd, input.registry, input.name);
  const listing = unwrap(await retryRateLimited(() => listReceipts(run.ep, ledger), run.retry));
  if (lockState(ledger, listing.receipts).locked === (input.to === "locked")) return { kind: "noop", ledger };
  const recorded = await recordGate(run, {
    gate: SURFACE_LOCK_GATE,
    issue: ledger,
    verdict: input.to === "locked" ? "PASS" : "AMENDED",
    artifact: file,
    authorized: grant,
    evidence: [{ kind: "text", content: `${input.to === "locked" ? "locked" : "lifted"} ${input.name}: ${reason}` }],
    actor: input.actor,
    actorInfo: input.actorInfo,
    ...(input.receiptLink !== undefined ? { receiptLink: input.receiptLink } : {}),
  });
  return {
    kind: "recorded",
    ledger,
    commentId: recorded.commentId,
    ...(recorded.recordSha256 !== undefined ? { recordSha256: recorded.recordSha256 } : {}),
    ...(recorded.linkUrl !== undefined ? { linkUrl: recorded.linkUrl } : {}),
    ...(recorded.linkMismatch !== undefined ? { linkMismatch: recorded.linkMismatch } : {}),
  };
}
