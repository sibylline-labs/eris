/**
 * The yak plugin's manifest: `eris yak issue|suggest|fatal`, and `eris login` /
 * `eris logout`, which manage the bearer `eris yak` reads, as registry rows
 * plus handler thunks (docs/dev/PLUGINS.md).
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
] as const;

export default definePlugin({
  name: "yak",
  rows: {
    yak: { impl: "ts", summary: "Land a durable observation with a Yaks endpoint (issue, suggest, fatal)" },
    "yak fatal": { summary: "The harness itself is broken", json: true, flags: YAK_FLAGS },
    "yak issue": { summary: "A harness/tooling defect, confirmed or suspected", json: true, flags: YAK_FLAGS },
    "yak suggest": { summary: "An improvement to the harness: a missing capability or a better way of working", json: true, flags: YAK_FLAGS },
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
                                            contract_version?, key_mismatch?, redactions, error?}
                                            (nothing on stderr, unlike every other surface here)
`,
});
