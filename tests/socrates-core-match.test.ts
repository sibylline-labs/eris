/**
 * packages/socrates-core matching, ported case for case from the Eris Yaks matcher's own suite.
 *
 * Seam: the package's public entry, the same functions the tenant actor calls to dedupe a new statement against
 * existing entries. The fixture strings and expected outcomes are yak's, unchanged; only the candidate shape
 * (`{ id, text }`) and the result field (`id`) are renamed. Red when the port diverges from yak's behaviour on any
 * of them: a different band, a different winner, a ranking that depends on input order, or an unbounded cost.
 */
import { describe, expect, test } from "bun:test";
import {
  classifyMatch,
  keywordScore,
  LEVENSHTEIN_MAX_INPUT_LENGTH,
  levenshtein,
  levenshteinSimilarity,
  MATCH_DEFAULTS,
  type MatchCandidate,
  normalize,
} from "../packages/socrates-core/src/index";

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

describe("normalize", () => {
  test("lowercases, strips punctuation, and collapses whitespace into the normalized string", () => {
    const { normalized } = normalize("Device  DISCONNECTED!!  (again)");
    expect(normalized).toBe("device disconnected again");
  });

  test("drops stopwords and sub-3-char tokens from the token set, but keeps them in normalized", () => {
    const { normalized, tokens } = normalize("The device is off and it will not boot");
    // normalized keeps every word — used for Levenshtein, which needs the
    // connecting words' characters to measure structural similarity.
    expect(normalized).toBe("the device is off and it will not boot");
    // tokens drops "the"/"is"/"and"/"it"/"not" (stopwords) and "off" survives
    // (3 chars, not a stopword) — "will"/"not" are stopwords, "boot"/"device"
    // are content words.
    expect(tokens.has("the")).toBeFalse();
    expect(tokens.has("and")).toBeFalse();
    expect(tokens.has("not")).toBeFalse();
    expect(tokens.has("device")).toBeTrue();
    expect(tokens.has("boot")).toBeTrue();
    // "is", "it" are under 3 chars and dropped regardless of the stopword list.
    expect(tokens.has("is")).toBeFalse();
    expect(tokens.has("it")).toBeFalse();
  });

  test("an all-stopword/short-token summary normalizes to an empty token set, not an error", () => {
    const { tokens } = normalize("it is on at");
    expect(tokens.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// keywordScore
// ---------------------------------------------------------------------------

describe("keywordScore", () => {
  test("identical (post-normalization) summaries score 1.0", () => {
    expect(keywordScore("Device disconnects during power cycle", "device disconnects during power cycle")).toBe(1);
  });

  test("a terse follow-up whose tokens are a strict subset of a longer summary scores near 1.0", () => {
    // Overlap coefficient (|A∩B| / min(|A|,|B|)), not Jaccard — a subset
    // relationship should score high regardless of the longer summary's
    // extra vocabulary, which is exactly the terser-follow-up-report case
    // matching exists to catch.
    const score = keywordScore(
      "device disconnects",
      "device disconnects repeatedly during the nightly power cycle test",
    );
    expect(score).toBe(1);
  });

  test("disjoint vocabularies score 0", () => {
    expect(keywordScore("device disconnects during power cycle", "database migration timed out")).toBe(0);
  });

  test("either summary normalizing to an empty token set scores 0, not NaN", () => {
    expect(keywordScore("it is on at", "device disconnects during power cycle")).toBe(0);
    expect(keywordScore("it is on at", "to of in")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// levenshtein / levenshteinSimilarity
// ---------------------------------------------------------------------------

describe("levenshtein / levenshteinSimilarity", () => {
  test("identical strings have distance 0 and similarity 1", () => {
    expect(levenshtein("device disconnects", "device disconnects")).toBe(0);
    expect(levenshteinSimilarity("device disconnects", "device disconnects")).toBe(1);
  });

  test("known small edit distance is exact (classic example)", () => {
    // kitten -> sitten (substitute k/s) -> sittin (substitute e/i) -> sitting
    // (insert g): 3 edits, the textbook kitten/sitting distance.
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });

  test("case and punctuation differences don't affect the score — normalized first", () => {
    expect(levenshtein("Device Disconnects!", "device disconnects")).toBe(0);
  });

  test("two empty (post-normalization) strings are trivially identical, not NaN", () => {
    expect(levenshteinSimilarity("!!!", "???")).toBe(1);
  });

  test("completely different strings of equal length have low similarity", () => {
    const sim = levenshteinSimilarity("abcdefgh", "zyxwvuts");
    expect(sim).toBeLessThan(0.2);
  });

  describe("the length cap — CPU-exhaustion defense", () => {
    test("a pathological input stays bounded and fast, not merely 'returns'", () => {
      const huge = "a".repeat(500_000);
      const otherHuge = "b".repeat(500_000);
      const start = performance.now();
      const distance = levenshtein(huge, otherHuge);
      const elapsedMs = performance.now() - start;

      // Proves the cap actually ran the DP matrix on capped input, not the
      // full 500,000-char strings: an uncapped O(n·m) run at this size is
      // ~250 BILLION cell writes and would not complete in any reasonable
      // test timeout, let alone under a generous smoke bound.
      expect(elapsedMs).toBeLessThan(500);
      // Distance between the capped strings can never exceed the cap itself.
      expect(distance).toBeLessThanOrEqual(LEVENSHTEIN_MAX_INPUT_LENGTH);
    });

    test("two inputs that only DIFFER past the cap boundary are indistinguishable", () => {
      // Directly proves truncation happened (not just "didn't hang"): if the
      // cap didn't apply, appending different suffixes past the boundary
      // would change the distance. It doesn't.
      const base = "x".repeat(LEVENSHTEIN_MAX_INPUT_LENGTH);
      const withSuffixA = base + "AAAAAAAAAA";
      const withSuffixB = base + "ZZZZZZZZZZZZZZZZZZZZ";
      expect(levenshtein(base, withSuffixA)).toBe(levenshtein(base, withSuffixB));
    });
  });
});

// ---------------------------------------------------------------------------
// classifyMatch — the three bands, and the case they're combined for
// ---------------------------------------------------------------------------

const cluster = (id: string, text: string): MatchCandidate => ({ id, text });

describe("classifyMatch — the three bands are provably distinct", () => {
  test("strong: near-identical summary, both signals high", () => {
    const result = classifyMatch(
      "device disconnects during nightly power cycle",
      [cluster("c-1", "device disconnects during the nightly power cycle")],
      MATCH_DEFAULTS,
    );
    expect(result.kind).toBe("strong");
    expect(result.id).toBe("c-1");
  });

  test("possible: partial keyword overlap (0.4), Levenshtein similarity below its own possible band (0.53)", () => {
    // Neither signal alone reaches "strong"; keyword overlap alone clears
    // "possible" (0.4 >= 0.3 keyword_possible) while Levenshtein (0.53) stays
    // under even ITS possible floor (0.6) — the overall band is decided by
    // keyword overlap, not Levenshtein, on this fixture.
    const result = classifyMatch(
      "the device disconnects randomly during use",
      [cluster("c-1", "the cable device disconnects intermittently when idle")],
      MATCH_DEFAULTS,
    );
    expect(result.kind).toBe("possible");
    expect(result.id).toBe("c-1");
  });

  test("none: unrelated summary, both signals low", () => {
    const result = classifyMatch(
      "database migration timed out during rollout",
      [cluster("c-1", "device disconnects during nightly power cycle")],
      MATCH_DEFAULTS,
    );
    expect(result.kind).toBe("none");
    expect(result.id).toBeNull();
  });

  test("no existing clusters at all is 'none' with a distinct why", () => {
    const result = classifyMatch("anything at all", [], MATCH_DEFAULTS);
    expect(result.kind).toBe("none");
    expect(result.id).toBeNull();
    expect(result.why).toContain("no existing entries");
  });
});

describe("classifyMatch — why is not decorative", () => {
  test("why states the actual scores and names which rule fired, for a match", () => {
    const result = classifyMatch(
      "device disconnects during nightly power cycle",
      [cluster("c-1", "device disconnects during the nightly power cycle")],
      MATCH_DEFAULTS,
    );
    expect(result.why).toContain("c-1");
    expect(result.why).toMatch(/keyword overlap \d\.\d\d/);
    expect(result.why).toMatch(/Levenshtein similarity \d\.\d\d/);
    expect(result.why).toContain("strong");
  });

  test("why states the actual scores for a non-match too", () => {
    const result = classifyMatch(
      "database migration timed out",
      [cluster("c-1", "device disconnects during nightly power cycle")],
      MATCH_DEFAULTS,
    );
    expect(result.why).toMatch(/keyword overlap \d\.\d\d/);
    expect(result.why).toMatch(/Levenshtein similarity \d\.\d\d/);
  });
});

describe("classifyMatch — the case the combined (OR) rule exists for: signals disagree", () => {
  test("high keyword overlap, low Levenshtein similarity — keyword score alone triggers the match", () => {
    // Same salient words, very different character arrangement/length — a
    // corpus of only-agreeing fixtures could never distinguish this from an
    // AND rule.
    const a = "disk full cleanup failed nightly job";
    const b = "nightly cleanup job reported that disk is completely full and the operation failed";
    const kw = keywordScore(a, b);
    const lev = levenshteinSimilarity(a, b);
    expect(kw).toBeGreaterThanOrEqual(MATCH_DEFAULTS.keyword_possible);
    expect(lev).toBeLessThan(MATCH_DEFAULTS.levenshtein_possible);

    const result = classifyMatch(a, [cluster("c-1", b)], MATCH_DEFAULTS);
    expect(result.kind).not.toBe("none");
    expect(result.why).toContain("keyword overlap");
  });

  test("high Levenshtein similarity, ZERO keyword overlap — Levenshtein alone triggers the match", () => {
    // A typo in every content word: "pwoer"/"discnnects" share no TOKEN with
    // "power"/"disconnects" (keyword matching is exact, so a
    // one-character typo makes the whole token a miss) but the CHARACTER
    // distance is tiny. This is the sharpest possible disagreement — keyword
    // overlap is exactly 0 while Levenshtein similarity clears the possible
    // band — and it's a realistic case: an agent re-reporting the same fault
    // with a typo it didn't have last time.
    const a = "the pwoer discnnects agian";
    const b = "the power disconnects again";
    const kw = keywordScore(a, b);
    const lev = levenshteinSimilarity(a, b);
    expect(kw).toBe(0);
    expect(lev).toBeGreaterThanOrEqual(MATCH_DEFAULTS.levenshtein_possible);

    const result = classifyMatch(a, [cluster("c-1", b)], MATCH_DEFAULTS);
    expect(result.kind).not.toBe("none");
    expect(result.why).toContain("Levenshtein similarity");
  });
});

describe("classifyMatch — band ranks before score (a strong match never loses to a higher-scoring possible one)", () => {
  // Recreation of the shipped defect: sorting candidates by raw
  // max(keyword, levenshtein) score, THEN band, lets a `possible`-band
  // candidate with a higher raw score outrank a `strong`-band candidate with
  // a lower one. That is a mis-triage — the observation joins the wrong
  // cluster's lineage — not a near-miss, and it's the NORMAL production path
  // (the actor calls classifyMatch with every candidate cluster of a kind).
  //
  // The prior multi-candidate fixtures above (the tie-break tests) only ever
  // compare candidates whose bands AGREE, or where the loser is `none` — a
  // shape that a purely score-major sort satisfies identically to a
  // band-major one. These fixtures are constructed so ONLY a band-major sort
  // passes: the "strong" candidate's raw score is deliberately the LOWER of
  // the two.
  const report = "database connection pool exhausted under load";
  // kw=0.60, lev=0.58 (max=0.60) — crosses keyword_strong (0.60) exactly, so
  // this candidate's band is strong.
  const strongLowScore = "database connection pool issue reported yesterday afternoon";
  // kw=0.00, lev=0.74 (max=0.74) — HIGHER raw score than strongLowScore
  // above, but stays under levenshtein_strong (0.85), so this candidate's
  // band is only possible.
  const possibleHighScore = "databasee conection pol exhosted andar loade nowe";

  test("a strong candidate with a lower raw score still beats a possible candidate with a higher one", () => {
    const kw = keywordScore(report, strongLowScore);
    const lev = levenshteinSimilarity(report, strongLowScore);
    const kwOther = keywordScore(report, possibleHighScore);
    const levOther = levenshteinSimilarity(report, possibleHighScore);
    // Pin the premise the rest of the test depends on: strongLowScore really
    // is `strong`, possibleHighScore really is `possible`-only, and the
    // latter's raw score really is higher. If normalize()/keywordScore()/
    // levenshteinSimilarity() ever drift, this fails here with a clear
    // signal rather than silently changing what the test below proves.
    expect(Math.max(kw, lev)).toBeGreaterThanOrEqual(MATCH_DEFAULTS.keyword_strong);
    expect(Math.max(kwOther, levOther)).toBeLessThan(MATCH_DEFAULTS.levenshtein_strong);
    expect(Math.max(kwOther, levOther)).toBeGreaterThan(Math.max(kw, lev));

    const result = classifyMatch(
      report,
      [cluster("possible-higher-score", possibleHighScore), cluster("strong-lower-score", strongLowScore)],
      MATCH_DEFAULTS,
    );
    expect(result.kind).toBe("strong");
    expect(result.id).toBe("strong-lower-score");
  });

  test("input order doesn't matter — band-major ranking, not array position, decides the winner", () => {
    const result = classifyMatch(
      report,
      [cluster("strong-lower-score", strongLowScore), cluster("possible-higher-score", possibleHighScore)],
      MATCH_DEFAULTS,
    );
    expect(result.kind).toBe("strong");
    expect(result.id).toBe("strong-lower-score");
  });

  test("three candidates (strong / possible / none): band order wins even though score order disagrees with it", () => {
    // noneCand's raw score is, by construction of the bands (none requires
    // BOTH kw < keyword_possible AND lev < levenshtein_possible), always
    // strictly below strongLowScore's 0.60 — a full none-highest-score
    // reversal across all three bands is mathematically impossible, since
    // `strong`'s floor (>=0.60) and `none`'s ceiling (<0.60) can't cross. The
    // meaningful, and constructible, reversal is between strong and possible
    // (proven above); this fixture additionally proves a `none` candidate
    // never surfaces or interferes once a real disagreement is in play.
    const noneCand = "user interface button color changed unexpectedly yesterday";
    const kwNone = keywordScore(report, noneCand);
    const levNone = levenshteinSimilarity(report, noneCand);
    expect(kwNone).toBeLessThan(MATCH_DEFAULTS.keyword_possible);
    expect(levNone).toBeLessThan(MATCH_DEFAULTS.levenshtein_possible);

    const result = classifyMatch(
      report,
      [
        cluster("possible-higher-score", possibleHighScore),
        cluster("none-cand", noneCand),
        cluster("strong-lower-score", strongLowScore),
      ],
      MATCH_DEFAULTS,
    );
    expect(result.kind).toBe("strong");
    expect(result.id).toBe("strong-lower-score");
  });
});

describe("classifyMatch — deterministic tie-breaking, never array order", () => {
  test("equal-score candidates resolve to the lowest cluster id, regardless of input order", () => {
    const candidates: MatchCandidate[] = [
      cluster("cluster-b", "device disconnects during power cycle"),
      cluster("cluster-a", "device disconnects during power cycle"),
    ];
    const forward = classifyMatch("device disconnects during power cycle", candidates, MATCH_DEFAULTS);
    const reversed = classifyMatch(
      "device disconnects during power cycle",
      [...candidates].reverse(),
      MATCH_DEFAULTS,
    );
    expect(forward.id).toBe("cluster-a");
    expect(reversed.id).toBe("cluster-a");
  });

  test("a strictly higher-scoring candidate wins over a lower-scoring one with a lexically smaller id", () => {
    const candidates: MatchCandidate[] = [
      cluster("aaa-lower-score", "totally unrelated summary about database migrations"),
      cluster("zzz-higher-score", "device disconnects during power cycle"),
    ];
    const result = classifyMatch("device disconnects during power cycle", candidates, MATCH_DEFAULTS);
    expect(result.id).toBe("zzz-higher-score");
  });
});

describe("classifyMatch — cost at a realistic cluster count", () => {
  test("5,000 clusters classify within a drain-row budget", () => {
    // `classifyMatch` runs once per drained row against EVERY cluster of a kind,
    // on the single-threaded actor that also serves ingress. When per-cluster
    // cost regresses (re-normalizing per comparison, Levenshtein on pairs the
    // length gap already rules out), a 25-row batch at this size stalls the
    // actor — this goes red on the budget. Generous so CI runners don't flake.
    const vocabulary = [
      "device", "disconnect", "timeout", "database", "pool", "exhausted", "worker", "crash",
      "token", "expired", "cache", "deploy", "schema", "drift", "alarm", "queue",
    ];
    const clusters: MatchCandidate[] = Array.from({ length: 5_000 }, (_, i) => {
      const words = Array.from({ length: 3 + (i % 12) }, (_, j) => vocabulary[(i * 7 + j * 13) % vocabulary.length]);
      return cluster(`cluster-${String(i).padStart(5, "0")}`, `${words.join(" ")} ${i}`);
    });

    const start = performance.now();
    const result = classifyMatch("worker crash on deploy after schema drift", clusters, MATCH_DEFAULTS);
    const elapsedMs = performance.now() - start;

    expect(result.kind).not.toBe("none");
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
