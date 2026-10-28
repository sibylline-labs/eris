/**
 * rubric@v1. A decision is load-bearing when reversing it forces a change
 * outside the code, PR or process that made it: another repository, a service
 * contract, a security boundary, a product promise, or a future plan that
 * cannot be written without knowing it.
 *
 * Published versions are frozen. Changing a question, an answer, a point value,
 * a feature or the threshold is a new version beside this one.
 */

import { classifyMatch, MATCH_DEFAULTS } from "../match";
import { defineRubric } from "./definition";

const END_CONDITION = /\b(?:temporar(?:y|ily)|until|for now|right now|for the time being)\b/i;
const FILE_PATH = /(?:\b[\w.-]+\/[\w.-]+|\b[\w-]+\.(?:ts|tsx|js|mjs|py|json|ya?ml|toml|md|sh|sql))\b/;
const ENV_VAR = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;
const SNAKE_IDENTIFIER = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/;
const VERSION_NUMBER = /\bv?\d+\.\d+(?:\.\d+)?\b/;
const MECHANISM = /\b(?:builds|renders|displays|is (?:offered|shown) when)\b/i;
const INVARIANT = /\b(?:never|only|stays|not \w+(?: \w+)? but)\b/i;
const CLAUSE_JOIN = /[;,]|\b(?:and|which|so that|then)\b/gi;
const PRACTICE = /\b(?:sign(?:s|ed|ing)?[- ]off|before (?:any |each |every )?(?:code|commit|merg\w*|review\w*|release\w*|deploy\w*)|(?:its|their) own commit|(?:development|engineering) work)\b/i;

export const RUBRIC_V1 = defineRubric({
  version: "rubric@v1",
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
    },
    owning_layer: {
      kind: "gate",
      prompt: "Does another layer already own this fact (a lockfile, CI config, wrangler config, a lint rule, the PRD)?",
      answers: ["no-other-owner", "owned-elsewhere"],
      passes: ["no-other-owner"],
      route: "reject",
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
      prompt: "Can the decision be reversed cheaply: a revert, a rename or a setting, with nothing outside its origin to change?",
      answers: ["one-way-door", "two-way-door"],
      passes: ["one-way-door"],
      route: "reject",
    },
    premise_basis: {
      kind: "gate",
      prompt: "Was the premise it rests on observed directly, or inferred?",
      answers: ["observed", "inferred"],
      passes: ["observed"],
      route: "key-assumption",
    },
    reversal_reach: {
      kind: "soft",
      prompt: "Reversing the decision forces a change where?",
      answers: ["within-origin", "other-repository", "service-contract", "security-boundary", "product-promise", "future-plan"],
      points: {
        "within-origin": 0,
        "other-repository": 4,
        "service-contract": 4,
        "security-boundary": 4,
        "product-promise": 4,
        "future-plan": 4,
      },
    },
    scope: {
      kind: "soft",
      prompt: "How far does the decision reach?",
      answers: ["one-module", "one-repository", "crosses-repositories"],
      points: { "one-module": -2, "one-repository": 0, "crosses-repositories": 1 },
    },
  },
  features: {
    matches_recorded_entry: {
      description: "The statement strongly matches an entry already recorded (keyword overlap or Levenshtein similarity).",
      points: 0,
      detect: (s, { recorded }) => classifyMatch(s, recorded, MATCH_DEFAULTS).kind === "strong",
    },
    practice_wording: {
      description: "The statement describes a step people take: a sign-off, something done before code or a merge, its own commit, development work.",
      points: 0,
      detect: (s) => PRACTICE.test(s),
    },
    end_condition_wording: {
      description: "The statement says temporary, until, for now or right now.",
      points: -2,
      detect: (s) => END_CONDITION.test(s),
    },
    names_artifact: {
      description: "The statement names a file, an environment variable, an identifier or a version number.",
      points: -1,
      detect: (s) => FILE_PATH.test(s) || ENV_VAR.test(s) || SNAKE_IDENTIFIER.test(s) || VERSION_NUMBER.test(s),
    },
    describes_mechanism: {
      description: "The statement says what the code does (builds, renders, is offered when), not what must hold.",
      points: -1,
      detect: (s) => MECHANISM.test(s),
    },
    invariant_wording: {
      description: "The statement says never, only, stays, or not X but Y.",
      points: 1,
      detect: (s) => INVARIANT.test(s),
    },
    multi_clause: {
      description: "The statement is long or chains several clauses: a mechanism, then its consequence.",
      points: -1,
      detect: (s) => s.length > 200 || (s.match(CLAUSE_JOIN)?.length ?? 0) > 3,
    },
  },
});

export type RubricV1 = typeof RUBRIC_V1;
