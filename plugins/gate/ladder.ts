/**
 * ladder.ts — the door-class ladder file reader (`readLadder`), built over the pure ladder contract
 * in `eris/gates-contract`.
 */

import { existsSync, readFileSync } from "node:fs";
import { BLEED_REDUCING, DEFAULT_RUNG, DEFAULT_RUNGS, DOOR_SIGNOFF, DoorLadder, type DoorRung, doorRung, RUNG_MEANS, decodeResult } from "eris/gates-contract";
import { parseDocument } from "yaml";
import { precondition } from "./failure";

export { BLEED_REDUCING, DEFAULT_RUNG, DEFAULT_RUNGS, DOOR_SIGNOFF, DoorLadder, type DoorRung, doorRung, RUNG_MEANS };

function invalid(file: string, why: string): never {
  return precondition(
    "gate-ladder-invalid",
    `${file}: ${why}`,
    "Make the file a YAML map with 'classes:', door class (all, U0-U3, U<n>:<crossing>) to R0, R1 or R2,\n" +
      "no U3 class above R1; or move it aside to read every class at its default rung.",
  );
}

/** The ladder at `file`, or null when there is none (every class at its default rung, `DEFAULT_RUNGS`). */
export function readLadder(file: string): DoorLadder | null {
  if (!existsSync(file)) return null;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return invalid(file, "cannot read the file");
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return invalid(file, `not YAML: ${doc.errors[0]!.message.split("\n")[0]}`);
  const decoded = decodeResult(DoorLadder, doc.toJS() as unknown);
  if (decoded._tag === "Success") return decoded.success;
  const first = decoded.failure.issues[0];
  return invalid(file, first === undefined ? decoded.failure.message : `${first.path.join(".") || "ladder"}: ${first.message}`);
}
