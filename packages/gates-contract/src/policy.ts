/**
 * policy.ts — the doctrine `policy:` contract: the structured block a `## <slug>` posture in a
 * doctrine.md carries, read by `eris doctrine check` and `gates`, and exported as JSON Schema by
 * `eris doctrine schema`. `DoctrinePolicy` composes `SignoffPolicy` (who signs each door, and
 * whether registered surfaces may unlock one-way doors) and `AskPolicy` (ask volume controls)
 * onto the base `GateDoctrinePolicy` (doctrine.ts), under the names the verbs use.
 */

import * as Schema from "effect/Schema";
import {
  GATE_DOOR_CLASS,
  GATE_MODES,
  GATE_RUNGS,
  GATE_U_CLASS_CEILING,
  GateCloseMode,
  GateDoctrinePolicy,
  GateEscalation,
  GateLadderClasses,
  GateMode,
  GateRemediate,
  GateRemediateScope,
  GateRemediateTrigger,
  GateRequirement,
  GateRung,
  GateSignoff,
} from "./doctrine";
import { GATE_CLOSE_EXPLAINS, GATE_EXPLAINS, GATE_FLOOR_GATES, GATE_GUARDED_CLASSES, GATE_REQUIREMENTS, GATE_U_CLASSES, GATE_USER_IMPACT_FLOOR, type GateUClass } from "./explains";
import { SURFACE_NAME, UnlockGate } from "./surfaces";
import { described, explained, meant } from "./explain";

export { GATE_EXPLAINS, GATE_MODES, GateMode };

export const CloseMode = GateCloseMode;
export type CloseMode = GateCloseMode;

export const Signoff = GateSignoff;
export type Signoff = GateSignoff;

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

/** `signoff.raise` keys: a registered surface name, or `*` for every surface. */
export const RAISE_ALL = "*";

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
const UnlockRaiseActions = Schema.Struct({
  merge: Schema.optionalKey(RaisedMerge),
  deploy: Schema.optionalKey(RaisedDeploy),
  effect: Schema.optionalKey(RaisedEffect),
}).annotate(unlockRaiseActionsDescribed);
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

const oneWayExplained = explained({
  summary: "Who approves a one-way door: a change that is hard to undo.",
  protects: "an irreversible change shipping without a human looking at it.",
  raise: "A human approves each one before it closes.",
  lower: "The agent closes it on its own receipts.",
});
const twoWayExplained = explained({
  summary: "Who approves a two-way door: a change that is easy to undo.",
  protects: "a quick mistake reaching users unnoticed.",
  raise: "A human approves every reversible change too, which slows every close.",
  lower: "The agent closes reversible changes itself: the fast path.",
});
const unlockExplained = explained({
  summary: "Whether registered surfaces may unlock one-way doors without a human when their unlock bar, audit baseline and change budget hold (default off).",
  protects: "an agent passing a one-way door on a sensitive surface when the operator wants every one-way door human-signed.",
  raise: "Switching unlock off keeps every one-way door with a human, whatever .claude/surfaces.yml lists.",
  lower: "Switching unlock on lets registered surfaces unlock one-way actions once their bar gates, audit baseline and budget hold.",
  unset: "strictest",
});
const waiveExplained = explained({
  summary: "Forbidden: a doctrine posture may only raise a surface's unlock bar, never waive a repo-declared gate.",
  protects: "a doctrine posture waiving a gate that a surface in .claude/surfaces.yml requires.",
  raise: "Leave waive unset: every repo-declared unlock gate holds.",
  lower: "Never allowed: eris doctrine check refuses any signoff.waive key.",
});
const signoffExplained = explained({
  summary: "Who must approve a change before it closes, by door kind, and whether registered surfaces may unlock one-way doors.",
  protects: "changes closing with less human oversight than the operator intends.",
  raise: "More changes wait for a human, or require more gates before a surface unlocks.",
  lower: "More changes close on the agent's own receipts.",
});
const OneWaySignoff = Signoff.annotate(oneWayExplained);
const TwoWaySignoff = Signoff.annotate(twoWayExplained);
const UnlockSwitchField = UnlockSwitch.annotate(unlockExplained);
const ForbiddenWaive = Schema.Unknown.annotate(waiveExplained);

/**
 * Who signs each door, and whether registered surfaces may unlock one-way doors (`unlock`,
 * default off) under the bar the repo declares plus `raise`. `waive` is typed only to be refused:
 * the decoder strips unknown keys, so an untyped waiver would vanish silently instead of failing
 * `eris doctrine check`.
 */
export const SignoffPolicy = Schema.Struct({
  "one-way": Schema.optionalKey(OneWaySignoff),
  "two-way": Schema.optionalKey(TwoWaySignoff),
  unlock: Schema.optionalKey(UnlockSwitchField),
  raise: Schema.optionalKey(UnlockRaise),
  waive: Schema.optionalKey(ForbiddenWaive),
})
  .annotate(signoffExplained)
  .check(
    Schema.makeFilter((s) => !("waive" in s), {
      expected: "no signoff.waive: doctrine only raises a surface's unlock bar, never waives a repo-declared gate",
    }),
  );
export type SignoffPolicy = typeof SignoffPolicy.Type;

export const RUNGS = GATE_RUNGS;
export const Rung = GateRung;
export type Rung = GateRung;

export const Escalation = GateEscalation;
export type Escalation = GateEscalation;

export const U_CLASSES = GATE_U_CLASSES;
export type UClass = GateUClass;

export const REQUIREMENTS = GATE_REQUIREMENTS;
export const Requirement = GateRequirement;
export type Requirement = GateRequirement;

export const USER_IMPACT_FLOOR = GATE_USER_IMPACT_FLOOR;
export const GUARDED_CLASSES = GATE_GUARDED_CLASSES;
export const FLOOR_GATES = GATE_FLOOR_GATES;
export const U_CLASS_CEILING = GATE_U_CLASS_CEILING;
export const DOOR_CLASS = GATE_DOOR_CLASS;
export const CLOSE_EXPLAINS = GATE_CLOSE_EXPLAINS;

export const RemediateTrigger = GateRemediateTrigger;
export type RemediateTrigger = GateRemediateTrigger;

export const RemediateScope = GateRemediateScope;
export type RemediateScope = GateRemediateScope;

export const Remediate = GateRemediate;
export type Remediate = GateRemediate;

export const LadderClasses = GateLadderClasses;

/**
 * Ask volume controls: how long a two-way ask waits before the doctrine answers it with its
 * recommendation, how a non-blocking ask is rolled up, and how many asks one session may hold
 * open. An absent block means no timeout and the default budget, never a default-on timeout.
 */
export const ASK_TIMEOUT_FLOOR_HOURS = 4;
export const ASK_TIMEOUT_MAX_HOURS = 720;
export const SESSION_BUDGET_DEFAULT = 5;
export const SESSION_BUDGET_MAX = 20;

export const ASK_DIGESTS = ["off", "hourly", "daily"] as const;
const askDigestMeanings = meant({
  summary: "How non-blocking asks are rolled up for the operator.",
  values: {
    off: "Each non-blocking ask is shown on its own.",
    hourly: "Non-blocking asks are rolled into one hourly digest.",
    daily: "Non-blocking asks are rolled into one daily digest.",
  },
});
export const AskDigest = Schema.Literals(ASK_DIGESTS).annotate(askDigestMeanings);
export type AskDigest = typeof AskDigest.Type;

const HOURS = /^[1-9][0-9]*h$/;

/** `"none"` is null, `"<n>h"` with n within the bounds is n, anything else is undefined. */
export function twoWayTimeoutHours(value: string): number | null | undefined {
  if (value === "none") return null;
  if (!HOURS.test(value)) return undefined;
  const hours = Number(value.slice(0, -1));
  return hours >= ASK_TIMEOUT_FLOOR_HOURS && hours <= ASK_TIMEOUT_MAX_HOURS ? hours : undefined;
}

const twoWayTimeoutExplained = explained({
  summary: `How long a two-way ask with a recommendation waits before it is answered with that recommendation: none (default), or <n>h from ${ASK_TIMEOUT_FLOOR_HOURS} to ${ASK_TIMEOUT_MAX_HOURS}. A one-way ask never times out.`,
  protects: "a decision that is not irreversible stalling a build while nobody answers.",
  raise: "No timeout, or a longer one: a two-way ask waits for a human longer.",
  lower: "A shorter timeout: the recommendation is taken sooner, with less human review.",
});
const TwoWayTimeout = Schema.String.annotate(twoWayTimeoutExplained).check(
  Schema.makeFilter((v) => twoWayTimeoutHours(v) !== undefined, {
    expected: `none, or <n>h with n from ${ASK_TIMEOUT_FLOOR_HOURS} to ${ASK_TIMEOUT_MAX_HOURS} (a two-way ask is never answered by timeout sooner than ${ASK_TIMEOUT_FLOOR_HOURS}h)`,
  }),
);

const askDigestExplained = explained({
  summary: "How non-blocking asks are rolled up for the operator: off (default), hourly, daily.",
  protects: "a stream of non-blocking asks burying the ones that block.",
  raise: "Rolling asks up into a digest: fewer interruptions, answers come later.",
  lower: "No digest: every non-blocking ask is shown as it arrives.",
});
const sessionBudgetExplained = explained({
  summary: `Open asks one session may hold before a new ask is refused (default ${SESSION_BUDGET_DEFAULT}, at most ${SESSION_BUDGET_MAX}).`,
  protects: "one session flooding the operator with open questions.",
  raise: "A smaller budget: a session must wait for answers before it asks more.",
  lower: "A larger budget: a session may hold more questions open at once.",
  stricter: "less",
});
const SessionBudget = Schema.Number.annotate(sessionBudgetExplained).check(
  Schema.makeFilter((n) => Number.isInteger(n) && n >= 1 && n <= SESSION_BUDGET_MAX, { expected: `an integer from 1 to ${SESSION_BUDGET_MAX}` }),
);

const askPolicyExplained = explained({
  summary: "Ask volume controls: the two-way timeout, the digest cadence and the per-session budget.",
  protects: "asks stalling a build, or flooding the operator.",
  raise: "Tighter limits: fewer open asks and slower timeouts, more waiting for a human.",
  lower: "Looser limits: more asks open at once, recommendations taken sooner.",
});
export const AskPolicy = Schema.Struct({
  two_way_timeout: Schema.optionalKey(TwoWayTimeout),
  digest: Schema.optionalKey(AskDigest.annotate(askDigestExplained)),
  session_budget: Schema.optionalKey(SessionBudget),
}).annotate(askPolicyExplained);
export type AskPolicy = typeof AskPolicy.Type;

function withAskPolicy(base: typeof GateDoctrinePolicy) {
  return base
    .mapFields(({ user_impact, ...rest }) => ({
      ...rest,
      signoff: Schema.optionalKey(SignoffPolicy),
      ask: Schema.optionalKey(AskPolicy),
      user_impact,
    }))
    .annotate(base.ast.annotations ?? {});
}

export const DoctrinePolicy = withAskPolicy(GateDoctrinePolicy);
export type DoctrinePolicy = typeof DoctrinePolicy.Type;
