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
import {
  GATE_CLOSE_EXPLAINS,
  GATE_EXPLAINS,
  GATE_FLOOR_GATES,
  GATE_GUARDED_CLASSES,
  GATE_REQUIREMENTS,
  GATE_U_CLASSES,
  GATE_USER_IMPACT_FLOOR,
  type GateUClass,
  signoffExplained,
} from "./explains";
import { explained, meant } from "./explain";
import { GateSignoffPolicy, RAISE_ALL, UNLOCK_SWITCH, UnlockRaise, UnlockSwitch } from "./signoff";

export { GATE_EXPLAINS, GATE_MODES, GateMode, RAISE_ALL, UNLOCK_SWITCH, UnlockRaise, UnlockSwitch };

export const CloseMode = GateCloseMode;
export type CloseMode = GateCloseMode;

export const Signoff = GateSignoff;
export type Signoff = GateSignoff;

const waiveExplained = explained({
  summary: "Forbidden: a doctrine posture may only raise a surface's unlock bar, never waive a repo-declared gate.",
  protects: "a doctrine posture waiving a gate that a surface in .claude/surfaces.yml requires.",
  raise: "Leave waive unset: every repo-declared unlock gate holds.",
  lower: "Never allowed: eris doctrine check refuses any signoff.waive key.",
});
const ForbiddenWaive = Schema.Unknown.annotate(waiveExplained);

/**
 * Who signs each door, and whether registered surfaces may unlock one-way doors (`unlock`,
 * default off) under the bar the repo declares plus `raise`. `waive` is typed only to be refused:
 * the decoder strips unknown keys, so an untyped waiver would vanish silently instead of failing
 * `eris doctrine check`.
 */
export const SignoffPolicy = GateSignoffPolicy.mapFields((fields) => ({
  ...fields,
  waive: Schema.optionalKey(ForbiddenWaive),
}))
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
