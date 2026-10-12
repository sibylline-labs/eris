# eris

eris is a small, plugin-composed command-line tool written in TypeScript on
[Bun](https://bun.sh). Core supplies the router, the verb registry, argument
parsing, the output contract (`--output text|json`, slugged failure blocks)
and shell completion; every verb group beyond that is a plugin composed in at
build time.

This build ships one plugin, `eris yak`, which AI coding agents (and people)
use to file observations about their own tooling: a broken command, a
misleading doc, a missing capability. A yak is redacted, given a dedup key and
sent in one bounded request to a Yaks endpoint you configure. It never fails
the task that filed it.

## Install

### From source

You need Bun (the version in `.bun-version`) and git.

```bash
git clone https://github.com/sibylline-labs/eris && cd eris
./install.sh --checkout     # bun install --frozen-lockfile, then a ~/.local/bin/eris wrapper around this checkout
eris --help
```

`./eris` in the checkout works without the wrapper too. To build a standalone
binary instead, run `bun install --frozen-lockfile && bun scripts/build.ts`; it
writes `dist/eris-<os>-<arch>`, which runs without Bun.

### Release binaries

Releases will be published on
[GitHub Releases](https://github.com/sibylline-labs/eris/releases), with
prebuilt binaries for `darwin-arm64` and `linux-x64` and a `SHA256SUMS` file.
Until the first release, build from source as above.

Once a release exists, `install.sh` run from a clone downloads the binary for
your platform, checks it against the release's `SHA256SUMS`, and installs it to
`~/.local/bin/eris`:

```bash
./install.sh                        # the latest release
ERIS_VERSION=<tag> ./install.sh     # a specific release
```

It needs `curl`, plus `shasum` on macOS or `sha256sum` on Linux.

## Quickstart

```bash
eris --help                         # the commands this build composes
source <(eris completion zsh)       # or bash; see docs/COMPLETION.md
eris yak --help
```

### Filing a yak

`eris yak` has no default endpoint. Configure one with environment variables:

```bash
export ERIS_YAKS_URL=https://yaks.example.com     # your Yaks endpoint
export ERIS_YAKS_TOKEN=<bearer token>
```

Or, from a checkout, mint a bearer into `~/.eris/yaks.json` (mode `0600`). The
script prints the entry your endpoint's operator needs to register:

```bash
bun plugins/yak/yak-setup.ts --url https://yaks.example.com
```

Then file reports:

```bash
eris yak issue   --summary "install.sh fails on Alpine" --body "sha256sum is missing from busybox"
eris yak suggest --summary "a --dry-run for completion" --body-file notes.md
eris yak fatal   --summary "eris exits before any verb runs" --body-file - < log.txt
eris yak issue   --summary "…" --body "…" --repro "bun test tests/foo.test.ts" --repo acme/widgets
eris --output json yak issue --summary "…" --body "…"    # one JSON record on stdout
```

A delivered yak prints `recorded: <id>`. A missing URL or token, an
unreachable endpoint or a timeout prints a `WARN` line with its slug and still
exits 0. Only misuse (a missing `--summary`, an over-long field, an unknown
flag) exits 1. [docs/YAK.md](docs/YAK.md) has the full reference.

## Writing a plugin

A plugin is registry rows plus lazily loaded handlers, written against the SDK
in `src/cli/plugin.ts`. Start with [docs/dev/PLUGINS.md](docs/dev/PLUGINS.md)
and copy the worked example in [`examples/plugins/widgets/`](examples/plugins/widgets).
A build's plugin list is `plugins/index.ts`.

## The Yaks wire contract

[`packages/yak-contract`](packages/yak-contract) is `@sibylline-labs/yak-contract`:
the Yaks submission contract v2 as Zod schemas, their inferred TypeScript
types, and the JSON Schema they emit (`schema/yak-v2.schema.json`) for
consumers in other languages. The `eris yak` client in this build still speaks
contract v1 (`plugins/yak/yaks-schema.v1.ts`).

## Documentation

[docs/README.md](docs/README.md) indexes the references: the architecture,
the output contract every command follows, every error slug, and the
developer guides.

## Contributing and security

We do not accept outside contributions; see [CONTRIBUTING.md](CONTRIBUTING.md).
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Licence

Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
