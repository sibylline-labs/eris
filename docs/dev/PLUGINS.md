# Writing a plugin

A plugin adds a verb group to eris without touching core. It is a package that
exports **registry rows plus handlers**. The rows are pure
data and the handlers are loaded lazily. A plugin talks to core through one
module, the SDK at `src/cli/plugin.ts`.

Plugins compose at **build time**. A build lists its plugins, core merges their
rows into the registry, and everything that derives from the registry then sees
them: the router table, the argv parser, the `--output json` allow-list, shell
completion and `eris --help`. There is no runtime plugin loader.

The worked example is `examples/plugins/widgets/`, which `tests/plugins.test.ts`
composes and drives. Copy it. The shipped plugin `plugins/yak/` (`eris yak`) is
the full-size one: a dispatcher, a core, and the core's own modules.

## The shape

```
plugins/<name>/
  index.ts      # the manifest: rows + handler thunks (loaded on every command line)
  handlers.ts   # the code (loaded only when the group's command runs)
```

## The manifest

`index.ts` default-exports `definePlugin({ name, rows, handlers, product? })`:

```ts
import { definePlugin } from "../../src/cli/plugin";

export default definePlugin({
  name: "widgets",
  rows: {
    widgets: { impl: "ts", summary: "Ping and count widgets (ping, count)" },
    "widgets ping": { summary: "Reply with a pong", json: true, flags: [{ name: "--name", takesValue: true }] },
    "widgets count": { summary: "Print N widgets", pos: ["n?"], usage: "<n>" },
  },
  handlers: {
    widgets: async () => (await import("./handlers")).runWidgets,
  },
});
```

- **`rows`** use the same `Row` shape as core's `src/cli/registry.ts`. Read its
  header for the fields (`flags`, `pos`, `usage`, `json`, `extraHint`). The
  group row (one word) says `impl: "ts"`. Each sub row hangs off a row the
  plugin declares. A value flag whose value is a file name says `file: true`,
  and tab completion offers file names after it.
- **`handlers`** has one thunk per group. The type checker requires a thunk for
  every group the rows declare. A thunk must `await import()` its module.
- **The manifest makes no other runtime import.** It loads on every command
  line, including the `eris completion` run at shell start. A static import of
  handler code would put a syntax error or a missing package in your plugin on
  every shell start. The `plugin-manifest-lazy-handlers` ast-grep rule enforces
  this. Type-only imports are fine.

## The handler

A handler is a `VerbHandler`, `(args, ctx) => Promise<number>`, the same
signature core's verbs use. `args` is everything after the group word, with the
global `--output` flag already removed. `ctx.format` is `"text"` or `"json"`.
Write payload to `ctx.stdout`, write diagnostics to `ctx.stderr`, and return the
exit code.

```ts
import { groupArgs, readArgs, type VerbHandler } from "../../src/cli/plugin";
import plugin from "./index";

export const runWidgets: VerbHandler = async (args, ctx) => {
  const g = groupArgs(plugin.rows, "widgets", args);
  if (g.kind === "bare" || g.kind === "help") return (ctx.stdout.write(USAGE), 0);
  if (g.kind === "unknown") return (ctx.stderr.write(`ERROR Unknown widgets command: ${g.sub}\n`), 1);
  const a = readArgs(plugin.rows, "widgets ping", g.rest, ctx);
  if (a === null) return 0; // --help was printed
  ctx.stdout.write(`pong ${a.flags["--name"] ?? "world"}\n`);
  return 0;
};
```

- **`readArgs(rows, path, argv, ctx)`** parses against the row. It accepts the
  row's flags and operands and nothing else. Its result is typed from the row,
  so `a.flags["--nmae"]` does not compile. It prints `--help` and returns
  `null`. A refusal is written to stderr and the command stops with exit 1. Never
  parse argv by hand (core's `adhoc-argv-parse` rule explains why).
- **`groupArgs(rows, group, argv)`** reads a group handler's first word and
  returns one of four kinds: `bare`, `help`, `sub`, or `unknown`.
- Follow the output contract ([OUTPUT-CONTRACT.md](../OUTPUT-CONTRACT.md)):
  stdout carries the payload only, a failure is a slugged block from
  `renderFailureBlock`, and a warning is `renderWarnLines` (both re-exported by
  the SDK, with `erisHome`, the install root a block's `docs:` path resolves under).
- Read an environment variable whose name you were handed with the SDK's
  **`readEnv(env, name)`**, never `env[name]`: an inherited name such as
  `__proto__` would read as set (`env-read-own-property-plugin`).

## What a plugin may import

The SDK, `src/cli/plugin.ts`, plus the plugin's own files (reached with `./`),
packages, and `node:` builtins. Nothing else is allowed: not `src/` or `ts/`,
not a root-level core file, and not another plugin or
`plugins/index.ts`. Those are core internals or neighbours that can change
under you, and the `plugin-imports-sdk-only` rule enforces the boundary for
static imports, re-exports, `import x = require()`, `require()` and dynamic
`import()` (quoted or template literal). The rule reads only the specifier, so
any `..` climb that does not land on the SDK is an error, as is a specifier
starting at `src/`, `ts/` or `/`. Keep a plugin's files importing each other
with `./`; subfolders of any name (`./src/helper`) are the plugin's own. If a plugin needs something from
core, export it from the SDK on purpose.

## `--output json`

The allow-list fails closed and is built from your rows. A sub accepts
`--output json` only if its own row says `json: true`. Every other command is
refused with `output-json-unsupported`, and the refusal's fix text gains a line
for each of your json rows, as does the `--output` paragraph of `eris --help`.
Those fix lines are generated from the row summaries. To describe the JSON shape
instead, as core's lines do, set `jsonFix` on the plugin: your own lines, each
`  eris <verb>` padded to column 43 with the shape after it, and each ending in a
newline (plugins/yak/index.ts sets one).
`json: true` on a group that has subs is refused at
composition: it would allow subs that have no machine rendering.

## Entitlements

A plugin with no `product` is available to every workspace. Set
`product: "<name>"` and its groups are **locked** for any workspace whose
entitlements do not include that product:

- `eris --help` marks the group `[locked: <product>]`;
- `eris <group> ... --help` prints the row's help plus a `Locked:` line, exit 0;
- anything else prints the `command-locked` block ([ERRORS.md](../ERRORS.md#command-locked)), exit 1.

The handler never loads while the group is locked. Entitlements reach `main`
as `MainOptions.entitlements`. When none are given, `NO_ENTITLEMENTS` applies
and no product is entitled.

## Composition and what it refuses

`composeCli(coreRows, coreHandlers, plugins)` (`src/cli/compose.ts`) merges the
rows and throws `PluginCompositionError` on:

- a group that collides with a built-in, an argv shape (`-h`), or another plugin's group;
- a group that is not `impl: "ts"`, or a sub row with another impl (a JavaScript plugin can name one the type does not admit);
- a sub row whose parent the plugin does not declare;
- a group with no handler, or a handler with no group;
- `json: true` on a group with subs;
- the same plugin name composed twice.

Composition runs in `scripts/build.ts` before bundling, so a refused plugin
fails the build. It also runs when the program starts, and in every test that
imports `src/main.ts`.

## Adding a plugin to a build

This build's list is `plugins/index.ts`:

```ts
import widgets from "./widgets";
export const PLUGINS: readonly ErisPlugin[] = [widgets];
```

That is the only edit, and nothing under `src/` changes. A distribution with a
different plugin set writes its own entry and composes its own list:

```ts
import { composeCli } from "eris/src/cli/compose";
import { REGISTRY } from "eris/src/cli/registry";
import { HANDLERS, runProgram } from "eris/src/main";
import { PLUGINS } from "eris/plugins";
import internal from "./plugins/internal";

runProgram({ cli: composeCli(REGISTRY, HANDLERS, [...PLUGINS, internal]) });
```

## Testing a plugin

Compose it in the test and drive `main` with `{ cli }`. This is the seam every
command line crosses. `tests/plugins.test.ts` is the reference: routing, argv
refusal, json, completion, help and locks, all through `main`. Add a
`docs/ERRORS.md` heading for each slug a shipped plugin raises
(`tests/errors-doc.test.ts` harvests `plugins/`).
