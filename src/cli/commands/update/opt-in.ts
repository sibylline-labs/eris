/**
 * opt-in.ts — `RELEASE_UPDATE`, the in-place `eris update` (./release.ts) as a
 * row and a lazy handler, for a distribution that publishes compiled binaries
 * to GitHub releases. Core's own `update` row prints the npm commands; a
 * distribution swaps both halves in when it composes (docs/dev/PLUGINS.md#distributions):
 *
 *   composeCli({ ...REGISTRY, update: RELEASE_UPDATE.row }, { ...HANDLERS, update: RELEASE_UPDATE.handler }, plugins)
 *
 * This module is light, because `eris/sdk` exports it and a plugin manifest
 * loads that on every command line: the handler is imported on first use.
 */

import type { VerbHandler } from "../../../main";
import type { Row } from "../../registry";

/** The release verb's row: the flags ./release.ts reads with `readRowArgs`. */
export const RELEASE_UPDATE_ROW = {
  impl: "ts",
  summary: "Update this eris binary to the latest release (--check, --to)",
  json: true,
  usage: "[--check] [--to <tag>]",
  flags: [
    { name: "--check", takesValue: false },
    { name: "--to", takesValue: true },
  ],
} as const satisfies Row;

/** The row and the handler thunk a distribution composes in place of core's `update`. */
export const RELEASE_UPDATE: { readonly row: Row; readonly handler: () => Promise<VerbHandler> } = {
  row: RELEASE_UPDATE_ROW,
  handler: async () => (await import("./release")).runReleaseUpdate,
};
