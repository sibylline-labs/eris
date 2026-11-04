/**
 * Scoring under a rubric policy, and the stricter-only repo layer over it.
 *
 * The rubric definition is ours and versioned; an org policy turns each question on or off, weights
 * each soft question and sets the threshold; a repo's `eris.yaml` layer can only make that policy
 * stricter. eris scores a candidate locally with these functions and the server scores the stamp a
 * submit carries with the same ones, so both answer the same verdict for the same inputs.
 *
 * Invariants:
 *   - Under `defaultPolicy(rubric)`, `scoreUnderPolicy` is `score`.
 *   - `mergeRepoPolicy` never loosens: a merged policy runs every gate the org policy runs, with a
 *     threshold at least the org's and auto-resolve off when either layer has it off. A layer that
 *     would loosen is refused, never clamped.
 */

import type { GateId, RubricDefinition, SoftQuestion, Verdict } from "./definition";
import { score } from "./definition";

/** One question's setting: whether it runs, and a soft question's weight (a gate's is 0). */
export interface PolicyGate {
  readonly enabled: boolean;
  readonly weight: number;
}

/** What scoring and the merge read of an org policy; the rest of the policy passes through. */
export interface ScoringPolicy {
  readonly gates: Readonly<Record<string, PolicyGate>>;
  readonly threshold: number;
  readonly auto_resolve: boolean;
}

/** A repo's stricter-only layer: turn a hard gate on, raise the threshold, pin auto-resolve off. */
export interface RepoPolicy {
  readonly gates?: Readonly<Record<string, { readonly enabled: true }>>;
  readonly threshold?: number;
  readonly auto_resolve?: false;
}

/**
 * The effective policy with no org policy stored. Every question is on; a gate's weight is 0 (it
 * routes, it never scores) and a soft question's is its highest answer's points. Verbosity is
 * load-bearing entries; escalation allows evidence, which is on by default; auto-resolve is off until
 * an org opts in; resolve reports nothing until an org picks a mode.
 */
export function defaultPolicy(rubric: RubricDefinition): {
  readonly gates: Readonly<Record<string, PolicyGate>>;
  readonly threshold: number;
  readonly verbosity: "load_bearing";
  readonly escalation: "evidence";
  readonly auto_resolve: false;
  readonly reporting: "none";
} {
  const gates: Record<string, PolicyGate> = {};
  for (const [id, q] of Object.entries(rubric.questions)) {
    gates[id] = { enabled: true, weight: q.kind === "gate" ? 0 : Math.max(...Object.values<number>(q.points)) };
  }
  return { gates, threshold: rubric.threshold, verbosity: "load_bearing", escalation: "evidence", auto_resolve: false, reporting: "none" };
}

/** The gates `policy` turns off. */
export function disabledGates(rubric: RubricDefinition, policy: ScoringPolicy): string[] {
  return Object.entries(rubric.questions)
    .filter(([id, q]) => q.kind === "gate" && policy.gates[id]?.enabled === false)
    .map(([id]) => id);
}

/**
 * `score` under a policy: a disabled gate does not run; a soft question counts
 * `points × weight / max points` (0 when disabled), so its default weight, its max points, counts it
 * as the rubric does; features keep their points; the policy's threshold decides.
 */
export function scoreUnderPolicy(
  rubric: RubricDefinition,
  policy: ScoringPolicy,
  answers: Readonly<Record<string, string>>,
  features: Readonly<Record<string, boolean>>,
  bypass: readonly string[],
): Verdict<RubricDefinition> {
  const verdict = score(rubric, answers as never, features as never, {
    bypass: [...bypass, ...disabledGates(rubric, policy)] as GateId<RubricDefinition>[],
  });
  if (verdict.kind !== "load-bearing" && verdict.kind !== "not-load-bearing") return verdict;
  const breakdown: Record<string, number> = {};
  let total = 0;
  for (const [id, q] of Object.entries(rubric.questions)) {
    if (q.kind !== "soft") continue;
    const points = (q as SoftQuestion).points as Readonly<Record<string, number>>;
    const p = points[answers[id]!]!;
    const gate = policy.gates[id];
    const max = Math.max(...Object.values(points));
    const counted = gate === undefined || !gate.enabled ? 0 : gate.weight === max || max === 0 ? p : (p * gate.weight) / max;
    if (counted !== 0) breakdown[id] = counted;
    total += counted;
  }
  for (const [id, f] of Object.entries(rubric.features)) {
    if (!features[id] || f.points === 0) continue;
    breakdown[id] = f.points;
    total += f.points;
  }
  const kind = total >= policy.threshold ? "load-bearing" : "not-load-bearing";
  return { kind, rubric: verdict.rubric, score: total, threshold: policy.threshold, breakdown };
}

/** The merged policy, or why the repo layer cannot be merged into `org`. */
export type MergedPolicy<P extends ScoringPolicy> = { readonly ok: true; readonly policy: P } | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Merge a repo's stricter-only layer into the org policy for `rubric`. A named question must be a
 * gate of the rubric (a soft question's setting cannot be made stricter, only different), and a
 * threshold must be at least the org's: anything else is refused with one problem per key.
 */
export function mergeRepoPolicy<P extends ScoringPolicy>(rubric: RubricDefinition, org: P, repo: RepoPolicy): MergedPolicy<P> {
  const problems: string[] = [];
  const gates: Record<string, PolicyGate> = { ...org.gates };
  for (const id of Object.keys(repo.gates ?? {})) {
    const q = Object.hasOwn(rubric.questions, id) ? rubric.questions[id] : undefined;
    if (q === undefined) problems.push(`${id} is not a question of ${rubric.version}`);
    else if (q.kind !== "gate") problems.push(`${id} is a soft question of ${rubric.version}; a repo can only turn a gate on`);
    else gates[id] = { enabled: true, weight: 0 };
  }
  // Written as "not at least" so a NaN threshold is refused too.
  if (repo.threshold !== undefined && !(repo.threshold >= org.threshold)) {
    problems.push(`threshold ${repo.threshold} is below the org's ${org.threshold}`);
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    policy: {
      ...org,
      gates,
      threshold: Math.max(org.threshold, repo.threshold ?? org.threshold),
      auto_resolve: repo.auto_resolve === false ? false : org.auto_resolve,
    },
  };
}
