/**
 * A plugin whose handler module throws when evaluated: composed by
 * tests/plugins.test.ts to show the completion path never loads handler code,
 * including for a row whose positional slot carries a completion domain.
 */

import { definePlugin } from "../../../../src/cli/plugin";

export default definePlugin({
  name: "tripwire",
  rows: {
    tripwire: {
      impl: "ts",
      summary: "Throws if its handler module is ever evaluated",
      complete: [[{ domain: "@trip", helper: "__eris_dom_trip() {\n  echo armed\n}\n" }]],
    },
  },
  handlers: { tripwire: async () => (await import("./handlers")).runTripwire },
});
