/**
 * router.ts — which implementation runs a command line.
 *
 * `TABLE` is derived from src/cli/registry.ts: a row for every group, the
 * three argv shapes that are not verbs (empty argv, `-h`, `--help`), and a
 * `"group sub"` row where a sub's implementation differs from its group's.
 *
 * A `ts` row runs in this process. A key is a group (`"completion"`)
 * or a group and its first argument (`"completion bash"`); the longer key wins. An
 * argv whose verb is not in the table is `unknown`: the router owns the
 * "Unknown command" refusal (src/main.ts).
 */

import { locateVerb } from "./args";
import { deriveTable, type Impl } from "./registry";

export type { Impl };

export const TABLE: Readonly<Record<string, Impl>> = deriveTable();

export type Route = { kind: "ts"; verb: string } | { kind: "unknown"; verb: string };

/** Resolve one command line. */
export function route(argv: readonly string[], table: Readonly<Record<string, Impl>> = TABLE): Route {
  const [verb = "", sub] = locateVerb(argv);
  const long = sub !== undefined ? `${verb} ${sub}` : undefined;
  const hit =
    long !== undefined && Object.hasOwn(table, long) ? table[long] : Object.hasOwn(table, verb) ? table[verb] : undefined;
  if (hit === "ts") return { kind: hit, verb };
  return { kind: "unknown", verb };
}
