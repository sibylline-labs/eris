/**
 * The widgets plugin's manifest: rows plus handler thunks (docs/dev/PLUGINS.md).
 *
 * The worked example of the plugin contract, composed by tests/plugins.test.ts.
 * It is not in any build's plugin list.
 */

import { definePlugin } from "../../../src/cli/plugin";

export default definePlugin({
  name: "widgets",
  rows: {
    widgets: { impl: "ts", summary: "Example plugin: ping and count widgets (ping, count)" },
    "widgets count": { summary: "Print N widgets", pos: ["n?"], usage: "<n>" },
    "widgets ping": { summary: "Reply with a pong", json: true, flags: [{ name: "--name", takesValue: true }] },
  },
  handlers: {
    widgets: async () => (await import("./handlers")).runWidgets,
  },
});
