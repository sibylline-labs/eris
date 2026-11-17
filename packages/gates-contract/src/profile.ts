/**
 * profile.ts — the gate list a work profile requires, and the `--profiles` file that names them.
 *
 * The built-ins are the two work profiles, spine and deep. `--profiles <file>` reads a YAML map
 * instead: an entry is a list of required gates, `<profile>: [<gate>, ...]`, or
 * `<profile>: { require: [...], forbid: [...] }`, where a forbidden gate is one a run must never
 * record. Names are kebab-case. Which gates a doctrine turns off is not decided here.
 */

import { readFileSync } from "node:fs";
import * as Schema from "effect/Schema";
import { parse as parseYaml } from "yaml";
import { decodeResult } from "./decode";
import type { GateProfile } from "./doctrine";
import { type ContractFailure, fail, type Outcome, succeed } from "./failure";

/** The gates a run must record, and the gates it must never record. */
export type Profile = GateProfile;

export const BUILTIN_PROFILES: Readonly<Record<string, Profile>> = {
  spine: { require: ["premise-gate", "plan-review", "final-gates"], forbid: [] },
  deep: { require: ["premise-gate", "define-future", "sdk-check", "plan-review", "final-gates"], forbid: [] },
};

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const kebab = (expected: string) => Schema.String.check(Schema.isPattern(KEBAB, { expected }));
const kebabKeys = <V extends Schema.Top>(value: V, expected: string) =>
  Schema.Record(Schema.String, value).check(Schema.makeFilter((r) => Object.keys(r).every((k) => KEBAB.test(k)), { expected }));

const GateName = kebab("a kebab-case gate name");
const Required = Schema.NonEmptyArray(GateName);
const Guarded = Schema.Struct({ require: Required, forbid: Schema.optionalKey(Schema.Array(GateName)) }).check(
  Schema.makeFilter((p) => !(p.forbid ?? []).some((g) => p.require.includes(g)), { expected: "no gate both required and forbidden" }),
);

/** Work and close profiles: `<name>: [<gate>, ...]` or `<name>: { require, forbid }` (`--profiles`). */
export const GateProfiles = kebabKeys(Schema.Union([Required, Guarded]), "kebab-case profile names");
export type GateProfiles = typeof GateProfiles.Type;

/** One profile entry as a `Profile`: the list form requires its gates and forbids none. */
export function gateProfileOf(entry: GateProfiles[string]): Profile {
  return "require" in entry ? { require: entry.require, forbid: entry.forbid ?? [] } : { require: entry, forbid: [] };
}

/** Every entry of `profiles` as a `Profile`. */
export function gateProfilesOf(profiles: GateProfiles): Record<string, Profile> {
  return Object.fromEntries(Object.entries(profiles).map(([name, entry]) => [name, gateProfileOf(entry)]));
}

function unreadable(file: string, why: string): ContractFailure {
  return {
    slug: "gate-profile-unreadable",
    what: `--profiles ${file}: ${why}`,
    fix:
      "Point --profiles at a YAML map of profile name to a non-empty list of kebab-case gate names,\n" +
      "or to { require: [<gate>, ...], forbid: [<gate>, ...] } with no gate in both lists.",
    docs: "docs/ERRORS.md#gate-profile-unreadable",
    exit: 3,
  };
}

/** The profiles in force: `file`'s when given, else the built-ins. */
export function readProfiles(file: string | undefined): Outcome<Readonly<Record<string, Profile>>> {
  if (file === undefined) return succeed(BUILTIN_PROFILES);
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(file, "utf8"));
  } catch {
    return fail(unreadable(file, "cannot read or parse the file"));
  }
  const decoded = decodeResult(GateProfiles, doc);
  return decoded._tag === "Success" ? succeed(gateProfilesOf(decoded.success)) : fail(unreadable(file, "not a map of profile name to a gate list or { require, forbid }"));
}
