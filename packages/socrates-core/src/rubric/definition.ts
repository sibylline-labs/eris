/**
 * The shape every rubric version takes, the answers and features it is scored
 * from, and the pure scorer.
 *
 * A candidate is classified from enum answers plus features eris checks
 * mechanically against its statement. No question can declare a numeric answer
 * (`AnswerList` is strings only), so a model is never asked to rate its own
 * confidence or impact. The points and threshold are the definition's own,
 * fixed per enum value, and a version is never edited once published: a change
 * is a new `rubric@vN`.
 */

import { z } from "zod";
import type { MatchCandidate } from "../match";

export type RubricVersion = `rubric@v${number}`;

/** A question's enum answers. Strings only: a numeric answer cannot be declared. */
export type AnswerList = readonly [string, ...string[]];

/** Where a firing gate sends the candidate instead of scoring it. */
export type GateRoute = "reject" | "key-assumption" | "practice";

/**
 * A gate: any answer outside `passes` stops scoring and routes the candidate, and so does any
 * `firedBy` feature that holds, whatever the answer was.
 */
export interface GateQuestion<A extends AnswerList = AnswerList, F extends string = string> {
  readonly kind: "gate";
  readonly prompt: string;
  readonly answers: A;
  readonly passes: readonly A[number][];
  readonly route: GateRoute;
  readonly firedBy?: readonly F[];
}

/** A soft question: each answer adds its fixed points to the score. */
export interface SoftQuestion<A extends AnswerList = AnswerList> {
  readonly kind: "soft";
  readonly prompt: string;
  readonly answers: A;
  readonly points: { readonly [K in A[number]]: number };
}

export type Question = GateQuestion | SoftQuestion;

/** What a feature may check the statement against besides itself. Entry ids are opaque. */
export interface FeatureContext {
  /** The entries already recorded in the living docs. */
  readonly recorded: readonly MatchCandidate[];
}

/** A feature eris checks on the statement itself; the model never answers it. */
export interface Feature {
  readonly description: string;
  readonly points: number;
  readonly detect: (statement: string, context: FeatureContext) => boolean;
}

export interface RubricDefinition {
  readonly version: RubricVersion;
  /** A score at or above this is load-bearing. */
  readonly threshold: number;
  /** Gates are evaluated in this order; the first that fires decides. */
  readonly questions: { readonly [id: string]: Question };
  readonly features: { readonly [id: string]: Feature };
}

/** Holds each question's `passes` / `points` keys to its own answers, and `firedBy` to the rubric's features. */
type CheckedQuestions<Q, F> = {
  readonly [K in keyof Q]: Q[K] extends { readonly kind: "gate"; readonly answers: infer A extends AnswerList }
    ? GateQuestion<A, keyof F & string>
    : Q[K] extends { readonly kind: "soft"; readonly answers: infer A extends AnswerList }
      ? SoftQuestion<A>
      : never;
};

/** Declares a rubric version, checking every question against its own answers. */
export function defineRubric<
  const V extends RubricVersion,
  const Q extends { readonly [id: string]: Question },
  const F extends { readonly [id: string]: Feature },
>(rubric: { readonly version: V; readonly threshold: number; readonly questions: Q & CheckedQuestions<Q, F>; readonly features: F }): {
  readonly version: V;
  readonly threshold: number;
  readonly questions: Q;
  readonly features: F;
} {
  return rubric;
}

type QuestionsOf<R extends RubricDefinition> = R["questions"];

export type QuestionId<R extends RubricDefinition> = keyof QuestionsOf<R> & string;

export type GateId<R extends RubricDefinition> = {
  [K in QuestionId<R>]: QuestionsOf<R>[K] extends { readonly kind: "gate" } ? K : never;
}[QuestionId<R>];

/** A gate whose firing rejects the candidate: the only gates an override may bypass. */
export type RejectGateId<R extends RubricDefinition> = {
  [K in GateId<R>]: QuestionsOf<R>[K] extends { readonly route: "reject" } ? K : never;
}[GateId<R>];

export type FeatureId<R extends RubricDefinition> = keyof R["features"] & string;

/** One enum answer per question, and nothing else. */
export type Answers<R extends RubricDefinition> = {
  readonly [K in QuestionId<R>]: QuestionsOf<R>[K]["answers"][number];
};

/** Whether each feature holds for the statement. */
export type Features<R extends RubricDefinition> = { readonly [K in FeatureId<R>]: boolean };

/** What each answer and feature added to the score, nonzero contributions only. */
export type Breakdown<R extends RubricDefinition> = Readonly<Partial<Record<QuestionId<R> | FeatureId<R>, number>>>;

/** The gate that stopped scoring, the answer given to it, and the feature that fired it when one did. */
interface GateFiring<R extends RubricDefinition> {
  readonly rubric: R["version"];
  readonly gate: GateId<R>;
  readonly answer: string;
  readonly feature?: FeatureId<R>;
}

/**
 * One verdict, one kind; every kind carries the rubric version that produced it. Only the two
 * scored kinds carry a score, so a practice is never also load-bearing, and it goes to the
 * Practices doc rather than into review.
 */
export type Verdict<R extends RubricDefinition> =
  | { readonly kind: "load-bearing"; readonly rubric: R["version"]; readonly score: number; readonly threshold: number; readonly breakdown: Breakdown<R> }
  | { readonly kind: "not-load-bearing"; readonly rubric: R["version"]; readonly score: number; readonly threshold: number; readonly breakdown: Breakdown<R> }
  | ({ readonly kind: "rejected" } & GateFiring<R>)
  | ({ readonly kind: "rerouted"; readonly to: "key-assumption" } & GateFiring<R>)
  | ({ readonly kind: "practice"; readonly to: "practices-doc" } & GateFiring<R>);

export interface ScoreOptions<R extends RubricDefinition> {
  /** Gates an override skips. Each named gate is skipped; every other gate still runs. */
  readonly bypass?: readonly GateId<R>[];
}

/** The answers schema for untyped input: each question's enum, no other key. */
export function answersSchema<R extends RubricDefinition>(rubric: R): z.ZodType<Answers<R>> {
  const shape: Record<string, z.ZodEnum<[string, ...string[]]>> = {};
  for (const [id, q] of Object.entries(rubric.questions)) shape[id] = z.enum([...q.answers]);
  return z.object(shape).strict() as unknown as z.ZodType<Answers<R>>;
}

/** Runs each of the rubric's mechanical checks on the statement. */
export function extractFeatures<R extends RubricDefinition>(rubric: R, statement: string, context: FeatureContext): Features<R> {
  const out: Record<string, boolean> = {};
  for (const [id, f] of Object.entries(rubric.features)) out[id] = f.detect(statement, context);
  return out as Features<R>;
}

/**
 * Whether one gate fires on these answers and features: the answer it was given, and the feature
 * that fired it when one did, or undefined when it passes. Pure, and the scorer's own test.
 */
export function gateFiring<R extends RubricDefinition>(rubric: R, gate: GateId<R>, answers: Answers<R>, features: Features<R>): { readonly answer: string; readonly feature?: FeatureId<R> } | undefined {
  const q = rubric.questions[gate] as GateQuestion;
  const answer = (answers as Readonly<Record<string, string>>)[gate]!;
  const feature = q.firedBy?.find((f) => (features as Readonly<Record<string, boolean>>)[f]);
  if (feature === undefined && q.passes.includes(answer)) return undefined;
  return { answer, ...(feature === undefined ? {} : { feature: feature as FeatureId<R> }) };
}

/**
 * The verdict for one candidate. Pure: it reads only its arguments, so the same
 * answers and features always give the same verdict.
 */
export function score<R extends RubricDefinition>(rubric: R, answers: Answers<R>, features: Features<R>, options: ScoreOptions<R> = {}): Verdict<R> {
  const bypass = new Set<string>(options.bypass ?? []);
  const given = answers as Readonly<Record<string, string>>;
  const held = features as Readonly<Record<string, boolean>>;
  for (const [id, q] of Object.entries(rubric.questions)) {
    if (q.kind !== "gate" || bypass.has(id)) continue;
    const fired = gateFiring(rubric, id as GateId<R>, answers, features);
    if (fired === undefined) continue;
    const firing: GateFiring<R> = { rubric: rubric.version, gate: id as GateId<R>, ...fired };
    switch (q.route) {
      case "reject":
        return { kind: "rejected", ...firing };
      case "key-assumption":
        return { kind: "rerouted", ...firing, to: "key-assumption" };
      case "practice":
        return { kind: "practice", ...firing, to: "practices-doc" };
    }
  }
  const breakdown: Record<string, number> = {};
  let total = 0;
  for (const [id, q] of Object.entries(rubric.questions)) {
    if (q.kind !== "soft") continue;
    const p = (q.points as Readonly<Record<string, number>>)[given[id]!]!;
    if (p !== 0) breakdown[id] = p;
    total += p;
  }
  for (const [id, f] of Object.entries(rubric.features)) {
    if (!held[id] || f.points === 0) continue;
    breakdown[id] = f.points;
    total += f.points;
  }
  const kind = total >= rubric.threshold ? "load-bearing" : "not-load-bearing";
  return { kind, rubric: rubric.version, score: total, threshold: rubric.threshold, breakdown: breakdown as Breakdown<R> };
}
