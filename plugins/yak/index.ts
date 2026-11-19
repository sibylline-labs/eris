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

import { definePlugin, type VerbContext } from "../../src/cli/plugin";

/**
 * What runs after a successful `eris login`, given the login's context. It never changes the login's
 * exit: it reports its own outcome on stderr. A build composes one in (`plugins/index.ts` pulls the
 * org's policy); with none, a login only writes the token.
 */
export type AfterLogin = (ctx: VerbContext) => Promise<void>;

export interface YakPluginOptions {
  /** Loaded on dispatch only, like a handler, so the manifest stays data plus thunks. */
  readonly afterLogin?: () => Promise<AfterLogin>;
}

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

/** The yak plugin, running `opts.afterLogin` after a successful `eris login`. */
export function yakPlugin(opts: YakPluginOptions = {}) {
  return definePlugin({
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
      "yak clusters": {
        summary: "This org's most-reported recent yak clusters, most sightings first",
        json: true,
        usage: "[--days 7|30] [--limit <1..50>] [--min-sightings <n>]",
        flags: [
          { name: "--days", takesValue: true },
          { name: "--limit", takesValue: true },
          { name: "--min-sightings", takesValue: true },
        ],
        example: "eris yak clusters --days 7 --min-sightings 6",
      },
      "yak show": {
        summary: "One yak cluster, or one observation, in full",
        json: true,
        pos: ["id?"],
        usage: "<cluster-or-observation-id>",
        example: "eris yak show 01M75PC29DE94YJYJHQZNJ4M47",
      },
      "yak retry": {
        summary: "Requeue one failed observation (an org admin's)",
        json: true,
        pos: ["id?"],
        usage: "<observation-id>",
        example: "eris yak retry 01M75PC29DE94YJYJHQZNJ4M47",
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
      org: { impl: "ts", summary: "This org's members, Linear and GitHub connections, and deletion (members, connect-linear, github, connect-github, disconnect-github, billing, delete)" },
      "org members": {
        summary: "List this org's members, deactivate one, or grant or revoke admin (an org admin's)",
        json: true,
        pos: ["action?", "first?", "second?"],
        usage: "[deactivate <member-id> | admin grant|revoke <member-id>]",
        complete: [["deactivate", "admin"]],
      },
      "org connect-linear": {
        summary: "Connect this org's Linear workspace through the browser, then wait until it reads connected (an org admin's)",
        json: true,
        usage: "[--no-browser]",
        flags: [{ name: "--no-browser", takesValue: false }],
        example: "eris org connect-linear --no-browser",
      },
      "org github": {
        summary: "Show the GitHub App installation bound to this org, and the App's install link (an org admin's)",
        json: true,
        example: "eris org github",
      },
      "org connect-github": {
        summary: "Install the platform's GitHub App on a GitHub org you own and bind it, proven with your gh token (an org admin's)",
        json: true,
        usage: "--account <github-org> [--no-browser]",
        flags: [
          { name: "--account", takesValue: true },
          { name: "--no-browser", takesValue: false },
        ],
        example: "eris org connect-github --account acme",
      },
      "org disconnect-github": {
        summary: "Unbind this org's GitHub App installation (an org admin's)",
        json: true,
        example: "eris org disconnect-github",
      },
      "org billing": { summary: "Print a Stripe Checkout or Billing Portal URL for this org (checkout, portal)" },
      "org billing checkout": {
        summary: "Print a Stripe Checkout URL for this org's subscription; pay on Stripe's page (an org admin's)",
        json: true,
        example: "eris org billing checkout",
      },
      "org billing portal": {
        summary: "Print a Stripe Billing Portal URL for this org (an org admin's)",
        json: true,
        example: "eris org billing portal",
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
      events: { impl: "ts", summary: "This org's archived events, and the operator's parked lines (list, parked)" },
      "events list": {
        summary: "This org's archived events for a product and UTC day",
        json: true,
        usage: "--product <product> [--day <YYYY-MM-DD>] [--cursor <c>] [--limit <1..500>]",
        flags: [
          { name: "--product", takesValue: true },
          { name: "--day", takesValue: true },
          { name: "--cursor", takesValue: true },
          { name: "--limit", takesValue: true },
        ],
        example: "eris events list --product yak --day 2026-11-18",
      },
      "events parked": {
        summary: "The lines the archive parked as invalid for a UTC day (the operator org's)",
        json: true,
        usage: "[--day <YYYY-MM-DD>] [--cursor <c>] [--limit <1..500>]",
        flags: [
          { name: "--day", takesValue: true },
          { name: "--cursor", takesValue: true },
          { name: "--limit", takesValue: true },
        ],
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
      login: async () => {
        const { runLogin } = await import("./login");
        const afterLogin = opts.afterLogin === undefined ? undefined : await opts.afterLogin();
        return afterLogin === undefined ? runLogin : (args: string[], ctx: VerbContext) => runLogin(args, ctx, { afterLogin });
      },
      logout: async () => (await import("./login")).runLogout,
      whoami: async () => (await import("./whoami")).runWhoami,
      tokens: async () => (await import("./tokens")).runTokens,
      org: async () => (await import("./org")).runOrg,
      events: async () => (await import("./events")).runEvents,
    },
    jsonFix: `  eris yak issue|suggest|fatal             {verb, delivered, id?, idempotency_key?, replay?,
                                            contract_version?, key_mismatch?, configured?,
                                            redactions, error?}
                                            (nothing on stderr, unlike every other surface here)
  eris yak status                          {configured, observation_count, last_filed_issue_identifier}
  eris yak reports                         {reports: [{id, summary, issue_identifier, issue_url,
                                            state: {name, type}, submitted_at}]}
  eris yak clusters                        {days, clusters: [{id, kind, summary, recent_count, total_count,
                                            last_seen, issue_identifier, recent_by_status: {filed, pending,
                                            failed}}]}
  eris yak retry <id>                      {requeued, status}
  eris events list                         {events: [{event_id, org_id, product, stream, seq, type,
                                            occurred_at, actor, payload}], next_cursor}
  eris events parked                       {lines: [{message_id, enqueued_at, attempts?, body, ...}],
                                            next_cursor}
  eris yak show <id>                       a cluster {id, kind, canonical_summary, observation_count,
                                            first_seen, last_seen, current_issue_identifier, issue_history,
                                            observations} or an observation {id, verb, route, summary, source,
                                            received_at, status, cluster_id, delivered_at, attempts,
                                            last_error, data}
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
  eris org members admin grant|revoke <id> {memberId, role, roleSource}
  eris org connect-linear                  the org's body from GET /v1/org/me once Linear reads connected
                                            ({orgId, memberId, role, linear: {status}, ...})
  eris org github                          {installation: {installation_id, bound_at} | null, app: {id, slug, install_url} | null}
  eris org connect-github --account <org>  the same body, once bound
  eris org disconnect-github               the same body, installation null
  eris org billing checkout|portal         {url}
  eris org delete --confirm <name>         {dueAt, cause}
  eris org delete --cancel                 {cancelled}
  eris whoami                              {org, source, path?, default, token_source, url,
                                            signed_in, default_org, file}
`,
  });
}

export default yakPlugin();
