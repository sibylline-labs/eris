/**
 * The socrates plugin's manifest: `eris socrates submit`, `classify`,
 * `resolve`, `discover` and `consult` as registry rows plus a handler thunk
 * (docs/dev/PLUGINS.md).
 *
 * No `product`: every install has the verbs, and the endpoint answers an
 * unentitled workspace with a subscribe link, which the verb prints.
 */

import { definePlugin } from "../../src/cli/plugin";

export default definePlugin({
  name: "socrates",
  rows: {
    socrates: { impl: "ts", summary: "Send decision candidates to a Socrates endpoint" },
    "socrates submit": {
      summary: "Submit one candidate (a decision, practice, PRD or conflict) for review",
      json: true,
      usage: "--title <text> --statement <text> --source <url> [--kind <kind>] [--project <name>] [--now] [--allow-redaction <class> --override-reason <text>]",
      flags: [
        { name: "--kind", takesValue: true },
        { name: "--title", takesValue: true },
        { name: "--statement", takesValue: true },
        { name: "--source", takesValue: true },
        { name: "--project", takesValue: true },
        { name: "--now", takesValue: false },
        { name: "--allow-redaction", takesValue: true, repeatable: true },
        { name: "--override-reason", takesValue: true },
      ],
    },
    "socrates classify": {
      summary: "Score one candidate's rubric answers locally and print the verdict",
      json: true,
      usage: "(--title <text> --statement <text> --source <url> [--kind <kind>] [--project <name>] --answer <question>=<answer>... | --request <json>) [--override <gate>=<reason>]...",
      flags: [
        { name: "--kind", takesValue: true },
        { name: "--title", takesValue: true },
        { name: "--statement", takesValue: true },
        { name: "--source", takesValue: true },
        { name: "--project", takesValue: true },
        { name: "--answer", takesValue: true, repeatable: true },
        { name: "--override", takesValue: true, repeatable: true },
        { name: "--request", takesValue: true },
      ],
    },
    "socrates resolve": {
      summary: "Resolve a closed review Epic on the server and print what it did",
      json: true,
      pos: ["epic?"],
      usage: "<epic>",
    },
    "socrates settings": { summary: "Change where this org's Socrates reviews file (team)" },
    "socrates settings team": {
      summary: "Set or clear the Linear team a project's review Epics file on (an org admin's)",
      json: true,
      pos: ["team?"],
      usage: "<team-uuid> [--project <name>] | --clear [--project <name>]",
      flags: [
        { name: "--project", takesValue: true },
        { name: "--clear", takesValue: false },
      ],
    },
    "socrates discover": {
      summary: "List the commits in this repo since the processed-source cursor",
      json: true,
      usage: "[--since <rev>] [--limit <n>] | --advance <rev>",
      flags: [
        { name: "--since", takesValue: true },
        { name: "--limit", takesValue: true },
        { name: "--advance", takesValue: true },
      ],
    },
    "socrates consult": {
      summary: "Print a living doc, or a brief of several, from the Socrates endpoint",
      json: true,
      usage: "[--canon | --practices | --brief] [--project <name>]",
      flags: [
        { name: "--canon", takesValue: false },
        { name: "--practices", takesValue: false },
        { name: "--brief", takesValue: false },
        { name: "--project", takesValue: true },
      ],
    },
  },
  handlers: {
    socrates: async () => (await import("./submit")).runSocrates,
  },
  jsonFix: `  eris socrates submit                     {candidate_id, deduped, contract_version, redactions,
                                            overrides}
  eris socrates classify                   {verdict, rubric_version, score?, threshold?, breakdown?,
                                            gate?, answer?, feature?, route?, reason?, overrides,
                                            meta: {_links: {override?}}}
  eris socrates resolve                    {epic, outcome, applied, carried_over, carry_over_epic?,
                                            reporting, contract_version}
  eris socrates consult                    {docs: [{doc, title, url, markdown, fetched_at,
                                            contract_version}], unavailable: [{doc, status, code,
                                            detail, settings?}], contract_version}
  eris socrates settings team              {project, override: {id, key}?, filing_team: {id, key,
                                            source}, contract_version}
  eris socrates discover                   {repo, cursor, head, sources: [{kind, sha, committed_at,
                                            subject}], truncated}
  eris socrates discover --advance         {repo, cursor}
`,
});
