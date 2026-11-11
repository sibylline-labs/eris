/**
 * docs.ts — `eris docs`: the verb reference of this build, read from the
 * composed rows (core's and every plugin's), so it can never list a verb the
 * build lacks or miss one it has.
 *
 * `--output json` (or the global `--json`) prints one record,
 * `{schema: "eris-docs/1", version, commands}`: `commands` is the top-level help
 * document, then one `eris-help/1` document (docs/OUTPUT-CONTRACT.md §3.2) per
 * composed row, in registry order. Text prints each row's usage line, summary and
 * flags. Nothing is read from the install root and nothing is fetched.
 */

import type { VerbHandler } from "../../main";
import { VERSION } from "../../runtime/home";
import { type HelpJson, helpJson, readVerbArgs, usageLine } from "../args";
import { REGISTRY, type Row } from "../registry";

const USAGE = `Usage: eris docs

Print the verb reference: every command this build composes, with its usage,
summary and flags. Each command's own --help says more.

Flags:
  --help, -h    Print this usage text

--output json (or --json) prints {schema, version, commands}, one eris-help/1
document per command (docs/OUTPUT-CONTRACT.md).
`;

export interface DocsJson {
  readonly schema: "eris-docs/1";
  readonly version: string;
  readonly commands: readonly HelpJson[];
}

/** The reference over `rows`: the top level, then each row in registry order. */
export function docsJson(rows: Readonly<Record<string, Row>>): DocsJson {
  return { schema: "eris-docs/1", version: VERSION, commands: [helpJson("", undefined, rows), ...Object.keys(rows).map((path) => helpJson(path, rows[path], rows))] };
}

function docsText(rows: Readonly<Record<string, Row>>): string {
  return Object.entries(rows)
    .map(([path, row]) => {
      const flags = (row.flags ?? []).map((f) => `    ${f.name}${f.takesValue ? " <value>" : ""}${f.repeatable === true ? "   (repeatable)" : ""}\n`).join("");
      return `${usageLine(path, row)}\n  ${row.summary}\n${flags}`;
    })
    .join("\n");
}

export const runDocs: VerbHandler = async (args, ctx) => {
  if (readVerbArgs("docs", args, ctx, { help: USAGE }) === null) return 0;
  const rows = ctx.session?.cli.registry ?? REGISTRY;
  ctx.stdout.write(ctx.format === "json" ? `${JSON.stringify(docsJson(rows))}\n` : docsText(rows));
  return 0;
};
