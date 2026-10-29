/**
 * The Socrates contract v1 beyond submit: classify, policy, evidence, consult,
 * resolve and status. Each route's request (where it takes one) and its response,
 * which decodes as the body or the gateway's problem+json error, nothing else.
 *
 * A vendored copy, like socrates-contract.v1.ts, decoding the same golden file
 * (tests/fixtures/socrates-contract-v1.json, `messages.<route>`).
 *
 * Invariants:
 *  - Every response is a two-member union: body | `SocratesProblem`.
 *  - A failed gate says why. An override link names a hard gate that failed, at
 *    most once, and a `pass` offers none. An override reason is one line.
 *  - Rubric answers map a `snake_case` gate key to the answer as the rubric
 *    spells it (kebab-case): the questions belong to the rubric version, not to
 *    this file.
 *  - IDs are opaque bounded strings. The policy hash names a policy, never an entry.
 */

import { z } from "zod";
import { SocratesCandidate, SocratesProblem, SOCRATES_SOURCE_MAX_LENGTH, SOCRATES_SUBMIT_PATH, Url, Version, nonBlank } from "./socrates-contract.v1";

/** Every route, so a verb never spells a path or method by hand. */
export const SOCRATES_ROUTES = {
  submit: { method: "POST", path: SOCRATES_SUBMIT_PATH },
  classify: { method: "POST", path: "/v1/socrates/classify" },
  policy: { method: "GET", path: "/v1/socrates/policy" },
  evidence_create: { method: "POST", path: "/v1/socrates/evidence" },
  evidence_get: { method: "GET", path: "/v1/socrates/evidence/{fragment_id}" },
  consult: { method: "GET", path: "/v1/socrates/consult" },
  resolve: { method: "POST", path: "/v1/socrates/resolve" },
  status: { method: "GET", path: "/v1/socrates/status" },
} as const;

export const SOCRATES_KEY_MAX_LENGTH = 64;
export const SOCRATES_OVERRIDE_REASON_MAX_LENGTH = 200;
export const SOCRATES_GATE_REASON_MAX_LENGTH = 500;
export const SOCRATES_DOC_TITLE_MAX_LENGTH = 500;
export const SOCRATES_EVIDENCE_MAX_LENGTH = 20_000;
export const SOCRATES_DOC_MAX_LENGTH = 1_000_000;
export const SOCRATES_ID_MAX_LENGTH = 200;
export const SOCRATES_PROJECT_MAX_LENGTH = 200;

export const SocratesVerdict = z.enum(["pass", "fail", "escalate"]);
export const SocratesGateKind = z.enum(["hard", "soft"]);
export const SocratesGateOutcome = z.enum(["pass", "fail", "off", "overridden"]);
export const SocratesVerbosity = z.enum(["spine", "load_bearing", "considered", "chatty", "everything"]);
export const SocratesEscalation = z.enum(["off", "evidence", "connected_repos"]);
export const SocratesReporting = z.enum(["pulse", "epic_comment", "none"]);
export const SocratesEvidenceKind = z.enum(["code", "doc", "session_utterance"]);
export const SocratesDocKind = z.enum(["one_pager", "lbd", "ka", "retro", "canon", "practices"]);
export const SocratesCandidateState = z.enum(["pending", "filed", "needs_input", "resolved", "rejected"]);
export const SocratesResolveOutcome = z.enum(["resolved", "queued"]);

const Key = z.string().max(SOCRATES_KEY_MAX_LENGTH).regex(/^[a-z][a-z0-9_]*$/, "must be a snake_case key");
/** Published answers are kebab-case; `_` stays legal so every value `Key` accepted still decodes. */
const Answer = z.string().max(SOCRATES_KEY_MAX_LENGTH).regex(/^[a-z][a-z0-9_-]*$/, "must be a lowercase rubric answer");
const RubricVersion = z.string().regex(/^rubric@v[1-9][0-9]*$/, "must be rubric@v<N>");
const PolicyHash = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase sha256 hex");
const IsoDatetime = z
  .string()
  .regex(
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/,
    "must be an ISO 8601 datetime with an offset",
  );
const OneLine = z
  .string()
  .min(1)
  .max(SOCRATES_OVERRIDE_REASON_MAX_LENGTH)
  .regex(/^[^\r\n]*$/, "must be a single line")
  .refine((s) => s.trim().length > 0, "must not be blank");
const Id = nonBlank(SOCRATES_ID_MAX_LENGTH);
const ProjectHint = nonBlank(SOCRATES_PROJECT_MAX_LENGTH);
const NonNegativeInt = z.number().int().min(0);
const NonNegativeNumber = z.number().finite().min(0);
const Provenance = z
  .string()
  .max(SOCRATES_SOURCE_MAX_LENGTH)
  .regex(
    /^(?:https?:\/\/[^\s/?#]+[^\s]*|[A-Za-z0-9._/-]+@[0-9a-f]{7,40}:[^\s#]+#L[1-9][0-9]*(?:-L?[1-9][0-9]*)?)$/,
    "must be an http(s) URL or repo@sha:path#L<n>",
  );

const uniqueGates = (items: readonly { gate: string }[]) => new Set(items.map((i) => i.gate)).size === items.length;

// --- classify ---------------------------------------------------------------

export const SocratesOverride = z.object({ gate: Key, reason: OneLine });

export const SocratesClassifyRequest = z.object({
  schema_version: Version,
  rubric_version: RubricVersion,
  candidate: SocratesCandidate,
  answers: z.record(Key, Answer).refine((a) => Object.keys(a).length > 0, "needs at least one rubric answer"),
  overrides: z.array(SocratesOverride).min(1).refine(uniqueGates, "one override per gate").optional(),
});
export type SocratesClassifyRequest = z.infer<typeof SocratesClassifyRequest>;

export const SocratesGateResult = z
  .object({ gate: Key, kind: SocratesGateKind, outcome: SocratesGateOutcome, reason: nonBlank(SOCRATES_GATE_REASON_MAX_LENGTH).optional() })
  .refine((g) => g.outcome !== "fail" || g.reason !== undefined, "a failed gate carries a reason");

export const SocratesOverrideLink = z.object({ href: Url, method: z.literal("POST"), gate: Key, title: z.string().optional() });

export const SocratesClassifyResult = z
  .object({
    verdict: SocratesVerdict,
    rubric_version: RubricVersion,
    policy_hash: PolicyHash,
    score: NonNegativeNumber,
    threshold: NonNegativeNumber,
    gates: z.array(SocratesGateResult).min(1),
    meta: z.object({ _links: z.object({ override: z.array(SocratesOverrideLink).optional() }) }),
    contract_version: Version,
  })
  .refine((r) => {
    const links = r.meta._links.override ?? [];
    if (r.verdict === "pass") return links.length === 0;
    const failedHard = new Set(r.gates.filter((g) => g.kind === "hard" && g.outcome === "fail").map((g) => g.gate));
    return links.every((l) => failedHard.has(l.gate)) && uniqueGates(links);
  }, "override links name failed hard gates, and a pass offers none");
export type SocratesClassifyResult = z.infer<typeof SocratesClassifyResult>;

export const SocratesClassifyResponse = z.union([SocratesClassifyResult, SocratesProblem]);

// --- policy -----------------------------------------------------------------

export const SocratesPolicy = z.object({
  gates: z.record(Key, z.object({ enabled: z.boolean(), weight: NonNegativeNumber })),
  threshold: NonNegativeNumber,
  verbosity: SocratesVerbosity,
  escalation: SocratesEscalation,
  auto_resolve: z.boolean(),
  reporting: SocratesReporting,
});

export const SocratesPolicyResult = z.object({ rubric_version: RubricVersion, policy_hash: PolicyHash, policy: SocratesPolicy, contract_version: Version });
export type SocratesPolicyResult = z.infer<typeof SocratesPolicyResult>;

export const SocratesPolicyResponse = z.union([SocratesPolicyResult, SocratesProblem]);

// --- evidence ---------------------------------------------------------------

const EvidenceContent = nonBlank(SOCRATES_EVIDENCE_MAX_LENGTH);

export const SocratesEvidenceCreateRequest = z.object({
  schema_version: Version,
  candidate_id: Id.optional(),
  kind: SocratesEvidenceKind,
  provenance: Provenance,
  content: EvidenceContent,
});
export type SocratesEvidenceCreateRequest = z.infer<typeof SocratesEvidenceCreateRequest>;

export const SocratesEvidenceReceipt = z.object({ fragment_id: Id, candidate_id: Id.optional(), expires_at: IsoDatetime, contract_version: Version });
export const SocratesEvidenceCreateResponse = z.union([SocratesEvidenceReceipt, SocratesProblem]);

export const SocratesEvidenceGetRequest = z.object({ fragment_id: Id });

export const SocratesEvidenceFragment = z.object({
  fragment_id: Id,
  candidate_id: Id.optional(),
  kind: SocratesEvidenceKind,
  provenance: Provenance,
  content: EvidenceContent,
  created_at: IsoDatetime,
  expires_at: IsoDatetime,
  contract_version: Version,
});
export const SocratesEvidenceGetResponse = z.union([SocratesEvidenceFragment, SocratesProblem]);

// --- consult ----------------------------------------------------------------

export const SocratesConsultRequest = z.object({ doc: SocratesDocKind, project: ProjectHint.optional() });

export const SocratesConsultResult = z.object({
  doc: SocratesDocKind,
  title: nonBlank(SOCRATES_DOC_TITLE_MAX_LENGTH),
  url: Url,
  markdown: z.string().max(SOCRATES_DOC_MAX_LENGTH),
  fetched_at: IsoDatetime,
  contract_version: Version,
});
export type SocratesConsultResult = z.infer<typeof SocratesConsultResult>;
export const SocratesConsultResponse = z.union([SocratesConsultResult, SocratesProblem]);

// --- resolve and status -----------------------------------------------------

export const SocratesResolveRequest = z.object({ schema_version: Version, epic: Id });

export const SocratesResolveReceipt = z.object({
  epic: Id,
  outcome: SocratesResolveOutcome,
  applied: z.array(Id),
  carried_over: z.array(Id),
  carry_over_epic: Id.optional(),
  reporting: SocratesReporting,
  contract_version: Version,
});
export const SocratesResolveResponse = z.union([SocratesResolveReceipt, SocratesProblem]);

export const SocratesStatusRequest = z.object({ candidate_id: Id.optional() });

export const SocratesStatusResult = z.object({
  rubric_version: RubricVersion,
  policy_hash: PolicyHash,
  pending_candidates: NonNegativeInt,
  open_epics: z.array(z.object({ epic: Id, project: ProjectHint, url: Url, open_children: NonNegativeInt })),
  candidate: z.object({ candidate_id: Id, state: SocratesCandidateState, issue_url: Url.optional() }).optional(),
  contract_version: Version,
});
export type SocratesStatusResult = z.infer<typeof SocratesStatusResult>;
export const SocratesStatusResponse = z.union([SocratesStatusResult, SocratesProblem]);
