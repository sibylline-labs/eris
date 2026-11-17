/**
 * plugins/index.ts — the plugins this build compiles in.
 *
 * src/main.ts composes this list with core's registry. Adding a plugin to the
 * build is an import and an entry here; nothing under src/ changes. Order is
 * the order of the plugin groups in `eris --help`. docs/dev/PLUGINS.md.
 */

import type { ErisPlugin } from "../src/cli/plugin";
import doctrine from "./doctrine";
import socrates from "./socrates";
import { yakPlugin } from "./yak";

/** `eris login` pulls the signed-in org's policy once the token is written (a WARN when it cannot). */
const yak = yakPlugin({ afterLogin: async () => (await import("./doctrine/pull")).seedAfterLogin() });

export const PLUGINS: readonly ErisPlugin[] = [yak, socrates, doctrine];
