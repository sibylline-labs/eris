export {
  applyOps,
  canonicalizeLinear,
  ensureDoc,
  parseTitle,
  writeDoc,
  type ApplyResult,
  type DocParent,
  type EnsureResult,
  type EntryIdentity,
  type FetchedDoc,
  type LinearDocPort,
  type OpReceipt,
  type Refusal,
  type SkippedOp,
  type SurgeryOp,
  type Title,
  type VerifiedBody,
  type WriteResult,
} from "./doc-surgery";
export * from "./entry-id";
export * from "./match";
export * from "./render";

export * from "./rubric/definition";
export { RUBRIC_V1, type RubricV1 } from "./rubric/v1";
export { RUBRIC_V2, type RubricV2 } from "./rubric/v2";

import type { RubricVersion } from "./rubric/definition";
import { RUBRIC_V1 } from "./rubric/v1";
import { RUBRIC_V2 } from "./rubric/v2";

/** Every published rubric, by version: what a server reclassifies a stamped submission with. */
export const RUBRICS = { [RUBRIC_V1.version]: RUBRIC_V1, [RUBRIC_V2.version]: RUBRIC_V2 } as const;

export type PublishedRubricVersion = keyof typeof RUBRICS;

/** The rubric a submission was stamped with, or undefined for a version this build does not know. */
export function rubricFor(version: RubricVersion): (typeof RUBRICS)[PublishedRubricVersion] | undefined {
  return Object.hasOwn(RUBRICS, version) ? RUBRICS[version as PublishedRubricVersion] : undefined;
}
