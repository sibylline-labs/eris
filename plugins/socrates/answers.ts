/**
 * answers.ts — the rubric answers and gate overrides `eris socrates classify`
 * and `submit` read, parsed the same way for both.
 *
 * Invariants:
 *   - The answers are the rubric's own enums (`answersSchema`); each override
 *     is the contract's `SocratesOverride` (a one-line reason).
 *   - An override names a reject-routed gate that fires on these answers and
 *     that the policy runs, at most once. A gate the policy turns off never
 *     fires, so there is nothing to override.
 */

import { answersSchema, type Answers, CURRENT_RUBRIC, disabledGates, type Features, type GateId, gateFiring, type ScoringPolicy } from "eris/socrates-core";
import { z } from "zod";
import type { VerbContext } from "../../src/cli/plugin";
import { fail, printable } from "./client";
import { SocratesOverride } from "./socrates-contract.v1";

export type Rubric = typeof CURRENT_RUBRIC;
export type Override = z.infer<typeof SocratesOverride>;

export const ANSWER_FIX = "pass one --answer <question>=<answer> per rubric question; run 'eris socrates classify --help' for the answers";
export const OVERRIDE_FIX = "use --override <gate>=<one-line reason>";

export function issues(error: z.ZodError, root: string): string {
  return error.issues.map((i) => `${[root, ...i.path].join(".")}: ${i.message}`).join("; ");
}

/** `<key>=<value>` pairs into a record; a pair without `=`, or a repeated key, is refused. */
export function pairs(ctx: VerbContext, flag: string, words: readonly string[], slug: "socrates-answers-invalid" | "socrates-override-invalid", fix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const w of words) {
    const at = w.indexOf("=");
    if (at <= 0) fail(ctx, slug, `${flag} ${printable(w)} is not <key>=<value>`, fix);
    const key = w.slice(0, at);
    if (Object.hasOwn(out, key)) fail(ctx, slug, `${flag} names ${printable(key)} twice`, fix);
    out[key] = w.slice(at + 1);
  }
  return out;
}

export function answersOf(ctx: VerbContext, rubric: Rubric, raw: unknown): Answers<Rubric> {
  const parsed = answersSchema(rubric).safeParse(raw);
  if (parsed.success) return parsed.data;
  const expected = Object.entries(rubric.questions)
    .map(([id, q]) => `${id}=${q.answers.join("|")}`)
    .join("\n");
  fail(ctx, "socrates-answers-invalid", `the answers do not fit ${rubric.version} (${printable(issues(parsed.error, "answers"))})`, `answer every question with one of its answers:\n${expected}`);
}

/** Each override is a one-line reason on a reject-routed gate the policy runs and that fires here, once. */
export function overridesOf(ctx: VerbContext, rubric: Rubric, policy: ScoringPolicy, raw: unknown, answers: Answers<Rubric>, features: Features<Rubric>): Override[] {
  const fix = "override only the gate a rejection named, as --override <gate>=<one-line reason>";
  const parsed = z.array(SocratesOverride).safeParse(raw);
  if (!parsed.success) fail(ctx, "socrates-override-invalid", `the override is not a gate with a one-line reason (${printable(issues(parsed.error, "overrides"))})`, fix);
  const off = new Set(disabledGates(rubric, policy));
  const seen = new Set<string>();
  for (const { gate } of parsed.data) {
    const q = (rubric.questions as Readonly<Record<string, { kind: string; route?: string }>>)[gate];
    if (q === undefined || q.kind !== "gate") fail(ctx, "socrates-override-invalid", `${gate} is not a gate of ${rubric.version}`, fix);
    if (q.route !== "reject") fail(ctx, "socrates-override-invalid", `${gate} routes the candidate (${q.route}) rather than rejecting it, so it cannot be overridden`, "answer the gate as it is; a reroute is not a rejection");
    if (seen.has(gate)) fail(ctx, "socrates-override-invalid", `${gate} is overridden twice`, fix);
    if (off.has(gate)) fail(ctx, "socrates-override-invalid", `${gate} is turned off by the policy, so there is nothing to override`, fix);
    if (gateFiring(rubric, gate as GateId<Rubric>, answers, features) === undefined) fail(ctx, "socrates-override-invalid", `${gate} does not reject these answers, so there is nothing to override`, fix);
    seen.add(gate);
  }
  return parsed.data;
}
