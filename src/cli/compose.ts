/**
 * compose.ts — core rows plus plugin rows, merged once, before anything is
 * derived from them.
 *
 * `composeCli` is called by a distribution's entry (src/main.ts composes the
 * build's list, plugins/index.ts). Its result, a `Cli`, is what the router,
 * the `--output json` allow-list, completion and the top-level help read, so a
 * plugin's rows reach every plane a core row does with no core edit.
 *
 * A plugin that would break a plane is refused here, at composition, which
 * runs when the build validates its plugin list (src/build.ts) and when the
 * program starts:
 *
 *   - a group that collides with a built-in, an argv shape or another plugin;
 *   - anything but a `ts` implementation (a row from untyped code can name
 *     one the type does not allow, and no other runs);
 *   - a sub row with no parent, a group with no handler, a handler with no group;
 *   - `json: true` on a group that has subs: the allow-list would accept every
 *     sub, including one added later with no machine rendering. Each sub that
 *     renders JSON says so on its own row, so the allow-list fails closed;
 *   - a completion slot the emitted script cannot hold (`complete` on a row, core's
 *     or a plugin's): a word that is not shell-safe, a domain helper that fails
 *     src/cli/commands/completion/domain.ts, or one domain (or one helper
 *     function) given two different texts across the build.
 *
 * A distribution may own the bare program (`eris` with no arguments): its
 * `menu` handler replaces core's usage there; `-h` and `--help` stay the usage.
 *
 * Entitlements are not composition: a `Cli` says which product each plugin
 * group belongs to, and `lockedProduct` checks a workspace's entitlements
 * against it per command line.
 */

import type { VerbHandler } from "../main";
import { helpText } from "./args";
import { renderFailureBlock } from "../../ts/lib/eris-fail";
import { domainFunction, scanHelper, slotWordRefusal } from "./commands/completion/domain";
import { jsonFixLine, unsupportedFix } from "./output";
import type { ErisPlugin } from "./plugin";
import { ARGV_SHAPES, deriveJsonSurfaces, deriveTable, type Impl, type Row } from "./registry";

type Rows = Readonly<Record<string, Row>>;
type Handlers = Readonly<Record<string, () => Promise<VerbHandler>>>;

export class PluginCompositionError extends Error {
  override name = "PluginCompositionError";
}

export interface PluginGroup {
  readonly group: string;
  readonly summary: string;
  readonly plugin: string;
  readonly product?: string;
}

export interface Cli {
  /** Core rows and every plugin's rows. */
  readonly registry: Rows;
  readonly table: Readonly<Record<string, Impl>>;
  readonly handlers: Handlers;
  readonly jsonSurfaces: Readonly<Record<string, true | readonly string[]>>;
  /** The `output-json-unsupported` fix text: core's, with each plugin's `jsonFix`, or a line per json row, in its plugin slot. */
  readonly jsonFix: string;
  /** The plugin groups, in composition order. */
  readonly groups: readonly PluginGroup[];
}

/** A composed CLI and the workspace's entitlements: what one command line runs against. */
export interface Session {
  readonly cli: Cli;
  readonly entitled: ReadonlySet<string>;
}

/** The entitlements a command line has when its caller supplies none: no
 *  product, so every product-gated plugin group is locked. */
export const NO_ENTITLEMENTS: ReadonlySet<string> = new Set();

const COMMAND_NAME = /^[a-z][a-z0-9-]*$/;

export interface ComposeOptions {
  /** The bare program's handler (`eris` with no arguments); core's usage when absent. */
  readonly menu?: () => Promise<VerbHandler>;
}

/** The completion domains a build has seen, so one name or function keeps one text. */
interface DomainLedger {
  readonly domains: Map<string, { readonly helper: string; readonly by: string }>;
  readonly functions: Map<string, { readonly helper: string; readonly by: string }>;
}

/** Refuses a row whose `complete` slots the emitted script cannot hold. `by` names the row's owner in a later refusal. */
function checkSlots(path: string, row: Row, by: string, ledger: DomainLedger, refuse: (what: string) => never): void {
  (row.complete ?? []).forEach((slot, n) => {
    for (const word of slot) {
      const why = slotWordRefusal(word);
      if (why !== null) refuse(`row '${path}' slot ${n}: ${why}`);
      if (typeof word === "string") continue;
      const d = `domain '${word.domain}'`;
      const prior = ledger.domains.get(word.domain);
      if (prior !== undefined) {
        if (prior.helper !== word.helper) refuse(`${d}: it carries a different helper from ${prior.by}`);
        continue;
      }
      const scan = scanHelper(word.helper);
      if (!scan.ok) return refuse(`${d}: its helper ${scan.why}`);
      if (!scan.functions.includes(domainFunction(word.domain))) refuse(`${d}: its helper does not define ${domainFunction(word.domain)}`);
      for (const f of scan.functions) {
        const other = ledger.functions.get(f);
        if (other !== undefined && other.helper !== word.helper) refuse(`${d}: its helper defines '${f}', which ${other.by} defines with other text`);
      }
      for (const f of scan.functions) ledger.functions.set(f, { helper: word.helper, by });
      ledger.domains.set(word.domain, { helper: word.helper, by });
    }
  });
}

export function composeCli(coreRows: Rows, coreHandlers: Handlers, plugins: readonly ErisPlugin[], opts: ComposeOptions = {}): Cli {
  const registry: Record<string, Row> = { ...coreRows };
  const handlers: Record<string, () => Promise<VerbHandler>> = { ...coreHandlers };
  if (opts.menu !== undefined) {
    if (typeof opts.menu !== "function") throw new PluginCompositionError("menu must be a handler thunk, () => Promise<VerbHandler>");
    handlers[""] = opts.menu;
  }
  const owner = new Map<string, string | null>();
  for (const k of [...Object.keys(ARGV_SHAPES), ...Object.keys(coreRows).filter((k) => !k.includes(" "))]) owner.set(k, null);
  const names = new Set<string>();
  const groups: PluginGroup[] = [];
  const fixLines: string[] = [];
  const ledger: DomainLedger = { domains: new Map(), functions: new Map() };
  const refuseCore = (what: string): never => {
    throw new PluginCompositionError(`core: ${what}`);
  };
  for (const [path, row] of Object.entries(coreRows)) checkSlots(path, row, "core", ledger, refuseCore);

  for (const p of plugins) {
    const refuse = (what: string): never => {
      throw new PluginCompositionError(`plugin '${p.name}': ${what}`);
    };
    if (names.has(p.name)) throw new PluginCompositionError(`plugin '${p.name}' is composed twice`);
    names.add(p.name);
    const paths = Object.keys(p.rows);
    const own = paths.filter((k) => !k.includes(" "));
    const generated: string[] = [];

    for (const g of own) {
      if (!COMMAND_NAME.test(g)) refuse(`group '${g}' is not a command name (lower-case letters, digits, '-')`);
      if (owner.has(g)) {
        const prior = owner.get(g);
        refuse(`group '${g}' collides with ${prior === null ? "a built-in command" : `plugin '${prior}'`}`);
      }
      if (p.rows[g]!.impl !== "ts") refuse(`group '${g}' must be impl 'ts'`);
      if (!Object.hasOwn(p.handlers, g)) refuse(`group '${g}' has no handler`);
    }
    for (const path of paths) {
      const row = p.rows[path]!;
      const words = path.split(" ");
      if (words.length > 1) {
        const parent = words.slice(0, -1).join(" ");
        if (!Object.hasOwn(p.rows, parent)) refuse(`row '${path}' hangs off '${parent}', which the plugin does not declare`);
        if (row.impl !== undefined && row.impl !== "ts") refuse(`row '${path}' must not name an impl other than 'ts'`);
      }
      checkSlots(path, row, `plugin '${p.name}'`, ledger, refuse);
      if (row.json === true) {
        if (paths.some((k) => k.startsWith(`${path} `))) refuse(`row '${path}' has subs, so json goes on each sub that renders it`);
        generated.push(jsonFixLine(path, row.summary));
      }
    }
    for (const h of Object.keys(p.handlers)) if (!own.includes(h)) refuse(`handler '${h}' has no group row`);
    if (p.jsonFix !== undefined) {
      if (generated.length === 0) refuse("jsonFix is set but no row says json: true");
      if (!p.jsonFix.endsWith("\n")) refuse("jsonFix must end with a newline");
      fixLines.push(p.jsonFix);
    } else fixLines.push(...generated);

    for (const g of own) {
      owner.set(g, p.name);
      groups.push({ group: g, summary: p.rows[g]!.summary, plugin: p.name, ...(p.product !== undefined ? { product: p.product } : {}) });
    }
    Object.assign(registry, p.rows);
    Object.assign(handlers, p.handlers);
  }

  return {
    registry,
    table: deriveTable(registry),
    handlers,
    jsonSurfaces: deriveJsonSurfaces(registry),
    jsonFix: unsupportedFix(fixLines),
    groups,
  };
}

/** The product `group` needs and the session has not bought, else undefined. */
export function lockedProduct(session: Session, group: string): string | undefined {
  const product = session.cli.groups.find((g) => g.group === group)?.product;
  return product !== undefined && !session.entitled.has(product) ? product : undefined;
}

const lockedWhy = (product: string) => `part of the '${product}' product, which this workspace has not bought`;

/** The top-level help's command lines: each core group, then each plugin
 *  group (a locked one marked), every summary starting in one column. */
export function commandLines(session: Session): string {
  const { registry, groups } = session.cli;
  const plugin = new Set(groups.map((g) => g.group));
  const core = Object.keys(registry)
    .filter((k) => !k.includes(" ") && !plugin.has(k))
    .map((group) => ({ group, summary: registry[group]!.summary }));
  const rows = [...core, ...groups];
  const width = Math.max(...rows.map((r) => r.group.length));
  return rows
    .map((r) => {
      const product = lockedProduct(session, r.group);
      return `  ${r.group.padEnd(width)}  ${r.summary}${product !== undefined ? ` [locked: ${product}]` : ""}\n`;
    })
    .join("");
}

/**
 * What a locked command line prints. Help (`--help` ahead of any `--`) is the
 * deepest row's generated help plus why it is locked, on stdout, exit 0: it
 * reads the rows only, never the plugin's handler. Anything else is the
 * `command-locked` block on stderr, exit 1.
 */
export function lockedOutcome(session: Session, product: string, words: readonly string[], help: boolean, home: string): { stream: "stdout" | "stderr"; text: string; rc: number } {
  const group = words[0]!;
  if (help) {
    let path = group;
    for (const w of words.slice(1)) {
      if (!Object.hasOwn(session.cli.registry, `${path} ${w}`)) break;
      path = `${path} ${w}`;
    }
    return { stream: "stdout", text: `${helpText(path, session.cli.registry[path]!)}\nLocked: ${lockedWhy(product)}.\n`, rc: 0 };
  }
  return {
    stream: "stderr",
    rc: 1,
    text: renderFailureBlock(
      {
        slug: "command-locked",
        what: `'eris ${group}' is ${lockedWhy(product)}`,
        fix: `add the '${product}' product to this workspace, then run the command again`,
        docs: "docs/ERRORS.md#command-locked",
      },
      home,
    ),
  };
}
