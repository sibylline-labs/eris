/**
 * ladder.ts — the door-class ladder: which rung a door class sits on, R0 human-before, R1
 * human-after, R2 auto.
 *
 * A door class is `all`, `U<n>`, or `U<n>:<crossing>`. A ladder file states a rung per class:
 *
 *   ladder: door-ladder@1      # optional label
 *   classes:
 *     all: R1
 *     U0: R2
 *     U2:auth: R0
 *
 * A class's rung is the most specific entry (`U<n>:<crossing>`, `U<n>`, `all`), else R1: a human
 * reviews the pull request after the run. With no ladder file every class reads R1. On a
 * bleed-reducing fix (the issue's latest `bleed-reducing` receipt passes) the active posture's
 * `lifts` raise it first; then its `ceilings` cap it and `U_CLASS_CEILING` caps it again, so a
 * ceiling only ever lowers a rung, a lift never outranks a ceiling, and no U3 class passes R1. With
 * several crossings the lowest rung decides.
 */

import { existsSync, readFileSync } from "node:fs";
import * as Schema from "effect/Schema";
import { decodeResult, type DoctrinePolicy, LadderClasses, type Rung, RUNGS, U_CLASS_CEILING, type UClass } from "eris/gates-contract";
import { parseDocument } from "yaml";
import { precondition } from "./failure";

export const DoorLadder = Schema.Struct({ ladder: Schema.optionalKey(Schema.String), classes: LadderClasses });
export type DoorLadder = typeof DoorLadder.Type;

/** The rung of a class the ladder does not name: human-after. */
export const DEFAULT_RUNG: Rung = "R1";

/** The gate a human pre-signs an R0 class with. */
export const DOOR_SIGNOFF = "door-signoff";

/** The gate whose passing receipt marks the issue a bleed-reducing fix, so the posture's `lifts` apply. */
export const BLEED_REDUCING = "bleed-reducing";

/** What each rung asks of a human. */
export const RUNG_MEANS: Readonly<Record<Rung, string>> = { R0: "human sign-off before close", R1: "human sign-off after (PR review)", R2: "auto" };

type RungMap = Readonly<Record<string, Rung>>;

const lower = (a: Rung, b: Rung): Rung => (RUNGS.indexOf(a) <= RUNGS.indexOf(b) ? a : b);
const higher = (a: Rung, b: Rung): Rung => (RUNGS.indexOf(a) >= RUNGS.indexOf(b) ? a : b);

/** The most specific entry of `map` for `u` crossing `crossing`: `U<n>:<crossing>`, then `U<n>`, then `all`. */
function rungAt(map: RungMap, u: UClass, crossing?: string): Rung | undefined {
  const narrow = crossing === undefined ? undefined : map[`${u}:${crossing}`];
  return narrow ?? map[u] ?? map.all;
}

export interface DoorRung {
  /** The rung in force. */
  readonly rung: Rung;
  /** The door class it decided for: `U<n>` or `U<n>:<crossing>`. */
  readonly door: string;
  /** The rung the ladder states (or the default) before any cap. */
  readonly stated: Rung;
  readonly cappedBy?: string;
  readonly liftedBy?: string;
}

/** The rung `u` sits on across `crossings` (none: the bare class). */
export function doorRung(input: {
  readonly ladder: DoorLadder | null;
  readonly policy: DoctrinePolicy | null | undefined;
  readonly posture: string | undefined;
  readonly u: UClass;
  readonly crossings: ReadonlyArray<string>;
  readonly bleedReducing: boolean;
}): DoorRung {
  const classes = input.ladder?.classes ?? {};
  const each = (input.crossings.length === 0 ? [undefined] : [...input.crossings].sort()).map((crossing): DoorRung => {
    const stated = rungAt(classes, input.u, crossing) ?? DEFAULT_RUNG;
    const lift = input.bleedReducing ? rungAt(input.policy?.lifts ?? {}, input.u, crossing) : undefined;
    const lifted = lift === undefined ? stated : higher(stated, lift);
    const ceiling = rungAt(input.policy?.ceilings ?? {}, input.u, crossing);
    const capped = ceiling === undefined ? lifted : lower(lifted, ceiling);
    const rung = lower(capped, U_CLASS_CEILING[input.u]);
    const posture = input.posture ?? "(active)";
    const cappedBy = capped !== lifted ? `doctrine ${posture} ceilings` : rung !== capped ? `the ${input.u} cap (${U_CLASS_CEILING[input.u]})` : undefined;
    const liftedBy = lifted !== stated ? `doctrine ${posture} lifts (${BLEED_REDUCING})` : undefined;
    return {
      rung,
      door: crossing === undefined ? input.u : `${input.u}:${crossing}`,
      stated,
      ...(cappedBy !== undefined ? { cappedBy } : {}),
      ...(liftedBy !== undefined ? { liftedBy } : {}),
    };
  });
  return each.reduce((a, b) => (RUNGS.indexOf(b.rung) < RUNGS.indexOf(a.rung) ? b : a));
}

function invalid(file: string, why: string): never {
  return precondition(
    "gate-ladder-invalid",
    `${file}: ${why}`,
    "Make the file a YAML map with 'classes:', door class (all, U0-U3, U<n>:<crossing>) to R0, R1 or R2,\n" +
      "no U3 class above R1; or move it aside to read every class at R1.",
  );
}

/** The ladder at `file`, or null when there is none (every class at R1). */
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
  return decoded._tag === "Success" ? decoded.success : invalid(file, decoded.failure.message);
}
