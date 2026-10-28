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
import { type Answers, answersSchema, extractFeatures, type Features, RUBRIC_V1, type RubricV1, rubricFor, score } from "../packages/socrates-core/src/index";

const PACKAGE_DIR = resolve(import.meta.dir, "../packages/socrates-core");

const PASSING: Answers<RubricV1> = {
  end_condition: "none",
  owning_layer: "no-other-owner",
  premise_basis: "observed",
  reversal_reach: "service-contract",
  scope: "crosses-repositories",
};

const NO_FEATURES: Features<RubricV1> = {
  end_condition_wording: false,
  names_artifact: false,
  describes_mechanism: false,
  invariant_wording: false,
  multi_clause: false,
};

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

describe("rubric@v1: the mechanical features", () => {
  it("reads the corpus's signals from the statement", () => {
    /** When a feature stops matching the wording it names, a temporary flag or a mechanism description scores as load-bearing: observed on statements shaped like the research corpus's rejected and accepted entries. */
    expect(extractFeatures(RUBRIC_V1, "A temporary departure from the claim flow until the mandate lands.")).toMatchObject({ end_condition_wording: true });
    expect(extractFeatures(RUBRIC_V1, "MAIA_CLAIM_LINKS gates the card")).toMatchObject({ names_artifact: true });
    expect(extractFeatures(RUBRIC_V1, "The preview step builds every PR")).toMatchObject({ describes_mechanism: true });
    expect(extractFeatures(RUBRIC_V1, "The Worker never executes a reproduction.")).toEqual({ ...NO_FEATURES, invariant_wording: true });
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
