export * from "./rubric/definition";
export { RUBRIC_V1, type RubricV1 } from "./rubric/v1";

import type { RubricVersion } from "./rubric/definition";
import { RUBRIC_V1 } from "./rubric/v1";

/** Every published rubric, by version: what a server reclassifies a stamped submission with. */
export const RUBRICS = { [RUBRIC_V1.version]: RUBRIC_V1 } as const;

export type PublishedRubricVersion = keyof typeof RUBRICS;

/** The rubric a submission was stamped with, or undefined for a version this build does not know. */
export function rubricFor(version: RubricVersion): (typeof RUBRICS)[PublishedRubricVersion] | undefined {
  return Object.hasOwn(RUBRICS, version) ? RUBRICS[version as PublishedRubricVersion] : undefined;
}
