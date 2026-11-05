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
 *    payload. Unknown keys are stripped, except in a repo policy layer, which
 *    refuses one: a key a repo meant must never be dropped silently.
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
export const SOCRATES_KEY_MAX_LENGTH = 64;
export const SOCRATES_OVERRIDE_REASON_MAX_LENGTH = 200;

export const SOCRATES_CANDIDATE_KINDS = ["decision", "practice", "prd", "conflict"] as const;
export const SocratesCandidateKind = z.enum(SOCRATES_CANDIDATE_KINDS);

/** The problem+json `type` prefix the gateway's errors carry. */
export const PROBLEM_TYPE_PREFIX = "urn:hera:error:";

export const nonBlank = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s.trim().length > 0, "must not be blank");

export const Url = z
  .string()
  .max(SOCRATES_SOURCE_MAX_LENGTH)
  .regex(/^https?:\/\/[^\s/?#]+[^\s]*$/, "must be an absolute http(s) URL");

export const Version = z.literal(SOCRATES_CONTRACT_VERSION);

export const SocratesCandidate = z.object({
  kind: SocratesCandidateKind,
  title: nonBlank(SOCRATES_TITLE_MAX_LENGTH),
  statement: nonBlank(SOCRATES_STATEMENT_MAX_LENGTH),
  source: Url,
  project: nonBlank(SOCRATES_PROJECT_MAX_LENGTH).optional(),
});
export type SocratesCandidate = z.infer<typeof SocratesCandidate>;

// --- rubric answers, overrides and the repo policy layer ---------------------
// Shared by classify (socrates-contract.v1.verbs.ts) and the stamp a submit carries.

export const SocratesKey = z.string().max(SOCRATES_KEY_MAX_LENGTH).regex(/^[a-z][a-z0-9_]*$/, "must be a snake_case key");
/** Published answers are kebab-case; `_` stays legal so every value `SocratesKey` accepted still decodes. */
export const SocratesAnswer = z.string().max(SOCRATES_KEY_MAX_LENGTH).regex(/^[a-z][a-z0-9_-]*$/, "must be a lowercase rubric answer");
export const SocratesRubricVersion = z.string().regex(/^rubric@v[1-9][0-9]*$/, "must be rubric@v<N>");
export const SocratesPolicyHash = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase sha256 hex");
export const SocratesNonNegativeNumber = z.number().finite().min(0);
export const SocratesVerdict = z.enum(["pass", "fail", "escalate"]);
export const SocratesOneLine = z
  .string()
  .min(1)
  .max(SOCRATES_OVERRIDE_REASON_MAX_LENGTH)
  .regex(/^[^\r\n]*$/, "must be a single line")
  .refine((s) => s.trim().length > 0, "must not be blank");

export const uniqueGates = (items: readonly { gate: string }[]) => new Set(items.map((i) => i.gate)).size === items.length;

export const SocratesOverride = z.object({ gate: SocratesKey, reason: SocratesOneLine });

/** Each rubric gate key mapped to its answer; the question set belongs to the rubric version. */
export const SocratesRubricAnswers = z.record(SocratesKey, SocratesAnswer).refine((a) => Object.keys(a).length > 0, "needs at least one rubric answer");
/** At least one override, one per gate. */
export const SocratesOverrides = z.array(SocratesOverride).min(1).refine(uniqueGates, "one override per gate");

/**
 * A repo's stricter-only layer over the org policy, from its `eris.yaml`
 * `socrates.policy`: turn a hard gate on, raise the threshold, pin auto-resolve
 * off. Any other key, at either level, is refused. Whether the threshold is at
 * least the org's, and whether a named question is a hard gate, needs the org
 * policy and the rubric: the merge decides those.
 */
export const SocratesRepoPolicy = z
  .object({
    gates: z.record(SocratesKey, z.object({ enabled: z.literal(true) }).strict()).optional(),
    threshold: SocratesNonNegativeNumber.optional(),
    auto_resolve: z.literal(false).optional(),
  })
  .strict();
export type SocratesRepoPolicy = z.infer<typeof SocratesRepoPolicy>;

/**
 * The stamp of a candidate eris scored: the inputs, never a verdict. The server
 * scores it again under the org's current policy.
 */
export const SocratesClassificationStamp = z.object({
  rubric_version: SocratesRubricVersion,
  policy_hash: SocratesPolicyHash,
  answers: SocratesRubricAnswers,
  overrides: SocratesOverrides.optional(),
  repo_policy: SocratesRepoPolicy.optional(),
});
export type SocratesClassificationStamp = z.infer<typeof SocratesClassificationStamp>;

/**
 * The server's verdict on a stamped submit, under the org policy `policy_hash`
 * names now. `stamped_policy_hash` is present exactly when `reclassified` is:
 * the hash the client stamped.
 */
export const SocratesSubmitClassification = z
  .object({
    verdict: SocratesVerdict,
    rubric_version: SocratesRubricVersion,
    policy_hash: SocratesPolicyHash,
    reclassified: z.boolean(),
    stamped_policy_hash: SocratesPolicyHash.optional(),
  })
  .refine(
    (c) => c.reclassified === (c.stamped_policy_hash !== undefined) && c.stamped_policy_hash !== c.policy_hash,
    "stamped_policy_hash present exactly when reclassified, and different from policy_hash",
  );
export type SocratesSubmitClassification = z.infer<typeof SocratesSubmitClassification>;

/**
 * `now`: file under today's review Epic straight away, which the server does for every submit.
 * `classification`: the stamp of a scored candidate; a `prd` or `conflict` is never scored, so it carries none.
 */
export const SocratesSubmitRequest = z.object({
  schema_version: Version,
  candidate: SocratesCandidate,
  now: z.boolean().optional(),
  classification: SocratesClassificationStamp.optional(),
});
export type SocratesSubmitRequest = z.infer<typeof SocratesSubmitRequest>;

/**
 * `deduped` is true when the server already held this candidate and wrote nothing.
 * `classification` answers a stamped submit with the server's verdict under the current policy.
 */
export const SocratesSubmitReceipt = z.object({
  candidate_id: nonBlank(SOCRATES_ID_MAX_LENGTH),
  deduped: z.boolean(),
  classification: SocratesSubmitClassification.optional(),
  contract_version: Version,
});
export type SocratesSubmitReceipt = z.infer<typeof SocratesSubmitReceipt>;

export const HalLink = z.object({ href: Url, title: z.string().optional() });

/**
 * The gateway's RFC 7807 error. The not-entitled 402 carries `_links.subscribe`; a
 * fragment refused because the org's evidence setting is off carries `_links.settings`.
 */
export const SocratesProblem = z.object({
  type: z.string().regex(/^urn:hera:error:[a-z][a-z0-9_]*$/),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string(),
  code: z.string(),
  request_id: z.string().optional(),
  retry_after: z.number().optional(),
  _links: z.object({ subscribe: HalLink.optional(), settings: HalLink.optional() }).optional(),
});
export type SocratesProblem = z.infer<typeof SocratesProblem>;

export const SocratesSubmitResponse = z.union([SocratesSubmitReceipt, SocratesProblem]);
export type SocratesSubmitResponse = z.infer<typeof SocratesSubmitResponse>;
