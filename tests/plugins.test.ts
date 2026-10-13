/**
 * Plugins compose at build time.
 *
 * A plugin is rows plus handler thunks (src/cli/plugin.ts). These tests compose
 * the example plugin (examples/plugins/widgets) and a tripwire plugin with the
 * core registry, the way a distribution's entry does, and drive the result
 * through `main`: the seam every command line crosses. Nothing in src/ names
 * either plugin.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import widgets from "../examples/plugins/widgets";
import { composeCli, PluginCompositionError } from "../src/cli/compose";
import type { ErisPlugin } from "../src/cli/plugin";
import { UNSUPPORTED_FIX } from "../src/cli/output";
import { REGISTRY } from "../src/cli/registry";
import { HANDLERS, main, type MainOptions } from "../src/main";
import tripwire from "./helpers/plugins/tripwire";

const REPO = resolve(import.meta.dir, "..");

async function run(argv: string[], opts: MainOptions = {}): Promise<{ rc: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const rc = await main(argv, { _ERIS_SHIM_DIR: REPO, PATH: process.env.PATH, HOME: process.env.HOME }, {
    ...opts,
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: (s: string) => ((stderr += s), true) },
  });
  return { rc, stdout, stderr };
}

const withWidgets = composeCli(REGISTRY, HANDLERS, [widgets]);

describe("a plugin adds a verb group with zero core edits", () => {
  it("the example plugin's group routes, parses, renders and completes once composed", async () => {
    /** When composition stops reaching one of the planes a row drives (router, argv parse, json allow-list, completion, top-level help), a plugin verb exists in one and is missing from another — observed through `main`. */
    expect(await run(["widgets", "ping", "--name", "ada"], { cli: withWidgets })).toEqual({ rc: 0, stdout: "pong ada\n", stderr: "" });
    expect(await run(["--output", "json", "widgets", "ping"], { cli: withWidgets })).toEqual({ rc: 0, stdout: '{"pong":"world"}\n', stderr: "" });
    expect(await run(["widgets", "count", "3"], { cli: withWidgets })).toEqual({ rc: 0, stdout: "widget 1\nwidget 2\nwidget 3\n", stderr: "" });

    // The row is the parser: an undeclared flag is refused with the row's usage.
    const bad = await run(["widgets", "ping", "--nmae", "x"], { cli: withWidgets });
    expect({ rc: bad.rc, stdout: bad.stdout }).toEqual({ rc: 1, stdout: "" });
    expect(bad.stderr).toBe("ERROR Unknown flag '--nmae' (usage: eris widgets ping [--name <value>])\n");

    const completion = await run(["completion", "bash"], { cli: withWidgets });
    expect(completion.rc).toBe(0);
    expect(completion.stdout).toMatch(/\bwidgets\b/);
    expect(completion.stdout).toContain("--name");

    const help = await run(["--help"], { cli: withWidgets });
    expect(help.stdout).toContain("\n  widgets     Example plugin: ping and count widgets (ping, count)\n");

    // The same argv without the plugin is an unknown command: the plugin, not core, added it.
    expect((await run(["widgets", "ping"])).stderr).toBe("ERROR Unknown command: widgets. Run 'eris --help'\n");
  });

  it("no core file names the example plugin", () => {
    /** When core special-cases a plugin (imports it, lists its group), adding a plugin is a core edit again — observed by reading src/ and ts/. */
    const files = (dir: string): string[] =>
      readdirSync(join(REPO, dir)).flatMap((e) => {
        const rel = join(dir, e);
        return statSync(join(REPO, rel)).isDirectory() ? files(rel) : [rel];
      });
    const core = [...files("src"), ...files("ts")].filter((f) => /\.tsx?$/.test(f));
    expect(core.length).toBeGreaterThan(15);
    expect(core.filter((f) => /\bwidgets\b|examples\/plugins/.test(readFileSync(join(REPO, f), "utf8")))).toEqual([]);
  });
});

describe("the three carried invariants", () => {
  it("completion never loads plugin handler code", async () => {
    /** When the completion path evaluates a plugin's handler module, a plugin that throws (or lacks a package) at load breaks every shell start — observed by a tripwire handler that throws on evaluation. */
    const cli = composeCli(REGISTRY, HANDLERS, [widgets, tripwire]);
    for (const shell of ["bash", "zsh"]) {
      const r = await run(["completion", shell], { cli });
      expect({ shell, rc: r.rc, stderr: r.stderr }).toEqual({ shell, rc: 0, stderr: "" });
      expect(r.stdout).toMatch(/\btripwire\b/);
    }
    // The tripwire is live: dispatching to it does evaluate the handler module.
    await expect(run(["tripwire"], { cli })).rejects.toThrow("tripwire: handler module evaluated");
  });

  it("the --output json allow-list comes from plugin rows and fails closed", async () => {
    /** When a plugin verb without a machine rendering accepts --output json, a parser is handed human text; when a json row is not honoured, a machine caller is refused — observed at the refusal block. */
    const refused = await run(["--output", "json", "widgets", "count", "2"], { cli: withWidgets });
    expect({ rc: refused.rc, stdout: refused.stdout }).toEqual({ rc: 1, stdout: "" });
    expect(refused.stderr).toContain("slug: output-json-unsupported");
    // Under the header, the description at column 43 as core's own lines were.
    expect(refused.stderr).toContain("fix: the surfaces that accept --output json are:\nfix:   eris widgets ping                        Reply with a pong\n");
    expect(refused.stderr).not.toContain("eris widgets count ");
    expect(withWidgets.jsonSurfaces.widgets).toEqual(["ping"]);
    // Core's own refusal text is unchanged by an empty plugin set.
    expect(composeCli(REGISTRY, HANDLERS, []).jsonFix).toBe(UNSUPPORTED_FIX);
  });

  it("a plugin's own json fix text replaces the lines generated from its summaries", async () => {
    /** When a plugin's declared fix text is dropped or misplaced, the refusal tells a machine caller what a row is about instead of the JSON shape it would parse — observed at the refusal block. */
    const jsonFix = "  eris widgets ping                        {pong}\n";
    const cli = composeCli(REGISTRY, HANDLERS, [{ ...widgets, jsonFix }]);
    const refused = await run(["--output", "json", "widgets", "count", "2"], { cli });
    // In the plugin slot after the header, and the last line of the fix (no empty `fix: ` after it).
    expect(refused.stderr).toContain("fix: the surfaces that accept --output json are:\nfix:   eris widgets ping                        {pong}\ndocs: ");
    expect(refused.stderr).not.toContain("Reply with a pong");
  });

  it("a plugin group that collides with a built-in is refused at composition", () => {
    /** When a plugin may take a built-in's name, one of the two silently stops being reachable — observed at composeCli. */
    const completion: ErisPlugin = { ...widgets, rows: { completion: { impl: "ts", summary: "mine" } }, handlers: { completion: widgets.handlers.widgets! } };
    expect(() => composeCli(REGISTRY, HANDLERS, [completion])).toThrow(new PluginCompositionError("plugin 'widgets': group 'completion' collides with a built-in command"));
  });
});

describe("composition refuses a plugin that would break a plane", () => {
  const ts = { impl: "ts", summary: "s" } as const;
  /** A row a JavaScript plugin can hand over that the `Impl` type never admits. */
  const foreign = { impl: "bash", summary: "s" } as unknown as typeof ts;
  const h = widgets.handlers.widgets!;
  const plugin = (p: Partial<ErisPlugin> & Pick<ErisPlugin, "rows" | "handlers">): ErisPlugin => ({ name: "p", ...p });
  const cases: [string, ErisPlugin[], string][] = [
    ["two plugins, one group", [plugin({ name: "a", rows: { w: ts }, handlers: { w: h } }), plugin({ name: "b", rows: { w: ts }, handlers: { w: h } })], "plugin 'b': group 'w' collides with plugin 'a'"],
    ["an argv shape", [plugin({ rows: { "-h": ts }, handlers: { "-h": h } })], "plugin 'p': group '-h' is not a command name (lower-case letters, digits, '-')"],
    ["a non-ts group (from untyped code)", [plugin({ rows: { w: foreign }, handlers: { w: h } })], "plugin 'p': group 'w' must be impl 'ts'"],
    ["a non-ts sub (from untyped code)", [plugin({ rows: { w: ts, "w x": foreign }, handlers: { w: h } })], "plugin 'p': row 'w x' must not name an impl other than 'ts'"],
    ["an orphan sub", [plugin({ rows: { w: ts, "v x": { summary: "s" } }, handlers: { w: h } })], "plugin 'p': row 'v x' hangs off 'v', which the plugin does not declare"],
    ["json on a group with subs", [plugin({ rows: { w: { ...ts, json: true }, "w x": { summary: "s" } }, handlers: { w: h } })], "plugin 'p': row 'w' has subs, so json goes on each sub that renders it"],
    ["a group with no handler", [plugin({ rows: { w: ts }, handlers: {} })], "plugin 'p': group 'w' has no handler"],
    ["a handler with no group", [plugin({ rows: { w: ts }, handlers: { w: h, v: h } })], "plugin 'p': handler 'v' has no group row"],
    ["a jsonFix with no json row", [plugin({ rows: { w: ts }, handlers: { w: h }, jsonFix: "  eris w  {}\n" })], "plugin 'p': jsonFix is set but no row says json: true"],
    ["a jsonFix with no final newline", [plugin({ rows: { w: { ...ts, json: true } }, handlers: { w: h }, jsonFix: "  eris w  {}" })], "plugin 'p': jsonFix must end with a newline"],
    ["one name twice", [plugin({ rows: { w: ts }, handlers: { w: h } }), plugin({ rows: { v: ts }, handlers: { v: h } })], "plugin 'p' is composed twice"],
  ];
  it.each(cases)("%s", (_name, plugins, message) => {
    /** When a malformed plugin composes, the binary routes to a script that does not exist, offers a verb nothing handles, or accepts --output json for subs with no rendering — observed at composeCli. */
    expect(() => composeCli(REGISTRY, HANDLERS, plugins)).toThrow(new PluginCompositionError(message));
  });
});

describe("entitlement gating: a product the workspace has not bought renders as locked", () => {
  const pro = composeCli(REGISTRY, HANDLERS, [{ ...widgets, product: "widgets-pro" }]);

  it("a locked command is refused with a block, help marks it, and an entitlement unlocks it", async () => {
    /** When a locked command runs, or runs without saying why it will not, an unentitled tenant is either handed a product it has not bought or a bare failure — observed through `main` with and without the entitlement. */
    const locked = await run(["widgets", "ping"], { cli: pro, entitlements: new Set() });
    expect({ rc: locked.rc, stdout: locked.stdout }).toEqual({ rc: 1, stdout: "" });
    expect(locked.stderr).toContain("slug: command-locked");
    expect(locked.stderr).toContain("'eris widgets' is part of the 'widgets-pro' product, which this workspace has not bought");

    const top = await run(["--help"], { cli: pro, entitlements: new Set() });
    expect(top.stdout).toContain("\n  widgets     Example plugin: ping and count widgets (ping, count) [locked: widgets-pro]\n");

    const help = await run(["widgets", "ping", "--help"], { cli: pro, entitlements: new Set() });
    expect(help).toEqual({
      rc: 0,
      stdout: "Usage: eris widgets ping [--name <value>]\n\nReply with a pong\n\nFlags:\n  --name <value>\n  --help, -h   Print this usage text\n\nLocked: part of the 'widgets-pro' product, which this workspace has not bought.\n",
      stderr: "",
    });

    expect(await run(["widgets", "ping"], { cli: pro, entitlements: new Set(["widgets-pro"]) })).toEqual({ rc: 0, stdout: "pong world\n", stderr: "" });
    expect((await run(["--help"], { cli: pro, entitlements: new Set(["widgets-pro"]) })).stdout).not.toContain("[locked");
  });

  it("the default entitlements know no product", async () => {
    /** When the default grants products, every product-gated plugin ships unlocked to tenants who never bought it — observed through `main` with no entitlements passed. */
    expect((await run(["widgets", "ping"], { cli: pro })).stderr).toContain("slug: command-locked");
  });
});

