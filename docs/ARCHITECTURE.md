# Eris architecture

The current-state map: what eris is made of, what calls what, and the constraints any change has to
survive. A claim here that no longer resolves against the tree is a bug in this file; fixing it
belongs to the change that moved the code.

---

## 1. What eris is

Eris is a TypeScript program run by bun, behind a POSIX `sh` shim: a small core (the router, the
verb registry, the output contract, the plugin host and its SDK, shell completion and the top-level
usage) plus the plugins a build composes in. This build's plugin is `eris yak`
([YAK.md](YAK.md)).

- **`eris`** finds bun and execs `src/main.ts`. Nothing else.
- **`bin/eris.ts`** is the same entry for an installed package: the `eris` command that `npm i -g
  @sibylline-labs/eris`, `bun add -g`, `npx` and `bunx` link (`bin` in `package.json`). It starts under bun
  through its shebang and calls `runProgram`.
- **`src/main.ts`** routes every command line.
- **`plugins/index.ts`** lists the plugins this build compiles in.
- **`src/sdk.ts`** is `eris/sdk`, the one module through which another repository reaches core
  (the `exports` map names `eris/sdk/testing`, `eris/yak-contract`, `eris/yak-redact` and `eris/socrates-core` beside it,
  nothing deeper).
  A **distribution** depends on this package, composes core with this build's plugins and its own,
  and compiles its own binary with `build()` ([`dev/PLUGINS.md`](dev/PLUGINS.md#distributions)).
- **`packages/yak-contract`** is the Yaks wire contract v2, a bun workspace package that builds
  standalone. The `exports` map also names it, as `eris/yak-contract`, so a repository pinned to
  this one imports the contract without core.
- **`packages/socrates-core`** is Socrates' living-doc surgery, a bun workspace package exported
  as `eris/socrates-core`. It runs a Linear document write through an injected client (fetch,
  splice, check, write, verify) and imports nothing; its tsconfig carries no Bun or Node types,
  because its consumer is a Cloudflare Worker.

eris installs from npm only (`npx`, `bunx`, `bun add -g @sibylline-labs/eris`); the package's
`bin/eris.ts` is the command. A checkout needs `bun install --frozen-lockfile` and no build step:
`bash <checkout>/eris` and `sh <checkout>/eris` run it as it stands.

`bun scripts/build.ts` also compiles the same program into one executable,
`dist/eris-<os>-<arch>`, through `build()` (`src/build.ts`), the same call a distribution makes
with its own entry. It carries the docs the source names and writes them once per
build to `${ERIS_CACHE_DIR:-${XDG_CACHE_HOME:-~/.cache}/eris}/<build id>/`, its install root
(`src/runtime/home.ts`), so a failure block's `docs:` line names a file that exists.

A binary also knows which build it is, from the same call: `build({ tag })` bakes the version,
the release repository, an optional version line and the docs base of a failure block
(`VERSION` and `identity()`, `src/runtime/home.ts`); a distribution run from source hands the
same identity to `runProgram({ identity })`, and a binary keeps what its build baked. `eris --version`
prints them. Core's `eris update` (`src/cli/commands/update.ts`) prints the npm commands for the
latest release. A distribution that publishes binaries composes `RELEASE_UPDATE`
(`src/cli/commands/update/`) in its place, which replaces the binary with the newest release of
its own repository, after checking it ([`UPDATE.md`](UPDATE.md)). The release is cut by
`.github/workflows/release.yml`, which builds and tests both binaries, publishes them with a
`SHA256SUMS`, and publishes the package to npm
([`dev/RELEASING.md`](dev/RELEASING.md)). The npm package is the source, run by bun: `exports` and
`bin` name `.ts` files, and `files` in `package.json` is the allow-list of what the tarball holds
(`tests/package.test.ts`).

---

## 2. The layers, as built

```
  eris                        POSIX sh shim: unset BUN_CONFIG_VERBOSE_FETCH; exec bun src/main.ts
  bin/eris.ts                 the npm bin: refuse BUN_CONFIG_VERBOSE_FETCH; runProgram()
   └─ src/main.ts             settings fill → route → handler (lazy import) | unknown
       ├─ src/sdk.ts          eris/sdk: what a distribution imports · src/build.ts: build()
       ├─ src/cli/            registry.ts (core's verbs) · compose.ts (core + plugins) · plugin.ts
       │                      (the SDK) · router.ts · args.ts (argv + the global --output pre-pass)
       │                      · output.ts (the json allow-list) · ts-verb.ts
       ├─ src/cli/commands/   completion/ · usage.ts · version.ts · update.ts + update/
       ├─ src/runtime/        logging · process · settings · env · home
       ├─ ts/lib/eris-fail.ts the failure block
       └─ plugins/            index.ts (the build's list) · yak/
```

### The shim

`eris` is POSIX `sh` because consumers run it as `bash eris`, `sh eris` and `exec <repo>/eris`. It:

- removes `BUN_CONFIG_VERBOSE_FETCH` before bun starts. Under it bun prints every fetch, bearer and
  body included, to stderr, and bun reads it from its own environment at fetch time, so
  `delete process.env.X` inside `src/main.ts` cannot turn it off;
- refuses a missing bun with the `eris-bun-missing` failure block, rendered by the shim itself;
- execs `bun --no-env-file --config=/dev/null src/main.ts`, so bun never loads a service
  directory's generated `.env` or runs a cwd `bunfig.toml` preload;
- exports nothing. It hands the router its logical directory through `_ERIS_SHIM_DIR`, which
  `src/main.ts` removes before anything is spawned.

`tests/cli-shim.test.ts` pins each of these.

### The package's bin

`bin/eris.ts` is what an install links as `eris`. It has no shell to run, so its shebang,
`#!/usr/bin/env -S bun --no-env-file --config=/dev/null`, does what the shim's `exec` does: bun never
reads the caller's cwd `.env` or `bunfig.toml` preload. A bare `#!/usr/bin/env bun` does neither, so
`npx eris` run in a service directory would load that directory's `.env` and run its preload.
`env -S` splits the flags out of the one shebang line (GNU coreutils 8.30 and newer, macOS).

The bin does not remove `BUN_CONFIG_VERBOSE_FETCH`; it refuses to run under it, with the
`eris-verbose-fetch-set` failure block, before it imports the program. With bun absent the operating
system's own `env: bun: No such file or directory` is the diagnostic; there is no `eris-bun-missing`
block, because nothing of eris has started to print one. The install root is the package directory,
whatever symlink the install put the bin behind. `tests/bin.test.ts` pins each of these.

### The router

`src/cli/registry.ts` `REGISTRY` has a row per group, sub and nested sub: `impl` (`ts`; a sub
inherits its group's), long flags with value arity, `json`, and a summary. From it
are derived:

- the router table (`src/cli/router.ts`, `deriveTable`): every group, empty argv, `-h`, `--help`,
  and a `"group sub"` key where a sub's impl differs from its group's (the longer key wins);
- the `--output json` allow-list (`src/cli/output.ts`);
- the shell completion tree (`src/cli/commands/completion/emit.ts`);
- every TS verb's argv parse (`src/cli/args.ts`): `readVerbArgs` accepts exactly the row's flags
  and `pos` operands, refuses anything else uniformly, and types the handler's args from the row.

The registry those planes read is core's rows composed with the build's plugins
(`src/cli/compose.ts`, over the list in `plugins/index.ts`): a plugin is rows plus lazily loaded
handlers, written against the SDK `src/cli/plugin.ts`, composed at build time, with collisions, a
non-`ts` row and a json group with subs refused, and a group whose product the workspace has not
bought locked per command line. [`dev/PLUGINS.md`](dev/PLUGINS.md).

A `ts` route runs the composed handler for the verb (`HANDLERS` in `src/main.ts`, plus each
plugin's), imported lazily, behind the global `--output` pre-pass. A command line whose verb is not in the table is refused by the router as an unknown
command. Adding or flipping a verb is a registry edit; `tests/cli-registry.test.ts` and
`tests/cli-router.test.ts` hold the rows against `HANDLERS`.

`runTsVerb` (`src/cli/ts-verb.ts`) turns a package that cannot be resolved into the
`eris-deps-not-installed` block, read from the error's `code` and `specifier`. Nothing on the path
`src/main.ts` → `src/cli/ts-verb.ts` → `src/cli/output.ts` may import a third-party package, or that
block cannot be reached.

The top-level usage (`src/cli/commands/usage.ts`) is a `HANDLERS` row too: bare `eris`, `-h` and
`--help` all print it. `--version` is the fourth argv shape (`ARGV_SHAPES`, `src/cli/registry.ts`):
it is not a verb, but it renders JSON under `--output` and reads no file from the install root.

---

## 3. Dependency direction

- **A plugin imports the SDK and nothing else of core.** `src/cli/plugin.ts` is the one core module
  under `plugins/` may import (`plugin-imports-sdk-only`, in `rules/`).
- **A distribution imports `eris/sdk` and nothing else of core.** The `exports` map refuses a
  deeper path; `distribution-imports-sdk-only` holds the example distribution to it. Its suites
  may also import `eris/sdk/testing` (`testing/`), which no source the binary bundles imports
  (`runtime-imports-no-testing`). `eris/yak-contract` is not core: it is the workspace package
  `packages/yak-contract`, which imports nothing of core (`tests/yak-contract-v2.test.ts`).
  `eris/yak-redact` is `plugins/yak/yak-redact.ts`, the client's redaction pass, so a server that
  redacts a submission runs the client's rules; it imports nothing (`tests/distribution.test.ts`).
  `eris/socrates-core` is the workspace package `packages/socrates-core`, which imports nothing
  (`bunx tsc --noEmit -p packages/socrates-core`, a CI step).
- **Completion imports the registry and nothing else.** `source <(eris completion bash)` runs on
  every shell start, so a broken source file elsewhere must not break a login shell.
  `tests/completion.test.ts` corrupts every other verb and every plugin's handler code in a copied
  tree and asserts byte-identical emission. Plugin rows reach completion through their manifests,
  which import nothing but the SDK (`plugin-manifest-lazy-handlers`); `tests/plugins.test.ts`
  composes a plugin whose handler module throws on evaluation and completes past it.
- **Only `src/runtime/process.ts` spawns.** Argv arrays only, an explicit
  timeout, and the whole tree killed on expiry.

---

## 4. Constraints

**C1 — `bash <checkout>/eris` runs from a git checkout with no build step**, with bun at
`.bun-version` and `bun install --frozen-lockfile`.

**C2 — the output contract and the error slugs are stable.** The failure block
(`ts/lib/eris-fail.ts`, one `### <slug>` heading per slug in [`ERRORS.md`](ERRORS.md),
harvested by `tests/errors-doc.test.ts`); exit `1` = failure and `2` = idempotent no-op; stdout
carries the payload and nothing else. Stated in [`OUTPUT-CONTRACT.md`](OUTPUT-CONTRACT.md) and pinned
by `tests/output-contract.test.ts`.

**C3 — `eris completion` emits without loading any other verb**, and its output is
byte-deterministic for a given composed registry. A row's completion domain is data on the row:
its helper text is checked at composition (`src/cli/commands/completion/domain.ts`) so sourcing
the script runs nothing and no helper can swallow core's text.

**C4 — the shell only shrinks.** The shim is frozen as one total (`.sh` files,
code lines, function definitions) by `tests/source-is-text.test.ts` against
`tests/fixtures/ratchet-baseline.json` `FREEZE`. Growth fails; a shrink fails until the baseline is
lowered in the same change, so freed room is never re-spent. The same file bans the quadratic
`${v//pattern/repl}` blank test in that shell. New logic goes to TypeScript.

---

## See also

- [`OUTPUT-CONTRACT.md`](OUTPUT-CONTRACT.md): what eris guarantees to a program.
- [`dev/ADDING-A-COMMAND.md`](dev/ADDING-A-COMMAND.md): adding a verb behind the registry.
- [`dev/PLUGINS.md`](dev/PLUGINS.md): adding a verb group as a build-time plugin.
- [`ERRORS.md`](ERRORS.md): the error-slug catalogue.
