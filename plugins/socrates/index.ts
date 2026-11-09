/**
 * The socrates plugin's manifest: `eris socrates submit`, `classify`,
 * `resolve`, `discover`, `consult`, `status`, `policy` and `evidence` as registry rows plus
 * a handler thunk (docs/dev/PLUGINS.md).
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
      usage: "--title <text> --statement <text> --source <url> [--kind <kind>] [--project <name>] [--scope <text>] [--section <text>] [--evidence <text>] [--target <doc>] [--now] (--answer <question>=<answer>... [--override <gate>=<reason>]... | --unfit --hypothesis <text> [--evidence-file <path|->]) [--fragment <path>#L<x>[-L<y>]]... [--allow-redaction <class> --override-reason <text>]",
      flags: [
        { name: "--kind", takesValue: true },
        { name: "--title", takesValue: true },
        { name: "--statement", takesValue: true },
        { name: "--source", takesValue: true },
        { name: "--project", takesValue: true },
        { name: "--scope", takesValue: true },
        { name: "--section", takesValue: true },
        { name: "--evidence", takesValue: true },
        { name: "--target", takesValue: true },
        { name: "--now", takesValue: false },
        { name: "--answer", takesValue: true, repeatable: true },
        { name: "--override", takesValue: true, repeatable: true },
        { name: "--allow-redaction", takesValue: true, repeatable: true },
        { name: "--override-reason", takesValue: true },
        { name: "--unfit", takesValue: false },
        { name: "--hypothesis", takesValue: true },
        { name: "--evidence-file", takesValue: true, file: true },
        { name: "--fragment", takesValue: true, repeatable: true, file: true },
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
    "socrates settings": { summary: "Read and change the org's Socrates settings (policy, enrolment, health, usage, Canon, team)" },
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
    "socrates settings policy": {
      summary: "Show the org's scoring policy, or change it (an org admin's), with a preview",
      json: true,
      usage: "[--threshold <n>] [--verbosity <v>] [--escalation <e>] [--reporting <r>] [--auto-resolve on|off] [--gate <key>=on|off]... [--weight <key>=<n>]... [--preview]",
      flags: [
        { name: "--threshold", takesValue: true },
        { name: "--verbosity", takesValue: true },
        { name: "--escalation", takesValue: true },
        { name: "--reporting", takesValue: true },
        { name: "--auto-resolve", takesValue: true },
        { name: "--gate", takesValue: true, repeatable: true },
        { name: "--weight", takesValue: true, repeatable: true },
        { name: "--preview", takesValue: false },
      ],
    },
    "socrates settings enrolment": { summary: "List the enrolled projects and their Linear links", json: true, usage: "" },
    "socrates settings health": { summary: "Print the install, webhook, reconcile and stuck-write health", json: true, usage: "" },
    "socrates settings usage": { summary: "Print the no-credit usage figures: entries, accept and reject rates, overrides", json: true, usage: "" },
    "socrates settings canon": {
      summary: "Show or choose the org's Canon doc (an org admin's)",
      json: true,
      usage: "[--doc <id> | --clear]",
      flags: [
        { name: "--doc", takesValue: true },
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
    "socrates status": {
      summary: "Print the pending count, the open review Epics and one candidate's state",
      json: true,
      usage: "[--candidate <id>]",
      flags: [{ name: "--candidate", takesValue: true }],
    },
    "socrates evidence": {
      summary: "Print one stored evidence fragment, by the id submit printed",
      json: true,
      pos: ["id?"],
      usage: "<fragment-id>",
    },
    "socrates policy": {
      summary: "Print the org's scoring policy, and refresh the cached copy",
      json: true,
      usage: "[--cached]",
      flags: [{ name: "--cached", takesValue: false }],
    },
  },
  handlers: {
    socrates: async () => (await import("./submit")).runSocrates,
  },
  jsonFix: `  eris socrates submit                     {candidate_id, deduped, contract_version, classification?,
                                            unfit?: {state}, evidence?: [{fragment_id, provenance,
                                            expires_at}], redactions, overrides}
  eris socrates classify                   {verdict, rubric_version, score?, threshold?, breakdown?,
                                            gate?, answer?, feature?, route?, reason?, overrides,
                                            policy_hash?, repo_policy?, meta: {_links: {override?}}}
  eris socrates resolve                    {epic, outcome, applied, carried_over, carry_over_epic?,
                                            reporting, contract_version}
  eris socrates consult                    {docs: [{doc, title, url, markdown, fetched_at,
                                            contract_version}], unavailable: [{doc, status, code,
                                            detail, settings?}], contract_version}
  eris socrates settings team              {project, override: {id, key}?, filing_team: {id, key,
                                            source}, contract_version}
  eris socrates settings policy            {policy: {rubric_version, version, source, policy_hash, policy,
                                            updated_at}, contract_version}; with a change: the receipt
                                            {rubric_version, policy_version, policy_hash, policy,
                                            canon_doc_id, contract_version}; --preview: {preview, version,
                                            policy_hash, policy, draft, changes: [{field, from, to}],
                                            contract_version}
  eris socrates settings enrolment         {projects: [{id, name, source, url}], contract_version}
  eris socrates settings health            {health: {install, webhook, reconcile, stuck}, contract_version}
  eris socrates settings usage             {usage: {window_days, entries, accept_rate, reject_rate,
                                            classifications}, contract_version}
  eris socrates settings canon             {canon: {doc_id}, contract_version}; with --doc or --clear:
                                            the settings receipt
  eris socrates discover                   {repo, cursor, head, sources: [{kind, sha, committed_at,
                                            subject}], truncated}
  eris socrates discover --advance         {repo, cursor}
  eris socrates status                     {rubric_version, policy_hash, pending_candidates,
                                            open_epics: [{epic, project, url, open_children}],
                                            candidate?: {candidate_id, state, issue_url?},
                                            contract_version}
  eris socrates policy                     {rubric_version, policy_hash, cached, fetched_at,
                                            org_policy, policy, repo_policy, repo_policy_path,
                                            changed?: {from, to}, contract_version}
  eris socrates evidence                   {fragment_id, candidate_id?, kind, provenance, content,
                                            created_at, expires_at, contract_version}
`,
});
