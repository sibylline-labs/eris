# Developing Eris

How the codebase is put together: the entrypoint, the router, the layers under
it, and the conventions every change follows.

Companion guides: [TESTING.md](TESTING.md) (the `bun test` suite),
[ADDING-A-COMMAND.md](ADDING-A-COMMAND.md) (a new subcommand or group, end to end)
[PLUGINS.md](PLUGINS.md) (a verb group as a build-time plugin) and
[RELEASING.md](RELEASING.md) (cutting a release: the tag, the workflow, the Homebrew tap).

## Setup

```bash
git clone https://github.com/sibylline-labs/eris && cd eris
./install.sh --checkout   # bun install --frozen-lockfile, writes ~/.local/bin/eris
```

A bare `./install.sh` installs the release binary instead (`curl` from the GitHub
releases, a SHA256SUMS check, `~/.local/bin/eris`). For development you want `--checkout`: the
installed `eris` is then a thin `exec` wrapper around the repo copy, so the working
tree is live. There is no build step for the checkout. The gates:

```bash
bunx tsc --noEmit
bun test ./tests
ast-grep scan                          # rules/ over eris's own source
ast-grep test --skip-snapshot-tests    # the rules' own cases, rule-tests/
shellcheck -s sh -S warning eris install.sh
bun scripts/build.ts && ERIS_BIN=dist/eris-<os>-<arch> bun test ./tests
```

The last line is the binary oracle: it compiles the binary and runs the same
suite against it ([TESTING.md](TESTING.md#the-binary-oracle)).

## The entrypoint and the router

- **`eris`** is a POSIX `sh` shim. It finds bun, removes
  `BUN_CONFIG_VERBOSE_FETCH`, and execs `bun --no-env-file --config=/dev/null
  src/main.ts`. Its header lists its invariants.
- **`bin/eris.ts`** is the same entry for an installed package (`bin` in `package.json`): a
  `#!/usr/bin/env -S bun --no-env-file --config=/dev/null` shebang that refuses to run under
  `BUN_CONFIG_VERBOSE_FETCH` and then calls `runProgram`. Run it as `bun bin/eris.ts` or directly
  (`./bin/eris.ts`) to see what an `npx`/`bunx` user sees.
- **`src/cli/registry.ts`** names core's verbs: one `REGISTRY` row per group, sub
  and nested sub, carrying `impl` (`ts`), long flags with value arity, `json`
  (has a machine rendering) and a summary.
  **`src/cli/compose.ts`** merges them with the build's plugins
  (`plugins/index.ts`). The router table, the `--output json` allow-list, the
  shell completion tree and the top-level usage are derived from the composed rows.
- **`src/main.ts`** routes each command line. A `ts` verb runs in-process behind
  the global `--output` pre-pass; its handler is a lazily imported entry in
  `HANDLERS` (core's, or a plugin's). Anything else is refused as an unknown
  command.

## Where things live

| Path | Holds |
|---|---|
| `bin/` | `eris.ts`, the package's `eris` command ([ARCHITECTURE.md](../ARCHITECTURE.md#the-packages-bin)) |
| `src/cli/` | The registry, composition, the plugin SDK, the router, argv parsing, the output allow-list, the TS route |
| `src/cli/commands/` | Core's verbs: `completion` and the top-level usage |
| `src/runtime/` | Logging, the subprocess runner, settings, env reads, the install root |
| `ts/lib/eris-fail.ts` | The failure block and the WARN lines |
| `plugins/` | The plugins this build composes (`plugins/index.ts`): `plugins/yak/` is `eris yak` |
| `packages/` | Bun workspace packages (root `package.json` `workspaces`): `packages/yak-contract/` is the Yaks wire contract v2, which the root `exports` map also names as `eris/yak-contract`. A package imports only itself and what its own manifest declares, and `tests/yak-contract-v2.test.ts` holds that |

## Conventions

**The output contract binds every command** ([OUTPUT-CONTRACT.md](../OUTPUT-CONTRACT.md)).
stdout carries the payload and nothing else; stderr carries every diagnostic;
`--output json` is global and a command with no JSON rendering refuses it
(`output-json-unsupported`). Never add a per-command output-format flag.

**Failures are slugged.** A failure writes the block from `renderFailureBlock`
(`ts/lib/eris-fail.ts`) to stderr and nothing to stdout. Every slug has a heading
in [ERRORS.md](../ERRORS.md); `tests/errors-doc.test.ts` harvests slugs from the
source and fails on one without.

**Argv is read from the row.** A handler reads its flags and operands through the
registry-driven parser (`readVerbArgs` in core, `readArgs` from the SDK in a
plugin), never from argv by hand; the `adhoc-argv-parse` rule holds it.

**Nothing is backgrounded to render progress, and fan-out is bounded.** A leaked
descendant holding a capture pipe makes the reader wait forever. Subprocesses go
through the runner in `src/runtime/process.ts` with a deadline; concurrency is
capped by `ERIS_BATCH_CONCURRENCY` (`ts/lib/pool.ts`).

**Every bun eris launches carries `--no-env-file --config=/dev/null`**, so a
directory's `.env` and `bunfig.toml` never load.
