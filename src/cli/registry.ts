/**
 * registry.ts — every eris verb, once.
 *
 * A row is keyed by its command path: a group (`"completion"`), a group and a
 * sub (`"completion bash"`), or a nested sub (`"group sub nested"`). A group
 * row names its implementation; a sub row inherits its parent's unless it names
 * its own. The one implementation is `ts`, which runs in-process; a row from
 * untyped code naming any other is refused at composition (src/cli/compose.ts).
 * `flags` are the long flags the verb accepts, `--help`
 * aside (every verb takes it); `pos` its positional operands. `json` marks a
 * surface that accepts the global `--output json`.
 *
 * Read by: the argv parser (src/cli/args.ts — a TS verb's flags and operands
 * are exactly its row's, and its handler's argument type is derived from the
 * row), the router (`TABLE`, src/cli/router.ts), the `--output json`
 * allow-list (src/cli/output.ts),
 * and the completion emitter (src/cli/commands/completion/emit.ts), which
 * generates the shell tab-completion tree from these rows.
 *
 * This module is on the path of every command line, the shell-start
 * completion run included: it imports nothing.
 */

export type Impl = "ts";

export type FlagName = `--${string}`;

export interface Flag {
  readonly name: FlagName;
  readonly takesValue: boolean;
  /** A value flag that may be given more than once; its values are kept in order. */
  readonly repeatable?: boolean;
  /** A one-letter spelling the parser also accepts (`-y` for `--yes`). */
  readonly alias?: `-${string}`;
  /** A value flag whose value is the next operand rather than the next word: a
   *  declared flag may sit between (`--from --yes f`), and a dash-led word
   *  directly after it is the value (`--from -f`). */
  readonly deferredValue?: boolean;
  /** A value flag whose value is a file name: tab completion offers file names
   *  after it. Read from the composed rows, so a plugin declares its own. */
  readonly file?: boolean;
}

export interface Row {
  readonly summary: string;
  /** Required on a group row; a sub row inherits its parent's. */
  readonly impl?: Impl;
  readonly flags?: readonly Flag[];
  readonly json?: boolean;
  /** The positional operands of a TS leaf, in order: `name`, `name?` (optional),
   *  `name...` (every remaining word). A leaf without `pos` takes none, and a
   *  word past the last is refused (src/cli/args.ts). */
  readonly pos?: readonly string[];
  /** The usage line after `eris <path> `, quoted in every argument refusal and
   *  heading the generated help. Absent: generated from `pos` and `flags`. */
  readonly usage?: string;
  /** Said in the extra-word refusal, e.g. "quote the statement". */
  readonly extraHint?: string;
  /** Tab completion for the positional operands, one entry per slot, in
   *  order: the words a slot offers. A word is a literal, `@file` (file
   *  names: the slot offers nothing else), or a `CompletionDomain`. A slot
   *  past the last entry completes nothing. Checked at composition. */
  readonly complete?: readonly (readonly SlotWord[])[];
}

/**
 * A slot whose words only a shell function can list at tab-press time: names
 * the distribution keeps in a file, say. `helper` is shell text, bash-3.2
 * clean (the zsh route loads the same body), holding exactly one function
 * definition, `__eris_dom_<name>` for `@<name>`. That function is called with
 * the words typed in the earlier positional slots and prints its words;
 * `compgen -W` expands them, so it must print shell-safe words only. Functions
 * it calls go in `library`, one definition per text, each `__eris_dom_…`;
 * domains that share a library hand over the same texts, emitted once.
 *
 * The texts bypass the emitter's word checks, so composition checks them
 * instead (src/cli/commands/completion/domain.ts). They are trusted like a
 * plugin's handler code: the check keeps a mistake from breaking or running
 * code in every shell that sources `eris completion`, not a hostile author out.
 */
export interface CompletionDomain {
  /** `@` then lower-case letters, digits, `_`; `@file` is built in. */
  readonly domain: `@${string}`;
  readonly helper: string;
  readonly library?: readonly string[];
}

export type SlotWord = string | CompletionDomain;

/** Every verb, as declared: the literal types the parser derives a handler's
 *  argument type from. `REGISTRY` is the same object for code that walks it.
 *  Core declares `completion` and `update`; every other group is a plugin's
 *  (plugins/index.ts, composed by src/cli/compose.ts). */
export const VERBS = {
  completion: { impl: "ts", summary: "Emit shell tab-completion script (bash, zsh)" },
  "completion bash": { summary: "Emit the bash completion script" },
  "completion zsh": { summary: "Emit the zsh completion script" },
  update: { impl: "ts", summary: "Print how to get the latest eris release (npx, bunx)", json: true },
} as const satisfies Readonly<Record<string, Row>>;

export type VerbPath = keyof typeof VERBS;

export const REGISTRY: Readonly<Record<string, Row>> = VERBS;

/** The argv shapes that are not verbs: the bare program, the top-level
 *  help and the version. */
export const ARGV_SHAPES: Readonly<Record<string, Impl>> = { "": "ts", "-h": "ts", "--help": "ts", "--version": "ts" };

/** The argv shapes that render JSON under the global `--output`. */
export const ARGV_SHAPE_JSON: readonly string[] = ["--version"];

/** The argv shapes, beyond a `--help`, that print from the binary alone and
 *  read nothing from the install root. The bare program is not one: a
 *  distribution's menu may read it. */
export const ARGV_SHAPES_NO_ASSETS: readonly string[] = ["--version"];

export function groupOf(path: string): string {
  return path.split(" ")[0]!;
}

/** A row's implementation: its own, else its nearest ancestor's. */
export function implOf(path: string, reg: Readonly<Record<string, Row>> = REGISTRY): Impl {
  const words = path.split(" ");
  for (let n = words.length; n > 0; n--) {
    const impl = reg[words.slice(0, n).join(" ")]?.impl;
    if (impl !== undefined) return impl;
  }
  throw new Error(`no implementation for '${path}'`);
}

/** The direct subs of a row, in key order. */
export function subsOf(path: string, reg: Readonly<Record<string, Row>> = REGISTRY): string[] {
  const depth = path.split(" ").length + 1;
  return Object.keys(reg)
    .filter((k) => k.startsWith(`${path} `) && k.split(" ").length === depth)
    .map((k) => k.split(" ")[depth - 1]!);
}

/** The group row and every row under it. */
export function rowsOfGroup(group: string, reg: Readonly<Record<string, Row>> = REGISTRY): string[] {
  return Object.keys(reg).filter((k) => k === group || k.startsWith(`${group} `));
}

export function flagsOf(path: string, reg: Readonly<Record<string, Row>> = REGISTRY): readonly Flag[] {
  return reg[path]?.flags ?? [];
}

/**
 * The router's table. A row per group plus the argv shapes; a `"group sub"`
 * row only where it changes the answer or names a TS sub: the router reads at
 * most two words, so a nested row never reaches it.
 */
export function deriveTable(reg: Readonly<Record<string, Row>> = REGISTRY): Record<string, Impl> {
  const table: Record<string, Impl> = { ...ARGV_SHAPES };
  for (const path of Object.keys(reg)) {
    const words = path.split(" ");
    if (words.length === 1) table[path] = implOf(path, reg);
    else if (words.length === 2) {
      const impl = implOf(path, reg);
      if (impl === "ts" || impl !== implOf(words[0]!, reg)) table[path] = impl;
    }
  }
  return table;
}

/** The `--output json` allow-list: a group maps to `true` (every sub) or to
 *  the subs that qualify. */
export function deriveJsonSurfaces(reg: Readonly<Record<string, Row>> = REGISTRY): Record<string, true | readonly string[]> {
  const out: Record<string, true | string[]> = Object.fromEntries(ARGV_SHAPE_JSON.map((shape) => [shape, true as const]));
  for (const [path, row] of Object.entries(reg)) {
    if (row.json !== true) continue;
    const words = path.split(" ");
    if (words.length === 1) out[path] = true;
    else if (words.length === 2) {
      const cur = out[words[0]!];
      if (cur !== true) out[words[0]!] = [...(cur ?? []), words[1]!];
    }
  }
  return out;
}
