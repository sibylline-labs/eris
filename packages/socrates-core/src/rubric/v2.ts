/**
 * rubric@v2. The same load-bearing bar as rubric@v1: reversing the decision
 * forces a change outside the code, PR or process that made it, or later work
 * relies on it as a rule.
 *
 * What changed from v1, against the classifier corpus's operator labels:
 *  - `reversibility` asks only whether the decision is a setting-level choice,
 *    and fires on a flag compared to a literal value. v1 asked whether it could
 *    be reversed cheaply, which reads almost any code decision as a two-way door.
 *  - `owning_layer` and `end_condition` fire on their wording as well as on the
 *    answer: a statement that names the gate, lint or types holding it, or says
 *    temporary or until.
 *  - The soft score is one question, what later work would break by
 *    contradicting the decision. v1's reach, scope and wording penalties scored
 *    operator accepts as low as rejects.
 *
 * Published versions are frozen. Changing a question, an answer, a point value,
 * a feature or the threshold is a new version beside this one. The patterns are
 * this version's own, so an edit to another version never moves this one.
 */

import { classifyMatch, MATCH_DEFAULTS } from "../match";
import { defineRubric } from "./definition";

const END_CONDITION = /\b(?:temporar(?:y|ily)|until|for now|right now|for the time being)\b/i;
const PRACTICE = /\b(?:sign(?:s|ed|ing)?[- ]off|before (?:any |each |every )?(?:code|commit|merg\w*|review\w*|release\w*|deploy\w*)|(?:its|their) own commit|(?:development|engineering) work)\b/i;
const HOLDER = String.raw`(?:gate|lint|linter|rule|rules|check|checker|kit|types?|tests?|CI|workflow|lockfile|config)`;
const OWNED_ELSEWHERE = new RegExp(
  String.raw`\b(?:${HOLDER}\s+(?:owns|holds|pins|enforces)\b|(?:held|owned|enforced|pinned) by (?:types|lint|ast-grep|oxlint|CI|error-severity|the |an? |its )|is (?:the |an? )?[\w-]+'s job\b|owns (?:the|a) (?:rule|ban|check)\b)`,
  "i",
);
const FLAG_VALUE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b[^.;]{0,30}?\b(?:is|equals|=)\s+(?:exactly\s+)?["'`]?(?:true|false|on|off|enabled|disabled)\b/;

export const RUBRIC_V2 = defineRubric({
  version: "rubric@v2",
  threshold: 3,
  questions: {
    already_recorded: {
      kind: "gate",
      prompt: "Is this fact already recorded as an entry in the living docs?",
      answers: ["new", "already-recorded"],
      passes: ["new"],
      route: "reject",
      firedBy: ["matches_recorded_entry"],
    },
    end_condition: {
      kind: "gate",
      prompt: "Does the decision carry an end condition (temporary, until X, right now)?",
      answers: ["none", "has-end-condition"],
      passes: ["none"],
      route: "reject",
      firedBy: ["end_condition_wording"],
    },
    owning_layer: {
      kind: "gate",
      prompt: "Does another layer already own this fact (a lockfile, CI config, wrangler config, a lint rule, the PRD)?",
      answers: ["no-other-owner", "owned-elsewhere"],
      passes: ["no-other-owner"],
      route: "reject",
      firedBy: ["owned_elsewhere_wording"],
    },
    practice: {
      kind: "gate",
      prompt: "Is it about how people work (a process, a review step, an operational habit), not what the system is?",
      answers: ["what-the-system-is", "how-people-work"],
      passes: ["what-the-system-is"],
      route: "practice",
      firedBy: ["practice_wording"],
    },
    reversibility: {
      kind: "gate",
      prompt:
        "Is it only a setting-level choice: one edit to a flag or variable value, a dependency or model version, a vendor pick, a style token or a name reverses it, and no other code, contract or plan has to change with it?",
      answers: ["more-than-a-setting", "setting-level"],
      passes: ["more-than-a-setting"],
      route: "reject",
      firedBy: ["flag_value_wording"],
    },
    premise_basis: {
      kind: "gate",
      prompt: "Was the premise it rests on observed directly, or inferred?",
      answers: ["observed", "inferred"],
      passes: ["observed"],
      route: "key-assumption",
    },
    consequence: {
      kind: "soft",
      prompt: "If later work contradicted this decision without knowing it, what would break?",
      answers: [
        "nothing-beyond-this-change",
        "a-rule-this-codebase-relies-on",
        "another-repository",
        "a-service-contract",
        "a-security-boundary",
        "a-product-promise",
        "a-future-plan",
      ],
      points: {
        "nothing-beyond-this-change": 0,
        "a-rule-this-codebase-relies-on": 3,
        "another-repository": 3,
        "a-service-contract": 3,
        "a-security-boundary": 3,
        "a-product-promise": 3,
        "a-future-plan": 3,
      },
    },
  },
  features: {
    matches_recorded_entry: {
      description: "The statement strongly matches an entry already recorded (keyword overlap or Levenshtein similarity).",
      points: 0,
      detect: (s, { recorded }) => classifyMatch(s, recorded, MATCH_DEFAULTS).kind === "strong",
    },
    end_condition_wording: {
      description: "The statement says temporary, until, for now or right now.",
      points: 0,
      detect: (s) => END_CONDITION.test(s),
    },
    owned_elsewhere_wording: {
      description: "The statement names what holds it instead: a gate, lint, check, kit or types that owns, holds, pins or enforces it, or another tool whose job it is.",
      points: 0,
      detect: (s) => OWNED_ELSEWHERE.test(s),
    },
    practice_wording: {
      description: "The statement describes a step people take: a sign-off, something done before code or a merge, its own commit, development work.",
      points: 0,
      detect: (s) => PRACTICE.test(s),
    },
    flag_value_wording: {
      description: "The statement compares an environment variable to a literal flag value (true, false, on, off, enabled, disabled).",
      points: 0,
      detect: (s) => FLAG_VALUE.test(s),
    },
  },
});

export type RubricV2 = typeof RUBRIC_V2;
