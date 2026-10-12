/**
 * This build's composed CLI (src/main.ts `CLI`: core's registry plus
 * plugins/index.ts) under the names core's modules export for core alone.
 *
 * A suite that holds "every eris verb" against a golden (the routing table,
 * the json allow-list, the completion tree) means the build, not core: since
 * `eris yak` became a plugin, core's REGISTRY no longer carries it.
 * Import these in place of the core names; the helpers default to the
 * composed registry and table and still take an explicit one.
 */

import * as core from "../../src/cli/registry";
import { route as coreRoute, type Route } from "../../src/cli/router";
import { CLI } from "../../src/main";

type Rows = Readonly<Record<string, core.Row>>;

export const REGISTRY: Rows = CLI.registry;
export const TABLE = CLI.table;
export const JSON_SURFACES = CLI.jsonSurfaces;
export const UNSUPPORTED_FIX = CLI.jsonFix;
export const HANDLERS = CLI.handlers;

export const implOf = (path: string, reg: Rows = REGISTRY) => core.implOf(path, reg);
export const subsOf = (path: string, reg: Rows = REGISTRY) => core.subsOf(path, reg);
export const rowsOfGroup = (group: string, reg: Rows = REGISTRY) => core.rowsOfGroup(group, reg);
export const flagsOf = (path: string, reg: Rows = REGISTRY) => core.flagsOf(path, reg);
export const route = (argv: readonly string[], table: Readonly<Record<string, core.Impl>> = TABLE): Route => coreRoute(argv, table);
