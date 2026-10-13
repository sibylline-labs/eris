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
import type { ErisPlugin, VerbHandler } from "../src/cli/plugin";
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
      // The row's completion domain is emitted from the manifest's data: its helper text and the slot that calls it.
      expect(r.stdout).toContain("__eris_dom_trip() {\n  echo armed\n}\n");
      expect(r.stdout).toContain(`"tripwire 0") echo "$(__eris_dom_trip "$@")" ;;`);
    }
    // The tripwire is live: dispatching to it does evaluate the handler module.
    await expect(run(["tripwire"], { cli })).rejects.toThrow("tripwire: handler module evaluated");
  });

  it("the --output json allow-list comes from plugin rows and fails closed", async () => {
    /** When a plugin verb without a machine rendering accepts --output json, a parser is handed human text; when a json row is not honoured, a machine caller is refused — observed at the refusal block. */
    const refused = await run(["--output", "json", "widgets", "count", "2"], { cli: withWidgets });
    expect({ rc: refused.rc, stdout: refused.stdout }).toEqual({ rc: 1, stdout: "" });
    expect(refused.stderr).toContain("slug: output-json-unsupported");
    // After core's own lines, the plugin's, the description at column 43 as core's shapes are.
    expect(refused.stderr).toContain("fix:   eris update                              {current, latest, update_available, updated}\nfix:   eris widgets ping                        Reply with a pong\n");
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
    expect(refused.stderr).toContain("fix:   eris update                              {current, latest, update_available, updated}\nfix:   eris widgets ping                        {pong}\ndocs: ");
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

  /** A row whose slot 0 completes `tokens`. */
  const slotted = (name: string, ...tokens: unknown[]): ErisPlugin =>
    plugin({ name, rows: { [`g${name}`]: { ...ts, complete: [tokens] } as typeof ts }, handlers: { [`g${name}`]: h } });
  const fn = (name: string, body = "  echo x") => `${name}() {\n${body}\n}\n`;
  const domainCases: [string, unknown[], string][] = [
    ["a slot word that is not shell-safe", ["a b"], "row 'gp' slot 0: 'a b' is not a completion word (letters, digits, '_', '?', '-'), '@file' or a domain"],
    ["an '@' word that is not '@file'", ["@env"], "row 'gp' slot 0: '@env' is not a completion word (letters, digits, '_', '?', '-'), '@file' or a domain"],
    ["a domain name outside the grammar", [{ domain: "@Env", helper: fn("__eris_dom_Env") }], "row 'gp' slot 0: domain '@Env' is not a domain name ('@', then lower-case letters, digits, '_')"],
    ["the built-in file domain as an object", [{ domain: "@file", helper: fn("__eris_dom_file") }], "row 'gp' slot 0: '@file' is built in: write it as the word '@file'"],
    ["a helper that does not define its function", [{ domain: "@x", helper: fn("__eris_dom_y") }], "domain '@x': its helper does not define __eris_dom_x"],
    ["a helper with no final newline", [{ domain: "@x", helper: "__eris_dom_x() {\n  echo x\n}" }], "domain '@x': its helper does not end with a newline"],
    ["a helper carrying a control character", [{ domain: "@x", helper: fn("__eris_dom_x", "  echo \x1b[31m") }], "domain '@x': its helper carries a control character (line 2)"],
    ["a helper carrying a bidi override", [{ domain: "@x", helper: fn("__eris_dom_x", "  echo ‮") }], "domain '@x': its helper carries a control character (line 2)"],
    ["a helper that runs a command when sourced", [{ domain: "@x", helper: `${fn("__eris_dom_x")}touch pwned\n` }], "domain '@x': its helper runs a command when sourced (line 4): outside a function only definitions, comments and blank lines may sit"],
    ["a helper defining a core function", [{ domain: "@x", helper: `${fn("__eris_dom_x")}${fn("_eris_completions")}` }], "domain '@x': its helper defines '_eris_completions' (line 4), outside the __eris_dom_ namespace"],
    ["a helper with a function inside a function", [{ domain: "@x", helper: fn("__eris_dom_x", "  __eris_comp_groups() { :; }") }], "domain '@x': its helper defines a function inside a function (line 2)"],
    ["a helper with a heredoc", [{ domain: "@x", helper: fn("__eris_dom_x", "  cat <<EOF\n}\nEOF") }], "domain '@x': its helper uses a heredoc (line 2): its body is text the script's framing cannot see"],
    ["a helper with a backtick substitution", [{ domain: "@x", helper: fn("__eris_dom_x", "  echo `ls`") }], "domain '@x': its helper uses a backtick substitution (line 2): use $( ) instead"],
    ["a helper ending inside a quote", [{ domain: "@x", helper: fn("__eris_dom_x", '  echo "open') }], "domain '@x': its helper ends inside a quote, expansion or substitution"],
    ["a helper ending inside a substitution", [{ domain: "@x", helper: fn("__eris_dom_x", "  echo $(ls") }], "domain '@x': its helper ends inside a quote, expansion or substitution"],
    ["a helper ending inside a function body", [{ domain: "@x", helper: "__eris_dom_x() {\n  { echo x\n}\n" }], "domain '@x': its helper ends inside a function body"],
    ["text after a closing brace", [{ domain: "@x", helper: "__eris_dom_x() { echo x; } ; touch pwned\n" }], "domain '@x': its helper puts text after a function's closing brace (line 1)"],
  ];
  it.each(domainCases)("%s", (_name, tokens, message) => {
    /** When composition accepts a completion slot the emitted script cannot hold — a word that breaks out of its quotes, a helper that runs a command when sourced, leaves a quote or body open (swallowing the rest of the script), or redefines core's functions — every shell that sources `eris completion` breaks or runs code at start: observed at composeCli. */
    expect(() => composeCli(REGISTRY, HANDLERS, [slotted("p", ...tokens)])).toThrow(new PluginCompositionError(`plugin 'p': ${message}`));
  });

  it("one domain carries one helper across the build, and one helper function has one definition", () => {
    /** When two plugins hand the same domain (or the same helper function) different text, whichever the script defines last silently wins, and the other plugin's slot completes the wrong words: observed at composeCli. */
    const x = (body: string) => ({ domain: "@x", helper: fn("__eris_dom_x", body) });
    expect(() => composeCli(REGISTRY, HANDLERS, [slotted("a", x("  echo a")), slotted("b", x("  echo b"))])).toThrow(
      new PluginCompositionError("plugin 'b': domain '@x': it carries a different helper from plugin 'a'"),
    );
    const lib = (body: string) => fn("__eris_dom_lib", body);
    expect(() =>
      composeCli(REGISTRY, HANDLERS, [
        slotted("a", { domain: "@x", helper: `${lib("  echo a")}${fn("__eris_dom_x")}` }),
        slotted("b", { domain: "@y", helper: `${lib("  echo b")}${fn("__eris_dom_y")}` }),
      ]),
    ).toThrow(new PluginCompositionError("plugin 'b': domain '@y': its helper defines '__eris_dom_lib', which plugin 'a' defines with other text"));
    // PAIRED: the same text in both plugins is one helper, shared.
    const shared = { domain: "@x", helper: fn("__eris_dom_x") };
    expect(composeCli(REGISTRY, HANDLERS, [slotted("a", shared), slotted("b", { ...shared })]).groups.map((g) => g.group)).toEqual(["ga", "gb"]);
  });
});

describe("a distribution owns the bare program", () => {
  it("its menu runs for bare `eris`; -h and --help stay the usage, and core's usage is the default", async () => {
    /** When the menu option is dropped or reaches the wrong argv shape, a distribution's bare `eris` prints core's usage instead of its launcher, or `eris --help` stops printing usage: observed through `main`. */
    const menu: VerbHandler = async (args, ctx) => (ctx.stdout.write(`menu ${JSON.stringify(args)} ${ctx.format}\n`), 0);
    const cli = composeCli(REGISTRY, HANDLERS, [widgets], { menu: async () => menu });
    expect(await run([], { cli })).toEqual({ rc: 0, stdout: "menu [] text\n", stderr: "" });
    for (const help of ["-h", "--help"]) {
      const r = await run([help], { cli });
      expect({ help, rc: r.rc, stderr: r.stderr }).toEqual({ help, rc: 0, stderr: "" });
      expect(r.stdout).toStartWith("Usage: eris <command> [args]\n");
      expect(r.stdout).toContain("\n  widgets ");
    }
    // PAIRED: without the option, bare `eris` is core's usage.
    expect((await run([], { cli: withWidgets })).stdout).toStartWith("Usage: eris <command> [args]\n");
    expect(() => composeCli(REGISTRY, HANDLERS, [], { menu: "launcher" as unknown as () => Promise<VerbHandler> })).toThrow(
      new PluginCompositionError("menu must be a handler thunk, () => Promise<VerbHandler>"),
    );
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

