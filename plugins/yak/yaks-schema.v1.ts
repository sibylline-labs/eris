// Vendored Yaks wire contract — yaks-schema.v1.ts (YAKS_CONTRACT_VERSION 1.0.0). The server owns it; re-vendor on a contract change.
/**
 * Yaks — wire contract
 *
 * YAKS_CONTRACT_VERSION 1.0.0
 *
 * Coordination artifact for the Yaks framework — the small, agent-facing
 * ingress that turns a durably-submitted report (an "issue", an improvement
 * "suggest", or a harness "fatal") into a deduplicated tracker issue, with a
 * cluster's lineage surviving issue closure. Two halves are built against this
 * one file: the server owns the Actor, matching and the tracker transports;
 * the CLI (`eris`) owns submission and local idempotency-key derivation.
 * Consumers vendor this file and check it with contract tests
 * (`tests/yaks-contract.test.ts`).
 *
 * Design invariants it encodes:
 *  - Exactly three verbs: `issue`, `suggest`, `fatal`. No open
 *    vocabulary — a fourth verb is a change to this file.
 *  - A submission is immutable once accepted: `YakSubmission` is
 *    written once as the `data` blob on a `YakObservation` and never rewritten.
 *    Everything that changes as an observation is processed — status,
 *    attempts, cluster_id, last_error — lives in sibling fields, not inside
 *    the submission itself.
 *  - The idempotency key is SERVER-authoritative: the client may send one,
 *    advisory only; the server always re-derives it from the payload it
 *    actually received via `deriveIdempotencyKey` below, and that derived
 *    value is what the receipt reports and what dedup keys off.
 *  - Bounded free text: `summary`, `body`, and `evidence` are
 *    agent-authored and otherwise unbounded — this contract enforces sane
 *    maxima at the door as a validation failure (400), never a silent
 *    truncation, because a server-side truncation would desynchronize the
 *    stored payload from the client's own idempotency-key derivation.
 *  - `provenance` is explicitly best-effort: a permissive record, never a
 *    gate. A submission with none of it populated is still a valid submission.
 *  - Closed vocabularies are never guessed; extending one is a change to this
 *    file.
 */

import { z } from "zod";

/** The single version this repo EMITS on every receipt — the version a fresh
 *  CLI should send. */
export const YAKS_CONTRACT_VERSION = "1.0.0";

/**
 * The write plane's version window — structured as a tuple from day one, not a
 * bare `z.literal(YAKS_CONTRACT_VERSION)`, even though it holds exactly one
 * member today. `schema/graph-schema.v0.ts`'s `ACCEPTED_SCHEMA_VERSIONS` is the
 * precedent and the reason (see this repo's README "Contract" section): a bare
 * literal bump rejects every in-flight submission from a CLI that has not yet
 * re-vendored the new contract, the instant the new version deploys — the
 * server's whole ingress path failing closed on a contract change the CLI
 * never saw. A tuple makes the fix at the NEXT bump a one-element addition
 * (`["1.0.0", "1.1.0"]`) instead of an emergency literal swap.
 *
 * When `YAKS_CONTRACT_VERSION` bumps: append the new version, don't replace
 * the old one. Narrow back to a single element only after every vendored copy
 * (the CLI in eris, and any other consumer) has re-vendored.
 */
export const ACCEPTED_YAKS_VERSIONS = ["1.0.0"] as const;

/** The write plane's version check. A response (`YakReceipt.contract_version`)
 *  keeps a literal: a receipt carries the one version that produced it. */
export const AcceptedYaksVersion = z.enum(ACCEPTED_YAKS_VERSIONS);

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

/** Exactly these three — closed, not extensible without a PR to
 *  this file:
 *   issue   — a harness defect the agent hit, confirmed or suspected
 *   suggest — an improvement to the harness (missing capability, better default)
 *   fatal   — the harness itself is broken; pages via the incident sink,
 *             and clusters SEPARATELY from issue/suggest */
export const YakVerb = z.enum(["issue", "suggest", "fatal"]);
export type YakVerb = z.infer<typeof YakVerb>;

/** Processing state of a stored observation. The `data` blob (the original
 *  `YakSubmission`) never changes; this is the only part of an observation row
 *  that does. */
export const YakObservationStatus = z.enum(["pending", "processed", "failed"]);
export type YakObservationStatus = z.infer<typeof YakObservationStatus>;

/** A cluster's kind mirrors the verb partition it exists for:
 *  `fatal` clusters never merge with `report` clusters (the `issue`/`suggest`
 *  pool), because only `fatal` pages and a shared lineage would have to pick
 *  one paging behaviour for both. */
export const YakClusterKind = z.enum(["fatal", "report"]);
export type YakClusterKind = z.infer<typeof YakClusterKind>;

// ---------------------------------------------------------------------------
// Bounded free text
// ---------------------------------------------------------------------------

/**
 * Length ceilings for the agent-authored fields (unbounded payload sizes
 * grow server storage and raise Levenshtein cost). These are the ONLY thing
 * standing between one submission and pathological storage or match cost, because the fields are free text an agent generated, not a
 * bounded enum or identifier.
 *
 * Enforced as a validation failure (400) at the zod boundary, never a silent
 * `.slice()` truncation: truncating server-side would desynchronize the
 * stored `summary`/`body`/`evidence` from what the CLI used to derive its own
 * (advisory) idempotency key, turning a length problem into a silent dedup
 * correctness problem.
 */
/** ~one tracker issue-title line with the `[Yak][Fatal] ` prefix (13 chars)
 *  still comfortably inside a readable title. */
export const YAK_SUMMARY_MAX_LENGTH = 200;
/** A full incident narrative in prose. Levenshtein match cost is capped
 *  independently on the server, and matching runs against `summary`, not
 *  `body` — this bound is about storage and issue description size, not
 *  match cost. */
export const YAK_BODY_MAX_LENGTH = 4_000;
/** Evidence is often a pasted log excerpt or stack trace — needs more room
 *  than prose, but still bounded; not exempt from the same storage
 *  argument. */
export const YAK_EVIDENCE_MAX_LENGTH = 20_000;
/** `device_id` / `execution_id` are opaque identifiers, not free text, but
 *  they are still caller-supplied strings that flow into the idempotency-key
 *  derivation below — bounded for the same storage-hygiene reason, sized
 *  generously above any real identifier (UUID, hostname, PID composite). */
export const YAK_ID_MAX_LENGTH = 200;
/** The client-supplied (advisory) idempotency key. A sha256 hex digest is 64
 *  chars; headroom is for a future hash algorithm change on the CLI side —
 *  never load-bearing here since the server always re-derives. */
export const YAK_IDEMPOTENCY_KEY_MAX_LENGTH = 128;

// ---------------------------------------------------------------------------
// Submission-adjacent shapes
// ---------------------------------------------------------------------------

/** Git identity of the reporter, when the CLI can read one out of the local
 *  git config. Optional and unvalidated beyond length: this is provenance,
 *  not an authentication claim — `source` (stamped from the ingress bearer
 *  token, never the payload, per the graph-schema `GraphIngest` precedent) is
 *  what the worker trusts for identity. */
export const YakReporter = z.object({
  name: z.string().max(200).optional(),
  email: z.string().max(320).optional(),
});
export type YakReporter = z.infer<typeof YakReporter>;

/**
 * Best-effort submission metadata. Six categories the CLI
 * MAY populate when it knows them; each is a permissive record because the
 * shape of "what a harness knows about its own process" varies by caller and
 * this contract deliberately does not gate on it. `.catchall()` additionally
 * accepts unknown top-level keys, so a CLI that learns an unforeseen
 * provenance category does not have to wait on a contract bump to send it.
 *
 * Never validated as a gate: a submission with `provenance` entirely absent,
 * or with any/all of these six keys absent, is still a fully valid
 * `YakSubmission`. This exists to enrich triage, not to constrain ingress.
 */
export const YakProvenance = z
  .object({
    process: z.record(z.string(), z.unknown()).optional(),
    device: z.record(z.string(), z.unknown()).optional(),
    harness: z.record(z.string(), z.unknown()).optional(),
    repo: z.record(z.string(), z.unknown()).optional(),
    git: z.record(z.string(), z.unknown()).optional(),
    execution: z.record(z.string(), z.unknown()).optional(),
  })
  .catchall(z.unknown());
export type YakProvenance = z.infer<typeof YakProvenance>;

// ---------------------------------------------------------------------------
// Ingress
// ---------------------------------------------------------------------------

/**
 * The ingress payload — `POST /v0/yaks`. Durable the instant it is accepted:
 * the ingress validates, derives the authoritative idempotency key, and
 * INSERTs the observation; no tracker work ever happens on this path.
 */
export const YakSubmission = z.object({
  schema_version: AcceptedYaksVersion,
  verb: YakVerb,
  summary: z.string().min(1).max(YAK_SUMMARY_MAX_LENGTH),
  body: z.string().min(1).max(YAK_BODY_MAX_LENGTH),
  evidence: z.string().max(YAK_EVIDENCE_MAX_LENGTH).optional(),
  device_id: z.string().min(1).max(YAK_ID_MAX_LENGTH),
  execution_id: z.string().min(1).max(YAK_ID_MAX_LENGTH),
  /** Client-derived, advisory only. The server always re-derives via
   *  `deriveIdempotencyKey` below and that value — never this one — is
   *  authoritative and is what the receipt reports. A mismatch is the Actor's
   *  concern to report and log, not this contract's. */
  idempotency_key: z.string().max(YAK_IDEMPOTENCY_KEY_MAX_LENGTH).optional(),
  reporter: YakReporter.optional(),
  provenance: YakProvenance.optional(),
});
export type YakSubmission = z.infer<typeof YakSubmission>;

/** What the ingress returns for a successful `POST /v0/yaks` — whether the
 *  submission was newly accepted or a replay of one already seen (a
 *  replay returns the ORIGINAL receipt, not a fresh one). */
export const YakReceipt = z.object({
  /** The stable id of the stored `YakObservation`. */
  id: z.string(),
  /** The server-derived, authoritative idempotency key — see
   *  `deriveIdempotencyKey` below. Always present, whether or not the client
   *  sent its own `idempotency_key` on the submission. */
  idempotency_key: z.string(),
  /** True when this INSERT lost a UNIQUE(idempotency_key) race to an
   *  already-stored observation and the receipt below describes that EARLIER
   *  observation, not a new one. */
  replay: z.boolean(),
  contract_version: z.literal(YAKS_CONTRACT_VERSION),
});
export type YakReceipt = z.infer<typeof YakReceipt>;

// ---------------------------------------------------------------------------
// Stored shapes — the read surface
// ---------------------------------------------------------------------------

/**
 * One immutable submission plus its mutable processing state.
 * `data` is written once at `submit()` time and never rewritten; `status`,
 * `cluster_id`, `attempts`, `next_attempt_at`, and `last_error` are the only
 * fields that change as `drainPending()` processes the row.
 */
export const YakObservation = z.object({
  id: z.string(),
  idempotency_key: z.string(),
  verb: YakVerb,
  summary: z.string(),
  /** Token identity of the ingesting caller, stamped by the worker from the
   *  bearer token — never from the payload (the `GraphIngest`/`source`
   *  precedent in `schema/graph-schema.v0.ts`). */
  source: z.string(),
  received_at: z.string().datetime(),
  status: YakObservationStatus,
  /** Absent until `drainPending()` assigns this observation to a cluster. */
  cluster_id: z.string().optional(),
  attempts: z.number().int().nonnegative(),
  /** Absent unless a prior attempt failed and this row is backing off. */
  next_attempt_at: z.string().datetime().optional(),
  last_error: z.string().optional(),
  /** The immutable submission this observation was created from. */
  data: YakSubmission,
});
export type YakObservation = z.infer<typeof YakObservation>;

/** One point in a cluster's tracker linkage history (`cluster_issues`: the
 *  lineage that survives closure). A cluster accumulates one of these each
 *  time it is linked to a tracker issue — including every time a closed
 *  predecessor forces a NEW issue + relation (relate, never reopen) rather
 *  than reusing the old one. */
export const YakClusterIssueLink = z.object({
  issue_id: z.string(),
  issue_identifier: z.string(), //  e.g. "ABC-1142"
  linked_at: z.string().datetime(),
  /** Set once the drain observes this issue as closed (the trigger for
   *  minting the NEXT link in the history). Absent while the
   *  linked issue is still open. */
  closed_observed_at: z.string().datetime().optional(),
});
export type YakClusterIssueLink = z.infer<typeof YakClusterIssueLink>;

/**
 * A persistent cluster of observations. `current_issue_id` /
 * `current_issue_identifier` name the issue new comments land on right now;
 * `issue_history` is the full lineage — every issue this cluster has ever been
 * linked to, in order, so closing an issue never loses the connection between
 * the old filing and the new one.
 */
export const YakCluster = z.object({
  id: z.string(),
  kind: YakClusterKind,
  canonical_summary: z.string(),
  keywords: z.array(z.string()).default([]),
  observation_count: z.number().int().nonnegative(),
  first_seen: z.string().datetime(),
  last_seen: z.string().datetime(),
  /** Absent only in the brief window between cluster creation and its first
   *  successful `issueCreate` — every persisted cluster is expected to reach
   *  one. */
  current_issue_id: z.string().optional(),
  current_issue_identifier: z.string().optional(),
  /** The full tracker linkage history — see `YakClusterIssueLink`. Defaults to
   *  `[]` for a brand-new cluster that has not yet been linked to anything. */
  issue_history: z.array(YakClusterIssueLink).default([]),
});
export type YakCluster = z.infer<typeof YakCluster>;

// ---------------------------------------------------------------------------
// Idempotency-key derivation — the load-bearing rule
// ---------------------------------------------------------------------------

/**
 * The canonical JSON encoding of the fields that make a submission a REPLAY of
 * an earlier one. Key order is fixed — `summary`, `body`, `evidence`, in that
 * exact order — because `JSON.stringify` on an object literal serializes
 * string keys in insertion order, so building this literal (rather than
 * forwarding whatever key order the caller's own object happened to have) is
 * what makes the derivation stable regardless of how the caller constructed
 * its `YakSubmission`. See the "stable across key-insertion order" test.
 */
export function canonicalPayload(
  submission: Pick<YakSubmission, "summary" | "body" | "evidence">,
): string {
  return JSON.stringify({
    summary: submission.summary,
    body: submission.body,
    evidence: submission.evidence,
  });
}

async function sha256Hex(text: string): Promise<string> {
  // Self-contained: this file is vendored standalone, so it imports nothing
  // but zod.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The authoritative idempotency-key derivation:
 *
 *   canonicalPayload = JSON.stringify({ summary, body, evidence })   // fixed key order, no whitespace
 *   idempotency_key  = sha256hex(`${device_id}\n${execution_id}\n${verb}\n${canonicalPayload}`)
 *
 * The `\n` delimiters are load-bearing, not decorative. Bare
 * concatenation would be PREFIX-AMBIGUOUS: with no
 * delimiter, `device_id="ab", execution_id="c"` and `device_id="a",
 * execution_id="bc"` serialize to the identical string `"abc..."` and
 * therefore hash to the identical key — two submissions from genuinely
 * different callers would silently dedup into one. Joining the fields with
 * `\n` instead means the two examples above serialize to `"ab\nc\n..."` and
 * `"a\nbc\n..."`, which are different strings and therefore different keys —
 * see the adversarial test below, which is the whole reason this delimiter
 * exists (a happy-path round-trip test would never exercise this).
 *
 * This function is what BOTH halves of Yaks call: the CLI to
 * compute its advisory `idempotency_key` before it ever sends a request, and
 * the Actor to compute the one authoritative value it
 * actually stores and dedupes on. Re-deriving here, from the payload actually
 * received, rather than trusting the client's own value, is what makes the
 * server authoritative — a mismatch between the two is reported in the
 * receipt and logged loudly by the Actor, never silently accepted.
 */
export function deriveIdempotencyKey(
  submission: Pick<YakSubmission, "device_id" | "execution_id" | "verb" | "summary" | "body" | "evidence">,
): Promise<string> {
  const canonical = canonicalPayload(submission);
  const material = `${submission.device_id}\n${submission.execution_id}\n${submission.verb}\n${canonical}`;
  return sha256Hex(material);
}
