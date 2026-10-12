# Source Layout

The annotated tree of the eris repo. Read the part for the area you are editing.

## Project Structure

```
eris                    # POSIX sh shim: unsets BUN_CONFIG_VERBOSE_FETCH, execs bun src/main.ts
install.sh              # POSIX sh: downloads + verifies the release binary into ~/.local/bin/eris; --checkout: bun install --frozen-lockfile + a wrapper around the checkout
src/                    # The TS program the shim runs
├── main.ts             #   the entry: composes core with the build's plugins (CLI), HANDLERS, main, runProgram
├── cli/registry.ts     #   core's verbs (subs, flags, impl, json); the derivations
│                       #   (router table, json allow-list) every plane reads
├── cli/compose.ts      #   core rows + plugin rows → table, allow-list, handlers, json fix text;
│                       #   collision refusal; entitlement locks
├── cli/plugin.ts       #   the plugin SDK: the one core module a plugin imports
├── cli/router.ts       #   the per-verb route, from the derived table
├── cli/args.ts         #   the registry-driven argv parser and the global --output pre-pass
├── cli/output.ts       #   the --output json allow-list and its refusal block
├── cli/ts-verb.ts      #   runTsVerb: pre-pass → allow-list → lock → handler; eris-deps-not-installed
├── cli/commands/       #   completion.ts + completion/ (emit.ts generates the bash/zsh script from the
│                       #   composed registry; it imports the registry only, because every shell start
│                       #   runs it), usage.ts (the top-level usage: bare eris, -h, --help)
└── runtime/            #   logging, process (the one spawn adapter), settings (~/.eris/settings.json),
                        #   env (readEnv), home (the install root: the checkout, or a compiled binary's
                        #   per-build asset home)
ts/lib/eris-fail.ts     # the ERROR/slug/fix/docs failure block, and the WARN lines
ts/lib/pool.ts          # the bounded-concurrency runner process.ts's runMany uses
plugins/index.ts        # the plugins this build compiles in, composed by src/main.ts (docs/dev/PLUGINS.md)
plugins/yak/            # `eris yak` as a plugin: index.ts (the manifest: rows + handler thunk), handlers.ts
                        #   (the dispatcher), yak.ts (the core), yak-{identity,context,redact,submit}.ts,
                        #   yaks-schema.v1.ts (vendored contract), yak-setup.ts (mints the bearer; docs/YAK.md)
packages/yak-contract/  # the Yaks wire contract v2, a bun workspace package that builds standalone.
                        #   src/v2.ts (Zod + inferred types), scripts/emit-json-schema.ts →
                        #   schema/yak-v2.schema.json (committed; `bun run emit-schema` in the package re-emits)
examples/plugins/widgets/  # the worked plugin example tests/plugins.test.ts composes
scripts/build.ts        # `bun scripts/build.ts` → dist/eris-<os>-<arch> (gitignored): the compiled binary,
                        #   its docs in the virtual `eris:assets` module
sgconfig.yml            # the code-quality rules over eris's OWN source (ruleDirs: rules; cases in rule-tests/):
rules/                  #   adhoc-argv-parse (one argv parser), env-read-own-property(-plugin) (env names
rule-tests/             #   are read through readEnv), plugin-manifest-lazy-handlers + plugin-imports-sdk-only
                        #   (the plugin contract)
tests/                  # `bun test ./tests` — the whole suite. helpers/blackbox.ts drives the real
                        #   `./eris` in a physical per-test sandbox (PATH fakes, hideReal); helpers/plugins/
                        #   holds a tripwire plugin
docs/                   # ARCHITECTURE.md, OUTPUT-CONTRACT.md, ERRORS.md, the verb docs, dev/
```
