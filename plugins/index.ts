/**
 * plugins/index.ts — the plugins this build compiles in.
 *
 * src/main.ts composes this list with core's registry. Adding a plugin to the
 * build is an import and an entry here; nothing under src/ changes. Order is
 * the order of the plugin groups in `eris --help`. docs/dev/PLUGINS.md.
 */

import type { ErisPlugin } from "../src/cli/plugin";
import doctrine from "./doctrine";
import { gatePlugin } from "./gate";
import { type LoopDefaults, loopPlugin } from "./loop";
import socrates from "./socrates";
import { yakPlugin } from "./yak";

/** `eris login` pulls the signed-in org's policy once the token is written (a WARN when it cannot). */
const yak = yakPlugin({ afterLogin: async () => (await import("./doctrine/pull")).seedAfterLogin() });

/** The gate verbs read the org's pulled, verified tree for their doctrine, profiles and policy sha. */
const gate = gatePlugin({ pulled: async (ctx, req) => (await import("./doctrine/pull")).pulledTree(ctx, req) });

/** The loop verbs read loop bodies only from the org's pulled, verified tree, pulled again when a claim names a newer bundle. */
export const LOOP_DEFAULTS: LoopDefaults = {
  policy: async (ctx, req) => (await import("./doctrine/pull")).freshTree(ctx, req.claimSha, { home: req.home, cwd: req.cwd, ...(req.fetch !== undefined ? { fetch: req.fetch } : {}) }),
};

const loop = loopPlugin(LOOP_DEFAULTS);

export const PLUGINS: readonly ErisPlugin[] = [yak, socrates, doctrine, gate, loop];
