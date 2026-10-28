/**
 * packages/socrates-core, rubric@v1 and its scorer.
 *
 * Seams: the package's public entry (what a server imports to reclassify a
 * stamped submission), `answersSchema` (what untyped JSON answers pass through)
 * and the package's own source files (what a consumer who installs it alone
 * gets).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  type Answers,
  answersSchema,
  defineRubric,
  extractFeatures,
  type FeatureContext,
  type Features,
  RUBRIC_V1,
  type RubricV1,
  rubricFor,
  score,
  type Verdict,
} from "../packages/socrates-core/src/index";

const PACKAGE_DIR = resolve(import.meta.dir, "../packages/socrates-core");

const PASSING: Answers<RubricV1> = {
  already_recorded: "new",
  end_condition: "none",
  owning_layer: "no-other-owner",
  practice: "what-the-system-is",
  reversibility: "one-way-door",
  premise_basis: "observed",
  reversal_reach: "service-contract",
  scope: "crosses-repositories",
};

const NO_FEATURES: Features<RubricV1> = {
  matches_recorded_entry: false,
  practice_wording: false,
  end_condition_wording: false,
  names_artifact: false,
  describes_mechanism: false,
  invariant_wording: false,
  multi_clause: false,
};

const NOTHING_RECORDED: FeatureContext = { recorded: [] };

// Candidates from the classifier research corpus, as the operator labelled them on review.
// Operational practice, rejected as "how some devops processes are done right now".
const PRACTICES = [
  "PR previews build with no secrets and upload from main's workflow_run file",
  "Cloudflare tokens are main-only environment secrets, never repo secrets",
  "Copy that changes a product claim ships in its own commit for owner sign-off",
  "Local workbenches are mandatory for serious development work",
  "Pragma-driven engineering signs off a target graph before any code",
];
// UI affordances and behaviour local to one module: reversed without touching anything else.
const REVERSIBLE = [
  "A step change moves focus to the new step's heading through one helper",
  "Focus, primary hover and input borders are contrast-measured tokens",
  "update() reads previous values inside its own write transaction",
  "Blob and cache exists() stays bool; an unreachable backend raises",
  "Variant-only cart lines are retitled from the catalogue",
];
// Accepted as load-bearing: a system of record, an identity, a trust boundary, a contract, a principle.
const ACCEPTED = [
  "The Org DO is the source of truth for seats, tokens and OAuth",
  "A tenant is an org we mint, bound 1:1 to a Linear workspace",
  "The Worker never executes a repro; an external runner does",
  "The events pipe is at-least-once and needs no ordering guarantee",
  "Envelope seq increases per stream; consumers dedupe on event_id",
  "The SDK ships no FastMCP server factory; remote MCP mounts are never native",
  "A check that cannot fail is prose; only a binding check counts as a rule",
  "Each invariant has one enforcing owner, a repo ast-grep rule or an eris slug",
  "OAuth grants carry no parameterised scopes; a bounded read needs a mandate",
];
// Entry ids are opaque to the rubric; these are placeholders, not an id scheme.
const RECORDED: FeatureContext = { recorded: ACCEPTED.map((text, i) => ({ id: `entry-${i}`, text })) };
const othersThan = (statement: string): FeatureContext => ({ recorded: RECORDED.recorded.filter((e) => e.text !== statement) });

describe("rubric@v1: the answer types carry no number", () => {
  it("refuses a confidence key or a numeric answer at compile time and at the schema", () => {
    /** When an answer type admits a number or an extra key, a model's self-rated confidence or impact rides into the verdict, the signal the corpus shows carries nothing: observed by tsc on the lines below (an unused @ts-expect-error fails the typecheck gate) and by the strict schema on untyped JSON. */
    // @ts-expect-error a confidence is not a rubric answer
    const withConfidence: Answers<RubricV1> = { ...PASSING, confidence: 0.9 };
    // @ts-expect-error an answer is one of its question's enum values, never a number
    const numericAnswer: Answers<RubricV1> = { ...PASSING, reversal_reach: 4 };
    const schema = answersSchema(RUBRIC_V1);
    expect(schema.safeParse(withConfidence).success).toBe(false);
    expect(schema.safeParse(numericAnswer).success).toBe(false);
    expect(schema.safeParse({ ...PASSING, scope: "everywhere" }).success).toBe(false);
    // PAIRED: the enum answers alone parse, so the refusals above are about the extra or numeric value.
    expect(schema.parse(PASSING)).toEqual(PASSING);
  });
});

describe("rubric@v1: the scorer", () => {
  it("gives the same verdict for the same answers and features, and changes neither", () => {
    /** When the scorer reads anything but its arguments (a clock, a counter, a mutated input), the server's reclassification of a stamped submission disagrees with the client's verdict: observed as repeated calls on frozen inputs. */
    const answers = Object.freeze({ ...PASSING });
    const features = Object.freeze({ ...NO_FEATURES, names_artifact: true });
    const first = score(RUBRIC_V1, answers, features);
    for (let i = 0; i < 3; i++) expect(score(RUBRIC_V1, answers, features)).toEqual(first);
    expect(first).toEqual({ kind: "load-bearing", rubric: "rubric@v1", score: 4, threshold: 3, breakdown: { reversal_reach: 4, scope: 1, names_artifact: -1 } });
  });

  it("lets the first firing gate decide, in definition order, and a bypass skips only the gate it names", () => {
    /** When gates run out of order the verdict depends on iteration accident, and when a bypass skips more than its gate an override lets a second failing gate through: observed at the verdict of a candidate two gates reject. */
    const twoGates: Answers<RubricV1> = { ...PASSING, end_condition: "has-end-condition", premise_basis: "inferred" };
    expect(score(RUBRIC_V1, twoGates, NO_FEATURES)).toEqual({ kind: "rejected", rubric: "rubric@v1", gate: "end_condition", answer: "has-end-condition" });
    expect(score(RUBRIC_V1, twoGates, NO_FEATURES, { bypass: ["end_condition"] })).toEqual({
      kind: "rerouted",
      rubric: "rubric@v1",
      gate: "premise_basis",
      answer: "inferred",
      to: "key-assumption",
    });
  });

  it("scores a change confined to its own origin below the threshold, whatever its wording", () => {
    /** When a decision whose reversal touches only the code that made it can still reach the threshold, every lock, pin and API shape the operator rejects passes again: observed at the best score such a candidate can reach. */
    const local: Answers<RubricV1> = { ...PASSING, reversal_reach: "within-origin" };
    const verdict = score(RUBRIC_V1, local, { ...NO_FEATURES, invariant_wording: true });
    expect(verdict.kind).toBe("not-load-bearing");
  });
});

describe("rubric@v1: the already-recorded, practice and reversibility gates on the corpus", () => {
  it("fires each gate on the entries the research doc labels for it, and on no other", () => {
    /** When a gate misses its label, a practice or a two-way door is filed as a load-bearing decision; when it fires on an accepted entry, a real decision is lost: observed at the verdict of every labelled corpus candidate, each answered as its label says. */
    for (const s of PRACTICES) {
      expect(score(RUBRIC_V1, { ...PASSING, practice: "how-people-work" }, extractFeatures(RUBRIC_V1, s, RECORDED))).toMatchObject({ kind: "practice", gate: "practice", to: "practices-doc" });
    }
    for (const s of REVERSIBLE) {
      expect(score(RUBRIC_V1, { ...PASSING, reversibility: "two-way-door" }, extractFeatures(RUBRIC_V1, s, RECORDED))).toMatchObject({ kind: "rejected", gate: "reversibility" });
    }
    // PAIRED: the accepted decisions, checked against every other accepted entry, pass all three gates and score as load-bearing.
    for (const s of ACCEPTED) {
      expect([s, score(RUBRIC_V1, PASSING, extractFeatures(RUBRIC_V1, s, othersThan(s))).kind]).toEqual([s, "load-bearing"]);
    }
  });

  it("fires the practice and already-recorded gates from the statement alone, whatever the model answered", () => {
    /** When only the model's answer can fire these gates, a practice the model calls system behaviour is filed for review, and a restated decision is filed twice: observed at the verdict of candidates answered as passing every gate. */
    const signOff = PRACTICES.filter((s) => extractFeatures(RUBRIC_V1, s, NOTHING_RECORDED).practice_wording);
    expect(signOff).toEqual(PRACTICES.slice(2));
    for (const s of signOff) {
      expect(score(RUBRIC_V1, PASSING, extractFeatures(RUBRIC_V1, s, RECORDED))).toEqual({
        kind: "practice",
        rubric: "rubric@v1",
        gate: "practice",
        answer: "what-the-system-is",
        feature: "practice_wording",
        to: "practices-doc",
      });
    }
    for (const s of [...ACCEPTED, ...REVERSIBLE]) expect([s, extractFeatures(RUBRIC_V1, s, NOTHING_RECORDED).practice_wording]).toEqual([s, false]);

    const restated = "The Worker never executes a reproduction; an external runner does it";
    expect(score(RUBRIC_V1, PASSING, extractFeatures(RUBRIC_V1, restated, RECORDED))).toEqual({
      kind: "rejected",
      rubric: "rubric@v1",
      gate: "already_recorded",
      answer: "new",
      feature: "matches_recorded_entry",
    });
    // PAIRED: the same statement with nothing recorded is a new decision.
    expect(score(RUBRIC_V1, PASSING, extractFeatures(RUBRIC_V1, restated, NOTHING_RECORDED)).kind).toBe("load-bearing");
  });

  it("orders the new gates: a duplicate before a practice, a practice before a two-way door, a two-way door before a Key Assumption", () => {
    /** When a two-way door is checked before the practice gate, every practice (also cheap to reverse) is rejected instead of filed to the Practices doc; when the premise gate runs first, a reversible decision becomes a Key Assumption: observed at the verdicts of candidates two gates would stop. */
    const all: Answers<RubricV1> = { ...PASSING, already_recorded: "already-recorded", practice: "how-people-work", reversibility: "two-way-door", premise_basis: "inferred" };
    expect(score(RUBRIC_V1, all, NO_FEATURES)).toMatchObject({ kind: "rejected", gate: "already_recorded" });
    expect(score(RUBRIC_V1, { ...all, already_recorded: "new" }, NO_FEATURES)).toMatchObject({ kind: "practice", gate: "practice" });
    expect(score(RUBRIC_V1, { ...all, already_recorded: "new", practice: "what-the-system-is" }, NO_FEATURES)).toMatchObject({ kind: "rejected", gate: "reversibility" });
    // A bypass of the practice gate skips its feature too, and only that gate.
    expect(score(RUBRIC_V1, PASSING, { ...NO_FEATURES, practice_wording: true }, { bypass: ["practice"] }).kind).toBe("load-bearing");
  });

  it("cannot type a practice as load-bearing, or fire a gate from a feature the rubric lacks", () => {
    /** When the verdict type lets a practice carry a score, a consumer files it as both a practice and a load-bearing decision; when a gate names a missing feature, it can never fire: observed by tsc on the lines below (an unused @ts-expect-error fails the typecheck gate). */
    const practice: Verdict<RubricV1> = { kind: "practice", rubric: "rubric@v1", gate: "practice", answer: "how-people-work", to: "practices-doc" };
    // @ts-expect-error a practice verdict carries no score: it is never also load-bearing
    const scored: Verdict<RubricV1> = { ...practice, score: 4, threshold: 3, breakdown: {} };
    // @ts-expect-error a practice goes to the Practices doc, never into review
    const filed: Verdict<RubricV1> = { ...practice, to: "review-epic" };
    defineRubric({
      version: "rubric@v99",
      threshold: 1,
      questions: {
        // @ts-expect-error firedBy names only the rubric's own features
        g: { kind: "gate", prompt: "?", answers: ["a", "b"], passes: ["a"], route: "reject", firedBy: ["missing"] },
      },
      features: { present: { description: "", points: 0, detect: () => false } },
    });
    expect([scored.kind, filed.kind]).toEqual(["practice", "practice"]);
  });
});

describe("rubric@v1: the mechanical features", () => {
  it("reads the corpus's signals from the statement", () => {
    /** When a feature stops matching the wording it names, a temporary flag or a mechanism description scores as load-bearing: observed on statements shaped like the research corpus's rejected and accepted entries. */
    expect(extractFeatures(RUBRIC_V1, "A temporary departure from the claim flow until the mandate lands.", NOTHING_RECORDED)).toMatchObject({ end_condition_wording: true });
    expect(extractFeatures(RUBRIC_V1, "MAIA_CLAIM_LINKS gates the card", NOTHING_RECORDED)).toMatchObject({ names_artifact: true });
    expect(extractFeatures(RUBRIC_V1, "The preview step builds every PR", NOTHING_RECORDED)).toMatchObject({ describes_mechanism: true });
    expect(extractFeatures(RUBRIC_V1, "The Worker never executes a reproduction.", NOTHING_RECORDED)).toEqual({ ...NO_FEATURES, invariant_wording: true });
  });
});

describe("socrates-core: what a server imports", () => {
  it("serves rubric@v1 by its stamp, and nothing for a version it does not know", () => {
    /** When the version a submission is stamped with does not resolve to its definition, the server reclassifies with the wrong rubric or none: observed at the package entry. */
    expect(rubricFor("rubric@v1")).toBe(RUBRIC_V1);
    expect(rubricFor("rubric@v999")).toBeUndefined();
  });

  it("imports only its own files and the packages its manifest declares", () => {
    /** When a package file imports outside the package or an undeclared dependency, the monorepo still builds (hoisting hides it) and the package breaks for a consumer who installs it alone; an import of a clock, filesystem or randomness module would also break the scorer's purity: observed at the import scan of each source file. */
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8"));
    const declared = new Set(Object.keys({ ...manifest.dependencies }));
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const seen = new Set<string>();
    const stray: string[] = [];
    for (const file of new Bun.Glob("src/**/*.ts").scanSync({ cwd: PACKAGE_DIR, absolute: true })) {
      for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
        seen.add(path);
        const inside = path.startsWith(".") ? resolve(dirname(file), path).startsWith(`${PACKAGE_DIR}/`) : declared.has(path);
        if (!inside) stray.push(`${relative(PACKAGE_DIR, file)} imports ${path}`);
      }
    }
    expect(stray).toEqual([]);
    // The scan sees real imports: a scanner that returned nothing would pass the check above for free.
    expect([...seen]).toEqual(expect.arrayContaining(["zod", "./definition"]));
  });
});
