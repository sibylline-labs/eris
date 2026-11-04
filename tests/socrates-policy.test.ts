/**
 * packages/socrates-core, scoring under a rubric policy and the stricter-only
 * repo layer.
 *
 * Seams: the package's public entry, which both `eris socrates classify` and
 * the server's reclassify import, so one scorer answers both.
 */

import { describe, expect, it } from "bun:test";
import { CURRENT_RUBRIC, defaultPolicy, mergeRepoPolicy, type RepoPolicy, score, scoreUnderPolicy } from "../packages/socrates-core/src/index";

const rubric = CURRENT_RUBRIC;
const questions = Object.entries(rubric.questions);

/** Every combination of the rubric's answers. */
function* allAnswers(): Generator<Record<string, string>> {
  const ids = questions.map(([id]) => id);
  const lists = questions.map(([, q]) => q.answers as readonly string[]);
  const pick = new Array<number>(ids.length).fill(0);
  for (;;) {
    yield Object.fromEntries(ids.map((id, i) => [id, lists[i]![pick[i]!]!]));
    let i = 0;
    while (i < ids.length && ++pick[i]! === lists[i]!.length) pick[i++] = 0;
    if (i === ids.length) return;
  }
}

const featureSets = [false, true].map((on) => Object.fromEntries(Object.keys(rubric.features).map((id) => [id, on])));
const none = featureSets[0]!;

const soft = questions.find(([, q]) => q.kind === "soft")! as [string, { readonly points: Readonly<Record<string, number>> }];
const softTop = Object.entries(soft[1].points).sort(([, a], [, b]) => b - a)[0]!;
const gate = questions.find(([, q]) => q.kind === "gate" && q.route === "reject")! as [string, { readonly passes: readonly string[]; readonly answers: readonly string[] }];

/** Answers that pass every gate and take each soft question's highest answer. */
function passing(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, q] of questions) {
    out[id] = q.kind === "gate" ? q.passes[0]! : Object.entries(q.points as Record<string, number>).sort(([, a], [, b]) => b - a)[0]![0];
  }
  return out;
}

const failing = () => ({ ...passing(), [gate[0]]: gate[1].answers.find((a) => !gate[1].passes.includes(a))! });

describe("scoreUnderPolicy", () => {
  // admits: the verdict moving for an org that stored no policy; equality of two scorers over the
  // whole answer space is a property no type sees.
  it("is `score` under the rubric's defaults for every answer combination", () => {
    const defaults = defaultPolicy(rubric);
    let n = 0;
    for (const answers of allAnswers()) {
      for (const features of featureSets) {
        expect(scoreUnderPolicy(rubric, defaults, answers, features, []) as unknown).toEqual(score(rubric, answers as never, features as never));
        n++;
      }
    }
    expect(n).toBeGreaterThan(1);
  });

  // admits: a stored policy that changes nothing a classify answers.
  it("moves the verdict for a disabled gate, a soft weight and a threshold", () => {
    const defaults = defaultPolicy(rubric);
    expect(scoreUnderPolicy(rubric, defaults, failing(), none, []).kind).toBe("rejected");
    const off = { ...defaults, gates: { ...defaults.gates, [gate[0]]: { enabled: false, weight: 0 } } };
    expect(scoreUnderPolicy(rubric, off, failing(), none, []).kind).not.toBe("rejected");

    const base = scoreUnderPolicy(rubric, defaults, passing(), none, []);
    if (base.kind !== "load-bearing" && base.kind !== "not-load-bearing") throw new Error("passing answers must score");
    const halved = { ...defaults, gates: { ...defaults.gates, [soft[0]]: { enabled: true, weight: softTop[1] / 2 } } };
    const scaled = scoreUnderPolicy(rubric, halved, passing(), none, []);
    expect("score" in scaled && scaled.score).toBe(base.score - softTop[1] / 2);

    expect(scoreUnderPolicy(rubric, { ...defaults, threshold: base.score + 1 }, passing(), none, []).kind).toBe("not-load-bearing");
  });
});

describe("mergeRepoPolicy", () => {
  const org = { ...defaultPolicy(rubric), threshold: 5, auto_resolve: true };
  const merge = (repo: RepoPolicy) => mergeRepoPolicy(rubric, org, repo);

  // admits: an empty or absent layer changing the org's policy.
  it("leaves the org policy as it is under an empty layer", () => {
    expect(merge({})).toEqual({ ok: true, policy: org });
  });

  // admits: a layer that only restates the org's settings being refused.
  it("accepts a threshold equal to the org's and a gate the org already runs", () => {
    const r = merge({ threshold: 5, gates: { [gate[0]]: { enabled: true } } });
    expect(r).toEqual({ ok: true, policy: org });
  });

  // admits: the stricter settings not reaching the merged policy, or a raise being clamped.
  it("raises the threshold, turns a gate the org turned off back on, and pins auto-resolve off", () => {
    const orgOff = { ...org, gates: { ...org.gates, [gate[0]]: { enabled: false, weight: 0 } } };
    const r = mergeRepoPolicy(rubric, orgOff, { threshold: 9, gates: { [gate[0]]: { enabled: true } }, auto_resolve: false });
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.policy.threshold).toBe(9);
    expect(r.policy.gates[gate[0]]).toEqual({ enabled: true, weight: 0 });
    expect(r.policy.auto_resolve).toBe(false);
    expect(scoreUnderPolicy(rubric, r.policy, failing(), none, []).kind).toBe("rejected");
  });

  // admits: a layer that loosens the org's policy being merged (the layer is stricter only).
  it("refuses a threshold below the org's, a soft question and an unknown question, naming each", () => {
    const r = merge({ threshold: 3, gates: { [soft[0]]: { enabled: true }, nope: { enabled: true } } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toEqual([
      `${soft[0]} is a soft question of ${rubric.version}; a repo can only turn a gate on`,
      `nope is not a question of ${rubric.version}`,
      "threshold 3 is below the org's 5",
    ]);
  });

  // admits: merging twice drifting the policy, so a reclassify differs from the first score.
  it("is idempotent", () => {
    const layer: RepoPolicy = { threshold: 7, gates: { [gate[0]]: { enabled: true } }, auto_resolve: false };
    const once = merge(layer);
    if (!once.ok) throw new Error("merge refused");
    expect(mergeRepoPolicy(rubric, once.policy, layer)).toEqual(once);
  });
});
