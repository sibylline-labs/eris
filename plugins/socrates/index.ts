/**
 * The socrates plugin's manifest: `eris socrates submit` as registry rows plus
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
      usage: "--title <text> --statement <text> --source <url> [--kind <kind>] [--project <name>] [--allow-redaction <class> --override-reason <text>]",
      flags: [
        { name: "--kind", takesValue: true },
        { name: "--title", takesValue: true },
        { name: "--statement", takesValue: true },
        { name: "--source", takesValue: true },
        { name: "--project", takesValue: true },
        { name: "--allow-redaction", takesValue: true, repeatable: true },
        { name: "--override-reason", takesValue: true },
      ],
    },
  },
  handlers: {
    socrates: async () => (await import("./submit")).runSocrates,
  },
  jsonFix: `  eris socrates submit                     {candidate_id, deduped, contract_version, redactions,
                                            overrides}
`,
});
