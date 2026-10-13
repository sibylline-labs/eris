/**
 * The example distribution's plugin manifest: rows plus a handler thunk, with a
 * completion domain on `demo hello`'s second slot (docs/dev/PLUGINS.md#completion-domains).
 *
 * Read on every command line, `eris completion` included: rows and the domain
 * helper are inline data, and the handler module loads only on dispatch.
 */

import { type CompletionDomain, definePlugin } from "eris/sdk";

/** The names to greet; the tone typed in the slot before picks their case. */
const NAME: CompletionDomain = {
  domain: "@demo_name",
  helper: `__eris_dom_demo_name() {
  case "\${1:-}" in
    loud) echo "ADA GRACE" ;;
    *) echo "ada grace" ;;
  esac
}
`,
};

export default definePlugin({
  name: "demo",
  rows: {
    demo: { impl: "ts", summary: "Example distribution plugin (hello, asset, release, heavy)" },
    "demo asset": { summary: "Print the asset this build carries" },
    "demo heavy": { summary: "Load a module a compiled binary carries only as a stub" },
    "demo hello": { summary: "Greet a name", pos: ["tone", "name?"], usage: "<tone> [<name>]", complete: [["loud", "quiet"], [NAME]] },
    "demo release": { summary: "Print where this build's releases are published" },
  },
  handlers: {
    demo: async () => (await import("./handlers")).runDemo,
  },
});
