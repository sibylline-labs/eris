# Testing Eris

One suite: `bun test` over `tests/*.test.ts`, run beside `bunx tsc --noEmit`,
`ast-grep scan` and shellcheck ([DEVELOPMENT.md](DEVELOPMENT.md#setup)).

## Running

```bash
bun test ./tests                     # the whole suite
bun test tests/completion.test.ts    # one file
```

- **Do not run as root.** Several tests assert a permission-based refusal.
- **`tests/required-tools.txt` is the tool surface** (`bun`, `zsh`, `git`,
  `script`). `describe.skipIf(!HAVE_X)` reports green when X is absent, so
  `tests/repo-hygiene.test.ts` fails a run missing a listed tool and fails a skip
  guard on an unlisted one. Add a tool there in the commit that adds its guard.

## The binary oracle

```bash
bun scripts/build.ts                                  # dist/eris-<os>-<arch>, host target only
ERIS_BIN=$PWD/dist/eris-darwin-arm64 bun test ./tests # every suite; the black-box ones drive the binary
```

`ERIS_BIN` swaps `ERIS` in `tests/helpers/blackbox.ts` for the compiled binary, and
every binary process in the run shares one asset cache (`.scratch/oracle-cache`), so the
race-safe first-run write is exercised by the suites' own parallelism. A test about the
checkout itself (the shim, a copy of the tree, the shell surface) is guarded by
`checkoutOnly("<reason>")` and skips; a test of the binary's own behaviour by
`binaryOnly("<reason>")` (`tests/compiled-binary.test.ts`). `rg 'checkoutOnly\(' tests` is the
skip list. A black-box test that names the install root (a `docs:` line) asks
`installRoot()`, never `REPO`.

## Kinds of test

| Kind | How | Example |
|---|---|---|
| Black-box CLI | the real `eris` entrypoint as a subprocess, through `tests/helpers/blackbox.ts`: stdout and stderr captured separately, files and modes left on disk, PATH-fake argv | `tests/output-contract.test.ts`, `tests/exit-codes-cli.test.ts` |
| In-process | `main` driven with a composed CLI, the seam every command line crosses | `tests/plugins.test.ts` |
| Handler / engine | a handler or a pure module called with injected deps | `tests/yak.test.ts`, `tests/cli-args.test.ts` |
| Golden | bytes compared to a committed capture, often of the deleted Bash | `tests/eris-fail.test.ts` against `tests/helpers/frozen-oracle.ts` |
| Policy | a scan over the tree | `tests/source-is-text.test.ts` (FREEZE, the banned quadratic idiom), `tests/compile-safe.test.ts`, `tests/errors-doc.test.ts` |

`tests/helpers/frozen-oracle.ts` answers for the earlier Bash implementation from
`tests/fixtures/yaml-parity/oracle-goldens.json`. A call with no recorded answer
throws; it never falls back to a live tool.

## Fakes

- **Network is a loopback fixture**, never a PATH `curl` fake: the TS verbs use
  `fetch()`, which a PATH shim cannot intercept. The sandbox strips the caller's
  Yaks credentials, so a sandboxed `eris yak` never files a real report.
  `tests/helpers/release-fixture.ts` is GitHub's releases API on two real listeners
  (the API, and a second origin standing in for asset storage that the API redirects
  to), recording every request's `Authorization`; `eris update`'s tests drive it, with
  `ERIS_UPDATE_API` pointing at it.
- **External binaries are PATH executables** (`gh`, `uname`, `sysctl` and `brew`
  for `tests/install-sh.test.ts`), never in-process fakes: the system under test
  is a separate process. To test "not installed", hide the real binary
  (`hideReal`, `tests/helpers/blackbox.ts`) and assert it no longer resolves.
- **Real git repos**: `git init -q` in the sandbox, and resolve paths physically
  (macOS `$TMPDIR` is under `/var` → `/private/var`).

## Writing a test

- **Red first.** A regression test fails on the broken code, not merely passes on
  the fixed code.
- **Name the failure mode.** The leading comment says what production failure
  turns it red.
- **Pair every absence assertion with a positive one** about the same output;
  "the secret does not appear" passes when the path never ran.
- **Pin a PATH-dependent branch** instead of inheriting whichever one the machine
  selects.
- **Never hit the network.**

New command? [ADDING-A-COMMAND.md](ADDING-A-COMMAND.md) says where its tests go.
