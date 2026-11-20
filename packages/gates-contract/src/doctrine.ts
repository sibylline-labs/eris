/**
 * doctrine.ts — the base doctrine `policy:` Schema (gates, close stages, sign-off by door, ceilings,
 * lifts, remediation, the user-impact floor) and the pure evaluators over it: a gate's mode, the
 * effective gate map per profile, each class's requirements, the lifts and the remediation loop
 * with defaults filled. `policy.ts` composes the full `DoctrinePolicy` on top of it.
 */

import * as Schema from "effect/Schema";
import * as Explains from "./explains";
import { GateSignoffPolicy } from "./signoff";

export * from "./signoff";

export {
  GATE_CLOSE_EXPLAINS,
  GATE_EXPLAINS,
  GATE_FLOOR_GATES,
  GATE_GUARDED_CLASSES,
  GATE_MAX_ROUNDS_CAP,
  GATE_REQUIREMENTS,
  GATE_U_CLASSES,
  GATE_USER_IMPACT_FLOOR,
  type GateUClass,
} from "./explains";

const { GATE_FLOOR_GATES, GATE_GUARDED_CLASSES, GATE_MAX_ROUNDS_CAP, GATE_REQUIREMENTS, GATE_U_CLASSES, GATE_USER_IMPACT_FLOOR } = Explains;
type GateUClass = Explains.GateUClass;

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const GATE_MODES = ["on", "lite", "once-at-end", "off"] as const;
export const GateMode = Schema.Literals(GATE_MODES).annotate(Explains.gateModeMeanings);
export type GateMode = typeof GateMode.Type;

export const GATE_CLOSE_MODES = ["on", "file-only", "off"] as const;
export const GateCloseMode = Schema.Literals(GATE_CLOSE_MODES).annotate(Explains.closeModeMeanings);
export type GateCloseMode = typeof GateCloseMode.Type;

/** Door-class ladder rungs: R0 human-pre, R1 human-post, R2 auto. */
export const GATE_RUNGS = ["R0", "R1", "R2"] as const;
export const GateRung = Schema.Literals(GATE_RUNGS).annotate(Explains.rungMeanings);
export type GateRung = typeof GateRung.Type;

export const GATE_ESCALATIONS = ["one-way-door", "cross-repo-seam", "U1", "U2", "U3"] as const;
export const GateEscalation = Schema.Literals(GATE_ESCALATIONS).annotate(Explains.escalationMeanings);
export type GateEscalation = typeof GateEscalation.Type;

export const GateRequirement = Schema.Literals(GATE_REQUIREMENTS).annotate(Explains.requirementMeanings);
export type GateRequirement = typeof GateRequirement.Type;

/** The highest rung each class may reach: U3 is capped at R1. */
export const GATE_U_CLASS_CEILING: Readonly<Record<GateUClass, GateRung>> = { U0: "R2", U1: "R2", U2: "R2", U3: "R1" };

/** A door class: `all`, or a U-class optionally narrowed to one crossing kind (`U2:cross-repo-seam`). */
export const GATE_DOOR_CLASS = /^(all|U[0-3])(:[a-z0-9]+(-[a-z0-9]+)*)?$/;

const keyedRecord = <V extends Schema.Top>(key: RegExp, value: V, expected: string, annotations: Schema.Annotations.Annotations) =>
  Schema.Record(Schema.String, value).annotate(annotations).check(Schema.makeFilter((r) => Object.keys(r).every((k) => key.test(k)), { expected }));

const guarded = (u: (typeof GATE_GUARDED_CLASSES)[number], annotations: Schema.Annotations.Annotations) =>
  Schema.Array(GateRequirement).annotate(annotations).check(
    Schema.makeFilter((list) => GATE_USER_IMPACT_FLOOR[u].every((req) => list.includes(req)), {
      expected: `a list holding ${GATE_USER_IMPACT_FLOOR[u].join(", ")} (the ${u} floor cannot be waived)`,
    }),
  );

const uClassOf = (door: string): GateUClass | undefined => GATE_U_CLASSES.find((u) => door === u || door.startsWith(`${u}:`));
const doorClassKeys = (r: Readonly<Record<string, GateRung>>): boolean => Object.keys(r).every((k) => GATE_DOOR_CLASS.test(k));
const underClassCeiling = (r: Readonly<Record<string, GateRung>>): boolean =>
  Object.entries(r).every(([door, rung]) => {
    const u = uClassOf(door);
    return u === undefined || GATE_RUNGS.indexOf(rung) <= GATE_RUNGS.indexOf(GATE_U_CLASS_CEILING[u]);
  });

const doorRungs = (annotations: Schema.Annotations.Annotations) =>
  Schema.Record(Schema.String, GateRung)
    .annotate(annotations)
    .check(Schema.makeFilter(doorClassKeys, { expected: "door classes: all, U0-U3, or U<n>:<crossing>" }))
    .check(Schema.makeFilter(underClassCeiling, { expected: "no U3 class above R1 (U3 is capped at R1)" }));

export const GATE_LIFT_CLASS = /^U[01](:[a-z0-9]+(-[a-z0-9]+)*)?$/;
export const GATE_LIFT_RUNGS = ["R1", "R2"] as const;
const LiftRung = Schema.Literals(GATE_LIFT_RUNGS).annotate(Explains.liftRungMeanings);
export const GateDoorLifts = keyedRecord(
  GATE_LIFT_CLASS,
  LiftRung,
  "lift classes U0, U1 or U<0|1>:<crossing>; never all, U2 or U3 (their sign-off is the floor)",
  Explains.liftsExplained,
);

const Gates = keyedRecord(KEBAB, GateMode, "kebab-case gate names", Explains.gatesExplained).check(
  Schema.makeFilter((g) => GATE_FLOOR_GATES.every((name) => g[name] !== "off"), {
    expected: `${GATE_FLOOR_GATES.join(" and ")} not off (they enforce the user-impact floor; use lite or once-at-end)`,
  }),
);

export const GATE_REMEDIATE_TRIGGERS = ["final-gates-fail", "unlock-gate-fail"] as const;
export const GateRemediateTrigger = Schema.Literals(GATE_REMEDIATE_TRIGGERS).annotate(Explains.remediateTriggerMeanings);
export type GateRemediateTrigger = typeof GateRemediateTrigger.Type;

export const GATE_REMEDIATE_SCOPES = ["findings-only"] as const;
export const GateRemediateScope = Schema.Literals(GATE_REMEDIATE_SCOPES).annotate(Explains.remediateScopeMeanings);
export type GateRemediateScope = typeof GateRemediateScope.Type;

const RUNTIME_SPEC = /^(claude|opencode(\/(follow|vertex|anthropic|go|hybrid))?)$/;
const runtimeSpecCheck = Schema.isPattern(RUNTIME_SPEC, { expected: "claude, opencode, or opencode/<follow|vertex|anthropic|go|hybrid>" });
const RemediateOn = Schema.Array(GateRemediateTrigger).annotate(Explains.remediateOnExplained).check(
  Schema.makeFilter((a) => a.length > 0, { expected: "at least one of final-gates-fail, unlock-gate-fail" }),
);
const MaxRounds = Schema.Number.annotate(Explains.maxRoundsExplained).check(
  Schema.makeFilter((n) => Number.isInteger(n) && n >= 1 && n <= GATE_MAX_ROUNDS_CAP, { expected: `an integer from 1 to ${GATE_MAX_ROUNDS_CAP}` }),
);
const RemediateLoop = Schema.String.annotate(Explains.remediateLoopExplained).check(Schema.isPattern(KEBAB));
const RuntimeDefault = Schema.String.annotate(Explains.runtimeDefaultExplained).check(runtimeSpecCheck);
const RuntimeEscalate = Schema.String.annotate(Explains.runtimeEscalateExplained).check(runtimeSpecCheck);
const RemediateRuntime = Schema.Struct({ default: Schema.optionalKey(RuntimeDefault), escalate: Schema.optionalKey(RuntimeEscalate) }).annotate(
  Explains.remediateRuntimeExplained,
);

export const GateRemediate = Schema.Struct({
  on: RemediateOn,
  loop: Schema.optionalKey(RemediateLoop),
  runtime: Schema.optionalKey(RemediateRuntime),
  max_rounds: Schema.optionalKey(MaxRounds),
  scope: Schema.optionalKey(GateRemediateScope.annotate(Explains.remediateScopeExplained)),
}).annotate(Explains.remediateExplained);
export type GateRemediate = typeof GateRemediate.Type;

export const GATE_REMEDIATE_DEFAULTS = {
  loop: "follow-up",
  runtime: { default: "opencode/vertex", escalate: "claude" },
  max_rounds: 2,
  scope: "findings-only",
} as const;

const ProfileDefault = Schema.String.annotate(Explains.profileDefaultExplained).check(Schema.isPattern(KEBAB));
const EscalateOn = Schema.Array(GateEscalation).annotate(Explains.escalateOnExplained);
const Close = keyedRecord(KEBAB, GateCloseMode, "kebab-case close stage names", Explains.closeExplained);
const Ceilings = doorRungs(Explains.ceilingsExplained);

/** The door-class ladder's `classes:` map: the same rungs and caps as `ceilings`, its own explanation. */
export const GateLadderClasses = doorRungs(Explains.ladderClassesExplained);

const U2Floor = guarded("U2", Explains.u2Explained);
const U3Floor = guarded("U3", Explains.u3Explained);
const UserImpact = Schema.Struct({
  U0: Schema.optionalKey(Schema.Array(GateRequirement).annotate(Explains.u0Explained)),
  U1: Schema.optionalKey(Schema.Array(GateRequirement).annotate(Explains.u1Explained)),
  U2: Schema.optionalKey(U2Floor),
  U3: Schema.optionalKey(U3Floor),
}).annotate(Explains.userImpactExplained);

export const GateDoctrinePolicy = Schema.Struct({
  profile_default: Schema.optionalKey(ProfileDefault),
  escalate_on: Schema.optionalKey(EscalateOn),
  gates: Schema.optionalKey(Gates),
  signoff: Schema.optionalKey(GateSignoffPolicy),
  close: Schema.optionalKey(Close),
  ceilings: Schema.optionalKey(Ceilings),
  lifts: Schema.optionalKey(GateDoorLifts),
  remediate: Schema.optionalKey(GateRemediate),
  user_impact: Schema.optionalKey(UserImpact),
}).annotate(Explains.policyDescribed);
export type GateDoctrinePolicy = typeof GateDoctrinePolicy.Type;

/** The gates a work profile must record, and the gates it must never record. */
export interface GateProfile {
  readonly require: readonly string[];
  readonly forbid: readonly string[];
}
/** Where `policy` sets `gate`'s mode (`gates.<gate>`, else `close.<gate>`) and the mode, or undefined. */
export function gateModeSource(policy: GateDoctrinePolicy | null | undefined, gate: string): { readonly key: string; readonly mode: GateMode } | undefined {
  const set = policy?.gates?.[gate];
  if (set !== undefined) return { key: `gates.${gate}`, mode: set };
  const close = policy?.close?.[gate];
  return close !== undefined ? { key: `close.${gate}`, mode: close === "off" ? "off" : "on" } : undefined;
}
export const modeSource = gateModeSource;

/** A gate's mode under `policy`: what it says, else `on`. */
export function gateMode(policy: GateDoctrinePolicy | null | undefined, gate: string): GateMode {
  return gateModeSource(policy, gate)?.mode ?? "on";
}

/** Each profile's required gates with their mode under `policy`, in profile order (`eris doctrine gates`). */
export function effectiveGateMap(profiles: Readonly<Record<string, GateProfile>>, policy: GateDoctrinePolicy | null | undefined) {
  return Object.entries(profiles).flatMap(([profile, p]) => p.require.map((gate) => ({ profile, gate, mode: gateMode(policy, gate) })));
}

/** What `cls` must prove: its floor ∪ the posture's `raise` (`policy.user_impact[cls]`), in `GATE_REQUIREMENTS` order. */
export function gateRequirementsFor(cls: GateUClass, raise?: ReadonlyArray<GateRequirement>): GateRequirement[] {
  return GATE_REQUIREMENTS.filter((req) => GATE_USER_IMPACT_FLOOR[cls].includes(req) || raise?.includes(req) === true);
}
export const requirementsFor = gateRequirementsFor;

/** Each class's effective requirements under `policy` (floor ∪ `user_impact`), for the classes that owe any. */
export function effectiveRequirements(policy: GateDoctrinePolicy | null | undefined): { cls: GateUClass; reqs: GateRequirement[] }[] {
  return GATE_U_CLASSES.map((cls) => ({ cls, reqs: gateRequirementsFor(cls, policy?.user_impact?.[cls]) })).filter((r) => r.reqs.length > 0);
}
export const effectiveGateRequirements = effectiveRequirements;

/** The posture's lifts, door class to rung, in authored order. */
export function effectiveLifts(policy: GateDoctrinePolicy | null | undefined): { door: string; rung: GateRung }[] {
  return Object.entries(policy?.lifts ?? {}).map(([door, rung]) => ({ door, rung }));
}
export const effectiveGateLifts = effectiveLifts;

/** A posture's remediation loop with its defaults filled in. */
export interface GateEffectiveRemediate {
  readonly on: readonly GateRemediateTrigger[];
  readonly loop: string;
  readonly runtime: { readonly default: string; readonly escalate: string };
  readonly max_rounds: number;
  readonly scope: string;
}

/** The posture's `remediate` block with defaults applied, or undefined when it has none. */
export function effectiveRemediate(policy: GateDoctrinePolicy | null | undefined): GateEffectiveRemediate | undefined {
  const r = policy?.remediate;
  if (r === undefined) return undefined;
  return {
    on: r.on,
    loop: r.loop ?? GATE_REMEDIATE_DEFAULTS.loop,
    runtime: { default: r.runtime?.default ?? GATE_REMEDIATE_DEFAULTS.runtime.default, escalate: r.runtime?.escalate ?? GATE_REMEDIATE_DEFAULTS.runtime.escalate },
    max_rounds: r.max_rounds ?? GATE_REMEDIATE_DEFAULTS.max_rounds,
    scope: r.scope ?? GATE_REMEDIATE_DEFAULTS.scope,
  };
}
export const effectiveGateRemediate = effectiveRemediate;

/** One `[key, value]` per effective remediation setting, in a fixed order (`@remediate` rows in `eris doctrine gates`). */
export function remediateRows(policy: GateDoctrinePolicy | null | undefined): [string, string][] {
  const r = effectiveRemediate(policy);
  if (r === undefined) return [];
  return [["on", r.on.join(",")], ["loop", r.loop], ["runtime", `${r.runtime.default}→${r.runtime.escalate}`], ["max_rounds", String(r.max_rounds)], ["scope", r.scope]];
}
export const gateRemediateRows = remediateRows;
