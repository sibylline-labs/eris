/**
 * rubric@v4. rubric@v3's questions, prompts, answers, points, threshold and owning-layer and
 * dependency-pick wording, word for word, so a replay compares v3 and v4 answer for answer.
 *
 * What changed from v3:
 *  - The end-condition wording fires on "until" only when it ends the decision itself: a person or
 *    team acts ("until we migrate", "until a reviewer decides"), a marker ("until then", "until GA",
 *    "until further notice"), a ticket key or version, the next major, release or phase, or a change
 *    that lands, ships or is migrated. A causal "until" on runtime state ("fails a check until its
 *    members carry pragmas", "stays until each source re-pushes") is how the system behaves, and
 *    no longer fires.
 *  - The flag-value wording does not fire on a conditional clause that opens its sentence ("While
 *    BILLING_ENABLED is on, ..."): the statement is the rule that holds under the flag, not the
 *    flag's value. A mid-sentence "only when X is exactly true" still fires.
 *  - `owning_layer` applies only to an observed premise. An inferred premise goes to the
 *    key-assumption gate whoever owns it, so an honest owned-elsewhere answer about another
 *    repository's code no longer rejects a key assumption before it can be rerouted.
 *  - `premise_basis` reroutes to Key Assumptions only when contradicting the claim would break
 *    something (`consequence` other than nothing-beyond-this-change); otherwise it is scored, and
 *    scores below the threshold. The practice gate is unchanged: practices are written directly.
 *
 * Published versions are frozen. Changing a question, an answer, a point value, a feature or the
 * threshold is a new version beside this one. The patterns are this version's own.
 */

import { classifyMatch, MATCH_DEFAULTS } from "../match";
import { defineRubric } from "./definition";

/** The decision's own sunset: a word that bounds it in time. */
const TEMPORARY = /\b(?:temporar(?:y|ily)|for now|right now|for the time being)\b/i;
/**
 * "until" that ends the decision: a person or team acts, a marker, a ticket key or version, the next
 * major/release/phase, or up to four words then a change that lands. A causal "until" on runtime
 * state ("until its …", "until each …", "until it merges", "until 30 days") is none of these.
 */
const UNTIL_SUNSET = new RegExp(
  String.raw`\buntil\s+(?:` +
    [
      String.raw`(?:we|I|you|they|someone|somebody)\b`,
      String.raw`(?:an?|the)\s+(?:human|person|reviewer|operator|maintainer|owner|team)s?\b`,
      String.raw`(?:then|further notice|GA|launch|(?:the\s+)?cut-?over|(?:the\s+)?migration)\b`,
      String.raw`[A-Z][A-Z0-9]+-\d+\b`,
      String.raw`v?\d+\.\d+`,
      String.raw`(?:the\s+)?(?:next|following)\s+(?:major|minor|release|version|phase|milestone|quarter|sprint|cycle)\b`,
      String.raw`(?:[\w./@\`'-]+\s+){0,4}?(?:lands|ships|supports|is\s+(?:migrated|replaced|retired|removed|cut over|deprecated|shipped|released))\b`,
    ].join("|") +
    ")",
  "i",
);
const END_CONDITION = (s: string): boolean => TEMPORARY.test(s) || UNTIL_SUNSET.test(s);
const PRACTICE = /\b(?:sign(?:s|ed|ing)?[- ]off|before (?:any |each |every )?(?:code|commit|merg\w*|review\w*|release\w*|deploy\w*)|(?:its|their) own commit|(?:development|engineering) work)\b/i;

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
/**
 * An environment variable compared to a literal flag value, unless a conditional clause opens the
 * sentence before it ("While BILLING_ENABLED is on, ..."): that sentence states the rule under the
 * flag, not the flag's value.
 */
const FLAG_VALUE = firesUnlessPreceded(
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b[^.;]{0,30}?\b(?:is|equals|=)\s+(?:exactly\s+)?["'`]?(?:true|false|on|off|enabled|disabled)\b/g,
  /(?:^|[.;:]\s+)(?:while|when|whenever|if|as long as)\s+(?:the\s+)?["'`]?$/i,
);
/**
 * A rule named before "lint rule" holds the fact, unless the rule is the route a counterexample fails
 * through ("… fails CI through the no-x lint rule"): there the rule bans one alternative, and the
 * decision the statement makes is not the rule's.
 */
const RULE_BEFORE_TOOL = firesUnlessPreceded(
  new RegExp(String.raw`["'\`]?\b${RULE_ID}["'\`]?\s+${TOOL}\s+rule\b`, "gi"),
  /\b(?:through|via)\s+(?:the\s+|an?\s+)?$/i,
);
/** A rule named after the tool, with "rule" or a delimiter; not the `eris lint` command. */
const NAMED_RULE = firesUnlessPreceded(
  new RegExp(String.raw`\b${TOOL}(?:\s+rule[:\s]+["'\`]?|:\s*|\s+["'\`])${RULE_ID}`, "gi"),
  /\beris\s+$/i,
);
/** A Canon NFR register row, unless the statement deviates from it. Case-sensitive: the ids are upper case. */
const NFR_ROW = firesUnlessPreceded(/\bNFR-[A-Z][A-Z0-9]*-\d+\b/g, /\b(?:deviat(?:e|es|ing) from|waiv(?:e|es|ing)|relax(?:es|ing)?|overrid(?:e|es|ing))\s+["'`\u2018\u201c]?$/i);
/** A scoped package picked for a job; "uses @scope/pkg as its boundary" names an architecture seam instead. */
const DEPENDENCY_PICK = /\b(?:uses?|depends on|adopts?|relies on)\s+["'`]?@[\w.-]+\/[\w.-]+["'`]?(?:\s+(?:for|to|and)\b|\s*[,;.]|$)/i;

export const RUBRIC_V4 = defineRubric({
  version: "rubric@v4",
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
      appliesWhen: { premise_basis: ["observed"] },
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
      appliesWhen: {
        consequence: ["a-rule-this-codebase-relies-on", "another-repository", "a-service-contract", "a-security-boundary", "a-product-promise", "a-future-plan"],
      },
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
      description: "The statement says temporary, for now or right now, or ends the decision \"until\" a person acts, a ticket, a version, a release or a change lands.",
      points: 0,
      detect: (s) => END_CONDITION(s),
    },
    owned_elsewhere_wording: {
      description:
        "The statement names what already holds it: a lint or ast-grep rule id, @ts-expect-error or a type test, a test that asserts it, a layer that already owns or provides it, a Canon NFR row, reuse rather than redeclaring, or a gate, kit or types that own, hold, pin or enforce it.",
      points: 0,
      detect: (s) => OWNED_ELSEWHERE.some((re) => re.test(s)) || NAMED_RULE(s) || RULE_BEFORE_TOOL(s) || NFR_ROW(s),
    },
    practice_wording: {
      description: "The statement describes a step people take: a sign-off, something done before code or a merge, its own commit, development work.",
      points: 0,
      detect: (s) => PRACTICE.test(s),
    },
    flag_value_wording: {
      description: "The statement compares an environment variable to a literal flag value (true, false, on, off, enabled, disabled), other than in a clause that opens its sentence with while, when, if or as long as.",
      points: 0,
      detect: (s) => FLAG_VALUE(s),
    },
    dependency_pick_wording: {
      description: "The statement picks a scoped package (uses, depends on, adopts or relies on @scope/pkg), not as a named boundary: a dependency choice.",
      points: 0,
      detect: (s) => DEPENDENCY_PICK.test(s),
    },
  },
});

export type RubricV4 = typeof RUBRIC_V4;
