/**
 * version.ts — `eris --version`: what this build is.
 *
 *   eris v0.2.0 (sibylline-labs/eris)
 *   <the line a distribution added, if any>
 *
 * `--output json` prints the same facts as one record:
 * `{version, release_repo, build_id, extra}`. `version` is the tag the build was
 * given (`dev` for an untagged build and for a checkout), `release_repo` the
 * repository `eris update` reads releases from, `build_id` the compiled
 * binary's id (null in a checkout) and `extra` the distribution's line (null
 * when it adds none). All four are baked at build time (src/build.ts); nothing
 * here reads a file, the network or the environment, so it answers in a binary
 * whose asset home cannot be written.
 */

import type { VerbHandler } from "../../main";
import { BUILD_ID, RELEASE_REPO, VERSION, VERSION_EXTRA } from "../../runtime/home";

export const runVersion: VerbHandler = async (_args, ctx) => {
  if (ctx.format === "json") {
    ctx.stdout.write(`${JSON.stringify({ version: VERSION, release_repo: RELEASE_REPO, build_id: BUILD_ID, extra: VERSION_EXTRA })}\n`);
  } else {
    ctx.stdout.write(`eris ${VERSION} (${RELEASE_REPO})\n${VERSION_EXTRA !== null ? `${VERSION_EXTRA}\n` : ""}`);
  }
  return 0;
};
