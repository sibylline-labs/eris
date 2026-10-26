# `eris --version` and `eris update`

eris is an npm package, `@sibylline-labs/eris`, run by [bun](https://bun.sh). npm is
the only way it is installed, so the package manager that installed it is what
updates it. `eris --version` says which build this is. `eris update` prints the
commands that get the latest release.

## Installing

```sh
npx @sibylline-labs/eris@latest <command>      # run the latest release, no install
bunx @sibylline-labs/eris@latest <command>     # the same, through bun
bun add -g @sibylline-labs/eris@latest         # install `eris` globally
```

Every form needs bun on PATH: the package's `eris` command is TypeScript with a bun
shebang (`bin/eris.ts`). A pre-release is published under npm's `next` dist-tag
(`@sibylline-labs/eris@next`), which `latest` never resolves to.

## `eris --version`

```
$ eris --version
eris v0.2.0 (sibylline-labs/eris)
```

The first line is `eris <version> (<release repository>)`. A build that adds a line
of its own (a distribution reporting the core it was built on) prints it next.

`eris --output json --version` prints one record:

```json
{"version":"v0.2.0","release_repo":"sibylline-labs/eris","build_id":"v0.2.0-3f9c1d0a7b2e4c58","extra":null}
```

| Field | Meaning |
|---|---|
| `version` | The tag a compiled build was given (`build({ tag })`); else, for an installed package, `v` and the version the release stamped into its package.json; else `dev` (an untagged build, a source checkout, a git dependency). |
| `release_repo` | The repository the build's releases are published to (the one a distribution's release `eris update` reads). |
| `build_id` | The compiled binary's build id, prefixed by the tag; `null` in a checkout. |
| `extra` | The line a distribution added (`build({ versionExtra })`); `null` when it added none. |

Every field is baked into a compiled binary at build time. A run from source reports
its package's version (or `dev`), a null `build_id`, and the release repository and line its entry handed
`runProgram({ identity })` (core's defaults when it handed none); a binary ignores that
option. `--version` reads no file, so it
answers even when the binary's asset cache cannot be written.

## `eris update`

```
$ eris update
eris v0.3.0. Run the latest release with:
  npx @sibylline-labs/eris@latest <command>
  bunx @sibylline-labs/eris@latest <command>
or install it globally (bun runs it, so bun must be on PATH):
  bun add -g @sibylline-labs/eris@latest
```

It reads nothing, fetches nothing, changes nothing, and exits `0`. It takes no flags.
`eris --output json update` prints `{"current":"v0.3.0","commands":[…]}`: this build's
version and the same three commands, in the same order.

## The release `eris update` (distributions)

A distribution that publishes compiled binaries to GitHub releases composes a second
`eris update` in place of core's: `RELEASE_UPDATE` from `eris/sdk`
([dev/PLUGINS.md](dev/PLUGINS.md#distributions)). It replaces the running binary with
the newest release of the repository it was built from, in place, after checking it.
Everything below describes that verb; core's own build never runs it.

```
eris update [--check] [--to <tag>]
```

| Flag | Meaning |
|---|---|
| none | Install the latest release if it is newer than this build. |
| `--check` | Say whether an update is available and change nothing. |
| `--to <tag>` | Install that release instead: a pre-release, or an older one (a downgrade). |

### Exit codes and output

| Run | Exit | stdout | stderr |
|---|---|---|---|
| update installed | `0` | nothing (`--output json`: the record) | `INFO` progress lines, then `INFO ✓ updated eris v0.2.0 -> v0.2.1 (<path>)` |
| already current | `0` | nothing (`--output json`: the record) | `INFO ✓ eris v0.2.1 is up to date` |
| `--check`, current | `0` | `up to date: v0.2.1` | nothing |
| `--check`, newer exists | `10` | `update available: v0.2.0 -> v0.2.1` | nothing |
| refused, or `--check` could not tell | `1` | nothing | a failure block ([ERRORS.md](ERRORS.md)) |

Exit `10` is not a failure: it is how a script asks "is there something newer?"
(`eris update --check; [ $? -eq 10 ] && eris update`).

`--output json` prints one record on every run that does not fail, `--check` included:

```json
{"current":"v0.2.0","latest":"v0.2.1","update_available":true,"updated":true}
```

`current` is this build's version, `latest` the release the run resolved (the newest,
or the one `--to` named), `update_available` whether that release is newer than this
build, and `updated` whether the binary was replaced. `--to` an older release gives
`update_available: false, updated: true`. Versions are ordered as semver orders them
(`v0.0.10` is after `v0.0.9`, a pre-release before its release); a build whose version
is not one (`dev`) is offered every release.

### What it does

1. **Refuses before any request** what it cannot update in place: a source checkout
   ([`update-not-compiled`](ERRORS.md#update-not-compiled)), a platform with no release
   binary ([`update-unsupported-platform`](ERRORS.md#update-unsupported-platform)), an
   unusable `ERIS_UPDATE_API` ([`update-api-invalid`](ERRORS.md#update-api-invalid)),
   and, unless `--check`, a directory it cannot write
   ([`update-target-unwritable`](ERRORS.md#update-target-unwritable)).
2. **Asks the releases API** of `release_repo` for the latest release, or the tag `--to`
   named. The latest never means a pre-release or a draft.
3. **Reads the release's `SHA256SUMS`**, then downloads this platform's
   `eris-<os>-<arch>` (`darwin-arm64` or `linux-x64`) into a temporary file beside the
   binary, hashing it as it arrives. A mismatch removes the file and changes nothing
   ([`update-checksum-mismatch`](ERRORS.md#update-checksum-mismatch)); a release with no
   checksum for the binary is refused too
   ([`update-asset-missing`](ERRORS.md#update-asset-missing)).
4. **Replaces** the binary with an atomic rename (resolving a symlink to the file it
   names), keeping the old one as `<path>.old`.
5. **Runs the new binary** (`eris --output json --version`) and requires it to report the
   release's tag. If it does not, the old binary is put back from `<path>.old`
   ([`update-smoke-failed`](ERRORS.md#update-smoke-failed)). Otherwise `<path>.old` is removed.

An interrupt (Ctrl-C, `TERM`, a hangup) is safe at every step: during the download it
removes the partial file, and between the rename and the check it puts the old binary
back, then ends by that signal as it would have.

Assets are fetched through the API's asset url with `Accept: application/octet-stream`,
never through a release's `browser_download_url`: for a private repository only the
former answers to a token.

### Tokens and the API host

| Variable | Meaning |
|---|---|
| `GH_TOKEN`, `GITHUB_TOKEN` | A GitHub token, `GH_TOKEN` first; surrounding whitespace is ignored, and a value with a space or line break inside is refused ([`update-token-invalid`](ERRORS.md#update-token-invalid)). Needed to update from a private repository. Anonymous requests share a limit of 60 an hour per address ([`update-rate-limited`](ERRORS.md#update-rate-limited)); a token raises it. |
| `ERIS_UPDATE_API` | Another API base: a GitHub Enterprise host (`https://ghe.example.com/api/v3`) or a test server. `https`, or `http` for `127.0.0.1`, `localhost` and `[::1]` only; no credentials, query or fragment. Default `https://api.github.com`. A base on any host other than `api.github.com` or a loopback host is sent no token, so a private repository on a GitHub Enterprise host cannot be updated from with this variable. |

The token is read only when the API base is `https://api.github.com` or a loopback
host, so a stray or planted `ERIS_UPDATE_API` never receives it. It is sent to that
API host and nowhere else. The asset download redirects to
GitHub's storage host, and the redirect is followed by hand so that hop carries no
`Authorization` header; an asset url on any other host never receives it. The new
binary is run without the token in its environment.

### Which repository

A binary updates from the repository it was built to be released from, so one build
never replaces itself with another's: the repository is fixed by `build({ releaseRepo })`
(default `sibylline-labs/eris`). A run from source reports the one its entry handed
`runProgram({ identity })`, else the default, and refuses to update in place anyway. A distribution that
publishes its own releases must publish them in the same shape
([dev/RELEASING.md](dev/RELEASING.md)).
