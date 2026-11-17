/**
 * surfaces.ts — the `.claude/surfaces.yml` Schema: the tier-1 surface registry a doctrine's
 * `signoff.raise` keys name, and the second contract `eris doctrine effect` reads. Each knob
 * carries its explanation (explain.ts), so an edit renders as sentences like a policy change does.
 */

import * as Schema from "effect/Schema";
import { described, explained, meant } from "./explain";

export const SURFACE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const UNLOCK_GATE = /^[a-z0-9]+(-[a-z0-9]+)*(:[a-z0-9]+(-[a-z0-9]+)*)?$/;
export const AUDIT_TTL = /^[1-9]\d*[dh]$/;
/** An issue-tracker key: a project prefix and a number. */
export const LEDGER_KEY = /^[A-Z][A-Z0-9]*-[0-9]+$/;

export const SEVERITY_FLOORS = ["critical", "high", "medium", "low"] as const;
export const UNLOCK_ACTIONS = ["merge", "deploy", "effect"] as const;

export const DEFAULT_SEVERITY_FLOOR = "low" as const;
export const DEFAULT_AUDIT_TTL = "30d" as const;
export const DEFAULT_CHANGE_BUDGET = 10 as const;

const severityFloorMeanings = meant({
  summary: "The lowest severity of posture finding that is reported.",
  values: {
    critical: "Only critical findings are reported.",
    high: "High and critical findings are reported.",
    medium: "Medium findings and above are reported.",
    low: "Every finding is reported.",
  },
  rank: ["critical", "high", "medium", "low"],
});
export const SeverityFloor = Schema.Literals(SEVERITY_FLOORS).annotate(severityFloorMeanings);
export type SeverityFloor = typeof SeverityFloor.Type;

const unlockGateDescribed = described(
  "A gate name, optionally with a qualifier, whose passing receipt is required. An effort qualifier (adversarial-review:max) passes only on a review-report@1 for this surface at that effort or above; :clean passes only on a PASS, not AMENDED; any other qualifier never unlocks.",
);
export const UnlockGate = Schema.String.annotate(unlockGateDescribed).check(
  Schema.isPattern(UNLOCK_GATE, { expected: "a kebab-case gate name with optional :qualifier (e.g. adversarial-review:max)" }),
);
export type UnlockGate = typeof UnlockGate.Type;

const unlockFor = (action: string, what: string) =>
  explained({
    summary: `The gates whose passing receipts let an agent ${what} on this surface without a human.`,
    protects: `an agent being able to ${what} on a sensitive surface with too little evidence.`,
    raise: `The agent must pass more gates before it may ${what} alone, or (with '${action}' removed) never alone.`,
    lower: `The agent may ${what} alone on less evidence: fewer gates, or '${action}' newly listed; leave it out to keep it human-signed.`,
    unset: "strictest",
  });

export const OneWayUnlock = Schema.Struct({
  merge: Schema.optionalKey(Schema.Array(UnlockGate).annotate(unlockFor("merge", "merge a one-way change"))),
  deploy: Schema.optionalKey(Schema.Array(UnlockGate).annotate(unlockFor("deploy", "deploy a one-way change"))),
  effect: Schema.optionalKey(Schema.Array(UnlockGate).annotate(unlockFor("effect", "run a one-way side effect"))),
});
export type OneWayUnlock = typeof OneWayUnlock.Type;

const auditTtlExplained = explained({
  summary: "How old the last clean surface audit may be before unlocks fall back to a human sign-off (default 30d).",
  protects: "an agent unlocking on an audit that no longer reflects the code.",
  raise: "A shorter window forces audits more often.",
  lower: "A longer window trusts an older audit.",
  stricter: "less",
});
export const AuditTtl = Schema.String.annotate(auditTtlExplained).check(
  Schema.isPattern(AUDIT_TTL, { expected: "a positive duration in days or hours (e.g. 30d, 720h)" }),
);
export type AuditTtl = typeof AuditTtl.Type;

const changeBudgetExplained = explained({
  summary: "How many unlocked merges one clean audit covers before the surface must be audited again (default 10).",
  protects: "many small unlocked changes adding up to a posture nobody has audited.",
  raise: "A smaller budget forces a re-audit sooner.",
  lower: "A larger budget lets more changes ride on one audit.",
  stricter: "less",
});
export const ChangeBudget = Schema.Number.annotate(changeBudgetExplained).check(
  Schema.makeFilter((n) => Number.isInteger(n) && n >= 1, { expected: "an integer change_budget >= 1" }),
);
export type ChangeBudget = typeof ChangeBudget.Type;

const ledgerExplained = explained({
  summary: "The Linear issue that holds this surface's audit-surfaces baseline and unlocked-<action> receipts (one issue per surface).",
  protects: "an agent unlocking with no single auditable ledger holding the surface's baseline and change budget.",
  raise: "Setting a ledger points unlock checks at that issue's audit baseline and budget.",
  lower: "Without a ledger, every one-way action on the surface stays human-signed; changing the ledger re-points the baseline.",
});
/** The issue that holds a surface's audit baseline and unlocked-action receipts, so a surface-wide baseline and change budget live on one issue. */
export const Ledger = Schema.String.annotate(ledgerExplained).check(
  Schema.isPattern(LEDGER_KEY, { expected: "a Linear issue key (e.g. ABC-123)" }),
);
export type Ledger = typeof Ledger.Type;

const globDescribed = described("A repo-relative glob (*, **, ?, {a,b}) matched against changed files.");
const GlobPattern = Schema.String.annotate(globDescribed).check(Schema.isMinLength(1, { expected: "a non-empty glob pattern" }));

const pathsExplained = explained({
  summary: "The files that belong to the surface, as repo-relative globs; a file may belong to several surfaces.",
  protects: "a sensitive file slipping past the posture check because no glob covers it.",
  raise: "More paths are gated, so more changes get posture checks.",
  lower: "Fewer paths are gated, so changes to the dropped files get no posture check.",
});
const Paths = Schema.NonEmptyArray(GlobPattern).annotate(pathsExplained);

const classTaxonomyExplained = explained({
  summary: "The vocabulary file listing the defect classes checked on this surface.",
  protects: "posture checks that know only generic defects and miss this surface's known failure shapes.",
  raise: "Pointing at a richer vocabulary checks more known failure shapes.",
  lower: "Without its own vocabulary, only the universal defect classes are checked.",
});
const ClassTaxonomy = Schema.String.annotate(classTaxonomyExplained).check(Schema.isMinLength(1, { expected: "a non-empty string" }));

const severityFloorExplained = explained({
  summary: "The lowest severity a posture finding must reach to be reported on this surface (default low: everything).",
  protects: "real findings being hidden as noise.",
  raise: "A lower floor (toward low) reports more findings.",
  lower: "A higher floor (toward critical) quiets the lesser findings.",
});

const descriptionExplained = explained({
  summary: "Free-text notes on why the surface is tier-1; no check reads it.",
  protects: "the next reader not knowing why these paths are gated.",
  raise: "More context for reviewers; no effect on gating.",
  lower: "Less context for reviewers; no effect on gating.",
});

const oneWayUnlockExplained = explained({
  summary: "Per action (merge, deploy, effect), the gates that let an agent pass a one-way door on this surface without a human; an action left out stays human-signed.",
  protects: "an agent passing an irreversible change on a sensitive surface with too little evidence.",
  raise: "Requiring more gates, or listing fewer actions, keeps more one-way doors with a human.",
  lower: "Listing an action, or requiring fewer gates for it, lets the agent pass those doors alone.",
});

const surfaceEntryDescribed = described("One tier-1 surface: the paths it covers and how hard changes to them are gated.");
export const SurfaceEntry = Schema.Struct({
  paths: Paths,
  class_taxonomy: Schema.optionalKey(ClassTaxonomy),
  severity_floor: Schema.optionalKey(SeverityFloor.annotate(severityFloorExplained)),
  description: Schema.optionalKey(Schema.String.annotate(descriptionExplained)),
  one_way_unlock: Schema.optionalKey(OneWayUnlock.annotate(oneWayUnlockExplained)),
  audit_ttl: Schema.optionalKey(AuditTtl),
  change_budget: Schema.optionalKey(ChangeBudget),
  ledger: Schema.optionalKey(Ledger),
}).annotate(surfaceEntryDescribed);
export type SurfaceEntry = typeof SurfaceEntry.Type;

const surfacesExplained = explained({
  summary: "The registered tier-1 surfaces (auth, secrets, webhooks, ...), by kebab-case name; a change touching one gets posture checks.",
  protects: "a change to a sensitive area merging without anyone checking its cumulative posture.",
  raise: "Registering a surface puts every change touching its paths through posture checks.",
  lower: "An unregistered area gets no posture check at all.",
  unset: "loosest",
});
export const SurfacesMap = Schema.Record(Schema.String, SurfaceEntry)
  .annotate(surfacesExplained)
  .check(Schema.makeFilter((r) => Object.keys(r).length > 0, { expected: "at least one surface in 'surfaces:'" }))
  .check(
    Schema.makeFilter((r) => Object.keys(r).every((k) => SURFACE_NAME.test(k)), {
      expected: "kebab-case surface names (e.g. auth, secrets, app-inbound-auth)",
    }),
  )
  .check(
    Schema.makeFilter(
      (r) => {
        const ledgers = Object.values(r).flatMap((s) => (s.ledger === undefined ? [] : [s.ledger]));
        return new Set(ledgers).size === ledgers.length;
      },
      { expected: "a distinct ledger per surface (an audit-surfaces receipt on a ledger is that one surface's baseline)" },
    ),
  );

/** A path inside the skill directory: relative, `/`-separated, no `..` segment. */
export const SKILL_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\\]+$/;

/** A review skill: `skills/<name>/` is human-edited only, except an addition-only change to its class checklist, which tightens. */
const checklistExplained = explained({
  summary: "The review skill's class checklist, a path inside skills/<name>/; adding new class sections to it is the only edit an agent may make to the skill.",
  protects: "a review skill's checks being loosened by the agents it reviews.",
  raise: "Pointing at a checklist with more classes checks more failure shapes.",
  lower: "Re-pointing it at a thinner checklist is a widening that needs a human.",
});
const reviewSkillDescribed = described("One review skill: skills/<name>/ is human-edited only, except new classes appended to its checklist.");
export const ReviewSkillEntry = Schema.Struct({
  checklist: Schema.String.annotate(checklistExplained).check(
    Schema.isPattern(SKILL_RELATIVE_PATH, { expected: "a path inside the skill directory, relative, with no '..' segment" }),
  ),
}).annotate(reviewSkillDescribed);
export type ReviewSkillEntry = typeof ReviewSkillEntry.Type;

const reviewSkillsExplained = explained({
  summary: "The review skills whose directories only a human may edit (eris gate monotone); keyed by the directory name under skills/.",
  protects: "an agent editing the prose of a skill that reviews its own changes.",
  raise: "More skills registered means more directories only a human may change.",
  lower: "Unregistering a skill is a widening that needs a human.",
});
export const ReviewSkillsMap = Schema.Record(Schema.String, ReviewSkillEntry).annotate(reviewSkillsExplained).check(
  Schema.makeFilter((r) => Object.keys(r).every((k) => SURFACE_NAME.test(k)), {
    expected: "kebab-case review skill names (the directory under skills/)",
  }),
);

const surfacesFileDescribed = described("The tier-1 surface registry (.claude/surfaces.yml).");
export const SurfacesFile = Schema.Struct({ surfaces: SurfacesMap, review_skills: Schema.optionalKey(ReviewSkillsMap) }).annotate(surfacesFileDescribed);
export type SurfacesFile = typeof SurfacesFile.Type;
