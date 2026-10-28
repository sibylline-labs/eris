/**
 * Keyword plus Levenshtein matching of an entry statement against existing entries: the deterministic dedupe
 * baseline that runs when no semantic matcher is available.
 *
 * A port of the Eris Yaks matcher, with the same normalisation, stopwords, length cap, bands, band-major ranking
 * and lowest-id tie-break, so both products classify the same pair of texts the same way. Pure: nothing here
 * touches storage, the clock or the network, and every function is total on its inputs.
 */

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

export type NormalizedText = {
  /** Lowercased, punctuation-stripped, whitespace-collapsed, but not stopword-filtered: Levenshtein needs the
   *  connecting words' characters to measure structural similarity. */
  normalized: string;
  /** The same tokens, pruned of stopwords and tokens shorter than 3 characters, for keyword overlap, where a
   *  function word carries no signal and would inflate overlap between unrelated texts. */
  tokens: Set<string>;
};

/**
 * Curated for short agent-authored statements, not an exhaustive stopword corpus. Extending it only makes keyword
 * matching more precise. Words shorter than 3 characters are dropped by the length filter regardless, so the list
 * holds only entries of length >= 3.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "his", "one", "our", "out", "who", "was", "has", "its", "let",
  "that", "this", "from", "they", "have", "with", "will", "would", "there",
  "their", "what", "about", "when", "which", "while", "where", "been",
  "being", "both", "each", "more", "most", "other", "some", "such", "than",
  "then", "once", "here", "into", "over", "under", "again", "further",
  "why", "how", "only", "own", "same", "too", "very", "just", "should",
  "now", "also", "upon", "per", "via", "does", "did", "doing", "having",
  "were", "any", "off", "yet", "still",
]);

const MIN_TOKEN_LENGTH = 3;

/**
 * Lowercase, strip punctuation, collapse whitespace, drop stopwords and short tokens. Splitting on any run of
 * non-letter, non-digit characters (Unicode-aware) does the stripping and collapsing in one pass, so
 * `"Device  disconnected!! (again)"` and `"device disconnected again"` tokenize identically.
 */
export function normalize(text: string): NormalizedText {
  const allTokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/gu)
    .filter((token) => token.length > 0);
  const normalized = allTokens.join(" ");
  const tokens = new Set(
    allTokens.filter((token) => token.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(token)),
  );
  return { normalized, tokens };
}

// ---------------------------------------------------------------------------
// keywordScore
// ---------------------------------------------------------------------------

/**
 * Overlap coefficient (`|A ∩ B| / min(|A|, |B|)`), not Jaccard: a terse restatement whose tokens are a subset of a
 * longer entry's should score close to 1, not be diluted by the longer text's extra vocabulary. Either token set
 * empty scores 0, never NaN.
 */
export function keywordScore(a: string, b: string): number {
  return tokenOverlap(normalize(a).tokens, normalize(b).tokens);
}

function tokenOverlap(tokensA: ReadonlySet<string>, tokensB: ReadonlySet<string>): number {
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }
  return intersection / Math.min(tokensA.size, tokensB.size);
}

// ---------------------------------------------------------------------------
// levenshtein / levenshteinSimilarity
// ---------------------------------------------------------------------------

/**
 * The normalized string is truncated to this length before the O(n·m) edit-distance table runs, so a
 * pathological input costs a coarser score, never unbounded CPU on the single-threaded caller.
 */
export const LEVENSHTEIN_MAX_INPUT_LENGTH = 256;

function capLength(text: string): string {
  return text.length > LEVENSHTEIN_MAX_INPUT_LENGTH ? text.slice(0, LEVENSHTEIN_MAX_INPUT_LENGTH) : text;
}

/** Edit distance in O(min(n, m)) space: only the previous row is needed, and no alignment is returned. */
function levenshteinDistance(a: string, b: string): number {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const width = shorter.length;

  let previousRow = new Array<number>(width + 1);
  let currentRow = new Array<number>(width + 1);
  for (let j = 0; j <= width; j++) previousRow[j] = j;

  for (let i = 1; i <= longer.length; i++) {
    currentRow[0] = i;
    const longerChar = longer[i - 1];
    for (let j = 1; j <= width; j++) {
      const cost = longerChar === shorter[j - 1] ? 0 : 1;
      currentRow[j] = Math.min(
        previousRow[j] + 1, // deletion
        currentRow[j - 1] + 1, // insertion
        previousRow[j - 1] + cost, // substitution
      );
    }
    [previousRow, currentRow] = [currentRow, previousRow];
  }
  return previousRow[width];
}

/**
 * Edit distance between two texts after `normalize()` and the length cap. Normalizing first keeps this signal
 * comparable to `keywordScore`: both ignore case and punctuation.
 */
export function levenshtein(a: string, b: string): number {
  return levenshteinDistance(capLength(normalize(a).normalized), capLength(normalize(b).normalized));
}

/** `1 - distance / maxLength`, in `[0, 1]`; two texts that normalize to the empty string score 1, not NaN. */
export function levenshteinSimilarity(a: string, b: string): number {
  return cappedSimilarity(capLength(normalize(a).normalized), capLength(normalize(b).normalized));
}

function cappedSimilarity(cappedA: string, cappedB: string): number {
  const distance = levenshteinDistance(cappedA, cappedB);
  const maxLength = Math.max(cappedA.length, cappedB.length);
  return maxLength === 0 ? 1 : 1 - distance / maxLength;
}

/**
 * An upper bound on `cappedSimilarity` from the lengths alone: edit distance is at least the length gap. Written in
 * the same expression shape as `cappedSimilarity` so IEEE monotonicity keeps the bound >= the exact value.
 */
function similarityUpperBound(lengthA: number, lengthB: number): number {
  const maxLength = Math.max(lengthA, lengthB);
  return maxLength === 0 ? 1 : 1 - (maxLength - Math.min(lengthA, lengthB)) / maxLength;
}

// ---------------------------------------------------------------------------
// classifyMatch
// ---------------------------------------------------------------------------

export type MatchConfig = {
  keyword_strong: number;
  keyword_possible: number;
  levenshtein_strong: number;
  levenshtein_possible: number;
};

/** The Eris Yaks defaults. Callers with an org policy pass their own thresholds. */
export const MATCH_DEFAULTS: MatchConfig = {
  keyword_strong: 0.6,
  keyword_possible: 0.3,
  levenshtein_strong: 0.85,
  levenshtein_possible: 0.6,
};

export type MatchKind = "strong" | "possible" | "none";

export type MatchResult = {
  kind: MatchKind;
  /** The winning entry's id, or null when nothing reached the possible band. */
  id: string | null;
  /** The actual scores and which rule fired, as prose a reviewer reads directly. */
  why: string;
};

/** What matching reads from an existing entry: its identity and its text. */
export type MatchCandidate = { id: string; text: string };

const fmt = (n: number): string => n.toFixed(2);

type ScoredCandidate = {
  candidate: MatchCandidate;
  keyword: number;
  levenshteinSim: number;
  kind: MatchKind;
};

function bandFor(keyword: number, levenshteinSim: number, thresholds: MatchConfig): MatchKind {
  if (keyword >= thresholds.keyword_strong || levenshteinSim >= thresholds.levenshtein_strong) {
    return "strong";
  }
  if (keyword >= thresholds.keyword_possible || levenshteinSim >= thresholds.levenshtein_possible) {
    return "possible";
  }
  return "none";
}

function describeMatch(entry: ScoredCandidate, thresholds: MatchConfig): string {
  const kwThreshold = entry.kind === "strong" ? thresholds.keyword_strong : thresholds.keyword_possible;
  const levThreshold =
    entry.kind === "strong" ? thresholds.levenshtein_strong : thresholds.levenshtein_possible;
  const keywordFired = entry.keyword >= kwThreshold;
  const levenshteinFired = entry.levenshteinSim >= levThreshold;
  const firedBy =
    keywordFired && levenshteinFired
      ? "both keyword overlap and Levenshtein similarity"
      : keywordFired
        ? "keyword overlap"
        : "Levenshtein similarity";
  return (
    `${entry.kind} match against entry ${entry.candidate.id}: ` +
    `keyword overlap ${fmt(entry.keyword)} (${entry.kind} threshold ${fmt(kwThreshold)}), ` +
    `Levenshtein similarity ${fmt(entry.levenshteinSim)} (${entry.kind} threshold ${fmt(levThreshold)}) — ` +
    `${firedBy} crossed the ${entry.kind} band`
  );
}

function describeNoMatch(entry: ScoredCandidate | undefined, thresholds: MatchConfig): string {
  if (entry === undefined) {
    return "no existing entries to compare against";
  }
  return (
    `no entry reached the possible band — closest candidate ${entry.candidate.id} scored ` +
    `keyword overlap ${fmt(entry.keyword)} (possible threshold ${fmt(thresholds.keyword_possible)}), ` +
    `Levenshtein similarity ${fmt(entry.levenshteinSim)} ` +
    `(possible threshold ${fmt(thresholds.levenshtein_possible)})`
  );
}

/** Band order for ranking: strong always outranks possible, which always outranks none. */
const BAND_RANK: Record<MatchKind, number> = { strong: 2, possible: 1, none: 0 };

/**
 * The single best-matching entry, or `none` when nothing crosses the possible band.
 *
 * A candidate's band is an OR across the two signals: a paraphrase with no shared vocabulary can match on
 * Levenshtein alone, and the same keywords rearranged can match on keyword overlap alone.
 *
 * Ranking is band-major: a strong candidate beats a possible one whatever their raw scores, because a lower-band
 * winner joins the wrong entry. Within a band, ties break by score, then by lowest id, never by input order.
 */
export function classifyMatch(
  text: string,
  candidates: readonly MatchCandidate[],
  thresholds: MatchConfig,
): MatchResult {
  if (candidates.length === 0) {
    return { kind: "none", id: null, why: describeNoMatch(undefined, thresholds) };
  }

  // Every candidate gets its exact band. Levenshtein is skipped only where the length gap alone proves similarity
  // is below both Levenshtein thresholds, so the bound and the exact value give the same band. (Both thresholds,
  // because nothing enforces possible < strong.)
  const incoming = prepare(text);
  const levenshteinFloor = Math.min(thresholds.levenshtein_possible, thresholds.levenshtein_strong);
  const entries: Pending[] = candidates.map((candidate) => {
    const prepared = prepare(candidate.text);
    const keyword = tokenOverlap(incoming.tokens, prepared.tokens);
    const bound = similarityUpperBound(incoming.capped.length, prepared.capped.length);
    const exact = bound >= levenshteinFloor;
    const levenshteinSim = exact ? cappedSimilarity(incoming.capped, prepared.capped) : bound;
    return {
      candidate,
      keyword,
      levenshteinSim,
      kind: bandFor(keyword, levenshteinSim, thresholds),
      exact,
      capped: prepared.capped,
    };
  });

  // Only the top band can hold the winner. Within it, an inexact entry's score is an upper bound, so visit
  // entries in (score desc, id asc) order and stop once no remaining entry can beat the best exact one. Every
  // entry that could win is scored exactly first, so the winner and its printed scores match a full scoring.
  let topRank = 0;
  for (const entry of entries) topRank = Math.max(topRank, BAND_RANK[entry.kind]);
  const contenders = entries
    .filter((entry) => BAND_RANK[entry.kind] === topRank)
    .sort((x, y) => scoreOf(y) - scoreOf(x) || compareIds(x.candidate.id, y.candidate.id));

  let best: Pending | undefined;
  for (const entry of contenders) {
    if (best !== undefined) {
      const bound = scoreOf(entry);
      const bestScore = scoreOf(best);
      if (bound < bestScore || (bound === bestScore && compareIds(entry.candidate.id, best.candidate.id) > 0)) break;
    }
    if (!entry.exact) {
      entry.levenshteinSim = cappedSimilarity(incoming.capped, entry.capped);
      entry.exact = true;
    }
    if (best === undefined || ranksBefore(entry, best)) best = entry;
  }

  const winner = best!;
  if (winner.kind === "none") {
    return { kind: "none", id: null, why: describeNoMatch(winner, thresholds) };
  }
  return { kind: winner.kind, id: winner.candidate.id, why: describeMatch(winner, thresholds) };
}

function prepare(text: string): { tokens: Set<string>; capped: string } {
  const normalized = normalize(text);
  return { tokens: normalized.tokens, capped: capLength(normalized.normalized) };
}

/** A scored candidate whose `levenshteinSim` is exact, or (`exact: false`) the upper bound standing in for it. */
type Pending = ScoredCandidate & { exact: boolean; capped: string };

const scoreOf = (entry: ScoredCandidate): number => Math.max(entry.keyword, entry.levenshteinSim);

function compareIds(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Within one band: higher score first, then lowest id. */
function ranksBefore(x: ScoredCandidate, y: ScoredCandidate): boolean {
  const scoreDiff = scoreOf(x) - scoreOf(y);
  return scoreDiff !== 0 ? scoreDiff > 0 : compareIds(x.candidate.id, y.candidate.id) < 0;
}
