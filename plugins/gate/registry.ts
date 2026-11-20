/**
 * registry.ts — `.claude/surfaces.yml` validation and matching (re-exported from
 * `eris/gates-contract`) plus the gate plugin's `surfacesInvalid` refusal.
 */

import { precondition } from "./failure";

export {
  expandBraces,
  globToRegex,
  issuesText,
  type MatchedSurface,
  matchSurfaces,
  type SurfacesIssue,
  type SurfacesValidationResult,
  validateSurfacesYaml,
  vocabularyPath,
} from "eris/gates-contract";

/** Stop with `gate-surfaces-invalid` naming the registry `file` and why. */
export function surfacesInvalid(file: string, why: string): never {
  return precondition(
    "gate-surfaces-invalid",
    `${file}: ${why}`,
    "Make the file a valid .claude/surfaces.yml with a non-empty 'surfaces:' map of kebab-case surface names\n" +
      "to { paths: [<glob>, ...], class_taxonomy?, severity_floor?, description?, one_way_unlock?, audit_ttl?, change_budget?, ledger? },\n" +
      "and optionally 'review_skills:', kebab-case skill names to { checklist: <path inside skills/<name>/> }.",
  );
}
