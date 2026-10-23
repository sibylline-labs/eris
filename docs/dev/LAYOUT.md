# Source Layout

The annotated tree of the eris repo. Read the part for the area you are editing.

## Project Structure

```
eris                    # POSIX sh shim: unsets BUN_CONFIG_VERBOSE_FETCH, execs bun src/main.ts
install.sh              # POSIX sh: downloads + verifies the release binary into ~/.local/bin/eris; --checkout: bun install --frozen-lockfile + a wrapper around the checkout
src/                    # The TS program the shim runs
├── main.ts             #   the entry: composes core with the build's plugins (CLI), HANDLERS, main, runProgram
├── sdk.ts              #   `eris/sdk`, the one module through which another repository reaches core (package.json exports):
│                       #   the plugin SDK, composition, runProgram, the runtime, build()
├── build.ts            #   build(): compiles a distribution's entry into one binary (eris:assets, stubs,
│                       #   the build id and release repository); scripts/build.ts calls it for this repo
├── cli/registry.ts     #   core's verbs (subs, flags, impl, json); the derivations
│                       #   (router table, json allow-list) every plane reads
├── cli/compose.ts      #   core rows + plugin rows → table, allow-list, handlers, json fix text;
│                       #   collision and completion-slot refusals; the menu option; entitlement locks
├── cli/plugin.ts       #   the plugin SDK: the one core module a plugin imports
├── cli/router.ts       #   the per-verb route, from the derived table
├── cli/args.ts         #   the registry-driven argv parser and the global --output pre-pass
├── cli/output.ts       #   the --output json allow-list and its refusal block
├── cli/ts-verb.ts      #   runTsVerb: pre-pass → allow-list → lock → handler; eris-deps-not-installed
├── cli/commands/       #   completion.ts + completion/ (emit.ts generates the bash/zsh script from the
│                       #   composed registry; it imports the registry only, because every shell start
│                       #   runs it; domain.ts checks a row's completion domains), usage.ts (the
│                       #   top-level usage: bare eris, -h, --help), version.ts (--version),
│                       #   update.ts + update/ (eris update: github.ts the releases API and the
│                       #   download, replace.ts the staged rename and its restore, semver.ts)
├── hera/               #   Hera CLI, HTTP, and schema primitives (ErisError, HeraCli, HeraHttp, HeraSchema, forEachBounded)
└── runtime/            #   logging, process (the one spawn adapter), settings (~/.eris/settings.json),
                        #   env (readEnv), home (the install root: the checkout, a distribution's own root
                        #   when its entry names one, or a compiled binary's
                        #   per-build asset home)
ts/lib/eris-fail.ts     # the ERROR/slug/fix/docs failure block, and the WARN lines
plugins/index.ts        # the plugins this build compiles in, composed by src/main.ts (docs/dev/PLUGINS.md)
plugins/yak/            # `eris yak` as a plugin: index.ts (the manifest: rows + handler thunk), handlers.ts
                        #   (the dispatcher), yak.ts (the core), yak-{identity,context,redact,submit}.ts,
                        #   yaks-schema.v1.ts (vendored contract), yak-setup.ts (mints the bearer; docs/YAK.md)
packages/yak-contract/  # the Yaks wire contract v2, a bun workspace package that builds standalone;
                        #   `eris/yak-contract` (package.json exports) is its src/index.ts.
                        #   src/v2.ts (Zod + inferred types), scripts/emit-json-schema.ts →
                        #   schema/yak-v2.schema.json (committed; `bun run emit-schema` in the package re-emits)
examples/plugins/widgets/  # the worked plugin example tests/plugins.test.ts composes
examples/distribution/  # the worked distribution: an entry importing eris/sdk alone, a demo plugin with a
                        #   completion domain, a menu, and build.ts; tests/distribution.test.ts builds and runs it
testing/                # `eris/sdk/testing` (package.json exports): the test helpers a distribution's suites
                        #   reuse. fake-runner.ts (createFakeRunner), build-child.ts (buildInChild: build() in a
                        #   child bun, from a module exporting BUILD). Outside src/, so no binary carries it
scripts/build.ts        # `bun scripts/build.ts` → dist/eris-<os>-<arch> (gitignored): this repo's binary,
                        #   through src/build.ts; exports its options as BUILD
scripts/render-formula.ts  # the Homebrew formula for a release, from packaging/homebrew/eris.rb.tmpl
.github/workflows/      # ci.yml (the PR gates) · release.yml (tag → build, oracle, publish, tap)
sgconfig.yml            # the code-quality rules over eris's OWN source (ruleDirs: rules; cases in rule-tests/):
rules/                  #   adhoc-argv-parse (one argv parser), env-read-own-property(-plugin) (env names
rule-tests/             #   are read through readEnv), plugin-manifest-lazy-handlers + plugin-imports-sdk-only
                        #   (the plugin contract), distribution-imports-sdk-only (eris/sdk alone),
                        #   runtime-imports-no-testing (the program never imports testing/)
tests/                  # `bun test ./tests` — the whole suite. helpers/blackbox.ts drives the real
                        #   `./eris` in a physical per-test sandbox (PATH fakes, hideReal); helpers/plugins/
                        #   holds a tripwire plugin; helpers/release-fixture.ts is GitHub's releases API
                        #   on loopback, for eris update
packaging/homebrew/     # eris.rb.tmpl, the formula the release workflow renders into the tap
docs/                   # ARCHITECTURE.md, OUTPUT-CONTRACT.md, ERRORS.md, the verb docs, dev/
```
