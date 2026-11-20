/**
 * signoff.ts — the doctrine `policy.signoff` contract: who signs each door (`one-way`, `two-way`),
 * whether registered surfaces may unlock one-way doors without a human (`unlock`, default `off`),
 * and extra gates a posture adds to a surface's repo-declared `one_way_unlock` bar (`raise`;
 * doctrine only raises). Shared by `GateDoctrinePolicy` (`doctrine.ts`) and `SignoffPolicy`
 * (`policy.ts`, which adds the explicit `waive` refusal for `eris doctrine check`).
 */

import * as Schema from "effect/Schema";
import { described, explained, meant } from "./explain";
import * as Explains from "./explains";
import { SURFACE_NAME, UnlockGate } from "./surfaces";

export const GATE_SIGNOFFS = ["human", "self"] as const;
export const GateSignoff = Schema.Literals(GATE_SIGNOFFS).annotate(Explains.signoffMeanings);
export type GateSignoff = typeof GateSignoff.Type;

/** Whether a posture lets a registered surface unlock a one-way door without a human. */
export const UNLOCK_SWITCH = ["on", "off"] as const;
const unlockSwitchMeanings = meant({
  summary: "Whether registered surfaces may unlock one-way doors without a human.",
  values: {
    on: "A one-way action on a registered surface unlocks when every bar gate passes bound to the PR head and the audit baseline and budget hold.",
    off: "Every one-way door stays human-signed, whatever the surface's one_way_unlock lists.",
  },
  rank: ["on", "off"],
});
export const UnlockSwitch = Schema.Literals(UNLOCK_SWITCH).annotate(unlockSwitchMeanings);
export type UnlockSwitch = typeof UnlockSwitch.Type;

/** `signoff.raise` keys: a registered surface name, or `*` for every surface. */
export const RAISE_ALL = "*" as const;

const raiseFor = (action: string, what: string) =>
  explained({
    summary: `Extra gates the posture adds to a surface's one_way_unlock.${action} bar before an agent may ${what} without a human.`,
    protects: `an agent being able to ${what} under this posture with only the repo's baseline gates.`,
    raise: `The agent must pass more gates before it may ${what} alone.`,
    lower: `Fewer posture-added gates; the repo's own one_way_unlock.${action} bar still holds.`,
  });

/** Gates a posture adds to one action's repo-declared unlock bar: never empty, which would read as a waiver. */
const raisedGates = (action: string, what: string) =>
  Schema.Array(UnlockGate)
    .annotate(raiseFor(action, what))
    .check(Schema.isMinLength(1, { expected: "at least one gate: an empty raise list reads as a waiver, and doctrine only raises" }));

const RaisedMerge = raisedGates("merge", "merge a one-way change");
const RaisedDeploy = raisedGates("deploy", "deploy a one-way change");
const RaisedEffect = raisedGates("effect", "run a one-way side effect");
const unlockRaiseActionsDescribed = described("Per action (merge, deploy, effect), extra gates added to the surface's repo-declared unlock bar.");
export const UnlockRaiseActions = Schema.Struct({
  merge: Schema.optionalKey(RaisedMerge),
  deploy: Schema.optionalKey(RaisedDeploy),
  effect: Schema.optionalKey(RaisedEffect),
}).annotate(unlockRaiseActionsDescribed);
export type UnlockRaiseActions = typeof UnlockRaiseActions.Type;

const unlockRaiseExplained = explained({
  summary: "Extra unlock gates a posture adds to a surface's repo-declared one_way_unlock bar, by surface name or * for every surface; doctrine only raises.",
  protects: "a surface's repo-declared unlock bar being too light for the active posture.",
  raise: "Adding surfaces or gates requires more passing receipts before a one-way action unlocks.",
  lower: "Dropping raised gates falls back toward the repo's own one_way_unlock bar; an unlisted action stays human-signed.",
});

/**
 * `signoff.raise`: surface (or `*`) → action → gates added to the repo's `one_way_unlock.<action>`
 * (doctrine may only raise the bar). A raise never creates an unlock for an action the repo does
 * not list.
 */
export const UnlockRaise = Schema.Record(Schema.String, UnlockRaiseActions)
  .annotate(unlockRaiseExplained)
  .check(
    Schema.makeFilter((r) => Object.keys(r).every((k) => k === RAISE_ALL || SURFACE_NAME.test(k)), {
      expected: "raise keys: a kebab-case surface name, or * for every surface",
    }),
  );
export type UnlockRaise = typeof UnlockRaise.Type;

const unlockExplained = explained({
  summary: "Whether registered surfaces may unlock one-way doors without a human when their unlock bar, audit baseline and change budget hold (default off).",
  protects: "an agent passing a one-way door on a sensitive surface when the operator wants every one-way door human-signed.",
  raise: "Switching unlock off keeps every one-way door with a human, whatever .claude/surfaces.yml lists.",
  lower: "Switching unlock on lets registered surfaces unlock one-way actions once their bar gates, audit baseline and budget hold.",
  unset: "strictest",
});

const OneWaySignoff = GateSignoff.annotate(Explains.oneWayExplained);
const TwoWaySignoff = GateSignoff.annotate(Explains.twoWayExplained);
const UnlockSwitchField = UnlockSwitch.annotate(unlockExplained);

/** The hosted bundle's `policy.signoff` block: `one-way`, `two-way`, `unlock`, and `raise` (omits `waive` so strict bundle decode refuses it). */
export const GateSignoffPolicy = Schema.Struct({
  "one-way": Schema.optionalKey(OneWaySignoff),
  "two-way": Schema.optionalKey(TwoWaySignoff),
  unlock: Schema.optionalKey(UnlockSwitchField),
  raise: Schema.optionalKey(UnlockRaise),
}).annotate(Explains.signoffExplained);
export type GateSignoffPolicy = typeof GateSignoffPolicy.Type;
