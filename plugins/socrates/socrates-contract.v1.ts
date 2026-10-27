/**
 * The Socrates submit contract, v1: what `eris socrates submit` posts to
 * `POST /v1/socrates/submit` and the two shapes it accepts back.
 *
 * A vendored copy. The source of truth is an Effect Schema contract in the
 * service's runtime library, which this public tree does not depend on; this
 * Zod copy mirrors it field for field. tests/fixtures/socrates-contract-v1.json
 * is the same golden file the source decodes, so a drift on either side fails
 * a suite until both agree.
 *
 * Invariants:
 *  - A response is a receipt or the gateway's problem+json error, nothing else:
 *    `SocratesSubmitResponse` is the only decoder the client reads a body with.
 *  - The tenant and the submitting actor come from the bearer token, never the
 *    payload. Unknown keys are stripped.
 *  - `kind` is a closed vocabulary; extending it is a change to this file and
 *    to the source contract.
 *  - Free text is bounded at the door: over-length is a validation failure,
 *    never a truncation.
 */

import { z } from "zod";

export const SOCRATES_CONTRACT_VERSION = "1.0.0" as const;
export const SOCRATES_SUBMIT_PATH = "/v1/socrates/submit" as const;

export const SOCRATES_TITLE_MAX_LENGTH = 200;
export const SOCRATES_STATEMENT_MAX_LENGTH = 4_000;
export const SOCRATES_SOURCE_MAX_LENGTH = 2_048;
export const SOCRATES_PROJECT_MAX_LENGTH = 200;
export const SOCRATES_ID_MAX_LENGTH = 200;

export const SOCRATES_CANDIDATE_KINDS = ["decision", "practice", "prd", "conflict"] as const;
export const SocratesCandidateKind = z.enum(SOCRATES_CANDIDATE_KINDS);

/** The problem+json `type` prefix the gateway's errors carry. */
export const PROBLEM_TYPE_PREFIX = "urn:hera:error:";

const nonBlank = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s.trim().length > 0, "must not be blank");

const Url = z
  .string()
  .max(SOCRATES_SOURCE_MAX_LENGTH)
  .regex(/^https?:\/\/[^\s/?#]+[^\s]*$/, "must be an absolute http(s) URL");

const Version = z.literal(SOCRATES_CONTRACT_VERSION);

export const SocratesCandidate = z.object({
  kind: SocratesCandidateKind,
  title: nonBlank(SOCRATES_TITLE_MAX_LENGTH),
  statement: nonBlank(SOCRATES_STATEMENT_MAX_LENGTH),
  source: Url,
  project: nonBlank(SOCRATES_PROJECT_MAX_LENGTH).optional(),
});
export type SocratesCandidate = z.infer<typeof SocratesCandidate>;

export const SocratesSubmitRequest = z.object({
  schema_version: Version,
  candidate: SocratesCandidate,
});
export type SocratesSubmitRequest = z.infer<typeof SocratesSubmitRequest>;

/** `deduped` is true when the server already held this candidate and wrote nothing. */
export const SocratesSubmitReceipt = z.object({
  candidate_id: nonBlank(SOCRATES_ID_MAX_LENGTH),
  deduped: z.boolean(),
  contract_version: Version,
});
export type SocratesSubmitReceipt = z.infer<typeof SocratesSubmitReceipt>;

export const HalLink = z.object({ href: Url, title: z.string().optional() });

/** The gateway's RFC 7807 error. The not-entitled 402 carries `_links.subscribe`. */
export const SocratesProblem = z.object({
  type: z.string().regex(/^urn:hera:error:[a-z][a-z0-9_]*$/),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string(),
  code: z.string(),
  request_id: z.string().optional(),
  retry_after: z.number().optional(),
  _links: z.object({ subscribe: HalLink.optional() }).optional(),
});
export type SocratesProblem = z.infer<typeof SocratesProblem>;

export const SocratesSubmitResponse = z.union([SocratesSubmitReceipt, SocratesProblem]);
export type SocratesSubmitResponse = z.infer<typeof SocratesSubmitResponse>;
