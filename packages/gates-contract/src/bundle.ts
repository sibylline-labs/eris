/**
 * bundle.ts — the hosted org policy bundle (`gates-contract/v1.5`): what `GET /v1/gates/policy` and
 * `/settings` serve, the 12-hex `bundle_sha` taken over them, and the files the bundle is written to
 * disk as (docs/dev/GATES-CLIENT.md#the-pulled-tree).
 *
 * Invariants:
 *  - Every posture's `policy` is a `GateDoctrinePolicy`, so decoding a bundle enforces the floor.
 *  - `active` names a posture; every `profile_default` names a profile; every posture's effective
 *    remediation loop names a loop; the loops total at most `GATES_LOOPS_MAX_BYTES` UTF-8 bytes.
 *  - `bundle_sha` is taken over the decoded values, so keys a lax decode dropped never reach it.
 *  - `renderBundle` is a byte contract: every eris build writes the same files for the same bundle,
 *    so builds on one machine share one tree. `bundleFromFiles` reads those files back to the
 *    bundle they were rendered from.
 */

import * as Schema from "effect/Schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { effectiveRemediate, GateDoctrinePolicy } from "./doctrine";
import { readBundleSections } from "./file";
import { GateProfiles } from "./profile";

/** The policy surface's version. */
export const GATES_POLICY_CONTRACT_VERSION = "gates-contract/v1.5" as const;

/** The loops' total UTF-8 size cap. */
export const GATES_LOOPS_MAX_BYTES = 256 * 1024;

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const kebab = (expected: string) => Schema.String.check(Schema.isPattern(KEBAB, { expected }));
const kebabKeys = <V extends Schema.Top>(value: V, expected: string) =>
  Schema.Record(Schema.String, value).check(Schema.makeFilter((r) => Object.keys(r).every((k) => KEBAB.test(k)), { expected }));

export const GatesBundleSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{12}$/, { expected: "12 lowercase hex characters" }));
export type GatesBundleSha = typeof GatesBundleSha.Type;

/** A posture: the `## <slug>` section of `doctrine.md` as data. */
export const GatesPosture = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  bullets: Schema.Array(Schema.String),
  policy: GateDoctrinePolicy,
});
export type GatesPosture = typeof GatesPosture.Type;

const utf8 = new TextEncoder();
const loopBytes = (loops: Readonly<Record<string, string>>): number => Object.values(loops).reduce((n, body) => n + utf8.encode(body).length, 0);

/** The org's versioned policy bundle. */
export const GatesOrgBundle = Schema.Struct({
  active: kebab("a kebab-case posture slug"),
  postures: kebabKeys(GatesPosture, "kebab-case posture slugs"),
  profiles: GateProfiles,
  loops: kebabKeys(Schema.String, "kebab-case loop slugs"),
}).check(
  Schema.makeFilter((b) => Object.hasOwn(b.postures, b.active), { expected: "an active posture that the postures map holds" }),
  Schema.makeFilter((b) => Object.values(b.postures).every((p) => p.policy.profile_default === undefined || Object.hasOwn(b.profiles, p.policy.profile_default)), {
    expected: "every posture's profile_default naming a profile in profiles",
  }),
  Schema.makeFilter(
    (b) =>
      Object.values(b.postures).every((p) => {
        const r = effectiveRemediate(p.policy);
        return r === undefined || Object.hasOwn(b.loops, r.loop);
      }),
    { expected: "every posture's remediation loop naming a loop in loops" },
  ),
  Schema.makeFilter((b) => loopBytes(b.loops) <= GATES_LOOPS_MAX_BYTES, { expected: `loops totalling at most ${GATES_LOOPS_MAX_BYTES} UTF-8 bytes` }),
);
export type GatesOrgBundle = typeof GatesOrgBundle.Type;

const GITHUB_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(\[bot\])?$/;

/** What CI does with a pull request: profile checks on or off, untracked PRs, and the bots exempt from an issue key. */
export const GatesCiSettings = Schema.Struct({
  check_profile_in_ci: Schema.Literals(["on", "off"]),
  untracked_prs: Schema.Literals(["block", "warn", "allow"]),
  bot_allowlist: Schema.Array(Schema.String.check(Schema.isPattern(GITHUB_LOGIN, { expected: "a GitHub login, optionally ending [bot]" }))),
});
export type GatesCiSettings = typeof GatesCiSettings.Type;

/** The org's Gates settings. */
export const GatesSettings = Schema.Struct({
  skills_repo: Schema.optionalKey(Schema.String.check(Schema.isPattern(GITHUB_REPO, { expected: "owner/repo" }))),
  staleness: Schema.Literals(["soft", "hard"]),
  ci: GatesCiSettings,
  spend_cap_calls: Schema.optionalKey(Schema.Number.check(Schema.makeFilter((n) => Number.isSafeInteger(n) && n > 0, { expected: "a positive integer" }))),
});
export type GatesSettings = typeof GatesSettings.Type;

/** `GET /v1/gates/policy`. */
export const GatesPolicyReply = Schema.Struct({
  contract: Schema.Literal(GATES_POLICY_CONTRACT_VERSION),
  bundle: GatesOrgBundle,
  bundle_sha: GatesBundleSha,
});
export type GatesPolicyReply = typeof GatesPolicyReply.Type;

/** `GET /v1/gates/settings`. */
export const GatesSettingsReply = Schema.Struct({
  contract: Schema.Literal(GATES_POLICY_CONTRACT_VERSION),
  settings: GatesSettings,
  bundle_sha: GatesBundleSha,
});
export type GatesSettingsReply = typeof GatesSettingsReply.Type;

/** Deterministic JSON: object keys sorted, `undefined` members dropped, `undefined` array slots as `null`. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

/** The 12-hex `bundle_sha`: SHA-256 over the canonical JSON of `{ bundle, settings }`, first 12 lowercase hex. */
export async function computeGatesBundleSha(bundle: GatesOrgBundle, settings: GatesSettings): Promise<GatesBundleSha> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(canonicalJson({ bundle, settings }))));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex.slice(0, 12);
}

/** Each slug of `from` and `to` (sorted) whose value differs, as `<label> <slug> added|removed|<edited>`. */
function keyedChanges(label: string, edited: string, from: Readonly<Record<string, unknown>>, to: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const slug of [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()) {
    if (!Object.hasOwn(from, slug)) out.push(`${label} ${slug} added`);
    else if (!Object.hasOwn(to, slug)) out.push(`${label} ${slug} removed`);
    else if (canonicalJson(from[slug]) !== canonicalJson(to[slug])) out.push(`${label} ${slug} ${edited}`);
  }
  return out;
}

/**
 * The parts of `base` that `next` changes, in bundle order: `active`, `posture <slug> added|removed|changed`,
 * `profiles`, `loop <slug> added|removed|edited`. Key order is not a change; equal bundles answer `[]`.
 */
export function bundleChanges(base: GatesOrgBundle, next: GatesOrgBundle): string[] {
  return [
    ...(base.active === next.active ? [] : ["active"]),
    ...keyedChanges("posture", "changed", base.postures, next.postures),
    ...(canonicalJson(base.profiles) === canonicalJson(next.profiles) ? [] : ["profiles"]),
    ...keyedChanges("loop", "edited", base.loops, next.loops),
  ];
}

export const BUNDLE_DOCTRINE_FILE = "doctrine.md";
export const BUNDLE_PROFILES_FILE = "profiles.yaml";
export const BUNDLE_LOOPS_DIR = "loops";

/** The files a bundle is written as, by path relative to the tree. */
export function renderBundle(bundle: GatesOrgBundle): Record<string, string> {
  const doc = [`active: ${bundle.active}`, ""];
  for (const [slug, p] of Object.entries(bundle.postures)) {
    doc.push(`## ${slug}`, p.name, ...p.bullets.map((b) => `- ${b}`), "", "```yaml", stringifyYaml({ policy: p.policy }).trimEnd(), "```", "");
  }
  const files: Record<string, string> = { [BUNDLE_DOCTRINE_FILE]: doc.join("\n"), [BUNDLE_PROFILES_FILE]: stringifyYaml(bundle.profiles) };
  for (const [slug, body] of Object.entries(bundle.loops)) files[`${BUNDLE_LOOPS_DIR}/${slug}.md`] = body;
  return files;
}

/** Whether `rel` is a path a bundle renders to: doctrine.md, profiles.yaml or loops/<slug>.md. */
export function isBundleFile(rel: string): boolean {
  return rel === BUNDLE_DOCTRINE_FILE || rel === BUNDLE_PROFILES_FILE || (rel.startsWith(`${BUNDLE_LOOPS_DIR}/`) && rel.endsWith(".md") && rel.length > BUNDLE_LOOPS_DIR.length + 4);
}

/**
 * The bundle a tree's files hold, undecoded (the caller decodes it as `GatesOrgBundle`), or the first
 * file that cannot be read as one. Each posture's policy is its fence's raw `policy:` value, so the
 * bundle decode, not the doctrine reader's wider policy Schema, decides what it holds.
 */
export function bundleFromFiles(files: Readonly<Record<string, string>>): { readonly value: unknown } | { readonly bad: string } {
  const read = readBundleSections(files[BUNDLE_DOCTRINE_FILE] ?? "");
  if (read.problems.length > 0) return { bad: `${BUNDLE_DOCTRINE_FILE} line ${read.problems[0]!.line}: ${read.problems[0]!.message}` };
  let profiles: unknown;
  try {
    profiles = parseYaml(files[BUNDLE_PROFILES_FILE] ?? "");
  } catch {
    return { bad: `${BUNDLE_PROFILES_FILE} is not YAML` };
  }
  const loops: Record<string, string> = {};
  for (const [rel, body] of Object.entries(files)) {
    if (rel.startsWith(`${BUNDLE_LOOPS_DIR}/`) && rel.endsWith(".md")) loops[rel.slice(BUNDLE_LOOPS_DIR.length + 1, -3)] = body;
  }
  const postures = Object.fromEntries(read.postures.map((p) => [p.slug, { name: p.name, bullets: p.bullets, policy: p.policy }]));
  return { value: { active: read.active, postures, profiles, loops } };
}
