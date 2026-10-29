/**
 * The yak plugin's manifest: `eris yak issue|suggest|fatal`; `eris yak status`,
 * `discover` and `config get|set`, which read and set the org's destination; and
 * `eris login` / `eris logout`, which manage the bearer `eris yak` reads, as
 * registry rows plus handler thunks (docs/dev/PLUGINS.md).
 *
 * Read on every command line, `eris completion` included: rows are inline
 * data, and the handler module loads only when `eris yak` dispatches.
 */

import { definePlugin } from "../../src/cli/plugin";

/** The one grammar the three verbs share. */
const YAK_FLAGS = [
  { name: "--summary", takesValue: true },
  { name: "--body", takesValue: true },
  { name: "--body-file", takesValue: true, file: true },
  { name: "--evidence", takesValue: true },
  { name: "--evidence-file", takesValue: true, file: true },
  { name: "--repro", takesValue: true },
  { name: "--repo", takesValue: true, repeatable: true },
  { name: "--no-redact", takesValue: false },
  { name: "--vendor", takesValue: false },
] as const;

export default definePlugin({
  name: "yak",
  rows: {
    yak: { impl: "ts", summary: "Land a durable observation with a Yaks endpoint (issue, suggest, fatal)" },
    "yak fatal": { summary: "The harness itself is broken", json: true, flags: YAK_FLAGS },
    "yak issue": { summary: "A harness/tooling defect, confirmed or suspected", json: true, flags: YAK_FLAGS },
    "yak suggest": { summary: "An improvement to the harness: a missing capability or a better way of working", json: true, flags: YAK_FLAGS },
    "yak status": { summary: "Whether this org has a destination for its yaks, and how many it holds", json: true },
    "yak discover": {
      summary: "The Linear teams, projects, states and labels this org can file yaks into",
      json: true,
      pos: ["kind?"],
      usage: "[teams|projects|states|labels] [--team <id|key|name>]",
      complete: [["teams", "projects", "states", "labels"]],
      flags: [{ name: "--team", takesValue: true }],
    },
    "yak config": { summary: "Read or set where this org's yaks are filed (get, set)" },
    "yak config get": { summary: "Show where this org's yaks are filed", json: true },
    "yak config set": {
      summary: "Set where this org's yaks are filed (an org admin's)",
      json: true,
      usage: "--team <id|key|name> [--project <id|name|none>] [--state <id|name|none>] [--labels <id|name,...>]",
      flags: [
        { name: "--team", takesValue: true },
        { name: "--project", takesValue: true },
        { name: "--state", takesValue: true },
        { name: "--labels", takesValue: true, repeatable: true },
      ],
    },
    login: {
      impl: "ts",
      summary: "Sign this machine in with a device code; writes the token 'eris yak' uses",
      usage: "[--url <url>] [--no-browser]",
      flags: [
        { name: "--url", takesValue: true },
        { name: "--no-browser", takesValue: false },
      ],
    },
    logout: { impl: "ts", summary: "Remove this machine's token from ~/.eris/yaks.json" },
  },
  handlers: {
    yak: async () => (await import("./handlers")).runYakVerb,
    login: async () => (await import("./login")).runLogin,
    logout: async () => (await import("./login")).runLogout,
  },
  jsonFix: `  eris yak issue|suggest|fatal             {verb, delivered, id?, idempotency_key?, replay?,
                                            contract_version?, key_mismatch?, configured?,
                                            redactions, error?}
                                            (nothing on stderr, unlike every other surface here)
  eris yak status                          {configured, observation_count, last_filed_issue_identifier}
  eris yak discover                        {teams, team_id, projects, workflow_states, labels,
                                            default_state_id}
  eris yak config get                      {configured, config?, updated_at?, updated_by?}
  eris yak config set                      {config, updated_at, updated_by}
`,
});
