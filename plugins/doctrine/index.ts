/**
 * The doctrine plugin's manifest: `eris doctrine check`, `schema`, `gates` and `effect` as
 * registry rows plus a handler thunk (docs/dev/PLUGINS.md, docs/DOCTRINE.md). Every verb is
 * offline: it reads a local doctrine file, a profiles file, or stdin.
 *
 * `doctrinePlugin(defaults)` is the same plugin with the files a verb reads when no `--file` or
 * `--profiles` is given: how a distribution points the verbs at its organisation's doctrine. The
 * default export has none, so `check` needs `--file` and the gate map is taken over the built-in
 * profiles.
 */

import { definePlugin, type VerbContext } from "../../src/cli/plugin";

/** The files the verbs read when their flag is absent. */
export interface DoctrineDefaults {
  readonly doctrineFile?: string;
  readonly profilesFile?: string;
}

/** Defaults fixed at composition, or resolved per command line (from its environment, say). */
export type DoctrineDefaultsSource = DoctrineDefaults | ((ctx: VerbContext) => DoctrineDefaults | Promise<DoctrineDefaults>);

const ROWS = {
  doctrine: { impl: "ts", summary: "Doctrine policy: blocks (check, schema, gates, effect, pull, path); the U2/U3 floor cannot be waived" },
  "doctrine check": {
    summary: "Validate every posture's policy: block in a doctrine file",
    json: true,
    flags: [
      { name: "--file", takesValue: true, file: true },
      { name: "--cite", takesValue: false },
    ],
    usage: "[--file <path>] [--cite]",
  },
  "doctrine schema": { summary: "Print the policy: contract as JSON Schema" },
  "doctrine gates": {
    summary: "Print the active posture's effective gate map (profile, gate, mode)",
    flags: [
      { name: "--file", takesValue: true, file: true },
      { name: "--profiles", takesValue: true, file: true },
      { name: "--explain", takesValue: false },
    ],
    usage: "[--file <path>] [--profiles <file>] [--explain]",
  },
  "doctrine effect": {
    summary: "Read a before/after policy or surfaces pair on stdin; print one plain-English sentence per changed knob",
    json: true,
    flags: [{ name: "--profiles", takesValue: true, file: true }],
    usage: '[--profiles <file>] < {"contract": "policy"|"surfaces", "before": ..., "after": ...}',
  },
  "doctrine pull": { summary: "Fetch the org's hosted policy on the eris login bearer and write it to ~/.eris/doctrine/<orgId>/", json: true },
  "doctrine path": { summary: "Print the pulled doctrine.md of the org this directory acts as, after verifying it" },
} as const;

const JSON_FIX = `  eris doctrine check                      {active, policy_hash, citation, postures: [{slug, name, line,
                                            section, policy, policy_sha256, policy_hash, citation}]}
  eris doctrine effect                     {effects: [{path, knob, before, after, direction, sentence}]}
  eris doctrine pull                       {org, bundle_sha, dir}
`;

/** The doctrine plugin, reading `defaults` when a verb's file flag is absent. */
export function doctrinePlugin(defaults: DoctrineDefaultsSource = {}) {
  return definePlugin({
    name: "doctrine",
    rows: ROWS,
    handlers: {
      doctrine: async () => (await import("./doctrine")).doctrineHandler(defaults),
    },
    jsonFix: JSON_FIX,
  });
}

export default doctrinePlugin();
