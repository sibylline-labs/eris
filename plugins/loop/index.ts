/**
 * The loop plugin's manifest: `eris loop`, the org's loops run as detached Claude Code background
 * sessions on tracker issues, each holding its issue's claim until its hand-back (docs/LOOP.md). Rows
 * plus a lazy handler thunk (docs/dev/PLUGINS.md). Every tracker read and write is a gates-client
 * request on the `eris login` bearer (docs/dev/GATES-CLIENT.md).
 *
 * `loopPlugin(defaults)` is the same plugin with what a build supplies: the org's pulled, verified
 * policy tree, refreshed when a claim names a newer bundle, which is the only place a loop body is read
 * from, and the distribution seams (docs/LOOP.md#distribution-seams). The default export has none, so
 * its verbs that need a body refuse, and every seam behaves as if it were never supplied.
 *
 * Invariants:
 *  - `loopRows(defaults)` is the one place the rows are built: the manifest composes them and the
 *    handler parses with them, so a flag a runtime adds is the flag the parser accepts;
 *  - no build replaces the built-in `claude` runtime, and no runtime flag shadows a built-in launch flag.
 */

import type { Outcome } from "eris/gates-contract";
import { definePlugin, type VerbContext } from "../../src/cli/plugin";
import type { ComposePromptInput } from "./prompt";
import type { LoopRuntime, LoopRuntimeFlag } from "./runtime";

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

/** Names a build used for its loops before this plugin's: read, never written. */
export interface LoopLegacy {
  /** Session-name prefixes (`<prefix><slug>-<issue>`) read beside `eris-loop-`. */
  readonly sessionPrefixes: ReadonlyArray<string>;
  /** Claim-ledger directories read after `~/.eris/loop/claims`. */
  readonly claimDirs: (home: string) => ReadonlyArray<string>;
}

/** What a build supplies the loop verbs. Each seam left out behaves as it does in the public build. */
export interface LoopDefaults {
  /** The org's verified tree, pulled first when absent or older than the claim's view; an edited tree is refused. */
  readonly policy?: (ctx: VerbContext, req: PolicyRequest) => Promise<Outcome<LoopTree>>;
  /** Runtimes beside the built-in `claude`, by the name `--runtime` takes. */
  readonly runtimes?: Readonly<Record<string, LoopRuntime>>;
  /** Lines a launch prompt carries after its `Hand-back:` line, before the loop's body. */
  readonly promptLines?: (input: ComposePromptInput & { readonly cwd: string }) => ReadonlyArray<string>;
  /** Older session names and ledger directories that status, stop, resume, reap and the live check also read. */
  readonly legacy?: LoopLegacy;
  /** Loop slugs that run with no claim and no status write, as if launched or resumed `--unclaimed`. */
  readonly claimless?: ReadonlyArray<string>;
  /** Env names no loop child inherits, beside the built-in ones; `X*` drops every name starting `X`. */
  readonly scrubEnv?: ReadonlyArray<string>;
  /** Run once a hand-back reached every target, best effort: a failure only warns. */
  readonly afterHandBack?: (ctx: VerbContext, input: { readonly issue: string }) => Promise<void>;
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
    flags: [v("--cwd"), v("--model"), v("--runtime"), v("--report-to"), v("--caller"), v("--context"), b("--force"), b("--unclaimed")],
    usage: "<loop> <ISSUE|YAK-ID> --cwd <abs> --model <m> [--runtime <name>] [--report-to <KEY>] [--caller <name>] [--context <text>] [--force] [--unclaimed]",
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

export type LoopRows = typeof ROWS;

/** The built-in runtime, which `--runtime` defaults to and no build replaces. */
const BUILT_IN_RUNTIME = "claude";

/**
 * The runtimes a build supplies, in its order; a runtime named `claude`, or a runtime flag that is a
 * built-in launch flag, is a build error (thrown when the plugin or the handler is built).
 */
export function runtimesOf(defaults: LoopDefaults): ReadonlyArray<readonly [string, LoopRuntime]> {
  const builtIn = new Set<string>(ROWS["loop launch"].flags.map((f) => f.name));
  const entries = Object.entries(defaults.runtimes ?? {});
  for (const [name, rt] of entries) {
    if (name === BUILT_IN_RUNTIME) throw new Error(`loop runtime '${BUILT_IN_RUNTIME}' is built in and cannot be replaced`);
    for (const f of rt.flags ?? []) if (builtIn.has(f.name)) throw new Error(`loop runtime '${name}' declares ${f.name}, a built-in launch flag`);
  }
  return entries;
}

/** Each launch flag the build's runtimes declare, once. */
export function runtimeFlagsOf(defaults: LoopDefaults): ReadonlyArray<LoopRuntimeFlag> {
  const seen = new Map<string, LoopRuntimeFlag>();
  for (const [, rt] of runtimesOf(defaults)) for (const f of rt.flags ?? []) if (!seen.has(f.name)) seen.set(f.name, { name: f.name, takesValue: true });
  return [...seen.values()];
}

/**
 * The plugin's rows for what the build supplies: `loop launch` also takes each runtime-declared flag,
 * and its usage line lists them. The type stays the public rows' (the parser accepts the added flags;
 * the launch handler reads them by name).
 */
export function loopRows(defaults: LoopDefaults): LoopRows {
  const extra = runtimeFlagsOf(defaults);
  if (extra.length === 0) return ROWS;
  const launch = ROWS["loop launch"];
  const row = { ...launch, flags: [...launch.flags, ...extra], usage: `${launch.usage} ${extra.map((f) => `[${f.name} <value>]`).join(" ")}` };
  return { ...ROWS, "loop launch": row } as unknown as LoopRows;
}

/** The loop plugin, with what the build supplies. */
export function loopPlugin(defaults: LoopDefaults = {}) {
  return definePlugin({
    name: "loop",
    rows: loopRows(defaults),
    handlers: {
      loop: async () => (await import("./handlers")).loopHandler(defaults),
    },
    jsonFix: JSON_FIX,
  });
}

export default loopPlugin();
