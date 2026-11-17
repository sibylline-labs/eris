/**
 * grants.ts — the grants a gate receipt may carry in `authorized`, and when each one holds.
 *
 *   - a human grant: prose naming the request behind it (`'<name> asked: <request>'`), recorded as
 *     given; no CLI can see the prompt it came from, so it is trusted as written;
 *   - `doctrine:<posture>`: a skip the active posture pre-authorizes by turning the gate `off`,
 *     re-checked against the doctrine file each time it is read;
 *   - `repo:no-eris-yaml`: the `define-future` skip in a git repo with no root `eris.yaml`.
 *
 * Invariants:
 *  - A grant that reads as a doctrine or repo grant by its first word, in any case, wrapper or
 *    spelling, is never a human grant: it is the exact machine grant, or it is refused.
 *  - `eris gate skip` asks `doctrineSkipBlocker` at write time and `eris gate check` at read time, so a
 *    doctrine skip counts only while the posture still bears it out.
 */

import { statSync } from "node:fs";
import { gateModeSource } from "./doctrine";
import type { DoctrineRead, Posture } from "./file";

/** The `doctrine:` grant prefix: a skip pre-authorized by a posture, checked against the doctrine file. */
export const DOCTRINE_GRANT = "doctrine:";

/** The deep-profile target-graph stage, which has a subject only in repos with a root `eris.yaml`. */
export const DEFINE_FUTURE_GATE = "define-future";

/** The pre-authorized skip grant for `define-future` when the target git repo has no root `eris.yaml`. */
export const NO_ERIS_YAML_GRANT = "repo:no-eris-yaml";

/** Leading whitespace, punctuation, symbols, format and control characters dropped after NFKC. */
const unwrap = (grant: string): string => grant.normalize("NFKC").replace(/^[\s\p{P}\p{S}\p{Cf}\p{Cc}]+/u, "");

/** Whether a grant claims doctrine authority by its first word, well-formed or not (`doctrines:`, `“Doctrine`). */
export function doctrineShaped(grant: string): boolean {
  return /^doctrine/i.test(unwrap(grant));
}

/** Whether a grant claims repository pre-authorization (`repo:`, `repo_`, `Repo `), well-formed or not. */
export function repoGrantShaped(grant: string): boolean {
  return /^repo(?::|_|\b)/i.test(unwrap(grant));
}

/** A human grant: set, not blank, and neither a doctrine nor a repo grant in any spelling. */
export function isHumanGrant(grant: string | undefined): grant is string {
  const g = grant?.trim();
  return g !== undefined && g !== "" && !doctrineShaped(g) && !repoGrantShaped(g);
}

/** The posture a well-formed `doctrine:<posture>` grant names (one non-space token), else null. */
export function doctrineGrantPosture(grant: string): string | null {
  return /^doctrine:\S+$/.test(grant) ? grant.slice(DOCTRINE_GRANT.length) : null;
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Why `repo:no-eris-yaml` does not pre-authorize skipping `gate` over the git checkouts `roots`, or
 * null when it does: the gate is `define-future`, a checkout resolved, and none has a root `eris.yaml`.
 */
export function noErisYamlSkipBlocker(roots: ReadonlyArray<string>, gate: string): string | null {
  if (gate !== DEFINE_FUTURE_GATE) return `only ${DEFINE_FUTURE_GATE} is skipped when a repo has no eris.yaml, not ${gate}`;
  if (roots.length === 0) return "not inside a git repository";
  const withManifest = roots.find((top) => top !== "" && isFile(`${top}/eris.yaml`));
  if (withManifest !== undefined) return `${withManifest}/eris.yaml exists`;
  return null;
}

/** The 12-hex hash of a posture's `policy:` block, or "" when it has none. */
const hashOf = (p: Pick<Posture, "policy_sha256">): string => (p.policy_sha256 === null || p.policy_sha256 === "" ? "" : p.policy_sha256.slice(0, 12));

/** The actor a doctrine skip is recorded under: `doctrine:<slug>@<12 hex of its policy block>`. */
export function doctrineActor(p: Pick<Posture, "slug" | "policy_sha256">): string {
  return `${DOCTRINE_GRANT}${p.slug}@${hashOf(p)}`;
}

/**
 * Why `doctrine:<posture>` does not pre-authorize skipping `gate` under `read`, or null when it does:
 * the file parses, has that posture, it is the active one (when `active:` is set), and its policy
 * turns the gate off.
 */
export function doctrineSkipBlocker(read: DoctrineRead | null, posture: string, gate: string): string | null {
  if (read === null) return "there is no doctrine file";
  if (read.problems.length > 0) return "the file does not parse as a doctrine ('eris doctrine check --file' names the problem)";
  const found = read.postures.find((p) => p.slug === posture);
  if (found === undefined) return `no ## ${posture} posture`;
  if (read.active !== null && read.active !== posture) return `the active posture is ${read.active}, not ${posture}`;
  const source = gateModeSource(found.policy, gate);
  if (source?.mode === "off") return null;
  const set = source?.key.startsWith("close.") === true ? found.policy?.close?.[gate] : source?.mode;
  return `posture ${posture} sets ${source?.key ?? `gates.${gate}`} to ${set ?? "(unset)"}, not off`;
}
