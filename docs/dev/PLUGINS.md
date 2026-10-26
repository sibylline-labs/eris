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
  and tab completion offers file names after it. A row's positional slots
  complete what its `complete` lists ([Completion domains](#completion-domains)).
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

## Completion domains

A row's `complete` lists what tab completion offers for each positional slot,
in order. A slot's words are literals, `@file` (file names, and nothing else),
or a **completion domain**: words only a shell function can list at tab-press
time, such as names the plugin keeps in a local file.

```ts
import { type CompletionDomain, definePlugin } from "../../src/cli/plugin";

/** The names to greet; the tone typed in the slot before picks their case. */
const NAME: CompletionDomain = {
  domain: "@demo_name",
  helper: `__eris_dom_demo_name() {
  case "\${1:-}" in
    loud) echo "ADA GRACE" ;;
    *) echo "ada grace" ;;
  esac
}
`,
};

// rows:
"demo hello": { summary: "Greet a name", pos: ["tone", "name?"], complete: [["loud", "quiet"], [NAME]] },
```

The helper is shell text that `eris completion` writes into the script every
shell sources at start, once per distinct text however many rows use it:

- It is exactly one function definition, `__eris_dom_<name>() {` for
  `@<name>`, starting at the text's first character and closing at its final
  `}`, then a newline. Nothing sits before or after it, so sourcing the script
  defines it and runs nothing. Functions it calls go in `library`, a list of
  texts held to the same rule, each defining one `__eris_dom_…` function.
  Domains that share a library hand over the same texts, emitted once.
- The function is called with the words typed in the earlier positional slots
  (`$1` is slot 0's) and prints its words. `compgen -W` expands what it prints,
  so print shell-safe words only. Like the rest of the script it never runs
  eris and never reaches the network, and it stays silent when it has nothing.
- It is bash-3.2 clean (macOS `/bin/bash`); zsh loads the same body through
  `bashcompinit`. The check does not model shell quoting: it accepts a subset
  whose framing both shells agree on and refuses the rest, even when it is
  valid shell. Printable ASCII only; no comment (keep it in the TypeScript
  beside the text), backtick, heredoc or here-string, `$'…'`, `$"…"`, `$[…]`
  or nested function; a backslash only inside quotes and before a letter or
  digit, so no line continuation; `${ }` holds a name and its operators only;
  `{` as a word only in command position and `}` only after `;` or a newline,
  closing a group; no `case` and no unbalanced parenthesis in a quote inside
  `$( )`.
- One domain has one helper and library across a build. Two plugins may hand
  over the same domain with the same texts, which are emitted once. A function
  defined by two different texts is refused.

Composition checks all of this (`src/cli/commands/completion/domain.ts`) and
refuses with the line at fault. The helper is trusted like a plugin's handler
code, and the check is not a sandbox: it stops a mistake from breaking, or
running code in, every shell that loads completion. Never build helper text
from anything read at runtime.

## Composition and what it refuses

`composeCli(coreRows, coreHandlers, plugins, { menu?, completionNote? })`
(`src/cli/compose.ts`) merges the rows and throws `PluginCompositionError` on:

- a group that collides with a built-in, an argv shape (`-h`), or another plugin's group;
- a group that is not `impl: "ts"`, or a sub row with another impl (a JavaScript plugin can name one the type does not admit);
- a sub row whose parent the plugin does not declare;
- a group with no handler, or a handler with no group;
- `json: true` on a group with subs;
- a completion slot word that is not shell-safe, or a completion domain whose
  name, helper or library fails the rules above;
- the same plugin name composed twice;
- a `completionNote` that is not one or more non-empty lines of printable ASCII.

`menu`, when given, is the handler for the bare program (`eris` with no
arguments) in place of core's usage; `-h` and `--help` stay the usage, and end
with `Run 'eris' without arguments for interactive mode.` A build without a
`menu` prints neither the line nor a menu.

`completionNote`, when given, is a paragraph `eris completion --help` prints
after core's description, before the pointer to the docs: say what the
distribution's completion domains offer (core's text only knows its own flags
and file names). Without it the help is core's text, byte for byte.

Composition runs in `build()` before bundling, so a refused plugin fails the
build. It also runs when the program starts, and in every test that imports
`src/main.ts`.

## Adding a plugin to a build

This build's list is `plugins/index.ts`:

```ts
import widgets from "./widgets";
export const PLUGINS: readonly ErisPlugin[] = [widgets];
```

That is the only edit, and nothing under `src/` changes. A different plugin set
is a distribution.

## Distributions

A distribution is another repository that ships its own eris binary: core, this
build's plugins, and plugins of its own. The worked example is
`examples/distribution/`, which `tests/distribution.test.ts` composes, builds
and runs. Copy its shape.

1. **Depend on this package** as a git dependency pinned to a merge commit on
   `main`, never a branch:

   ```json
   "dependencies": { "eris": "github:sibylline-labs/eris#<merge commit sha>" }
   ```

2. **Import core only as `eris/sdk`** (`src/sdk.ts`): the plugin SDK, core's
   rows and handlers, this build's plugin list, `composeCli`, `runProgram`,
   `main`, the argv and output helpers (`parseGlobal` and `GlobalFlagError`
   included, for an entry that runs outside the router), the runtime
   (subprocesses, the bounded pool `runPool`, logging, the install root,
   `BUILD_ID`, `releaseRepo()`, the `DistributionIdentity` type) and `build`. The package's
   `exports` map refuses any deeper path (`eris/src/...`), so a core refactor
   never breaks a distribution that compiles today. A distribution's plugin
   manifests import `eris/sdk` too, and load handler code lazily as above.
   The `distribution-imports-sdk-only` rule holds this for the example; a
   distribution keeps its own copy for its tree. The `exports` map points at
   TypeScript, so the distribution's own `tsc` checks core's source too; it needs
   `"moduleResolution": "Bundler"` and `bun-types`, and no `files` entry for core's
   declarations (`src/runtime/home.ts` references the `eris:assets` one, the module
   `build()` supplies at bundle time). `tests/distribution.test.ts` typechecks the
   example under a tsconfig that lists only its sources.

3. **Compose and run** from its entry:

   ```ts
   import { join } from "node:path";
   import { composeCli, type DistributionIdentity, HANDLERS, PLUGINS, REGISTRY, runProgram } from "eris/sdk";
   import mine from "./plugins/mine";

   export const IDENTITY: DistributionIdentity = {
     releaseRepo: "my-org/my-eris",
     versionExtra: "core <pinned sha>",
     docsBase: "https://github.com/my-org/my-eris/blob/main",
   };

   export const CLI = composeCli(REGISTRY, HANDLERS, [...PLUGINS, mine], {
     menu: async () => (await import("./menu")).runMenu,
     completionNote: "Also completes mine's names.",
   });

   if (import.meta.main) runProgram({ cli: CLI, installRoot: join(import.meta.dir, ".."), identity: IDENTITY });
   ```

   `installRoot` is the distribution's root, an absolute path: the directory
   `build()` takes as `root`, and (for an entry in `src/`) the one above it. Run
   from source, a command's `ctx.erisDir` is that directory, and a file the binary
   carries as an asset is read from the same relative path. The local `docs:` line
   of a failure block names its doc under that directory when it holds the doc,
   else under this package's (`docRoots`' order), so the line names a file that
   exists, as it does in the binary. Left out, `ctx.erisDir` is this package's
   directory, which in a dependent repository is `node_modules/eris`, not the
   distribution. A compiled binary ignores it (its root is its per-build asset
   home), and the `_ERIS_SHIM_DIR` a distribution's own shim sets wins over it.

   `identity` is who the distribution is: `releaseRepo`, `versionExtra` and
   `docsBase`, the same three fields `build()` takes (step 4). Run from source,
   `eris --version`, `eris update`, `releaseRepo()` and a failure block's second
   `docs:` line report them in place of this repository's; left out, a run from
   source says it is public eris and links public docs, which hold none of the
   distribution's slugs. Keep the values in one module that both the entry and
   the build import (the example's `IDENTITY`), so the two cannot drift.
   `runProgram` checks them as `build()` does. **Precedence:** a compiled binary
   reports the identity its build baked and ignores `identity`, so what a binary
   says it is, and where it updates from, is fixed when it is built; no
   environment variable moves either, in a binary or from source.

4. **Build** with `build()` from `eris/sdk` (`src/build.ts` documents what the
   binary carries):

   | Option | Meaning |
   |---|---|
   | `entry` | The entry above. Required. |
   | `root` | The distribution's root, which the paths below are relative to, and the `installRoot` its entry hands `runProgram`. Default: the nearest directory with a `package.json` at or above the entry's. |
   | `plugins` | The plugin list the entry composes, composed again before bundling so a refused plugin fails the build. |
   | `assetRoots` | Files, and directories of files, the binary carries and writes to its asset home, at the same relative paths. |
   | `docRoots` | Where a `docs/*.md` the source names is looked for, in order. Default: the root, then this package. |
   | `sourceRoots` | What is hashed into the build id and scanned for docs. Default: `src`, `ts` and `plugins` where present, the entry, `package.json` and the lockfile. This package's source is always added. |
   | `stubs` | `{ match, reason }`: specifiers bundled as a module that throws `<specifier> is not bundled into the compiled eris binary (<reason>)` if evaluated, for a module the binary must not carry. |
   | `releaseRepo` | `owner/name` the binary's own releases are published to, reported by `releaseRepo()` and `eris --version` and read by the release `eris update`. Default: `sibylline-labs/eris`. |
   | `versionExtra` | One printable line `eris --version` prints after the version line, and `extra` in its JSON record: the core a distribution was built on. Default: none. |
   | `docsBase` | An https URL (no query, fragment or space) the doc paths in a failure block's second `docs:` line are appended to, so a distribution links its own docs. Default: this repository's public docs. |
   | `outfile`, `target`, `tag` | The output path (default `dist/eris-<os>-<arch>`), a bun compile target (default: the host), and a release tag: prefixed to the build id, printed by `eris --version` and compared by the release `eris update` (an untagged build reports `dev`). |

   `eris --version` and `eris update` are core's: a distribution gets both. Core's `eris update`
   only prints the npm commands for this package. A distribution that publishes compiled
   binaries composes the in-place verb, `RELEASE_UPDATE` from `eris/sdk`, in its place:

   ```ts
   composeCli({ ...REGISTRY, update: RELEASE_UPDATE.row }, { ...HANDLERS, update: RELEASE_UPDATE.handler }, plugins)
   ```

   Its binary then updates from its own `releaseRepo`, never from this repository's
   releases ([UPDATE.md](../UPDATE.md#the-release-eris-update-distributions)). To be updatable
   it publishes each release in the shape [RELEASING.md](RELEASING.md#a-distributions-releases)
   describes. The example distribution does this.

5. **Test** by driving `main(argv, env, { cli })` with the distribution's
   composition, and by running the binary `build()` writes
   ([below](#testing-a-distribution)).

### Starting without node_modules

When a package a verb needs is not installed, core ends the command with the
`eris-deps-not-installed` block, naming the distribution's `installRoot` in its
`fix:` line. The SDK does not export that renderer (`missingDependencyBlock`): an
export would sit in `eris/sdk`, which cannot load when `eris` itself is the missing
package, the one case a distribution's entry must handle before it has loaded
anything. Such an entry loads its composition with a dynamic `import()`, and writes
the block by hand for a package that import cannot resolve (the grammar is
[OUTPUT-CONTRACT.md](../OUTPUT-CONTRACT.md) §4, the slug's text
[ERRORS.md](../ERRORS.md#eris-deps-not-installed)), leaving every other failure a crash.

### Testing a distribution

Two seams: `main(argv, env, { cli })` with the distribution's composition, which
every command line crosses, and the binary `build()` writes, driven as a
subprocess. A distribution's suites import their helpers from **`eris/sdk/testing`**
rather than copying them:

| Export | Use |
|---|---|
| `createFakeRunner(respond)`, `FakeRunner` | A `Runner` (`eris/sdk`) that records every call in `calls` and answers from `respond`, to inject in place of `nodeRunner`. |
| `buildInChild({ module, outfile, tag?, releaseRepo?, versionExtra?, docsBase? })` | `build()` in a child bun, returning its `BuildResult`. `module` is the absolute path of a file that exports `BUILD`, the distribution's `BuildOptions` (`examples/distribution/build.ts` is one); the rest overrides it. Use it for every test that compiles a binary: a compile in the test process fails on Linux in a later test file ([TESTING.md](TESTING.md#the-binary-oracle)). |

The subpath is for tests. It is a separate module and `eris/sdk` does not export
it, so a binary does not carry it: keep it out of the distribution's own source
(`distribution-imports-sdk-only` refuses it in the example, and this repository's
`runtime-imports-no-testing` rule keeps core and its plugins from importing it).

## Testing a plugin

Compose it in the test and drive `main` with `{ cli }`. This is the seam every
command line crosses. `tests/plugins.test.ts` is the reference: routing, argv
refusal, json, completion, help and locks, all through `main`. Add a
`docs/ERRORS.md` heading for each slug a shipped plugin raises
(`tests/errors-doc.test.ts` harvests `plugins/`).
