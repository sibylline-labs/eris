/**
 * The loop plugin's manifest: `eris loop`, the org's loops run as detached Claude Code background
 * sessions on tracker issues, each holding its issue's claim until its hand-back (docs/LOOP.md). Rows
 * plus a lazy handler thunk (docs/dev/PLUGINS.md). Every tracker read and write is a gates-client
 * request on the `eris login` bearer (docs/dev/GATES-CLIENT.md).
 *
 * `loopPlugin(defaults)` is the same plugin with what a build supplies: the org's pulled, verified
 * policy tree, refreshed when a claim names a newer bundle, which is the only place a loop body is read
 * from. The default export has none, so its verbs that need a body refuse.
 */

import type { Outcome } from "eris/gates-contract";
import { definePlugin, type VerbContext } from "../../src/cli/plugin";

/** The org's verified policy tree, as the loop verbs read it. */
export interface LoopTree {
  readonly org: string;
  /** The tree's directory, resolved once, so every read sees one tree. */
  readonly dir: string;
  readonly bundleSha: string;
  /** The loop slugs the tree's manifest carries, sorted. */
  readonly loops: ReadonlyArray<string>;
}

/** What `policy` is asked: the directory whose org is meant, the home its trees live under, and the claim's view of the policy. */
export interface PolicyRequest {
  readonly cwd: string;
  readonly home: string;
  /** The claim reply's `bundle_sha`: a tree that is not this one is pulled first. Absent: any verified tree serves. */
  readonly claimSha?: string | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

/** What a build supplies the loop verbs. */
export interface LoopDefaults {
  /** The org's verified tree, pulled first when absent or older than the claim's view; an edited tree is refused. */
  readonly policy?: (ctx: VerbContext, req: PolicyRequest) => Promise<Outcome<LoopTree>>;
}

const v = <const N extends `--${string}`>(name: N) => ({ name, takesValue: true }) as const;
const b = <const N extends `--${string}`>(name: N) => ({ name, takesValue: false }) as const;

const ROWS = {
  loop: { impl: "ts", summary: "Run the org's loops as background Claude Code sessions that hold an issue's claim" },
  "loop list": { summary: "The loops the org's policy carries", json: true },
  "loop resolve": { summary: "The issue key an operand (a key or a yak id) names", json: true, pos: ["ref"], usage: "<ISSUE|YAK-ID>" },
} as const;

/** The loop plugin, with what the build supplies. */
export function loopPlugin(defaults: LoopDefaults = {}) {
  return definePlugin({
    name: "loop",
    rows: ROWS,
    handlers: {
      loop: async () => (await import("./handlers")).loopHandler(defaults),
    },
  });
}

export default loopPlugin();
