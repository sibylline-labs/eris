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
import {
  SocratesAnswer as Answer,
  SocratesCandidate,
  SocratesCandidateState,
  SocratesDocKind,
  SocratesEvidenceContent as EvidenceContent,
  SocratesEvidenceKind,
  SocratesKey as Key,
  SocratesNonNegativeNumber as NonNegativeNumber,
  SocratesOverrides,
  SocratesPolicyHash as PolicyHash,
  SocratesProblem,
  SocratesProvenance as Provenance,
  SocratesRepoPolicy,
  SocratesRubricAnswers,
  SocratesRubricVersion as RubricVersion,
  SocratesVerdict,
  SOCRATES_SUBMIT_PATH,
  uniqueGates,
  Url,
  Version,
  nonBlank,
} from "./socrates-contract.v1";

export {
  SOCRATES_DOC_KINDS,
  SOCRATES_EVIDENCE_MAX_LENGTH,
  SOCRATES_KEY_MAX_LENGTH,
  SOCRATES_OVERRIDE_REASON_MAX_LENGTH,
  SocratesCandidateState,
  SocratesDocKind,
  SocratesEvidenceKind,
  SocratesOverride,
  SocratesRepoPolicy,
  SocratesVerdict,
} from "./socrates-contract.v1";

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
  settings_team: { method: "PUT", path: "/v1/socrates/settings/team" },
  settings: { method: "GET", path: "/v1/socrates/settings" },
  settings_policy: { method: "PUT", path: "/v1/socrates/settings/policy" },
  settings_canon: { method: "PUT", path: "/v1/socrates/settings/canon" },
} as const;

export const SOCRATES_GATE_REASON_MAX_LENGTH = 500;
export const SOCRATES_DOC_TITLE_MAX_LENGTH = 500;
export const SOCRATES_DOC_MAX_LENGTH = 1_000_000;
export const SOCRATES_ID_MAX_LENGTH = 200;
export const SOCRATES_PROJECT_MAX_LENGTH = 200;

export const SocratesGateKind = z.enum(["hard", "soft"]);
export const SocratesGateOutcome = z.enum(["pass", "fail", "off", "overridden"]);
export const SocratesVerbosity = z.enum(["spine", "load_bearing", "considered", "chatty", "everything"]);
export const SocratesEscalation = z.enum(["off", "evidence", "connected_repos"]);
export const SocratesReporting = z.enum(["pulse", "epic_comment", "none"]);
export const SocratesResolveOutcome = z.enum(["resolved", "queued"]);

const IsoDatetime = z
  .string()
  .regex(
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/,
    "must be an ISO 8601 datetime with an offset",
  );
const Id = nonBlank(SOCRATES_ID_MAX_LENGTH);
const ProjectHint = nonBlank(SOCRATES_PROJECT_MAX_LENGTH);
const NonNegativeInt = z.number().int().min(0);

// --- classify ---------------------------------------------------------------

export const SocratesClassifyRequest = z.object({
  schema_version: Version,
  rubric_version: RubricVersion,
  candidate: SocratesCandidate,
  answers: SocratesRubricAnswers,
  overrides: SocratesOverrides.optional(),
  repo_policy: SocratesRepoPolicy.optional(),
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

// --- settings team ----------------------------------------------------------

/** `team` is a Linear team UUID on the project; `null` clears the override. */
export const SocratesSettingsTeamRequest = z.object({ schema_version: Version, project: ProjectHint.optional(), team: Id.nullable() });

const TeamRef = z.object({ id: Id, key: Id });
export const SocratesSettingsTeamReceipt = z.object({
  project: Id,
  override: TeamRef.nullable(),
  filing_team: z.object({ id: Id, key: Id, source: z.enum(["override", "lead", "first"]) }),
  contract_version: Version,
});
export type SocratesSettingsTeamReceipt = z.infer<typeof SocratesSettingsTeamReceipt>;
export const SocratesSettingsTeamResponse = z.union([SocratesSettingsTeamReceipt, SocratesProblem]);

// --- settings read model and the policy and Canon writes -------------------

/** `rubric_version` must be the rubric the server scores with; `expected_version`, when sent, is the policy version the editor read. */
export const SocratesSettingsPolicyRequest = z.object({
  schema_version: Version,
  rubric_version: RubricVersion,
  policy: SocratesPolicy,
  expected_version: NonNegativeInt.optional(),
});
export type SocratesSettingsPolicyRequest = z.infer<typeof SocratesSettingsPolicyRequest>;

/** `doc` is a Linear document id; `null` clears the Canon doc. */
export const SocratesSettingsCanonRequest = z.object({ schema_version: Version, doc: Id.nullable(), expected_version: NonNegativeInt.optional() });
export type SocratesSettingsCanonRequest = z.infer<typeof SocratesSettingsCanonRequest>;

/** What every settings write answers: the version it stored and the hash that version carries. */
export const SocratesSettingsReceipt = z.object({
  rubric_version: RubricVersion,
  policy_version: NonNegativeInt,
  policy_hash: PolicyHash,
  policy: SocratesPolicy,
  canon_doc_id: Id.nullable(),
  contract_version: Version,
});
export type SocratesSettingsReceipt = z.infer<typeof SocratesSettingsReceipt>;
export const SocratesSettingsWriteResponse = z.union([SocratesSettingsReceipt, SocratesProblem]);

const Rate = z.number().finite().min(0).max(1);

export const SocratesSettingsResult = z.object({
  policy: z.object({
    rubric_version: RubricVersion,
    version: NonNegativeInt,
    source: z.enum(["default", "org"]),
    policy_hash: PolicyHash,
    policy: SocratesPolicy,
    updated_at: IsoDatetime.nullable(),
  }),
  canon: z.object({ doc_id: Id.nullable() }),
  enrolment: z.object({ projects: z.array(z.object({ id: Id, name: ProjectHint.nullable(), source: z.enum(["label", "stub"]), url: Url.nullable() })) }),
  health: z.object({
    install: z.object({ state: z.enum(["installed", "provisioned", "needs_labels", "uninstalled"]).nullable(), missing_labels: z.array(ProjectHint), checked_at: IsoDatetime.nullable() }),
    webhook: z.object({ last_delivery_at: IsoDatetime.nullable() }),
    reconcile: z.object({ last_at: IsoDatetime.nullable(), watermark: IsoDatetime.nullable() }),
    stuck: z.object({ retrying_writes: NonNegativeInt, oldest_retrying_at: IsoDatetime.nullable(), refused_entries: NonNegativeInt }),
  }),
  usage: z.object({
    window_days: NonNegativeInt,
    entries: z.object({ total: NonNegativeInt, pending: NonNegativeInt, filed: NonNegativeInt, resolved: NonNegativeInt, rejected: NonNegativeInt, needs_input: NonNegativeInt }),
    accept_rate: Rate.nullable(),
    reject_rate: Rate.nullable(),
    classifications: z.object({ total: NonNegativeInt, passed: NonNegativeInt, failed: NonNegativeInt, overridden: NonNegativeInt, overrides: NonNegativeInt }),
  }),
  contract_version: Version,
});
export type SocratesSettingsResult = z.infer<typeof SocratesSettingsResult>;
export const SocratesSettingsResponse = z.union([SocratesSettingsResult, SocratesProblem]);
