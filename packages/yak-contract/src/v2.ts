/**
 * Yaks wire contract v2: the shapes an `eris` client posts
 * to the Yaks ingest API, and the shapes the service stores and reports back.
 *
 * Derived from the v1 contract (`plugins/yak/yaks-schema.v1.ts`, contract
 * version 1.0.0). Whatever is not listed here is v1 unchanged. The deltas:
 *  - `reporter` is gone. The server derives the tracker user from the caller's
 *    token. A client's git identity may still ride in `provenance.git` as a hint
 *    and is never an identity claim. Unknown keys are stripped, as in v1, so a
 *    client that still sends `reporter` is accepted and the field is dropped.
 *  - `route` is new and required: `workspace` files into the caller's own
 *    tenant, `vendor` into the vendor's.
 *  - `provenance.repo.target_repos` keeps the wire location v1's clients use and
 *    gains a type and bounds (the server's routing reads it).
 *  - `provenance.execution.rung` names which rung of the client's execution-id
 *    ladder produced `execution_id`. Its vocabulary holds v1's rungs and the
 *    generic harness rungs `ai-agent`, `codex` and `cursor`.
 *
 * Design invariants it encodes:
 *  - The tenant is never in the payload: it comes from the bearer token. The
 *    same holds for `source` on a stored observation.
 *  - Exactly three verbs: `issue`, `suggest`, `fatal`. A fourth is a change to
 *    this file.
 *  - A submission is immutable once accepted: `YakSubmission` is written once as
 *    the `data` blob on a `YakObservation` and never rewritten. Everything that
 *    changes as an observation is processed lives in sibling fields.
 *  - The idempotency key is SERVER-authoritative. The client may send one,
 *    advisory only. The server re-derives it from the payload it received via
 *    `deriveIdempotencyKey`, and that value is what the receipt reports and what
 *    dedup keys off. The derivation is v1's unchanged, and the server scopes the
 *    key per tenant. `route` is not an input: a vendor-routed report lands in the
 *    vendor's tenant scope and a workspace one in the caller's.
 *  - Bounded free text: `summary`, `body` and `evidence` are agent-authored, so
 *    the contract enforces maxima at the door as a validation failure, never a
 *    silent truncation. Truncating server-side would desynchronize the stored
 *    payload from the client's own key derivation.
 *  - `provenance` is best-effort: a permissive record, never a gate. A
 *    submission with none of it populated is still valid. Its two typed keys,
 *    `repo.target_repos` and `execution.rung`, are the only parts it validates.
 *  - Closed vocabularies are never guessed. Extending one is a change to this
 *    file, and the server is deployed before the clients that send the new
 *    value.
 */

import { z } from "zod";

/** The single version the service EMITS on every receipt: the version a fresh
 *  client should send. Separate from the ingest endpoint's own version. */
export const YAKS_CONTRACT_VERSION = "2.0.0";

/**
 * The write plane's version window. A tuple, not a bare
 * `z.literal(YAKS_CONTRACT_VERSION)`, even with one member: a bare literal bump
 * rejects every in-flight submission from a client that has not yet upgraded, the
 * instant the new version deploys.
 *
 * When `YAKS_CONTRACT_VERSION` bumps: append the new version, don't replace the
 * old one. Narrow back to a single element only after every client has moved.
 */
export const ACCEPTED_YAKS_VERSIONS = ["2.0.0"] as const;

/** The write plane's version check. A response (`YakReceipt.contract_version`)
 *  keeps a literal: a receipt carries the one version that produced it. */
export const AcceptedYaksVersion = z.enum(ACCEPTED_YAKS_VERSIONS);

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

/** Exactly these three, closed:
 *   issue   : a harness defect the agent hit, confirmed or suspected
 *   suggest : an improvement to the harness (missing capability, better default)
 *   fatal   : the harness itself is broken; clusters SEPARATELY from
 *             issue/suggest */
export const YakVerb = z.enum(["issue", "suggest", "fatal"]);
export type YakVerb = z.infer<typeof YakVerb>;

/** Where a submission files. `workspace` is the caller's own tenant. `vendor` is
 *  a report about eris itself, which flows into the vendor's tenant and never
 *  out of it. Required on the wire: a client always
 *  knows which it means, and a missing route is a client bug to refuse, not to
 *  default. */
export const YakRoute = z.enum(["workspace", "vendor"]);
export type YakRoute = z.infer<typeof YakRoute>;

/**
 * The rung of the client's `execution_id` ladder that produced the value. The
 * rungs hold genuinely different ids for one task, so which one fired decides
 * the dedup grain a report lands at. The client owns the ladder's order and the
 * environment it reads; the contract owns only the names.
 *
 *  - v1's rungs, unchanged: `override` (an explicit id), `session` and
 *    `host-session` (the Claude Code session ids), `shell-session` (the
 *    invoking shell's id) and `shell` (the final fallback).
 *  - The generic harness rungs: `ai-agent` (the cross-vendor AI_AGENT
 *    identifier), `codex` and `cursor` (those harnesses' own session ids).
 *
 * The order of this list is not the ladder's order.
 */
export const YAK_EXECUTION_ID_RUNGS = ["override", "session", "host-session", "shell-session", "shell", "ai-agent", "codex", "cursor"] as const;
export const YakExecutionIdRung = z.enum(YAK_EXECUTION_ID_RUNGS);
export type YakExecutionIdRung = z.infer<typeof YakExecutionIdRung>;

/** Processing state of a stored observation. The `data` blob (the original
 *  `YakSubmission`) never changes; this is the only part of an observation row
 *  that does. */
export const YakObservationStatus = z.enum(["pending", "processed", "failed"]);
export type YakObservationStatus = z.infer<typeof YakObservationStatus>;

/** A cluster's kind mirrors the verb partition it exists for: `fatal` clusters
 *  never merge with `report` clusters (the `issue`/`suggest` pool), because only
 *  `fatal` escalates and a shared lineage would have to pick one behaviour for
 *  both. */
export const YakClusterKind = z.enum(["fatal", "report"]);
export type YakClusterKind = z.infer<typeof YakClusterKind>;

// ---------------------------------------------------------------------------
// Bounded free text
// ---------------------------------------------------------------------------

/**
 * Length ceilings for the agent-authored fields. These are the only thing
 * standing between one submission and pathological storage or match cost,
 * because the fields are free text an agent generated, not a bounded enum or
 * identifier. Enforced as a validation failure, never a `.slice()`.
 */
/** ~one tracker issue-title line with the `[Yak][Fatal] ` prefix (13 chars)
 *  still comfortably inside a readable title. */
export const YAK_SUMMARY_MAX_LENGTH = 200;
/** A full incident narrative in prose. Matching runs against `summary`, not
 *  `body`; this bound is about storage and issue-description size. */
export const YAK_BODY_MAX_LENGTH = 4_000;
/** Evidence is often a pasted log excerpt or stack trace: it needs more room
 *  than prose, but is still bounded. */
export const YAK_EVIDENCE_MAX_LENGTH = 20_000;
/** `device_id` / `execution_id` are opaque identifiers, not free text, but they
 *  are caller-supplied strings that flow into the idempotency-key derivation:
 *  bounded for the same storage-hygiene reason, sized generously above any real
 *  identifier (UUID, hostname, PID composite). */
export const YAK_ID_MAX_LENGTH = 200;
/** The client-supplied (advisory) idempotency key. A sha256 hex digest is 64
 *  chars; headroom is for a future hash algorithm change on the client side,
 *  never load-bearing since the server always re-derives. */
export const YAK_IDEMPOTENCY_KEY_MAX_LENGTH = 128;
/** A target-repo hint is a short `owner/name` identifier, not a URL or a
 *  paste. Sized generously above any real repo name. */
export const YAK_REPO_HINT_MAX_LENGTH = 200;
/** More hints than any single report spans repos. */
export const YAK_REPO_HINTS_MAX_COUNT = 20;

// ---------------------------------------------------------------------------
// Submission-adjacent shapes
// ---------------------------------------------------------------------------

/**
 * A target-repo hint: `owner/name` by convention, and nested namespaces
 * (`group/subgroup/project`) are legal because clients derive hints from git
 * remotes. Bounded in length only. A shape check would turn a hint the client
 * could not normalize into a refused report, and a hint is never worth that.
 */
export const YakRepoHint = z.string().min(1).max(YAK_REPO_HINT_MAX_LENGTH);

/** The `repo` category of provenance: free-form like the rest, with one typed
 *  key. `target_repos` is an array even for one hint, for a report that spans
 *  repos. */
export const YakRepoProvenance = z
  .object({
    target_repos: z.array(YakRepoHint).max(YAK_REPO_HINTS_MAX_COUNT).optional(),
  })
  .catchall(z.unknown());
export type YakRepoProvenance = z.infer<typeof YakRepoProvenance>;

/** The `execution` category of provenance: session facts the client read, with
 *  one typed key, the rung that produced `execution_id`. */
export const YakExecutionProvenance = z
  .object({
    rung: YakExecutionIdRung.optional(),
  })
  .catchall(z.unknown());
export type YakExecutionProvenance = z.infer<typeof YakExecutionProvenance>;

/**
 * Best-effort submission metadata. Six categories the client MAY populate when
 * it knows them; each is a permissive record because the shape of "what a
 * harness knows about its own process" varies by caller and this contract
 * deliberately does not gate on it. `.catchall()` additionally accepts unknown
 * top-level keys, so a client that learns an unforeseen provenance category does
 * not have to wait on a contract change to send it.
 *
 * `git` may carry the committer's identity (git config) as a hint. The reporter
 * is the tracker user the server derives from the token, never this.
 *
 * Never validated as a gate beyond the two typed keys above: a submission with
 * `provenance` entirely absent is still a fully valid `YakSubmission`. This
 * exists to enrich triage, not to constrain ingress.
 */
export const YakProvenance = z
  .object({
    process: z.record(z.string(), z.unknown()).optional(),
    device: z.record(z.string(), z.unknown()).optional(),
    harness: z.record(z.string(), z.unknown()).optional(),
    repo: YakRepoProvenance.optional(),
    git: z.record(z.string(), z.unknown()).optional(),
    execution: YakExecutionProvenance.optional(),
  })
  .catchall(z.unknown());
export type YakProvenance = z.infer<typeof YakProvenance>;

// ---------------------------------------------------------------------------
// Ingress
// ---------------------------------------------------------------------------

/**
 * The ingress payload. Durable the instant it is accepted: ingress validates,
 * derives the authoritative idempotency key, and persists the observation. No
 * tracker work happens on this path.
 */
export const YakSubmission = z.object({
  schema_version: AcceptedYaksVersion,
  verb: YakVerb,
  route: YakRoute,
  summary: z.string().min(1).max(YAK_SUMMARY_MAX_LENGTH),
  body: z.string().min(1).max(YAK_BODY_MAX_LENGTH),
  evidence: z.string().max(YAK_EVIDENCE_MAX_LENGTH).optional(),
  device_id: z.string().min(1).max(YAK_ID_MAX_LENGTH),
  execution_id: z.string().min(1).max(YAK_ID_MAX_LENGTH),
  /** Client-derived, advisory only. The server always re-derives via
   *  `deriveIdempotencyKey` below and that value, never this one, is
   *  authoritative and is what the receipt reports. A mismatch is the server's
   *  concern to report and log, not this contract's. */
  idempotency_key: z.string().max(YAK_IDEMPOTENCY_KEY_MAX_LENGTH).optional(),
  provenance: YakProvenance.optional(),
});
export type YakSubmission = z.infer<typeof YakSubmission>;

/** What ingress returns for an accepted submission, whether newly accepted or a
 *  replay of one already seen (a replay returns the ORIGINAL receipt, not a
 *  fresh one). */
export const YakReceipt = z.object({
  /** The stable id of the stored `YakObservation`. */
  id: z.string(),
  /** The server-derived, authoritative idempotency key: see
   *  `deriveIdempotencyKey` below. Always present, whether or not the client
   *  sent its own on the submission. */
  idempotency_key: z.string(),
  /** True when this insert lost a uniqueness race on the idempotency key to an
   *  already-stored observation, and the receipt describes that EARLIER
   *  observation, not a new one. */
  replay: z.boolean(),
  contract_version: z.literal(YAKS_CONTRACT_VERSION),
});
export type YakReceipt = z.infer<typeof YakReceipt>;

// ---------------------------------------------------------------------------
// Stored shapes: the read surface
// ---------------------------------------------------------------------------

/**
 * One immutable submission plus its mutable processing state. `data` is written
 * once at submit time and never rewritten; `status`, `cluster_id`, `attempts`,
 * `next_attempt_at` and `last_error` are the only fields that change as the
 * drain processes the row.
 */
export const YakObservation = z.object({
  id: z.string(),
  idempotency_key: z.string(),
  verb: YakVerb,
  summary: z.string(),
  /** Identity of the ingesting caller, stamped by the service from the bearer
   *  token, never from the payload. */
  source: z.string(),
  received_at: z.string().datetime(),
  status: YakObservationStatus,
  /** Absent until the drain assigns this observation to a cluster. */
  cluster_id: z.string().optional(),
  attempts: z.number().int().nonnegative(),
  /** Absent unless a prior attempt failed and this row is backing off. */
  next_attempt_at: z.string().datetime().optional(),
  last_error: z.string().optional(),
  /** The immutable submission this observation was created from. */
  data: YakSubmission,
});
export type YakObservation = z.infer<typeof YakObservation>;

/** One point in a cluster's issue-linkage history. A cluster accumulates one of
 *  these each time it is linked to a tracker issue, including every time a
 *  closed predecessor forces a NEW issue plus a relation (relate, never reopen)
 *  rather than reusing the old one. */
export const YakClusterIssueLink = z.object({
  issue_id: z.string(),
  issue_identifier: z.string(), //  e.g. "ABC-123"
  linked_at: z.string().datetime(),
  /** Set once the drain observes this issue as closed (the trigger for minting
   *  the NEXT link in the history). Absent while the linked issue is open. */
  closed_observed_at: z.string().datetime().optional(),
});
export type YakClusterIssueLink = z.infer<typeof YakClusterIssueLink>;

/**
 * A persistent cluster of observations. `current_issue_id` /
 * `current_issue_identifier` name the issue new comments land on right now;
 * `issue_history` is the full lineage, every issue this cluster has ever been
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
   *  successful issue creation: every persisted cluster is expected to reach
   *  one. */
  current_issue_id: z.string().optional(),
  current_issue_identifier: z.string().optional(),
  /** The full linkage history: see `YakClusterIssueLink`. Defaults to `[]` for
   *  a brand-new cluster not yet linked to anything. */
  issue_history: z.array(YakClusterIssueLink).default([]),
});
export type YakCluster = z.infer<typeof YakCluster>;

// ---------------------------------------------------------------------------
// Idempotency-key derivation: the load-bearing rule, unchanged from v1
// ---------------------------------------------------------------------------

/**
 * The canonical JSON encoding of the fields that make a submission a REPLAY of
 * an earlier one. Key order is fixed (`summary`, `body`, `evidence`) because
 * `JSON.stringify` serializes string keys in insertion order, so building this
 * literal, rather than forwarding whatever key order the caller's own object
 * had, is what makes the derivation stable however the caller built its
 * `YakSubmission`.
 */
export function canonicalPayload(submission: Pick<YakSubmission, "summary" | "body" | "evidence">): string {
  return JSON.stringify({
    summary: submission.summary,
    body: submission.body,
    evidence: submission.evidence,
  });
}

/** Web-standard crypto only, so the package runs unchanged in a Worker, bun or
 *  node. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The authoritative idempotency-key derivation:
 *
 *   canonicalPayload = JSON.stringify({ summary, body, evidence })   // fixed key order, no whitespace
 *   idempotency_key  = sha256hex(`${device_id}\n${execution_id}\n${verb}\n${canonicalPayload}`)
 *
 * The `\n` delimiters are load-bearing, not decorative. Bare concatenation is
 * PREFIX-AMBIGUOUS: `device_id="ab", execution_id="c"` and `device_id="a",
 * execution_id="bc"` would serialize to the identical string and hash to the
 * identical key, so two genuinely different callers would silently dedup into
 * one. Joined with `\n` they serialize differently and so hash differently.
 *
 * Both halves call this: the client to compute its advisory key before it sends
 * a request, and the server to compute the one value it stores and dedupes on.
 * Re-deriving from the payload actually received, rather than trusting the
 * client's value, is what makes the server authoritative. It is v1's derivation
 * byte for byte, so a report replayed from a v1 client keys the same.
 */
export function deriveIdempotencyKey(submission: Pick<YakSubmission, "device_id" | "execution_id" | "verb" | "summary" | "body" | "evidence">): Promise<string> {
  const canonical = canonicalPayload(submission);
  const material = `${submission.device_id}\n${submission.execution_id}\n${submission.verb}\n${canonical}`;
  return sha256Hex(material);
}
