/**
 * yak-redact.ts — the Yak submission redaction pass.
 *
 * Agent-authored Yak bodies are free text persisted server-side and posted
 * to an issue tracker. Redaction belongs in this CLI, which sees the material
 * first: nothing on the server can un-see it. An agent reporting a broken
 * harness may paste an env dump.
 *
 * PURE: no I/O, no filesystem, no network, no config load, no added latency.
 * `redact()` runs on `summary` / `body` / `evidence` BEFORE key derivation
 * so the Actor's re-derived key agrees with the
 * client's — deriving from unredacted text would guarantee a mismatch on
 * every report.
 *
 * ELEVEN CLASSES, applied in a fixed pipeline order, most-specific first.
 * Order is load-bearing for two reasons:
 *
 *   1. A JSON-embedded GCP private key ("private_key":"-----BEGIN...") is
 *      also a syntactic match for the generic PEM-block pattern (`[\s\S]*?`
 *      matches escaped `\n` sequences same as it matches real newlines). The
 *      GCP-specific pass runs first so that case is classified and redacted
 *      as `gcp-private-key`, not `pem`, and is never double-counted by the
 *      generic pass that follows.
 *   2. `auth-header` runs before `assignment`, because "Authorization: Bearer
 *      …" is ALSO a syntactic match for the generic NAME:value scrub (`AUTH`
 *      is in the assignment name list and `Authorization` starts with it).
 *      Running auth-header first means the marker is in place before
 *      `assignment`'s pass ever sees that text, so it is classified once, as
 *      the more specific class.
 *
 * Because each pass runs sequentially over the STRING RESULT of the previous
 * pass, and the `«redacted:<class>»` marker itself matches none of the
 * patterns below (verified in tests/yak-redact.test.ts — idempotence and
 * "marker is never re-matched"), this ordering fully prevents double
 * counting without any bespoke "already redacted" bookkeeping.
 *
 * NO CATASTROPHIC BACKTRACKING. This runs on agent-authored text of
 * arbitrary shape mid-task, so every pattern here is either a fixed-literal
 * scan, a single unambiguous character class with a quantifier, or the
 * standard `(?:[^"\\]|\\.)*` safe-JSON-string idiom (mutually exclusive
 * alternatives, no ambiguity for the engine to search). None of them nest a
 * quantified group inside another quantified group over an unbounded class —
 * the shape that produces exponential blowup. `ASSIGNMENT_RE`'s NAME group is
 * `[A-Za-z0-9_]{0,60}WORD[A-Za-z0-9_]{0,60}` — two BOUNDED, non-nested
 * quantifiers either side of a fixed-literal alternation, not a lookahead —
 * so a worst-case backtrack is O(60) per candidate `\b` position, never
 * exponential in input length. See the "pathological input" tests for the
 * exercised worst cases.
 *
 * NAME MATCHING (`ASSIGNMENT_RE`): the governed word must appear ANYWHERE inside the identifier token —
 * prefix, suffix, or infix, `_`-delimited or not — not just as the token's
 * own prefix. `_` is a `\w` character, so `\bTOKEN` never matches the
 * `TOKEN` in `GITHUB_TOKEN` (no boundary between `_` and `T`); the original
 * prefix-only pattern therefore missed the dominant real-world shape,
 * `*_TOKEN` / `*_SECRET` / `*_API_KEY` (`DATABASE_PASSWORD`, `CLERK_API_KEY`,
 * `ERIS_YAKS_TOKEN` — this CLI's own bearer — among others). The fix wraps
 * the alternation in a bounded `[A-Za-z0-9_]{0,60}` on each side instead of
 * anchoring it to the start, and the surrounding `\b`s still require the
 * WHOLE token to be an identifier (no partial match inside a longer
 * non-identifier run) — outer boundaries are unaffected by *where* in the
 * token the word sits. Case-insensitive (`gi`), which is what catches the
 * lowercase `aws_session_token` shape.
 *
 * NAME MATCHING — HYPHENATED NAMES (fixed, the same class of miss one
 * separator over): `[A-Za-z0-9_]` excludes `-`, so `x-api-key`,
 * `api-key`, and `private-key` — the standard HTTP-header and YAML-config
 * spelling — broke into non-governed halves at the hyphen (`api`/`key`,
 * `private`/`key`; neither half alone is a governed word) and shipped in
 * plaintext, even though the underscore-joined spelling (`API_KEY`,
 * `PRIVATE_KEY`) already matched. The prefix/suffix class is now
 * `[A-Za-z0-9_-]`, and the two-word alternatives (`PRIVATE_KEY`, `API_KEY`,
 * `ACCESS_KEY`, `CLIENT_SECRET`) use `[_-]` in place of a literal `_` for
 * their internal separator, so both spellings match. The single-word
 * governed terms (SECRET, TOKEN, AUTH, …) already matched a hyphenated
 * neighbor by accident before this fix — they stand alone as their own
 * hyphen-bounded identifier regardless of what the surrounding class
 * allows — which is why `client-secret`/`access-token` were never in the
 * leak list, only the two-word phrases were.
 *
 * `.` is deliberately NOT added to this class, despite being another
 * realistic dotted-config-key separator (`service.api.key`). Unlike `-`,
 * `.` is also the sentence-ending and file-extension character, and this
 * codebase's own convention — used throughout this file's comments and
 * `docs/YAK.md` — is `word.ext: description` (`yak-redact.ts: the
 * redaction pass`). Merging across `.` would turn every such reference
 * whose filename happens to start with a governed word (`auth.md: …`,
 * `token.ts: …`) into a false-positive `NAME: value` match, which is a
 * common and realistic yak-report shape, not a contrived one. `-` doesn't
 * carry that collision (English prose runs `word-word`, not
 * `sentence.-next`), so it clears the bar `.` doesn't. If a dotted-config
 * shape becomes a real, observed miss, it needs its own scoped pattern
 * (e.g. anchored to a known key vocabulary) rather than widening this
 * general-purpose class further.
 *
 * VALUE BOUND (fixed): the unquoted/quoted value alternatives are
 * bounded to 20,000 chars — `YAK_EVIDENCE_MAX_LENGTH` in
 * `yaks-schema.v1.ts`, the largest of the three redacted fields — not 4,096.
 * A value longer than the capture bound is only PARTIALLY replaced: the
 * captured prefix becomes a marker and everything past the bound survives as
 * plaintext directly after it, which is worse than no redaction (it *looks*
 * handled). This module deliberately does not import the schema constant —
 * it stays dependency-free by design (file header, "PURE") — so the bound is
 * a literal number here, with this comment as the cross-reference. If
 * `YAK_EVIDENCE_MAX_LENGTH` changes, this bound is the sibling to update.
 *
 * MINIMUM UNQUOTED VALUE LENGTH (fixed, found while rebuilding the negative
 * corpus): the unquoted value alternative requires >= 4 non-whitespace
 * chars, not >= 1. No real credential this pass targets is 1-3 characters;
 * requiring 4 is what keeps `Session: 3 of 4 workers failed to start` from
 * matching as `Session: «redacted:assignment»` (captured value `"3"`) while
 * costing nothing against any real secret shape — every positive fixture in
 * the test file is one to three orders of magnitude longer than 4 chars.
 * Quoted values keep no minimum: an explicit `"…"` or `'…'` is already a
 * stronger structural signal of an intentional value than bare unquoted text
 * is, so a short quoted value (`"token": "x"` in a JSON fixture) is left
 * alone by this rule (it may still be caught by GCP's own JSON-string
 * pattern where relevant).
 *
 * THE NAME: VALUE TRADE-OFF (deliberate, NOT "fixed" — a structural ambiguity,
 * not a bug): `seed: 4815162342 (deterministic replay)` and
 * `- SECRET_SCANNING: enabled` are syntactically indistinguishable from a
 * real `SEED=<wallet-seed>` or `CLIENT_SECRET: <credential>` assignment —
 * both are `NAME` `[:=]` `value`, and this pass has no semantic model of
 * "this NAME is a log field, that NAME is a credential." The minimum-length
 * fix above removes the cheapest false positives (single-digit/short
 * values); it does NOT and cannot resolve this class, because a real seed
 * or session value can legitimately be exactly as long as a fake one. The
 * deliberate choice: keep matching. A false positive here costs one line's
 * readability (the marker plus the surrounding sentence are still legible,
 * and `--no-redact` exists for exactly this complaint); a miss costs a
 * leaked credential. Those costs are not symmetric, so this pass is tuned
 * toward over-redaction on ambiguous `NAME: value` shapes rather than
 * under-redaction. See `tests/yak-redact.test.ts`'s "documented trade-off"
 * block, which pins this as intended behavior so a future reader sees it was
 * decided, not missed.
 *
 * AUTH SCHEME (fixed): `AUTH_HEADER_RE` matched only `Bearer|Token`, so
 * `Authorization: Basic <base64>` fell through to the generic `assignment`
 * pass, which eats only the scheme word (`AUTH` is a governed name) and
 * ships the base64 credential in plaintext. The pattern now matches ANY
 * RFC-7235-shaped scheme token (`Basic`, `Bearer`, `Digest`, `Token`,
 * `AWS4-HMAC-SHA256`, …) — always anchored to a literal `Authorization:`
 * prefix, so this cannot fire on ordinary prose that happens to contain the
 * word "authorization".
 *
 * SK- WORD BOUNDARY (fixed): `SK_KEY_RE` had no boundary before
 * `sk-`, so it matched mid-word inside `risk-assessment-methodology`,
 * `disk-cache-manager-impl`, and any other hyphenated word with `sk-`
 * inside it — a real path or a real sentence, mangled. A leading `\b` fixes
 * this: `\b` between two `\w` characters (the `i` and `s` in `risk`) never
 * holds, so `\bsk-` cannot start mid-identifier; it still matches happily
 * after whitespace, `=`, a quote, or the start of the string, which is
 * every real `sk-…` key's actual context.
 */

export type RedactionClass =
  | "pem"
  | "jwt"
  | "aws-key"
  | "github-token"
  | "slack-token"
  | "google-api-key"
  | "sk-key"
  | "auth-header"
  | "gcp-private-key"
  | "conn-string"
  | "assignment";

export interface RedactionResult {
  text: string;
  counts: Record<RedactionClass, number>;
  total: number;
}

/** Every class, in a fixed order — the single source of truth for
 *  what a fresh `counts` record looks like. */
const REDACTION_CLASSES: RedactionClass[] = [
  "pem",
  "jwt",
  "aws-key",
  "github-token",
  "slack-token",
  "google-api-key",
  "sk-key",
  "auth-header",
  "gcp-private-key",
  "conn-string",
  "assignment",
];

function emptyCounts(): Record<RedactionClass, number> {
  const counts = {} as Record<RedactionClass, number>;
  for (const c of REDACTION_CLASSES) counts[c] = 0;
  return counts;
}

function marker(cls: RedactionClass): string {
  return `«redacted:${cls}»`;
}

// --- pass definitions ------------------------------------------------------
//
// Each pass is a (RedactionClass, RegExp) pair. `re` must carry the `g` flag.
// `replace(text, counts)` runs the pass once over `text`, incrementing
// `counts[cls]` per match, and returns the transformed text. Passes that need
// to preserve surrounding structure (a capture group they must keep) supply
// a `build` function instead of relying on whole-match replacement.

interface Pass {
  cls: RedactionClass;
  re: RegExp;
  /** Given the match, return the literal replacement string. Defaults to the
   *  bare class marker (whole match replaced). */
  build?: (m: RegExpExecArray) => string;
}

// PEM private-key blocks: BEGIN...END, non-greedy across the body so a file
// with multiple keys yields one match — and one count — per key.
const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

// JWTs: three dot-separated base64url segments, header always starts "eyJ"
// (base64 of `{"`). Bounded segment lengths — no unbounded nested repetition.
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,500}\.[A-Za-z0-9_-]{10,500}\.[A-Za-z0-9_-]{10,500}/g;

// AWS: access-key ids (AKIA/ASIA + 16 alnum) and the aws_secret_access_key
// assignment, as two independent matches under one class.
const AWS_KEY_ID_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const AWS_SECRET_RE =
  /aws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{20,80}['"]?/gi;

// GitHub fine-grained/classic tokens: gh[pousr]_<alnum>{36,}.
const GITHUB_TOKEN_RE = /gh[pousr]_[A-Za-z0-9]{36,255}/g;

// Slack tokens: xox[baprs]-<alnum/hyphen>{10,}.
const SLACK_TOKEN_RE = /xox[baprs]-[A-Za-z0-9-]{10,128}/g;

// Google API keys: AIza + 35 fixed chars (39 total, per Google's own format).
const GOOGLE_API_KEY_RE = /AIza[0-9A-Za-z_-]{35}/g;

// OpenAI/Anthropic-style secret keys: sk-, sk-ant-, sk-proj-, etc. `\b`
// before `sk-` is load-bearing (see file header, "SK- WORD BOUNDARY") — it
// is what stops this from matching mid-word inside `risk-…`/`disk-…`/`task-…`.
const SK_KEY_RE = /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,120}/g;

// Authorization headers: any scheme token + bounded credential, applied
// before the generic `assignment` pass so "Authorization: <scheme> …" is
// classified once here (see file header, "AUTH SCHEME") — not just Bearer
// and Token, so `Authorization: Basic …` no longer falls through to the
// generic pass and ships its base64 credential unredacted.
const AUTH_HEADER_RE = /Authorization:\s*[A-Za-z][A-Za-z0-9._-]{0,40}\s+[^\s\r\n]{1,2048}/gi;

// GCP service-account "private_key" JSON field: the standard safe JSON-string
// idiom for the value, so the surrounding quotes and key name survive and
// only the material is replaced.
const GCP_PRIVATE_KEY_RE = /("private_key"\s*:\s*")((?:[^"\\]|\\.)*)(")/g;

// Connection strings with an inline password: proto://user:pass@host. Every
// character class excludes the next delimiter, so there is no ambiguity for
// the engine to backtrack through.
const CONN_STRING_RE =
  /[a-zA-Z][a-zA-Z0-9+.-]{0,30}:\/\/[^\s:@/]{1,255}:[^\s@/]{1,255}@[^\s/]{1,255}/g;

// Key-name assignments: NAME=value / NAME: value, case-insensitive, where
// NAME contains one of the governed words ANYWHERE in the identifier — see
// file header, "NAME MATCHING". The operator must follow only optional
// whitespace — prose like "the auth token was missing" never reaches an
// `=`/`:` and so never matches. The value is captured separately (quoted or
// a bounded non-whitespace run) so only the VALUE is replaced, keeping the
// variable name visible for triage.
//
// Group 1 is `[A-Za-z0-9_-]{0,60}` + the governed-word alternation +
// `[A-Za-z0-9_-]{0,60}` — bounded prefix AND suffix, so `SECRET_KEY`,
// `DATABASE_PASSWORD`, `ERIS_YAKS_TOKEN`, and `x-api-key` all capture their
// FULL identifier, not just the governed word itself; losing either bounded
// run from the capture would silently truncate the name in the rebuilt
// replacement. `-` is in the class (file header, "NAME MATCHING —
// HYPHENATED NAMES") for the standard HTTP-header/YAML-config spelling; the
// two-word alternatives (`PRIVATE[_-]KEY`, `API[_-]KEY`, `ACCESS[_-]KEY`,
// `CLIENT[_-]SECRET`) allow `_` OR `-` as their internal separator so
// `private-key` and `x-api-key` match the same as `PRIVATE_KEY` and
// `API_KEY` do — a literal underscore in the alternation would never match
// a hyphenated spelling no matter how permissive the surrounding class is.
//
// The value alternatives are bounded to 20,000 chars (file header, "VALUE
// BOUND") and the unquoted alternative requires >= 4 chars (file header,
// "MINIMUM UNQUOTED VALUE LENGTH").
//
// The `(?!«redacted:)` guard directly after the operator stops this pass
// from treating an EARLIER pass's marker as its "value": without it,
// "credentials: «redacted:aws-key»" (the aws-key pass having already run)
// would match here too — CREDENTIAL is a governed name, the marker has no
// internal whitespace so it satisfies the unquoted-value alternative, and
// the text would be reclassified/reprocessed as `assignment`, breaking both
// idempotence and the count for the class that actually caught it.
const GOVERNED_NAME =
  "[A-Za-z0-9_-]{0,60}(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]KEY|API[_-]KEY|CREDENTIAL|ACCESS[_-]KEY|CLIENT[_-]SECRET|MNEMONIC|SEED|SESSION|COOKIE|AUTH)[A-Za-z0-9_-]{0,60}";

// The NAME side is TWO alternatives, not one pattern with an optional
// quote — see file header, "JSON/QUOTED NAME MATCHING" for why a single
// `["']?` can't do this safely. `(?<q>["'])…\k<q>` requires the SAME quote
// character to close (so `"token'` never matches), and the unquoted
// alternative keeps its own `\b` pair — a quoted match doesn't need `\b`
// at all, because the quote character is itself an unambiguous delimiter
// no ordinary prose produces around a bare identifier.
const ASSIGNMENT_RE = new RegExp(
  `(?:(?<q>["'])(?<qname>${GOVERNED_NAME})\\k<q>|\\b(?<uname>${GOVERNED_NAME})\\b)` +
    // `['"]?` before the marker prefix (not just a bare `«redacted:`) is
    // what makes this guard work with the new quoted-value alternative
    // below: an EARLIER pass (sk-key, jwt, gcp-private-key, …) that fires
    // on a value embedded in `"api_key": "sk-ant-…"` leaves that marker
    // wrapped in its ORIGINAL quotes — `"api_key": "«redacted:sk-key»"` —
    // untouched by that pass (it only ever replaces the material INSIDE
    // the quotes, never the quotes themselves). Without the optional quote
    // here, the guard only sees a `"` immediately after the operator (not
    // the marker glyph itself), lets the quoted-value alternative consume
    // the whole `"«redacted:sk-key»"` span, and reclassifies it as the
    // generic `assignment` — corrupting a MORE specific classification
    // into a less specific one, silently, for any class that can appear
    // as a governed key's JSON value.
    `(?<sep>\\s*[:=]\\s*)(?!['"]?«redacted:)` +
    `(?<value>"(?:[^"\\\\\\r\\n]|\\\\.){0,20000}"|'(?:[^'\\\\\\r\\n]|\\\\.){0,20000}'|[^\\s,}\\]]{4,20000})`,
  "gi",
);

function runWholeMatchPass(
  text: string,
  cls: RedactionClass,
  re: RegExp,
  counts: Record<RedactionClass, number>,
): string {
  re.lastIndex = 0;
  return text.replace(re, () => {
    counts[cls]++;
    return marker(cls);
  });
}

// --- the pipeline, most-specific class first (see file header) -----------------

function runPipeline(input: string): { text: string; counts: Record<RedactionClass, number> } {
  const counts = emptyCounts();
  let text = input;

  // gcp-private-key BEFORE the generic pem pass (reason 1, file header).
  GCP_PRIVATE_KEY_RE.lastIndex = 0;
  text = text.replace(GCP_PRIVATE_KEY_RE, (_whole, prefix: string, _value: string, suffix: string) => {
    counts["gcp-private-key"]++;
    return `${prefix}${marker("gcp-private-key")}${suffix}`;
  });

  text = runWholeMatchPass(text, "pem", PEM_RE, counts);
  text = runWholeMatchPass(text, "jwt", JWT_RE, counts);

  // aws-key: two independent regexes feeding one class.
  text = runWholeMatchPass(text, "aws-key", AWS_KEY_ID_RE, counts);
  text = runWholeMatchPass(text, "aws-key", AWS_SECRET_RE, counts);

  text = runWholeMatchPass(text, "github-token", GITHUB_TOKEN_RE, counts);
  text = runWholeMatchPass(text, "slack-token", SLACK_TOKEN_RE, counts);
  text = runWholeMatchPass(text, "google-api-key", GOOGLE_API_KEY_RE, counts);
  text = runWholeMatchPass(text, "sk-key", SK_KEY_RE, counts);

  // auth-header BEFORE assignment (reason 2, file header).
  text = runWholeMatchPass(text, "auth-header", AUTH_HEADER_RE, counts);

  text = runWholeMatchPass(text, "conn-string", CONN_STRING_RE, counts);

  // assignment last: the catch-all, most likely to overlap an already-handled
  // class's surface text if run earlier.
  //
  // Named groups, not positional args: the NAME side is an alternation
  // (quoted vs. unquoted — see ASSIGNMENT_RE's definition), so exactly one
  // of `qname`/`uname` is defined per match and the other is `undefined`.
  // A quoted match reconstructs `q + qname + q` (the quotes are part of the
  // preserved NAME text, same as the original design preserved an unquoted
  // name verbatim); an unquoted match reconstructs `uname` alone.
  ASSIGNMENT_RE.lastIndex = 0;
  text = text.replace(ASSIGNMENT_RE, (...args: unknown[]) => {
    const groups = args[args.length - 1] as {
      q?: string;
      qname?: string;
      uname?: string;
      sep: string;
    };
    counts.assignment++;
    const name = groups.qname !== undefined ? `${groups.q}${groups.qname}${groups.q}` : groups.uname!;
    return `${name}${groups.sep}${marker("assignment")}`;
  });

  return { text, counts };
}

/**
 * Redact secret material from a single string. Pure, synchronous, no I/O.
 *
 * Each match is replaced with `«redacted:<class>»`. `counts` names every
 * `RedactionClass` (zero when unmatched — never an absent key) and `total` is
 * their total. Idempotent: redacting the output of `redact()` again returns the
 * same text with every count at zero (tests/yak-redact.test.ts).
 */
export function redact(text: string): RedactionResult {
  const { text: redacted, counts } = runPipeline(text);
  const total = REDACTION_CLASSES.reduce((acc, c) => acc + counts[c], 0);
  return { text: redacted, counts, total };
}

/**
 * Render one concise stderr line for a redaction pass's count/class
 * breakdown — `docs/YAK.md` promises this on stderr in text mode, not
 * only in `--output json`'s `redactions` field. Pure formatting, no policy: the caller decides WHEN to emit this
 * (`yak.ts` only calls it in text mode, and only when there is something to
 * report) — this function does not gate on `count` itself, so it stays a
 * formatter, not a decision.
 *
 * Takes the `{count, classes}` shape structurally (matches
 * `yak-submit.ts`'s `RedactionSummary` without importing it — this module
 * stays dependency-free by design, file header "PURE") rather than a full
 * `RedactionResult`, since the caller already has the summarized shape and
 * re-deriving classes from `counts` would be a second implementation of
 * `summarizeRedactionCounts` living in the wrong module.
 */
export function formatRedactionSummary(summary: { count: number; classes: RedactionClass[] }): string {
  const noun = summary.count === 1 ? "redaction" : "redactions";
  return `${summary.count} ${noun}: ${summary.classes.join(", ")}\n`;
}

/**
 * Result shape for `redactDeep()` — same `counts`/`total` contract as
 * `RedactionResult`, but `value` is the redacted structure rather than a
 * single string.
 */
export interface DeepRedactionResult<T> {
  value: T;
  counts: Record<RedactionClass, number>;
  total: number;
}

/**
 * Redact every string leaf in an arbitrary JSON-ish value (objects, arrays,
 * strings, and pass-through primitives), accumulating one combined
 * `counts`/`total` across the whole tree.
 *
 * For provenance: `provenance.git.origin_url` can carry a token
 * embedded in the URL, and this is the one function that needs to reach it
 * without the caller hand-walking the shape.
 *
 * `undefined` leaves pass through as `undefined` rather than being coerced to
 * a string — this is what keeps an absent `evidence` field absent rather than
 * becoming the four-character string `"undefined"` (the absent-vs-empty
 * discipline the submission core one layer up depends on).
 */
export function redactDeep<T>(value: T): DeepRedactionResult<T> {
  const counts = emptyCounts();

  function walk(v: unknown): unknown {
    if (typeof v === "string") {
      const r = redact(v);
      for (const c of REDACTION_CLASSES) counts[c] += r.counts[c];
      return r.text;
    }
    if (Array.isArray(v)) {
      return v.map(walk);
    }
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val);
      }
      return out;
    }
    // numbers, booleans, null, undefined — pass through unchanged.
    return v;
  }

  const redactedValue = walk(value) as T;
  const total = REDACTION_CLASSES.reduce((acc, c) => acc + counts[c], 0);
  return { value: redactedValue, counts, total };
}
