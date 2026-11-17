/**
 * receipt.ts — the gate-receipt contract: the record `eris gate record` and `gate skip` write and the
 * gateway stores (`gate-receipt@v2`), the server-stamped `gate-receipt@v3`, and the legacy
 * `gate-receipt@v1` that `eris gate check` still reads and normalises to v2. Data and pure functions
 * only: the receipt routes in client.ts carry it, the gate verbs decide what it means.
 *
 * Invariants:
 *  - Every optional field is `optionalKey`, so a record written before that field existed still
 *    decodes, and no field is ever removed: stored records outlive their writer.
 *  - `artifact` is a tagged union on `_tag` (`git` | `file`), and `evidence` a union on `kind`
 *    (inline | media | review-report). A new kind is a new union member, never a widened string.
 *  - The listing hands back each record's payload as `unknown`; `decodePayload` is the one place a
 *    payload becomes a receipt. It strips keys the contract does not name, so a writer that adds a
 *    field never makes an older reader drop the record.
 *  - v3 spreads v2's fields, so it cannot drift from them. Clients write v2; only the gateway stamps
 *    a `mandate` and writes v3.
 */

import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import { decodeResult } from "./decode";
import { GateReviewReportEvidence, isGateReviewReportEvidence } from "./review-report";

export const GATE_RECEIPT_SCHEMA = "gate-receipt@v2";
export const GATE_RECEIPT_SCHEMA_V1 = "gate-receipt@v1";
export const GATE_RECEIPT_SCHEMA_V3 = "gate-receipt@v3";

/** The user-impact classes: U0 internal, U1 reversible, U2 availability, U3 loss. */
export const GATE_USER_IMPACTS = ["U0", "U1", "U2", "U3"] as const;
export const GateUserImpact = Schema.Literals(GATE_USER_IMPACTS);
export type GateUserImpact = typeof GateUserImpact.Type;

export const GATE_VERDICTS = ["PASS", "AMENDED", "BLOCKING", "SKIPPED"] as const;
export const GateVerdict = Schema.Literals(GATE_VERDICTS);
export type GateVerdict = typeof GateVerdict.Type;

/** Gate names are kebab-case slugs; issue keys are tracker identifiers (`ABC-123`). */
export const GATE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const ISSUE_KEY = /^[A-Z][A-Z0-9]*-[0-9]+$/;

/** Inline evidence is capped so a receipt stays a comment, not a log store. */
export const INLINE_MAX_BYTES = 16 * 1024;
/** An encoded artifact copy past this is left out of the receipt (the store caps a decoded copy at 1 MiB). */
export const COPY_MAX_BYTES = 48 * 1024;
/** The store's cap on one uploaded media file. */
export const ASSET_MAX_BYTES = 25 * 1024 * 1024;

/** The artifact's (or doctrine's) bytes carried in the record: gzip, then base64. */
export const GateArtifactCopy = Schema.Struct({
  encoding: Schema.Literal("gzip+base64"),
  content: Schema.String,
  bytes: Schema.Number,
});
export type GateArtifactCopy = typeof GateArtifactCopy.Type;

/** The active doctrine posture snapshot; all but `path` and `sha256` postdate v2. */
export const GateDoctrine = Schema.Struct({
  path: Schema.String,
  sha256: Schema.String,
  name: Schema.optionalKey(Schema.String),
  posture: Schema.optionalKey(Schema.String),
  policy_hash: Schema.optionalKey(Schema.String),
  copy: Schema.optionalKey(GateArtifactCopy),
});
export type GateDoctrine = typeof GateDoctrine.Type;

/** Actor display metadata frozen at record time; `actor` stays the raw key. */
export const GateActor = Schema.Struct({
  kind: Schema.Literals(["session", "human"]),
  name: Schema.String,
  runtime: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  launched_by: Schema.optionalKey(Schema.String),
});
export type GateActor = typeof GateActor.Type;

/** What the gate judged: a file in a git repo at a ref, located by the repo's origin slug. */
export const GateGitArtifact = Schema.TaggedStruct("git", {
  repo: Schema.String,
  ref: Schema.String,
  /** The 40-hex commit on `origin` whose tree holds `path` at `sha256`; absent on older records. */
  commit: Schema.optionalKey(Schema.String),
  path: Schema.String,
  sha256: Schema.String,
  copy: Schema.optionalKey(GateArtifactCopy),
});
/** A file outside a checkout with a hosted origin. */
export const GateFileArtifact = Schema.TaggedStruct("file", {
  path: Schema.String,
  sha256: Schema.String,
  copy: Schema.optionalKey(GateArtifactCopy),
});
export const GateArtifact = Schema.Union([GateGitArtifact, GateFileArtifact]);
export type GateArtifact = typeof GateArtifact.Type;

/** Evidence whose content rides inline in the record. */
export const GATE_INLINE_KINDS = ["text", "log", "test-run", "e2e"] as const;
/** Evidence uploaded to the store's asset storage, cited by URL and digest. */
export const GATE_MEDIA_KINDS = ["screenshot", "video"] as const;
export type GateInlineKind = (typeof GATE_INLINE_KINDS)[number];
export type GateMediaKind = (typeof GATE_MEDIA_KINDS)[number];

export const GateInlineEvidence = Schema.Struct({
  kind: Schema.Literals(GATE_INLINE_KINDS),
  name: Schema.optionalKey(Schema.String),
  content: Schema.String,
  sha256: Schema.String,
});
export type GateInlineEvidence = typeof GateInlineEvidence.Type;

export const GateMediaEvidence = Schema.Struct({
  kind: Schema.Literals(GATE_MEDIA_KINDS),
  name: Schema.String,
  content_type: Schema.String,
  bytes: Schema.Number,
  sha256: Schema.String,
  asset_url: Schema.String,
});
export type GateMediaEvidence = typeof GateMediaEvidence.Type;

export const GateEvidence = Schema.Union([GateInlineEvidence, GateMediaEvidence, GateReviewReportEvidence]);
export type GateEvidence = typeof GateEvidence.Type;

export const isGateMediaEvidence = (e: GateEvidence): e is GateMediaEvidence => (GATE_MEDIA_KINDS as readonly string[]).includes(e.kind);
export { isGateReviewReportEvidence };

export const GateReceiptV2 = Schema.Struct({
  schema: Schema.Literal(GATE_RECEIPT_SCHEMA),
  gate: Schema.String,
  issue: Schema.String,
  verdict: GateVerdict,
  artifact: GateArtifact,
  /** Absent when no rubric was applied, never `[]`. */
  rubrics: Schema.optionalKey(Schema.NonEmptyArray(Schema.String)),
  doctrine: Schema.optionalKey(GateDoctrine),
  user_impact: Schema.optionalKey(GateUserImpact),
  /** The human grant behind this receipt. */
  authorized: Schema.optionalKey(Schema.String),
  /** Why a `SKIPPED` gate was not run; absent on other verdicts. */
  reason: Schema.optionalKey(Schema.String),
  actor: Schema.String,
  actor_info: Schema.optionalKey(GateActor),
  evidence: Schema.Array(GateEvidence),
  recorded_at: Schema.String,
});
export type GateReceiptV2 = typeof GateReceiptV2.Type;

/** A ULID, the public id of a mandate node, a use or a root. */
const MandateId = Schema.String.check(Schema.isPattern(/^[0-9A-HJKMNP-TV-Z]{26}$/, { expected: "a 26-character ULID" }));
/** base64url SHA-256, unpadded: 43 characters. */
const MandateDigest = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/, { expected: "43-character base64url SHA-256 digest" }));
/** A compact JWS (`header.payload.signature`). */
const MandateAttestation = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, { expected: "compact JWS header.payload.signature" }),
  Schema.isMaxLength(4096),
);

const SCOPE_PREFIX = "sr:us:mandate:";
const SCOPE_SEGMENT = /^[a-z][a-z0-9_]*$/;
const SCOPE_ACTION = /^[a-z][a-z0-9_]*(?:@[1-9][0-9]*)?$/;
const SCOPE_VALUE = /^[A-Za-z0-9._:/-]+$/;

/** Whether `raw` is a scope literal in canonical form: `sr:us:mandate:<domain>:<action>[?k=v(&k=v)*]`, keys sorted, at most 16, no handle-shaped value. */
function canonicalScope(raw: string): boolean {
  if (raw.length > 512 || !raw.startsWith(SCOPE_PREFIX)) return false;
  const rest = raw.slice(SCOPE_PREFIX.length);
  const q = rest.indexOf("?");
  const segments = (q === -1 ? rest : rest.slice(0, q)).split(":");
  if (segments.length !== 2 || !SCOPE_SEGMENT.test(segments[0]!) || !SCOPE_ACTION.test(segments[1]!)) return false;
  if (q === -1) return true;
  const pairs = rest.slice(q + 1).split("&");
  if (pairs.length > 16) return false;
  const keys: string[] = [];
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) return false;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (!SCOPE_SEGMENT.test(key) || !SCOPE_VALUE.test(value) || value.includes("mnd_") || keys.includes(key)) return false;
    keys.push(key);
  }
  return keys.every((k, i) => i === 0 || keys[i - 1]! < k);
}
const MandateScope = Schema.String.check(Schema.makeFilter((s: string) => canonicalScope(s), { expected: "canonical sr:us:mandate:{domain}:{action}?{params} scope" }));

/** The mandate use the gateway stamped a v3 receipt with: public ids, digests and the signed attestation only. */
export const GateMandateStamp = Schema.Struct({
  id: MandateId,
  use_id: MandateId,
  root_id: MandateId,
  scope: MandateScope,
  chain_digest: MandateDigest,
  attestation: MandateAttestation,
});

export const GateReceiptV3 = Schema.Struct({
  ...GateReceiptV2.fields,
  schema: Schema.Literal(GATE_RECEIPT_SCHEMA_V3),
  /** The mandate use that authorised this receipt; absent when no mandate was used. */
  mandate: Schema.optionalKey(GateMandateStamp),
});
export type GateReceiptV3 = typeof GateReceiptV3.Type;

/** The receipt every reader sees: v2 (v1 normalised to it) or a gateway-stamped v3, by `schema`. */
export type GateReceipt = GateReceiptV2 | GateReceiptV3;

const HashedFile = Schema.Struct({ path: Schema.String, sha256: Schema.String });

export const GateReceiptV1 = Schema.Struct({
  schema: Schema.Literal(GATE_RECEIPT_SCHEMA_V1),
  gate: Schema.String,
  issue: Schema.String,
  verdict: GateVerdict,
  artifact: HashedFile,
  rubric_version: Schema.optionalKey(Schema.String),
  doctrine: Schema.optionalKey(HashedFile),
  user_impact: Schema.optionalKey(GateUserImpact),
  authorized: Schema.optionalKey(Schema.String),
  actor: Schema.String,
  evidence: Schema.Array(Schema.String),
  recorded_at: Schema.String,
});
export type GateReceiptV1 = typeof GateReceiptV1.Type;

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** A v1 receipt in v2's shape: its artifact stays a (cwd-relative) `file`, its strings `text`. */
export function fromV1(r: GateReceiptV1): GateReceiptV2 {
  return {
    schema: GATE_RECEIPT_SCHEMA,
    gate: r.gate,
    issue: r.issue,
    verdict: r.verdict,
    artifact: { _tag: "file", path: r.artifact.path, sha256: r.artifact.sha256 },
    ...(r.rubric_version !== undefined ? { rubrics: [r.rubric_version] as const } : {}),
    ...(r.doctrine !== undefined ? { doctrine: r.doctrine } : {}),
    ...(r.user_impact !== undefined ? { user_impact: r.user_impact } : {}),
    ...(r.authorized !== undefined ? { authorized: r.authorized } : {}),
    actor: r.actor,
    evidence: r.evidence.map((content) => ({ kind: "text" as const, content, sha256: sha256Hex(content) })),
    recorded_at: r.recorded_at,
  };
}

/** A stored record's payload read as a receipt of its marker version (v1 normalised to v2), or invalid. */
export type DecodedPayload = { readonly kind: "receipt"; readonly receipt: GateReceipt; readonly version: "v1" | "v2" } | { readonly kind: "invalid" };

/** A record's payload as a receipt of `version`, or invalid; the gateway lists a stamped v3 under version "v2". */
export function decodePayload(version: "v1" | "v2", json: unknown): DecodedPayload {
  if (version === "v1") {
    const v1 = decodeResult(GateReceiptV1, json);
    return v1._tag === "Success" ? { kind: "receipt", receipt: fromV1(v1.success), version: "v1" } : { kind: "invalid" };
  }
  const v2 = decodeResult(GateReceiptV2, json);
  if (v2._tag === "Success") return { kind: "receipt", receipt: v2.success, version: "v2" };
  const v3 = decodeResult(GateReceiptV3, json);
  return v3._tag === "Success" ? { kind: "receipt", receipt: v3.success, version: "v2" } : { kind: "invalid" };
}
