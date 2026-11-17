/**
 * The yak plugin's manifest: `eris yak issue|suggest|fatal`; `eris yak status`, `ready`,
 * `discover` and `config get|set`, which read and set the org's destination; and
 * `eris login` / `eris logout`, which manage the bearer `eris yak` reads, and
 * `eris whoami`, which says which org's bearer a directory uses; `eris tokens
 * ls|create|revoke`, which manage the org's API tokens; and `eris org members
 * [deactivate <id>]` and `eris org delete --confirm|--cancel`, as registry rows plus handler thunks (docs/dev/PLUGINS.md).
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
    "yak fatal": {
      summary: "The harness itself is broken",
      json: true,
      flags: YAK_FLAGS,
      example: `eris yak fatal --summary "every eris command exits 1 before it runs" --body "eris --version prints a stack trace on this machine"`,
    },
    "yak issue": {
      summary: "A harness/tooling defect, confirmed or suspected",
      json: true,
      flags: YAK_FLAGS,
      example: `eris yak issue --summary "a hook blocks a legal edit" --body "the pre-edit hook refused a change the rule allows" --repro "<the command>"`,
    },
    "yak suggest": {
      summary: "An improvement to the harness: a missing capability or a better way of working",
      json: true,
      flags: YAK_FLAGS,
      example: `eris yak suggest --summary "a --dry-run flag for eris yak" --body "I wanted to see the payload before it was sent"`,
    },
    "yak status": { summary: "Whether this org has a destination for its yaks, and how many it holds", json: true },
    "yak reports": {
      summary: "This org's own vendor reports with their Linear state",
      json: true,
      example: "eris yak reports",
    },
    "yak ready": { summary: "Whether this machine can file yaks, and when to file; always exits 0 (a SessionStart hook runs it)", json: true },
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
    logout: { impl: "ts", summary: "Remove this directory's org's token from ~/.eris/yaks.json" },
    org: { impl: "ts", summary: "This org's members, Linear connection and deletion (members, connect-linear, delete)" },
    "org members": {
      summary: "List this org's members, or deactivate one (an org admin's)",
      json: true,
      pos: ["action?", "id?"],
      usage: "[deactivate <member-id>]",
      complete: [["deactivate"]],
    },
    "org connect-linear": {
      summary: "Connect this org's Linear workspace through the browser, then wait until it reads connected (an org admin's)",
      json: true,
      usage: "[--no-browser]",
      flags: [{ name: "--no-browser", takesValue: false }],
      example: "eris org connect-linear --no-browser",
    },
    "org delete": {
      summary: "Schedule this org's deletion (--confirm <workspace>) or cancel it (--cancel); an org admin's",
      json: true,
      usage: "--confirm <workspace> | --cancel",
      flags: [
        { name: "--confirm", takesValue: true },
        { name: "--cancel", takesValue: false },
      ],
      example: "eris org delete --confirm Acme",
    },
    whoami: { impl: "ts", summary: "Show the org this directory acts as, why, and where its token comes from (never the token)", json: true },
    tokens: { impl: "ts", summary: "List, create and revoke this org's API tokens (ls, create, revoke)" },
    "tokens ls": { summary: "List this org's tokens: name, kind, scope, created, last used (never a secret)", json: true },
    "tokens create": {
      summary: "Mint a service token; its sib_ secret is printed once, on stdout only",
      json: true,
      usage: "--name <name> --scope <product:access> [--scope <product:access>...]",
      flags: [
        { name: "--name", takesValue: true },
        { name: "--scope", takesValue: true, repeatable: true },
      ],
      example: "eris tokens create --name ci --scope yak:write",
    },
    "tokens revoke": { summary: "Revoke a token by id", json: true, pos: ["id?"], usage: "<id>" },
  },
  handlers: {
    yak: async () => (await import("./handlers")).runYakVerb,
    login: async () => (await import("./login")).runLogin,
    logout: async () => (await import("./login")).runLogout,
    whoami: async () => (await import("./whoami")).runWhoami,
    tokens: async () => (await import("./tokens")).runTokens,
    org: async () => (await import("./org")).runOrg,
  },
  jsonFix: `  eris yak issue|suggest|fatal             {verb, delivered, id?, idempotency_key?, replay?,
                                            contract_version?, key_mismatch?, configured?,
                                            redactions, error?}
                                            (nothing on stderr, unlike every other surface here)
  eris yak status                          {configured, observation_count, last_filed_issue_identifier}
  eris yak reports                         {reports: [{id, summary, issue_identifier, issue_url,
                                            state: {name, type}, submitted_at}]}
  eris yak ready                           {ready, signed_in, endpoint, configured,
                                            last_filed_issue_identifier, fix}
  eris yak discover                        {teams, team_id, projects, workflow_states, labels,
                                            default_state_id}
  eris yak config get                      {configured, config?, updated_at?, updated_by?}
  eris yak config set                      {config, updated_at, updated_by}
  eris tokens ls                           {tokens: [{id, name, kind, scopes, memberId?, device?,
                                            createdAt, lastUsedAt, expiresAt?}], entitled,
                                            serviceTokens: {live, limit}}
  eris tokens create                       {token, tokenId, name, scopes, expiresAt?}
                                            (the one place the sib_ secret is printed)
  eris tokens revoke                       {tokenId}
  eris org members                         {members: [{memberId, name, email, role, status, seats}]}
  eris org members deactivate <id>         {memberId, status}
  eris org connect-linear                  the org's body from GET /v1/org/me once Linear reads connected
                                            ({orgId, memberId, role, linear: {status}, ...})
  eris org delete --confirm <name>         {dueAt, cause}
  eris org delete --cancel                 {cancelled}
  eris whoami                              {org, source, path?, default, token_source, url,
                                            signed_in, default_org, file}
`,
});
