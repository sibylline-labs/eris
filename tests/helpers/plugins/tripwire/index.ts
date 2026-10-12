/**
 * A plugin whose handler module throws when evaluated: composed by
 * tests/plugins.test.ts to show the completion path never loads handler code.
 */

import { definePlugin } from "../../../../src/cli/plugin";

export default definePlugin({
  name: "tripwire",
  rows: { tripwire: { impl: "ts", summary: "Throws if its handler module is ever evaluated" } },
  handlers: { tripwire: async () => (await import("./handlers")).runTripwire },
});
