/**
 * rubric@v3. The same questions, answers, points and threshold as rubric@v2.
 *
 * What changed from v2: an agent's answers are self-reported, and an agent that reuses one answer
 * set across candidates answers every gate as passing. v2's owning-layer wording fired only on
 * "<holder> owns|holds|pins|enforces" and "held|owned|pinned by", so a statement that cited its
 * owner any other way reached review. v3 fires on the ways an owner is actually cited:
 *  - a named lint or ast-grep rule id, with "rule", a delimiter, in parentheses, or before "lint rule";
 *  - `@ts-expect-error`, a `.test-d.ts` file, `expectTypeOf`, or a type-level test that pins it;
 *  - a test as the subject that asserts the fact, or the fact asserted or covered by a test;
 *  - a layer that already owns, provides or handles it;
 *  - a Canon NFR register row, unless the statement deviates from it;
 *  - reuse "rather than / instead of" redeclaring or reimplementing.
 * A dependency pick ("uses @scope/pkg for …") fires the reversibility gate, whose prompt already
 * calls a dependency or vendor pick setting-level.
 *
 * The prompts for owning_layer and already_recorded name types, tests, shared SDK primitives and
 * Canon, so an agent that reads them answers the gate from the statement.
 *
 * Published versions are frozen. Changing a question, an answer, a point value, a feature or the
 * threshold is a new version beside this one. The patterns are this version's own.
 */

import { classifyMatch, MATCH_DEFAULTS } from "../match";
import { defineRubric } from "./definition";

const END_CONDITION = /\b(?:temporar(?:y|ily)|until|for now|right now|for the time being)\b/i;
const PRACTICE = /\b(?:sign(?:s|ed|ing)?[- ]off|before (?:any |each |every )?(?:code|commit|merg\w*|review\w*|release\w*|deploy\w*)|(?:its|their) own commit|(?:development|engineering) work)\b/i;
const FLAG_VALUE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b[^.;]{0,30}?\b(?:is|equals|=)\s+(?:exactly\s+)?["'`]?(?:true|false|on|off|enabled|disabled)\b/;

const HOLDER = String.raw`(?:gate|lint|linter|rule|rules|check|checker|kit|types?|tests?|CI|workflow|lockfile|config)`;
const TOOL = String.raw`(?:lint|ast-grep|oxlint|eslint)`;
/** A rule id: kebab or snake case, optionally scoped or namespaced (`@scope/rule`, `plugin/rule`). */
const RULE_ID = String.raw`(?:[\w@.-]+\/)?[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+`;
const TYPE_TEST = String.raw`(?:type(?:[- ]level)?|compile-?time)[- ]tests?`;
const TEST_VERB = String.raw`(?:dump|assert|check|prove|fail|refuse|find|pin)s?`;

const OWNED_ELSEWHERE = [
  // v2's wording, unchanged.
  String.raw`\b(?:${HOLDER}\s+(?:owns|holds|pins|enforces)\b|(?:held|owned|enforced|pinned) by (?:types|lint|ast-grep|oxlint|CI|error-severity|the |an? |its )|is (?:the |an? )?[\w-]+'s job\b|owns (?:the|a) (?:rule|ban|check)\b)`,
  // A named rule: "lint rule no-x", "lint: no-x", "lint \`no-x\`", "(lint no-x)", "no-x lint rule".
  String.raw`\(${TOOL}\s+["'\`]?${RULE_ID}["'\`]?\)`,
  String.raw`\b${RULE_ID}["'\`]?\s+${TOOL}\s+rule\b`,
  // A type-level test.
  String.raw`@ts-expect-error|\.test-d\.ts\b|\bexpectTypeOf\b|\b${TYPE_TEST}\b[^.;]{0,50}?\b(?:pins?|refuses|asserts|fails|checks|proves|enforces)\b|\bby an? ${TYPE_TEST}\b`,
  // A test that asserts it, as the subject of a sentence or the agent of a passive.
  String.raw`(?:^|[.;]\s+)(?:(?:an?|the|one|every)\s+)?(?:[\w-]+\s+){0,2}tests?\s+${TEST_VERB}\b`,
  String.raw`\b(?:asserted|covered)\s+by\s+(?:an?\s+|the\s+)?(?:[\w-]+\s+)?tests?\b`,
  // A layer that already owns it.
  String.raw`\balready\s+(?:owns|provides|handles)\b|\b(?:owns|provides)\b[^.;]{0,30}\balready\b`,
  // Reuse rather than a second declaration.
  String.raw`\b(?:rather|instead) (?:than|of) (?:re-?declar|redefin|re-?implement)\w*`,
].map((source) => new RegExp(source, "i"));
/**
 * Fires when a match is not vetoed by the text just before it. The repo bans regex lookbehind (it
 * drops the pinned bun to its slow interpreter), so the veto reads the prefix in code instead.
 */
const firesUnlessPreceded = (re: RegExp, veto: RegExp) => (s: string) => {
  for (const m of s.matchAll(re)) if (!veto.test(s.slice(0, m.index))) return true;
  return false;
};
/** A rule named after the tool, with "rule" or a delimiter; not the `eris lint` command. */
const NAMED_RULE = firesUnlessPreceded(
  new RegExp(String.raw`\b${TOOL}(?:\s+rule[:\s]+["'\`]?|:\s*|\s+["'\`])${RULE_ID}`, "gi"),
  /\beris\s+$/i,
);
/** A Canon NFR register row, unless the statement deviates from it. Case-sensitive: the ids are upper case. */
const NFR_ROW = firesUnlessPreceded(/\bNFR-[A-Z][A-Z0-9]*-\d+\b/g, /\b(?:deviat(?:e|es|ing) from|waiv(?:e|es|ing)|relax(?:es|ing)?|overrid(?:e|es|ing))\s+$/i);
/** A scoped package picked for a job; "uses @scope/pkg as its boundary" names an architecture seam instead. */
const DEPENDENCY_PICK = /\b(?:uses?|depends on|adopts?|relies on)\s+["'`]?@[\w.-]+\/[\w.-]+["'`]?(?:\s+(?:for|to|and)\b|\s*[,;.]|$)/i;

export const RUBRIC_V3 = defineRubric({
  version: "rubric@v3",
  threshold: 3,
  questions: {
    already_recorded: {
      kind: "gate",
      prompt: "Is this fact already recorded in the living docs or in Canon (an entry, a register row such as an NFR)?",
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
      prompt:
        "Does another layer already own this fact: a lint or ast-grep rule, a type or a type test, a test that asserts it, a shared SDK primitive, a Canon or NFR row, a lockfile, CI or wrangler config, the PRD? Answer from this candidate's statement: if it names what holds it, it is owned elsewhere.",
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
      firedBy: ["flag_value_wording", "dependency_pick_wording"],
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
      description:
        "The statement names what already holds it: a lint or ast-grep rule id, @ts-expect-error or a type test, a test that asserts it, a layer that already owns or provides it, a Canon NFR row, reuse rather than redeclaring, or a gate, kit or types that own, hold, pin or enforce it.",
      points: 0,
      detect: (s) => OWNED_ELSEWHERE.some((re) => re.test(s)) || NAMED_RULE(s) || NFR_ROW(s),
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
    dependency_pick_wording: {
      description: "The statement picks a scoped package (uses, depends on, adopts or relies on @scope/pkg), not as a named boundary: a dependency choice.",
      points: 0,
      detect: (s) => DEPENDENCY_PICK.test(s),
    },
  },
});

export type RubricV3 = typeof RUBRIC_V3;
