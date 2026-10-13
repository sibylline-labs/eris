/**
 * args.ts — the one way a TS verb reads its argv: from its row in
 * src/cli/registry.ts. A verb names its row; the parser accepts exactly the
 * row's flags and operands, and the handler's argument type is derived from
 * the row's literal declaration, so a flag the row does not declare can be
 * neither passed nor read.
 *
 * The grammar, the same for every verb:
 *
 *   - `-h` / `--help` anywhere before `--` asks for help; it wins over any refusal.
 *   - `--flag` (a boolean), `--flag value` or `--flag=value` (a value flag). A
 *     value that looks like a flag (`--issue --yes`) is refused: pass it joined
 *     (`--issue=--yes`) if it really is one. A boolean given `=x` is refused.
 *   - A repeatable value flag collects its values in order; any other value
 *     flag given twice is refused rather than one value silently dropped.
 *   - A `deferredValue` flag (a `--from <file>`) takes the next operand
 *     instead: a declared flag may sit between, and a dash-led word directly
 *     after it is its value.
 *   - `-y`-style aliases come from the row (`Flag.alias`).
 *   - `--` ends the flags: every later word is an operand, dash or not.
 *   - `-` alone and a negative number (`-5`) are operands.
 *   - Operands fill the row's `pos` in order; a word past the last is refused.
 *     A missing operand is not: the verb names what is missing in its own words.
 *
 * Every refusal carries the row's usage line. The ast-grep rule
 * `adhoc-argv-parse` (rules/) keeps flag parsing in this file. Ahead of the
 * verb's parse, every command line passes the global `--output` pre-pass
 * (`parseGlobal`, below).
 */

import { renderFailureBlock } from "../../ts/lib/eris-fail";
import { type OutputFormat, sanitizeDisplay } from "./output";
import { type Flag, type FlagName, REGISTRY, type Row, subsOf, VERBS, type VerbPath } from "./registry";

/** A verb stops early by throwing this after writing its diagnostic (re-exported
 *  by src/cli/ts-verb.ts, where the router catches it). */
export class CliExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

// --- the global `--output text|json` pre-pass ----------------------------------------------

export class GlobalFlagError extends Error {
  constructor(readonly block: string) {
    super(block);
  }
}

/**
 * Where the argv's verb and sub-verb sit once the global flag is stripped —
 * the same walk as `output::parse_global`, but it never fails: a malformed
 * `--output` is reported by whichever implementation the verb routes to.
 */
export function locateVerb(argv: readonly string[]): string[] {
  const out: string[] = [];
  let terminated = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (terminated) out.push(a);
    else if (a === "--") terminated = true;
    else if (a === "--output") i++;
    else if (!a.startsWith("--output=")) out.push(a);
  }
  return out;
}

function formatError(got: string, home: string): GlobalFlagError {
  const what = `--output takes 'text' or 'json'${got !== "" ? ` (got '${sanitizeDisplay(got)}')` : ""}`;
  return new GlobalFlagError(
    renderFailureBlock(
      {
        slug: "output-format-unknown",
        what,
        fix:
          "eris --output json <command>     machine rendering (JSON on stdout)\n" +
          "eris --output text <command>     human rendering (the default)",
        docs: "docs/OUTPUT-CONTRACT.md#2-the-flag",
      },
      home,
    ),
  );
}

/**
 * `output::parse_global`. Throws `GlobalFlagError` carrying the exact block.
 *
 * `--` ends the global flags. Bash dropped it; a TS verb asks to keep it
 * (`keepTerminator`) so its own parse still sees where the flags end. A `--`
 * ahead of the verb is dropped either way.
 */
export function parseGlobal(
  argv: readonly string[],
  home: string,
  opts: { keepTerminator?: boolean } = {},
): { format: OutputFormat; argv: string[] } {
  const rest: string[] = [];
  let fmt = "";
  let terminated = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (terminated) {
      rest.push(a);
      continue;
    }
    if (a === "--") {
      terminated = true;
      if (opts.keepTerminator === true && rest.length > 0) rest.push(a);
    } else if (a === "--output") {
      const v = argv[i + 1] ?? "";
      if (v === "") throw formatError("", home);
      fmt = v;
      i++;
    } else if (a.startsWith("--output=")) fmt = a.slice("--output=".length);
    else rest.push(a);
  }
  if (fmt === "") return { format: "text", argv: rest };
  if (fmt === "text" || fmt === "json") return { format: fmt, argv: rest };
  throw formatError(fmt, home);
}

// --- types derived from the declaration ----------------------------------------------

type RowOf<P extends VerbPath> = (typeof VERBS)[P];
type FlagsOfRow<R> = [R] extends [{ readonly flags: readonly (infer F)[] }] ? F : never;
type ValueOf<F> = F extends { readonly repeatable: true } ? string[] : F extends { readonly takesValue: true } ? string | undefined : boolean;

/** A row's flags, keyed by the declared name: a boolean, a value (absent:
 *  `undefined`), or a repeatable flag's values (absent: `[]`). Derived from the
 *  row's literal type, a core verb's or a plugin's (src/cli/plugin.ts). */
export type RowFlagValues<R> = { readonly [F in FlagsOfRow<R> as F extends { readonly name: infer N extends FlagName } ? N : never]: ValueOf<F> };

/** A core verb's flags. */
export type FlagValues<P extends VerbPath> = RowFlagValues<RowOf<P>>;

export interface RowArgs<R> {
  readonly flags: RowFlagValues<R>;
  /** The operands, in order, at most as many as the row declares. */
  readonly pos: readonly string[];
}

export type VerbArgs<P extends VerbPath> = RowArgs<RowOf<P>>;

/** The direct subs of a group, from the registry. */
export type SubOf<G extends VerbPath> = {
  [K in VerbPath]: K extends `${G} ${infer S}` ? (S extends `${string} ${string}` ? never : S) : never;
}[VerbPath];

export type ArgError =
  | { readonly kind: "unknown-flag"; readonly token: string }
  | { readonly kind: "missing-value"; readonly flag: string; readonly next: string | undefined; readonly inline: boolean }
  | { readonly kind: "unexpected-value"; readonly flag: string }
  | { readonly kind: "repeated-flag"; readonly flag: string }
  | { readonly kind: "unexpected-arg"; readonly token: string };

export type Parsed<P extends VerbPath> = { readonly kind: "help" } | ({ readonly kind: "ok" } & VerbArgs<P>) | { readonly kind: "error"; readonly error: ArgError };

// --- the parser ------------------------------------------------------------------------

const isHelpToken = (a: string): boolean => a === "-h" || a === "--help";

/** Whether a help token appears before any `--` terminator, anywhere in the argv. */
export function asksForHelp(argv: readonly string[]): boolean {
  for (const a of argv) {
    if (a === "--") return false;
    if (isHelpToken(a)) return true;
  }
  return false;
}

/** A word the parser reads as an operand although it starts with `-`. */
const isDashOperand = (a: string): boolean => a === "-" || /^-[0-9]/.test(a);

/** A token in a value slot that is really the next flag. */
const looksLikeFlag = (a: string): boolean => /^--?[A-Za-z]/.test(a) || a === "--";

function rowOf(path: string, reg: Readonly<Record<string, Row>> = REGISTRY): Row {
  const row = Object.hasOwn(reg, path) ? reg[path] : undefined;
  if (row === undefined) throw new Error(`no registry row for '${path}'`);
  return row;
}

/** How many operands a row takes: `Infinity` once one is `name...`. */
function maxOperands(row: Row): number {
  const pos = row.pos ?? [];
  return pos.some((p) => p.endsWith("...")) ? Number.POSITIVE_INFINITY : pos.length;
}

/** Parse `argv` (everything after the verb's path) against `path`'s row. Pure. */
export function parseVerbArgs<P extends VerbPath>(path: P, argv: readonly string[]): Parsed<P> {
  return parseRow(rowOf(path), argv) as Parsed<P>;
}

/** The row-driven parse, for a row given directly (tests, and `parseVerbArgs`). */
export function parseRow(row: Row, argv: readonly string[]): Parsed<VerbPath> {
  const end = argv.indexOf("--");
  const flagged = end === -1 ? argv : argv.slice(0, end);
  if (flagged.some(isHelpToken)) return { kind: "help" };

  const byName = new Map<string, Flag>();
  for (const f of row.flags ?? []) {
    byName.set(f.name, f);
    if (f.alias !== undefined) byName.set(f.alias, f);
  }
  const values: Record<string, boolean | string | string[] | undefined> = {};
  for (const f of row.flags ?? []) values[f.name] = f.repeatable === true ? [] : f.takesValue ? undefined : false;
  const seen = new Set<string>();
  const pos: string[] = [];
  const max = maxOperands(row);
  const fail = (error: ArgError): Parsed<VerbPath> => ({ kind: "error", error });
  const operand = (a: string): Parsed<VerbPath> | null => {
    if (pos.length >= max) return fail({ kind: "unexpected-arg", token: a });
    pos.push(a);
    return null;
  };

  // A `deferredValue` flag waiting for its value, and whether the word now
  // being read sits directly after it.
  let pending: Flag | null = null;
  let fresh = false;
  const setValue = (flag: Flag, value: string): Parsed<VerbPath> | null => {
    if (flag.repeatable === true) (values[flag.name] as string[]).push(value);
    else if (seen.has(flag.name)) return fail({ kind: "repeated-flag", flag: flag.name });
    else values[flag.name] = value;
    seen.add(flag.name);
    return null;
  };

  for (let i = 0; i < flagged.length; i++) {
    const a = flagged[i]!;
    const direct = fresh;
    fresh = false;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq === -1 ? a : a.slice(0, eq);
    const flag = a.startsWith("-") ? byName.get(name) : undefined;
    if (pending !== null && a !== "" && flag === undefined && (direct || !a.startsWith("-") || isDashOperand(a))) {
      const refused = setValue(pending, a);
      if (refused !== null) return refused;
      pending = null;
      continue;
    }
    if (!a.startsWith("-") || isDashOperand(a)) {
      const refused = operand(a);
      if (refused !== null) return refused;
      continue;
    }
    if (flag === undefined) return fail({ kind: "unknown-flag", token: a });
    if (!flag.takesValue) {
      if (eq !== -1) return fail({ kind: "unexpected-value", flag: flag.name });
      values[flag.name] = true;
      continue;
    }
    if (flag.deferredValue === true && eq === -1) {
      if (pending !== null) return fail({ kind: "missing-value", flag: pending.name, next: a, inline: false });
      pending = flag;
      fresh = true;
      continue;
    }
    let value: string;
    if (eq !== -1) {
      value = a.slice(eq + 1);
      if (value === "") return fail({ kind: "missing-value", flag: flag.name, next: undefined, inline: true });
    } else {
      const next = flagged[i + 1];
      if (next === undefined || next === "" || looksLikeFlag(next)) {
        return fail({ kind: "missing-value", flag: flag.name, next: end !== -1 && i + 1 === flagged.length ? "--" : next, inline: false });
      }
      value = next;
      i++;
    }
    const refused = setValue(flag, value);
    if (refused !== null) return refused;
  }
  if (pending !== null) return fail({ kind: "missing-value", flag: pending.name, next: end !== -1 ? "--" : undefined, inline: false });
  if (end !== -1) {
    for (const a of argv.slice(end + 1)) {
      const refused = operand(a);
      if (refused !== null) return refused;
    }
  }
  return { kind: "ok", flags: values as FlagValues<VerbPath>, pos };
}

// --- the words of a refusal and of help --------------------------------------------------

/** A value echoed into a diagnostic, on one line: C0 controls and DEL removed,
 *  a newline shown as `\n` (a failure block is parsed line by line). */
const shown = (s: string): string => s.replace(/\n/g, "\\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

function operandWords(row: Row): string {
  return (row.pos ?? [])
    .map((p) => (p.endsWith("...") ? `[${p.slice(0, -3)}...]` : p.endsWith("?") ? `[${p.slice(0, -1)}]` : `<${p}>`))
    .join(" ");
}

function flagWords(row: Row): string {
  return (row.flags ?? []).map((f) => `[${f.name}${f.takesValue ? " <value>" : ""}]${f.repeatable === true ? "..." : ""}`).join(" ");
}

/** `eris <path> <usage>`: the row's own line, else one generated from it. */
export function usageLine(path: string, row: Row = rowOf(path)): string {
  const tail = row.usage ?? [operandWords(row), flagWords(row)].filter((s) => s !== "").join(" ");
  return `eris ${path}${tail !== "" ? ` ${tail}` : ""}`;
}

/** The refusal's one-line `what`, lower-case, without the usage. */
export function argErrorWhat(e: ArgError): string {
  switch (e.kind) {
    case "unknown-flag":
      return `unknown flag '${shown(e.token)}'`;
    case "unexpected-arg":
      return `unexpected argument '${shown(e.token)}'`;
    case "unexpected-value":
      return `${e.flag} takes no value`;
    case "repeated-flag":
      return `${e.flag} was given more than once — one value is kept, so the other would be dropped`;
    case "missing-value":
      return `${e.flag} requires a value — ${
        e.next === undefined || e.next === "" || e.next === "--"
          ? "no value follows it"
          : `the next argument is '${shown(e.next)}', which is itself a flag — not a value`
      }`;
  }
}

/** The refusal as eris prints it: `ERROR <line>` for most, the documented
 *  `flag-value-missing` block for a value flag with no value. */
export function argErrorText(path: string, e: ArgError, home: string, row: Row = rowOf(path)): string {
  const usage = usageLine(path, row);
  switch (e.kind) {
    case "missing-value":
      return renderFailureBlock(
        {
          slug: "flag-value-missing",
          what: argErrorWhat(e),
          fix: `pass the value immediately after the flag:\n  ${e.flag} <value>\nor in the joined form:\n  ${e.flag}=<value>`,
          docs: "docs/ERRORS.md#flag-value-missing",
        },
        home,
      );
    case "unknown-flag":
      return `ERROR Unknown flag '${shown(e.token)}' (usage: ${usage})\n`;
    case "unexpected-arg": {
      const hint = row.extraHint;
      return `ERROR Unexpected arg '${shown(e.token)}'${hint !== undefined ? ` — ${hint}` : ""} (usage: ${usage})\n`;
    }
    case "unexpected-value":
    case "repeated-flag":
      return `ERROR ${argErrorWhat(e)} (usage: ${usage})\n`;
  }
}

/** The help a row generates: its usage line, summary, and flags. */
export function helpText(path: string, row: Row = rowOf(path)): string {
  const flags = (row.flags ?? []).map(
    (f) => `  ${f.name}${f.takesValue ? " <value>" : ""}${f.alias !== undefined ? `, ${f.alias}` : ""}${f.repeatable === true ? "   (repeatable)" : ""}\n`,
  );
  return `Usage: ${usageLine(path, row)}\n\n${row.summary}\n\nFlags:\n${flags.join("")}  --help, -h   Print this usage text\n`;
}

// --- the verb-facing entry -----------------------------------------------------------------

export interface ArgSinks {
  readonly erisDir: string;
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown };
}

export interface ReadOptions {
  /** The verb's own help text; the row's generated help when absent. */
  readonly help?: string;
  /** A verb whose refusal is a documented, slugged block renders the kinds it
   *  owns here and stops; returning falls through to `argErrorText`. */
  readonly refuse?: (e: ArgError, what: string) => void;
}

/** Write `e`'s uniform refusal and stop with exit 1. A row core's registry
 *  does not hold (a plugin's) is passed with its path. */
export function refuseArg(path: VerbPath, e: ArgError, io: ArgSinks): never;
export function refuseArg(path: string, e: ArgError, io: ArgSinks, row: Row): never;
export function refuseArg(path: string, e: ArgError, io: ArgSinks, row: Row = rowOf(path)): never {
  io.stderr.write(argErrorText(path, e, io.erisDir, row));
  throw new CliExit(1);
}

/**
 * Parse for a verb handler. Help: written to stdout, `null` returned (the verb
 * returns 0). A refusal: written to stderr, then `CliExit(1)`.
 */
export function readVerbArgs<P extends VerbPath>(path: P, argv: readonly string[], io: ArgSinks, opts: ReadOptions = {}): VerbArgs<P> | null {
  return readRowArgs(path, rowOf(path), argv, io, opts) as VerbArgs<P> | null;
}

/** `readVerbArgs` for a row given directly: a plugin's (src/cli/plugin.ts). */
export function readRowArgs<R extends Row>(path: string, row: R, argv: readonly string[], io: ArgSinks, opts: ReadOptions = {}): RowArgs<R> | null {
  const p = parseRow(row, argv);
  if (p.kind === "help") {
    io.stdout.write(opts.help ?? helpText(path, row));
    return null;
  }
  if (p.kind === "error") {
    opts.refuse?.(p.error, argErrorWhat(p.error));
    io.stderr.write(argErrorText(path, p.error, io.erisDir, row));
    throw new CliExit(1);
  }
  return p as unknown as RowArgs<R>;
}

export type GroupArgs<G extends VerbPath> =
  | { readonly kind: "bare" }
  | { readonly kind: "help" }
  | { readonly kind: "sub"; readonly sub: SubOf<G>; readonly rest: string[] }
  | { readonly kind: "unknown"; readonly sub: string };

/**
 * A group dispatcher's first word: none (`bare`), `-h`/`--help` (`help`), one
 * of the group's subs from the registry, or anything else (`unknown`, refused
 * by the dispatcher in its own words). A leading `--` is skipped: a sub name
 * never starts with a dash.
 */
export function groupArgs<G extends VerbPath>(group: G, argv: readonly string[]): GroupArgs<G> {
  return groupArgsIn(REGISTRY, group, argv) as GroupArgs<G>;
}

/** `groupArgs` over a given set of rows: a plugin's (src/cli/plugin.ts). */
export function groupArgsIn(reg: Readonly<Record<string, Row>>, group: string, argv: readonly string[]): GroupArgs<never> | { readonly kind: "sub"; readonly sub: string; readonly rest: string[] } {
  const words = argv[0] === "--" ? argv.slice(1) : argv;
  const first = words[0];
  if (first === undefined || first === "") return { kind: "bare" };
  if (isHelpToken(first)) return { kind: "help" };
  if (subsOf(group, reg).includes(first)) return { kind: "sub", sub: first, rest: words.slice(1) };
  return { kind: "unknown", sub: first };
}
