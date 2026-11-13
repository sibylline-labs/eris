/**
 * packages/socrates-core, rubric@v3: the owning-layer and dependency-pick wording.
 *
 * Seam: the package's public entry, `extractFeatures` and `score` over a statement and a set of
 * answers, as `eris socrates classify` and the server run them.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  type Answers,
  CURRENT_RUBRIC,
  extractFeatures,
  type FeatureContext,
  RUBRIC_V2,
  RUBRIC_V3,
  type RubricV2,
  type RubricV3,
  rubricFor,
  score,
} from "../packages/socrates-core/src/index";

const NOTHING_RECORDED: FeatureContext = { recorded: [] };

/** An agent that answers every gate as passing, as one that reuses a single answer set does. */
const PASSING: Answers<RubricV3> = {
  already_recorded: "new",
  end_condition: "none",
  owning_layer: "no-other-owner",
  practice: "what-the-system-is",
  reversibility: "more-than-a-setting",
  premise_basis: "observed",
  consequence: "a-security-boundary",
};

// Shaped like operator rejects: each statement names the layer that already owns its fact.
const OWNED_REJECTS = [
  "The billing server functions only forward the session and body to the gateway and decide nothing. Each server function calls requireAccess() first (lint billing-guarded).",
  "The signing keyring is read as 'v1:<hex>,v2:<hex>', and the highest version signs. The shared config SDK already owns versioned keyring reading.",
  "A root grant is minted only for a signer built from a verified user principal, so a service principal cannot sign one; a type test with @ts-expect-error lines pins it.",
  "A bearer handle is returned once, and the store keeps only its hash. A test dumps every table and finds no handle.",
  "Revoked and wrong-org refusals use the shared catalog status, 401, rather than redeclaring them. A token whose org prefix differs from the verified org is refused before the store is read (NFR-SECURITY-1).",
  "Forged brands close where they are owned: oxlint owns a ban on `@ts-expect-error` and `@ts-ignore` in app source.",
];
const DEPENDENCY_REJECT =
  "Passkey assertion verify uses @example/webauthn-server for WebAuthn and its token signing uses jose; both were executed on the target runtime and a flipped challenge is refused.";

// Shaped like operator accepts: real decisions, some naming a type rung, a decision row, an SDK or a refusal choice.
const ACCEPTED = [
  "Before a key signs a root, the page shows the frozen request three ways, and the value displayed is the value digested and posted: a branded PreparedRoot made only by prepareRoot is the only input to the sign step.",
  "The gateway rows check the session, the Origin on writes and the org's entitlement, but not the role: who may sign a root is the Worker's decision, so its refusal reaches the page.",
  "The page shows a bearer handle once and keeps it only in component state: never the query cache, a URL, local storage, a log line or a toast. Same pattern as service tokens (minted-token-dialog).",
  "Every passkey is enrolled as discoverable, because the root assertion is requested with an empty allowCredentials. Changing either side requires changing the other.",
  "An authority refusal is a forbidden error carrying the verifier's own kebab-case code in its slug; a missing credential exits 3 authority-credential-missing without calling the verifier.",
  "The SDK carries a product-neutral authority port (core, @example/sdk/authority); a verb without authority cannot receive the context (type rung), and the context constructor is exported from no barrel.",
  "The receipt endpoint refuses (422 client_supplied) any receipt carrying its own stamp, rather than stripping it; only the gate service writes the stamp.",
  "A retry under the same comment id replays the stored stamp and never spends a second use; a different record under that id is 409.",
  "Every plan names the enforcement rung for each invariant (architecture, type, lint or test), a test row says why no rule can, and a lint row names its rule id at error severity with its test cases.",
  "Each invariant has one enforcing owner, a repo ast-grep rule or an eris slug",
  "A SQL CHECK constraint is never read as a lifecycle anchor, because the estate's own tests already pin each CHECK list to the state array.",
  "The Org DO is the source of truth for seats, tokens and OAuth",
  "A check that cannot fail is prose; only a binding check counts as a rule",
];

// Every red-teamed way of citing the layer that already owns a fact.
const OWNED_SHAPES = [
  "the ast-grep rule no-raw-sql bans it",
  "ast-grep rule no_raw_sql bans it",
  "eslint rule @typescript-eslint/no-floating-promises bans it",
  "lint rule acme/no-raw-sql bans it",
  'lint rule "no-raw-sql" bans it',
  "Enforced at lint: billing-guarded",
  "Guarded by lint `ts-no-date-parse` in CI",
  "The billing-guarded lint rule fails the build",
  "a type-level test refuses a session principal",
  "a .test-d.ts file pins the shape",
  "expectTypeOf asserts the principal type",
  "The compile-time test fails when the principal widens.",
  "Tests dump every table and assert no handle rows.",
  "Only the owner signs. A nightly integration test asserts it.",
  "The redaction is asserted by a snapshot test.",
  "The shared auth SDK owns this concern already.",
  "The platform SDK already provides the retry.",
  "The base worker already handles the CORS preflight.",
  "Canon row NFR-SECURITY-1 covers this.",
  "per NFR-S3-4 the bucket is encrypted",
  "The gateway delegates to the SDK instead of reimplementing the check.",
];
// The same words with no owner cited: decisions an operator reads.
const NOT_OWNED_SHAPES = [
  "lint pre-commit hooks run first",
  "The CLI exposes eris lint check-all as a public command",
  "Type tests run in a separate tsconfig project so the build stays fast",
  "We deviate from NFR-LATENCY-3: p99 is 800ms for the batch path because of the queue boundary.",
  "Cache invalidation is per-tenant rather than duplicating keys per region.",
  "The edge worker uses @example/sdk/authority as its only import boundary into the SDK.",
  "The latest attested contest wins.",
];

const fired = (statement: string) => {
  const f = extractFeatures(RUBRIC_V3, statement, NOTHING_RECORDED);
  return { owned: f.owned_elsewhere_wording, dependency: f.dependency_pick_wording, flag: f.flag_value_wording, end: f.end_condition_wording };
};

describe("rubric@v3: a statement that names its owning layer is not load-bearing", () => {
  it("rejects an owned-elsewhere statement at owning_layer, whatever the agent answered", () => {
    /** When the owning-layer gate fires only on '<holder> owns|holds|pins|enforces', as v2's did, a statement citing its lint rule id, its @ts-expect-error test, a test that asserts it, an SDK that already owns it or a Canon NFR row reaches review on an agent's no-other-owner answer: observed at the verdict of those statements stamped with every gate passing. */
    for (const s of OWNED_REJECTS) {
      expect([s, score(RUBRIC_V3, PASSING, extractFeatures(RUBRIC_V3, s, NOTHING_RECORDED))]).toEqual([
        s,
        { kind: "rejected", rubric: "rubric@v3", gate: "owning_layer", answer: "no-other-owner", feature: "owned_elsewhere_wording" },
      ]);
    }
  });

  it("rejects a dependency pick at reversibility", () => {
    for (const s of [
      "Assertion verify uses @example/webauthn-server and its token signing uses jose.",
      "The worker depends on @example/jose-lite, chosen for its size.",
    ]) {
      expect([s, fired(s).dependency]).toEqual([s, true]);
    }
    /** When nothing detects 'uses @scope/pkg for …', a library choice the reversibility prompt already calls setting-level reaches review on a more-than-a-setting answer: observed at the verdict of that statement stamped with every gate passing. */
    expect(score(RUBRIC_V3, PASSING, extractFeatures(RUBRIC_V3, DEPENDENCY_REJECT, NOTHING_RECORDED))).toEqual({
      kind: "rejected",
      rubric: "rubric@v3",
      gate: "reversibility",
      answer: "more-than-a-setting",
      feature: "dependency_pick_wording",
    });
  });

  it("fires on every red-teamed way of citing an owner", () => {
    /** When one citation shape is missed (a rule id after the tool, a scoped or underscored id, a type-level test, a passive test, an owner that already owns it, an NFR slug with a digit), that shape of owned fact reaches review: observed at the feature on each shape. */
    for (const s of OWNED_SHAPES) expect([s, fired(s).owned]).toEqual([s, true]);
  });

  it("keeps accepted decisions load-bearing, and fires on nothing that does not cite an owner", () => {
    /** When the v3 wording over-reaches (a type rung inside an architecture decision, a decision row, 'tests already pin', 'rather than stripping', a package path in parentheses, a decision about lint or test infrastructure itself, a deviation from an NFR), accepted decisions are rejected: observed at the verdicts and features of the accepts and the paired near-misses. */
    for (const s of ACCEPTED) {
      expect([s, fired(s)]).toEqual([s, { owned: false, dependency: false, flag: false, end: false }]);
      expect([s, score(RUBRIC_V3, PASSING, extractFeatures(RUBRIC_V3, s, NOTHING_RECORDED)).kind]).toEqual([s, "load-bearing"]);
    }
    for (const s of NOT_OWNED_SHAPES) expect([s, fired(s).owned, fired(s).dependency]).toEqual([s, false, false]);
  });
});

describe("rubric@v3 is published beside a frozen rubric@v2", () => {
  it("is the current rubric, and both resolve by their stamp", () => {
    /** When v3 is not the current rubric, classify and submit keep stamping v2; when v2 stops resolving, every submission an older client stamped is refused: observed at the package entry. */
    expect(CURRENT_RUBRIC).toBe(RUBRIC_V3);
    expect(rubricFor("rubric@v3")).toBe(RUBRIC_V3);
    expect(rubricFor("rubric@v2")).toBe(RUBRIC_V2);
  });

  it("keeps v2's definition byte for byte, its narrow wording included", () => {
    /** When v3's change edits v2 in place, every submission stamped rubric@v2 is reclassified by a rubric its client never ran: observed at the fingerprint of the published v2 definition, and at v2 still scoring an owned-elsewhere statement load-bearing. */
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(RUBRIC_V2, (_k, v: unknown) => (typeof v === "function" ? v.toString() : v)))
      .digest("hex");
    expect(fingerprint).toBe("3c3646fe0e21fec2fe050d8111f819aea34f2bad33f9981fda2fd4b812c4125d");
    const v2Passing: Answers<RubricV2> = PASSING;
    expect(score(RUBRIC_V2, v2Passing, extractFeatures(RUBRIC_V2, OWNED_REJECTS[0]!, NOTHING_RECORDED)).kind).toBe("load-bearing");
  });

  it("asks the same questions with the same answers as v2", () => {
    /** When a v3 question gains or loses an answer, a stamp built for v2's enums is refused, and a corpus replay cannot compare the versions answer for answer: observed at each question's answers. */
    const answersOf = (r: { questions: Record<string, { answers: readonly string[] }> }) => Object.fromEntries(Object.entries(r.questions).map(([id, q]) => [id, q.answers]));
    expect(answersOf(RUBRIC_V3)).toEqual(answersOf(RUBRIC_V2));
  });
});
