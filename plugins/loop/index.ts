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
  "loop launch": {
    summary: "Claim an issue and start a loop on it as a background session",
    json: true,
    pos: ["loop", "issue"],
    flags: [v("--cwd"), v("--model"), v("--report-to"), v("--caller"), v("--context"), b("--force"), b("--unclaimed")],
    usage: "<loop> <ISSUE|YAK-ID> --cwd <abs> --model <m> [--report-to <KEY>] [--caller <name>] [--context <text>] [--force] [--unclaimed]",
  },
  "loop resume": {
    summary: "Continue a finished loop session, holding its claim again",
    json: true,
    pos: ["ref?"],
    flags: [b("--all"), v("--prompt"), b("--unclaimed")],
    usage: "<ref> | --all [--prompt <text>] [--unclaimed]",
  },
  "loop status": { summary: "A loop session's state, detail, claim, in-flight calls and newest message", pos: ["ref"], usage: "<ref>" },
  "loop reap": {
    summary: "Stop finished loop sessions, release their claims, remove clean finished worktrees",
    json: true,
    flags: [b("--dry-run"), { name: "--repo", takesValue: true, repeatable: true }],
    usage: "[--dry-run] [--repo <abs>]...",
  },
  "loop stop": { summary: "Stop a loop session, release its claim, move an In Progress issue to Todo", json: true, pos: ["ref"], usage: "<ref>" },
  "loop hand-back": {
    summary: "Post a loop's hand-back (stdin) as the claim's release response, else a comment",
    json: true,
    pos: ["issue"],
    flags: [v("--claim"), v("--report-to"), v("--outcome")],
    usage: "<ISSUE> [--claim <id>] [--report-to <KEY>] [--outcome handed_back|aborted] < body",
  },
} as const;

const JSON_FIX = `  eris loop list                           {loops}
  eris loop resolve                        {issue, yak?}
  eris loop launch                         {issue, slug, session, runtime, model, claimId?, yak?}
  eris loop resume|stop|reap               {lines}
  eris loop hand-back                      {lines, failed}
`;

/** The loop plugin, with what the build supplies. */
export function loopPlugin(defaults: LoopDefaults = {}) {
  return definePlugin({
    name: "loop",
    rows: ROWS,
    handlers: {
      loop: async () => (await import("./handlers")).loopHandler(defaults),
    },
    jsonFix: JSON_FIX,
  });
}

export default loopPlugin();
