/**
 * plugin.ts — the plugin SDK: the contract a plugin is written against, and
 * the one eris module a plugin imports (the `plugin-imports-sdk-only`
 * ast-grep rule in rules/ holds it).
 *
 * A plugin is a package exporting registry rows plus handlers:
 *
 *   - `rows`: pure data, the same `Row` shape as src/cli/registry.ts. A group
 *     row (one word) says `impl: "ts"`; sub rows hang off it. The router table,
 *     the argv parse, the `--output json` allow-list, completion and the
 *     top-level help all derive from them once composed (src/cli/compose.ts).
 *   - `handlers`: one thunk per group, `async () => (await import("./x")).run`.
 *     The manifest is read on every command line, `eris completion` included,
 *     and a thunk is called only on dispatch, so plugin code never loads at
 *     shell start (`plugin-manifest-lazy-handlers`).
 *   - `product`: absent for a plugin every workspace gets; else the product a
 *     workspace must have bought, without which its commands render as locked.
 *
 * Composition is build-time: a distribution's entry composes core with its
 * plugin list and hands the result to `runProgram` (src/main.ts). There is no
 * runtime plugin loader. docs/dev/PLUGINS.md is the authoring guide.
 *
 * Everything here is on the completion path through the manifests: it imports
 * only modules that path already loads.
 */

import type { CliContext, VerbContext, VerbHandler } from "../main";
import { type ArgSinks, type GroupArgs, groupArgsIn, type ReadOptions, readRowArgs, type RowArgs } from "./args";
import type { CompletionDomain, Flag, FlagName, Row, SlotWord } from "./registry";

export { erisHome, renderFailureBlock, renderWarnLines } from "../../ts/lib/eris-fail";
export { readEnv } from "../runtime/env";
export {
  DEFAULT_YAKS_URL,
  readYaksFileConfig,
  resolveToken,
  resolveUrl,
  writeYaksFileConfig,
  yaksConfigPath,
  type CredentialOutcome,
  type YaksFileConfig,
  type YaksUrlSource,
} from "../runtime/credentials";
export { CliExit } from "./args";
export type { ArgSinks, CliContext, CompletionDomain, Flag, FlagName, GroupArgs, ReadOptions, Row, RowArgs, SlotWord, VerbContext, VerbHandler };

type Rows = Readonly<Record<string, Row>>;

/** The one-word keys of a rows table: its groups. */
export type GroupsOf<R> = { [K in keyof R & string]: K extends `${string} ${string}` ? never : K }[keyof R & string];

export interface ErisPlugin<R extends Rows = Rows> {
  /** Unique across a build; named in every composition refusal. */
  readonly name: string;
  readonly product?: string;
  readonly rows: R;
  readonly handlers: Readonly<Record<string, () => Promise<VerbHandler>>>;
  /**
   * The plugin's lines in the `output-json-unsupported` fix text, written
   * like core's (src/cli/output.ts): `  eris <verb>`, then from column 43 the
   * JSON shape it prints, each line ending in a newline. Absent, compose
   * writes one line per json row from its summary.
   */
  readonly jsonFix?: string;
}

/** A plugin, with a handler required for each group its rows declare. */
export function definePlugin<const R extends Rows>(plugin: {
  readonly name: string;
  readonly product?: string;
  readonly rows: R;
  readonly handlers: { readonly [G in GroupsOf<R>]: () => Promise<VerbHandler> };
  readonly jsonFix?: string;
}): ErisPlugin<R> {
  return plugin;
}

/**
 * A handler's argv, read from its row: the row's flags and operands exactly,
 * typed from the row's literal declaration. Help goes to stdout and returns
 * null (the handler returns 0); a refusal goes to stderr, then `CliExit(1)`.
 */
export function readArgs<R extends Rows, P extends keyof R & string>(
  rows: R,
  path: P,
  argv: readonly string[],
  io: ArgSinks,
  opts: ReadOptions = {},
): RowArgs<R[P]> | null {
  return readRowArgs(path, rows[path]!, argv, io, opts);
}

/** A group handler's first word: `bare`, `help`, one of the group's subs, or `unknown`. */
export function groupArgs<R extends Rows>(rows: R, group: GroupsOf<R>, argv: readonly string[]) {
  return groupArgsIn(rows, group, argv);
}
