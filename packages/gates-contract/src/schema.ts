/**
 * schema.ts — the `policy:` contract as a JSON Schema (draft 2020-12) document, generated from the
 * Schema at run time, with each knob's explanation merged in as `x-eris-explain` and the floor as
 * data under `x-eris-floor`: the user-impact requirements no posture can lower, and the gates no
 * posture can turn off. JSON Schema cannot state the floor itself; `eris doctrine check` enforces it.
 */

import * as Schema from "effect/Schema";
import { explainDocument } from "./explain";
import { DoctrinePolicy, FLOOR_GATES, GUARDED_CLASSES, USER_IMPACT_FLOOR } from "./policy";

export function policyJsonSchema(): Record<string, unknown> {
  const floor = Object.fromEntries(GUARDED_CLASSES.map((u) => [u, USER_IMPACT_FLOOR[u]]));
  return { ...explainDocument(DoctrinePolicy, Schema.toJsonSchemaDocument(DoctrinePolicy)), "x-eris-floor": { user_impact: floor, gates_never_off: FLOOR_GATES } };
}
