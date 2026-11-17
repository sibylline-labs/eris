/**
 * active.ts — the active doctrine posture as `eris doctrine check` and `gates` read it: the file's
 * read (or none), its first problem as a failure, the active posture, its policy hash and
 * citation, and the ask settings with their defaults filled.
 */

import { existsSync, readFileSync } from "node:fs";
import { type ContractFailure, fail, type Outcome, succeed } from "./failure";
import { type DoctrineRead, type Posture, readDoctrine } from "./file";
import { type AskDigest, type DoctrinePolicy, SESSION_BUDGET_DEFAULT, twoWayTimeoutHours } from "./policy";

export type Mode = NonNullable<DoctrinePolicy["gates"]>[string];

/** The doctrine file's read, or null when there is no file at `file`. */
export function readDoctrineFile(file: string): Outcome<DoctrineRead | null> {
  if (!existsSync(file)) return succeed(null);
  try {
    return succeed(readDoctrine(readFileSync(file, "utf8")));
  } catch {
    return fail({
      slug: "doctrine-file-missing",
      what: `${file}: cannot read the doctrine file`,
      fix: "Check the file's permissions, or pass --file <path>.",
      docs: "docs/ERRORS.md#doctrine-file-missing",
      exit: 3,
    });
  }
}

/** `doctrine-policy-invalid` naming `read`'s first problem, or null when it has none. */
export function invalidDoctrine(file: string, read: DoctrineRead): ContractFailure | null {
  const first = read.problems[0];
  if (first === undefined) return null;
  return {
    slug: "doctrine-policy-invalid",
    what: `${file}:${first.line}: ${first.message}${read.problems.length > 1 ? ` (and ${read.problems.length - 1} more)` : ""}`,
    fix: "Run 'eris doctrine check --file <path>' and fix each line it names.",
    docs: "docs/ERRORS.md#doctrine-policy-invalid",
    exit: 3,
  };
}

/** The posture `active:` names, when it has a section. */
export function activePosture(read: DoctrineRead | null): Posture | undefined {
  return read?.postures.find((p) => p.slug === read.active);
}

/**
 * The 12-hex policy hash of `p`'s `policy:` block, or null when `p` has no `policy:` block.
 * Computed over the `policy:` block only, so editing an inactive posture or prose bullets leaves
 * it unchanged.
 */
export function policyHash(p: Pick<Posture, "policy_sha256">): string | null {
  return p.policy_sha256 === null || p.policy_sha256 === "" ? null : p.policy_sha256.slice(0, 12);
}

/**
 * The human citation of a posture: `<Display name> (<slug>@<policy-hash>)`, or
 * `<Display name> (<slug>)` when the posture has no `policy:` block.
 */
export function citePosture(p: Pick<Posture, "slug" | "name" | "policy_sha256">): string {
  const display = p.name.trim() !== "" ? p.name.trim() : p.slug;
  const hash = policyHash(p);
  return hash !== null ? `${display} (${p.slug}@${hash})` : `${display} (${p.slug})`;
}

/** A posture's ask volume controls with the defaults filled in. */
export interface EffectiveAsk {
  /** Hours a two-way ask with a recommendation waits before the doctrine answers it; null is no timeout. */
  readonly two_way_timeout_hours: number | null;
  readonly digest: AskDigest;
  readonly session_budget: number;
}

/**
 * The posture's `ask` block with defaults applied: no timeout, no digest, the default session
 * budget. Total, unlike `effectiveRemediate`: the budget applies whether or not a block (or a
 * doctrine file) exists.
 */
export function effectiveAsk(policy: DoctrinePolicy | null | undefined): EffectiveAsk {
  const a = policy?.ask;
  return {
    two_way_timeout_hours: a?.two_way_timeout === undefined ? null : (twoWayTimeoutHours(a.two_way_timeout) ?? null),
    digest: a?.digest ?? "off",
    session_budget: a?.session_budget ?? SESSION_BUDGET_DEFAULT,
  };
}

/** One `[key, value]` per effective ask setting, in a fixed order (`@ask` rows of `doctrine gates`). */
export function askRows(policy: DoctrinePolicy | null | undefined): [string, string][] {
  const a = effectiveAsk(policy);
  return [
    ["two_way_timeout", a.two_way_timeout_hours === null ? "none" : `${a.two_way_timeout_hours}h`],
    ["digest", a.digest],
    ["session_budget", String(a.session_budget)],
  ];
}
