/**
 * packages/socrates-core, rubric@v4: the end-condition and flag-value wording, and the key-assumption
 * gates that read another question's answer.
 *
 * Seam: the package's public entry, `extractFeatures` and `score` over a statement and a set of
 * answers, as `eris socrates classify` and the server run them.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  type Answers,
  CURRENT_RUBRIC,
  defineRubric,
  extractFeatures,
  type FeatureContext,
  gateFiring,
  RUBRIC_V3,
  RUBRIC_V4,
  type RubricV3,
  type RubricV4,
  rubricFor,
  score,
} from "../packages/socrates-core/src/index";

const NOTHING_RECORDED: FeatureContext = { recorded: [] };

/** An agent that answers every gate as passing. */
const PASSING: Answers<RubricV4> = {
  already_recorded: "new",
  end_condition: "none",
  owning_layer: "no-other-owner",
  practice: "what-the-system-is",
  reversibility: "more-than-a-setting",
  premise_basis: "observed",
  consequence: "a-rule-this-codebase-relies-on",
};

const verdictOf = (statement: string, answers: Answers<RubricV4> = PASSING) => score(RUBRIC_V4, answers, extractFeatures(RUBRIC_V4, statement, NOTHING_RECORDED));
/** The same answers scored by the frozen v3, whose questions and answers are v4's. */
const v3VerdictOf = (statement: string, answers: Answers<RubricV4> = PASSING) => score(RUBRIC_V3, answers as Answers<RubricV3>, extractFeatures(RUBRIC_V3, statement, NOTHING_RECORDED));
const fired = (statement: string) => {
  const f = extractFeatures(RUBRIC_V4, statement, NOTHING_RECORDED);
  return { end: f.end_condition_wording, flag: f.flag_value_wording };
};

// Permanent rules an operator filed, which v3's wording rejected: a causal "until" on runtime state,
// and a conditional clause that opens the sentence with a flag.
const PERMANENT_RULES = [
  "A Worker fails `key-undeclared` until its Env members carry key pragmas.",
  "Values stamped before 0.6.0 stay until each source re-pushes.",
  "The gateway answers 402 until a card-bearing subscription clears it.",
  "While BILLING_ENABLED is on, every write route answers 402 to an org without an active subscription.",
];

/** The decision's own sunset: each must still fire the end-condition wording. */
const SUNSETS = [
  "We use a temporary allowlist for the preview hosts.",
  "The worker polls the queue for now.",
  "The preview keeps v1 until we migrate the callers.",
  "Nothing is changed until a reviewer decides.",
  "The flag stays on until ABC-123 lands.",
  "Reads go to the old table until the new route lands.",
  "A bare `transaction()` warns until the next major removes it.",
  "Writes are paused until further notice.",
  "The feature is free until GA.",
  "Until we cut over, both stores receive every write.",
  "The shim stays until v2.0 ships.",
  "The fallback stays until the SDK supports streaming.",
];
/** A causal "until" on runtime state: none fires the end-condition wording. */
const CAUSAL = [
  "A Worker fails `key-undeclared` until its Env members carry key pragmas.",
  "Values stamped before 0.6.0 stay until each source re-pushes.",
  "The gateway answers 402 until a card-bearing subscription clears it.",
  "A PR that changes bindings previews with the old ones until it merges.",
  "The link redirects to the permalink until 30 days, then returns 410.",
  "Retries never wrap writes in nested blocks until one succeeds.",
  "The writer holds the row lock until the write's transaction ends.",
  "Every read is refused locally until the deadline passes.",
];
/** A flag compared to a value as the statement's own claim: each must still fire. */
const FLAG_VALUES = [
  'The preview tools are registered only when MAIA_PREVIEW_TOOLS is exactly "true".',
  'Claim links are offered only when the var CLAIM_LINKS is "true".',
  "In production FEATURE_X is false.",
];
/** A conditional clause that opens its sentence: none fires. */
const CONDITIONALS = [
  "While BILLING_ENABLED is on, every write route answers 402 to an org without an active subscription.",
  "Every route checks the session. When AUDIT_MODE is enabled, each write also logs its actor.",
  "If STRICT_PINS is true, an unpinned dependency fails the build.",
  "As long as SAFE_MODE is on, deploys need a second approver.",
];

describe("rubric@v4: a permanent rule reaches review whatever words it bounds itself with", () => {
  // admits: a filed permanent rule rejected by end-condition or flag wording; prose semantics no type or lint sees.
  it("files the permanent rules v3's wording rejected", () => {
    /** When the end-condition wording fires on every "until" and the flag wording on a sentence-opening conditional, as v3's did, these filed rules are rejected and go unfiled: observed at v3's verdict on each and v4's. */
    for (const s of PERMANENT_RULES) {
      expect([s, v3VerdictOf(s).kind]).toEqual([s, "rejected"]);
      expect([s, verdictOf(s).kind]).toEqual([s, "load-bearing"]);
    }
  });

  // admits: the narrowed until missing a real sunset, or firing on a causal until; regex over prose.
  it("still fires on the decision's own end condition, and on nothing causal", () => {
    /** When the narrowed "until" misses a sunset shape (a person acts, a ticket, a version, the next major, a change that lands), a temporary decision reaches review as permanent: observed at the feature on each shape and on the causal near-misses. */
    for (const s of SUNSETS) expect([s, fired(s).end]).toEqual([s, true]);
    for (const s of CAUSAL) expect([s, fired(s).end]).toEqual([s, false]);
  });

  // admits: the conditional veto over- or under-reaching; regex over prose.
  it("still fires on a flag compared to its value, but not on a conditional clause", () => {
    /** When the conditional veto reads past the sentence start, a statement whose claim is a flag's value reaches review: observed at the feature on each flag value and each conditional. */
    for (const s of FLAG_VALUES) expect([s, fired(s).flag]).toEqual([s, true]);
    for (const s of CONDITIONALS) expect([s, fired(s).flag]).toEqual([s, false]);
  });
});

describe("rubric@v4: a key assumption is judged by its premise and its consequence", () => {
  const CROSS_REPO = "eris leaves the repro out of a yak's idempotency key.";

  // admits: owning_layer rejecting an honest cross-repo key assumption before the reroute; gate order is runtime scoring.
  it("reroutes an inferred claim about another repository's code to Key Assumptions, not owning_layer", () => {
    /** When owning_layer runs before the key-assumption gate on an inferred premise, as in v3, an honest owned-elsewhere answer about another repository rejects the assumption before it can be rerouted: observed at both versions' verdicts on the same answers. */
    const honest = { ...PASSING, owning_layer: "owned-elsewhere", premise_basis: "inferred", consequence: "another-repository" } as const;
    expect(v3VerdictOf(CROSS_REPO, honest)).toMatchObject({ kind: "rejected", gate: "owning_layer" });
    expect(verdictOf(CROSS_REPO, honest)).toEqual({ kind: "rerouted", rubric: "rubric@v4", gate: "premise_basis", answer: "inferred", to: "key-assumption" });
  });

  // admits: appliesWhen on owning_layer disabling it for observed facts too; runtime scoring.
  it("still rejects an observed fact another layer owns", () => {
    /** When the premise condition disables owning_layer for observed facts too, every owned fact reaches review: observed at the verdict on an observed owned-elsewhere answer. */
    expect(verdictOf(CROSS_REPO, { ...PASSING, owning_layer: "owned-elsewhere" })).toMatchObject({ kind: "rejected", gate: "owning_layer" });
  });

  // admits: a key assumption of no consequence being filed; runtime scoring.
  it("does not file an inferred claim of no consequence as a key assumption", () => {
    /** When the key-assumption reroute ignores consequence, as in v3, a claim nothing depends on is filed as a key assumption: observed at both versions' verdicts on the same answers. */
    const idle = { ...PASSING, premise_basis: "inferred", consequence: "nothing-beyond-this-change" } as const;
    expect(v3VerdictOf(CROSS_REPO, idle).kind).toBe("rerouted");
    expect(verdictOf(CROSS_REPO, idle)).toMatchObject({ kind: "not-load-bearing", score: 0 });
    expect(gateFiring(RUBRIC_V4, "premise_basis", idle, extractFeatures(RUBRIC_V4, CROSS_REPO, NOTHING_RECORDED))).toBeUndefined();
  });

  // admits: an appliesWhen naming a question or answer the rubric does not have; held at the type rung, these cases prove it.
  it("names only the rubric's own questions and answers in appliesWhen", () => {
    const questions = {
      a: { kind: "gate", prompt: "a?", answers: ["yes", "no"], passes: ["yes"], route: "reject" },
      b: { kind: "soft", prompt: "b?", answers: ["x", "y"], points: { x: 0, y: 3 } },
    } as const;
    defineRubric({ version: "rubric@v99", threshold: 3, features: {}, questions: { ...questions, a: { ...questions.a, appliesWhen: { b: ["y"] } } } });
    // @ts-expect-error: "z" is not an answer of b.
    defineRubric({ version: "rubric@v99", threshold: 3, features: {}, questions: { ...questions, a: { ...questions.a, appliesWhen: { b: ["z"] } } } });
    // @ts-expect-error: c is not a question of the rubric.
    defineRubric({ version: "rubric@v99", threshold: 3, features: {}, questions: { ...questions, a: { ...questions.a, appliesWhen: { c: ["y"] } } } });
  });
});

describe("rubric@v4 is published beside a frozen rubric@v3", () => {
  // admits: classify stamping an old rubric, or the server refusing an older stamp; registry contents.
  it("is the current rubric, and every earlier version still resolves by its stamp", () => {
    /** When v4 is not the current rubric, classify and submit keep stamping v3; when v3 stops resolving, every submission an older client stamped is refused: observed at the package entry. */
    expect(CURRENT_RUBRIC).toBe(RUBRIC_V4);
    expect(rubricFor("rubric@v4")).toBe(RUBRIC_V4);
    expect(rubricFor("rubric@v3")).toBe(RUBRIC_V3);
  });

  // admits: v4's change editing the published v3 in place; a frozen value across files no checker sees.
  it("keeps v3's definition byte for byte", () => {
    /** When v4's change edits v3 in place, every submission stamped rubric@v3 is reclassified by a rubric its client never ran: observed at the fingerprint of the published v3 definition. */
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(RUBRIC_V3, (_k, v: unknown) => (typeof v === "function" ? v.toString() : v)))
      .digest("hex");
    expect(fingerprint).toBe("a702bd3d6fd6cb81c7b00d0e091334b6b445b6bf0cadee933d23c0221d058ac7");
  });

  // admits: a reworded prompt or changed answer breaking the answer-for-answer replay and v3 stamps; frozen values.
  it("asks v3's questions, answers and prompts word for word", () => {
    /** When v4 rewords a prompt or changes an answer, a replay can no longer attribute a verdict change to v4's wording and gates, and a stamp built for v3's enums is refused: observed at each question. */
    const asked = (r: { questions: Record<string, { prompt: string; answers: readonly string[] }> }) => Object.fromEntries(Object.entries(r.questions).map(([id, q]) => [id, [q.prompt, q.answers]]));
    expect(asked(RUBRIC_V4)).toEqual(asked(RUBRIC_V3));
  });
});
