# CLAUDE.md

eris is a TypeScript CLI run under bun. A POSIX `sh` shim (`eris`) execs the router
(`src/main.ts`), which routes every command line. Core supplies the registry, argv parsing, the
output contract and shell completion; verb groups are plugins composed at build time
(`plugins/index.ts`). This build ships one plugin, `plugins/yak/` (`eris yak`, and `eris login` /
`eris logout` for its token), and one workspace package, `packages/yak-contract/` (the Yaks wire
contract v2).

## Commands

```bash
bun install --frozen-lockfile        # deps (needed in a fresh clone or worktree)
./install.sh --checkout              # dev install: deps + a ~/.local/bin/eris wrapper around this checkout
bunx tsc --noEmit                    # typecheck
bun test ./tests                     # the suite
ast-grep scan                        # rules/ over the source, error severity
ast-grep test --skip-snapshot-tests  # the rules' own cases, rule-tests/
shellcheck -s sh -S warning eris install.sh
bun scripts/build.ts                 # compiled binary -> dist/eris-<os>-<arch>
ERIS_BIN=dist/eris-<os>-<arch> bun test ./tests   # the same suite against the binary
bun scripts/scrub-check.ts --history # no private references in the tree or any reachable commit
```

Every one of these is a PR gate: `.github/workflows/ci.yml` runs them all, and CI is the
authority when this list and the workflow disagree. The suite needs `zsh`, `git` and `script`
on PATH (`tests/required-tools.txt`).

## Rules that bite

- **The output contract binds every command** (`docs/OUTPUT-CONTRACT.md`). stdout is payload
  only; every diagnostic goes to stderr; `--output json` is global, and a verb without a JSON
  rendering refuses it. Never add a per-command output-format flag.
- **Failures are slugged.** A failure writes the `ERROR`/`slug: `/`fix: `/`docs: ` block from
  `ts/lib/eris-fail.ts` to stderr. The block is machine-parsed, so its grammar does not change.
  Every slug needs a `### <slug>` heading in `docs/ERRORS.md`; `tests/errors-doc.test.ts`
  enforces it.
- **The registry names every verb.** A handler reads its flags and operands from its row through
  the parser (`readVerbArgs` in core, `readArgs` from the SDK in a plugin), never from argv by
  hand. The `adhoc-argv-parse` rule holds this.
- **A plugin imports core only through the SDK**, `src/cli/plugin.ts`. Its manifest
  (`index.ts`) is data plus lazy handler thunks, because it loads on every command line,
  completion included. The `plugin-imports-sdk-only` and `plugin-manifest-lazy-handlers` rules
  hold this.
- **Read an env var by a computed name only through `readEnv`.** `env[name]` resolves
  `__proto__` and `constructor` to inherited values. The `env-read-own-property` rule holds this.
- **The shell surface is frozen.** New logic goes to TypeScript, never into the shim or
  `install.sh`. `tests/source-is-text.test.ts` ratchets that surface down-only against
  `tests/fixtures/ratchet-baseline.json`: growth fails, and a shrink fails until you lower the
  baseline in the same change.
- **Never background a process to draw UI, and never fan out unbounded.** An orphan holding a
  capture pipe hangs the reader forever. Subprocesses go through `src/runtime/process.ts` with a
  deadline.
- **Every bun eris launches carries `--no-env-file --config=/dev/null`**, so a directory's `.env`
  and `bunfig.toml` never load into eris.
- **This tree is public.** `bun scripts/scrub-check.ts` fails on a private organisation
  reference, internal host, secret-store path, personal email, tracker, register or review
  label, a section of a document this repo does not hold, a commit SHA this repo cannot
  resolve, or a token-shaped literal. Its rules are generic; a maintainer's private names go in
  a denylist file kept outside the repo (`--denylist <file>`). A test fixture that needs a
  token-shaped value assembles it at runtime (`"ghp" + "_…"`), so no literal trips a secret
  scanner.
- **Tests sit at seams and pass the value gate**: each test's leading comment names the failure
  that turns it red and where that failure is observed. Loopback HTTP comes from a real
  `Bun.serve` in the test, never a PATH `curl` fake for code that calls `fetch()`. Scratch
  probes go in the gitignored `data/scratch/`, never `/tmp`.

## Where the depth lives

Read the file for the area you are touching before you change it:

| Topic | File |
|---|---|
| Current-state map | `docs/ARCHITECTURE.md` |
| Annotated source tree | `docs/dev/LAYOUT.md` |
| Setup, the request path, conventions | `docs/dev/DEVELOPMENT.md` |
| The suite, fixtures, the binary oracle | `docs/dev/TESTING.md` |
| Adding a command | `docs/dev/ADDING-A-COMMAND.md` |
| Writing a plugin | `docs/dev/PLUGINS.md` |
| Cutting a release, the tap | `docs/dev/RELEASING.md` |
| Output contract | `docs/OUTPUT-CONTRACT.md` |
| Error slugs | `docs/ERRORS.md` |
| `eris yak` | `docs/YAK.md` |
| `eris --version`, `eris update` | `docs/UPDATE.md` |
