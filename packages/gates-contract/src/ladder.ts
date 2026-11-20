/**
 * ladder.ts — the pure door-class ladder contract: `DoorLadder` Schema, default rungs, and
 * `doorRung` evaluation (R0 human-before, R1 human-after, R2 auto). Zero filesystem I/O.
 */

import * as Schema from "effect/Schema";
import { type DoctrinePolicy, LadderClasses, type Rung, RUNGS, U_CLASS_CEILING, type UClass } from "./policy";

export const DoorLadder = Schema.Struct({ ladder: Schema.optionalKey(Schema.String), classes: LadderClasses });
export type DoorLadder = typeof DoorLadder.Type;

/** The rung of a door the ladder does not name and no U-class decides (`all`): human-after. */
export const DEFAULT_RUNG: Rung = "R1";

/**
 * The rung of a U-class the ladder does not name: U0/U1 two-way work is auto (R2), so it reads as
 * needing no human; U2/U3 stay human-after. `U_CLASS_CEILING` still caps each.
 */
export const DEFAULT_RUNGS: Readonly<Record<UClass, Rung>> = { U0: "R2", U1: "R2", U2: "R1", U3: "R1" };

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
    const stated = rungAt(classes, input.u, crossing) ?? DEFAULT_RUNGS[input.u];
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
