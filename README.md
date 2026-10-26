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

eris is published to npm as `@sibylline-labs/eris` and runs on Bun, which must be on
PATH. npm is the only install path:

```bash
npx @sibylline-labs/eris@latest --help      # run the latest release, no install
bunx @sibylline-labs/eris@latest --help     # the same, through bun
bun add -g @sibylline-labs/eris@latest      # install `eris` globally
```

### From source

You need Bun (the version in `.bun-version`) and git.

```bash
git clone https://github.com/sibylline-labs/eris && cd eris
bun install --frozen-lockfile
./eris --help
```

Put the checkout on your `PATH` to run it as `eris`. To build a standalone binary,
run `bun scripts/build.ts`; it writes `dist/eris-<os>-<arch>`, which runs without Bun.

### Version and updates

```bash
eris --version                      # eris v0.3.0 (sibylline-labs/eris)
eris update                         # prints the npx / bunx / bun add -g commands for the latest release
```

`eris update` changes nothing: the package manager that installed eris updates it.
[docs/UPDATE.md](docs/UPDATE.md) has the details.

## Quickstart

```bash
eris --help                         # the commands this build composes
source <(eris completion zsh)       # or bash; see docs/COMPLETION.md
eris yak --help
```

### Filing a yak

Sign in once with a device code. `eris login` shows a code to approve in the
browser and writes the token to `~/.eris/yaks.json` (mode `0600`):

```bash
eris login
```

That signs in to `https://api.sibylline.group`. For another endpoint, pass
`--url`, or configure it with environment variables:

```bash
export ERIS_YAKS_URL=https://yaks.example.com     # your Yaks endpoint
export ERIS_YAKS_TOKEN=<bearer token>
```

Or, for a self-hosted endpoint without device login, mint a bearer into
`~/.eris/yaks.json` from a checkout. The script prints the entry your endpoint's
operator needs to register:

```bash
bun plugins/yak/yak-setup.ts --url https://yaks.example.com
```

Then file reports:

```bash
eris yak issue   --summary "completion fails on Alpine" --body "busybox sh lacks compgen"
eris yak suggest --summary "a --dry-run for completion" --body-file notes.md
eris yak fatal   --summary "eris exits before any verb runs" --body-file - < log.txt
eris yak issue   --summary "…" --body "…" --repro "bun test tests/foo.test.ts" --repo acme/widgets
eris --output json yak issue --summary "…" --body "…"    # one JSON record on stdout
```

A delivered yak prints `recorded: <id>`. A missing URL or token, an
unreachable endpoint or a timeout prints a `WARN` line with its slug and still
exits 0. Only misuse (a missing `--summary`, an over-long field, an unknown
flag) exits 1. [docs/YAK.md](docs/YAK.md) has the full reference.

### Agent skill

[`skills/eris-yaks`](skills/eris-yaks/SKILL.md) is an agent skill that walks a coding agent
through setting up Yaks for its user: running eris, the browser steps to connect Linear and
create a token, a test yak, and the `AGENTS.md` block that teaches later sessions to file. Install
it with the [skills](https://github.com/vercel-labs/skills) CLI:

```bash
npx skills add sibylline-labs/eris --skill eris-yaks
```

## Writing a plugin

A plugin is registry rows plus lazily loaded handlers, written against the SDK
in `src/cli/plugin.ts`. Start with [docs/dev/PLUGINS.md](docs/dev/PLUGINS.md)
and copy the worked example in [`examples/plugins/widgets/`](examples/plugins/widgets).
A build's plugin list is `plugins/index.ts`.

To ship your own binary with plugins of your own, write a distribution: depend
on this repository, import `eris/sdk`, compose, and build with `build()`
([docs/dev/PLUGINS.md#distributions](docs/dev/PLUGINS.md#distributions); the
worked example is [`examples/distribution/`](examples/distribution)).

## The Yaks wire contract

[`packages/yak-contract`](packages/yak-contract) is `@sibylline-labs/yak-contract`:
the Yaks submission contract v2 as Zod schemas, their inferred TypeScript
types, and the JSON Schema they emit (`schema/yak-v2.schema.json`) for
consumers in other languages. A repository that depends on this one (a git
dependency pinned to a merge commit on `main`) imports the TypeScript contract
as `eris/yak-contract`. The `eris yak` client in this build imports it and
posts contract v2 submissions.

The client's redaction pass, [`plugins/yak/yak-redact.ts`](plugins/yak/yak-redact.ts), is
exported as `eris/yak-redact` (`redact`, `redactDeep`), so a server that redacts a submission
before it commits runs the same rules. The module imports nothing.

## Documentation

[docs/README.md](docs/README.md) indexes the references: the architecture,
the output contract every command follows, every error slug, and the
developer guides.

## Contributing and security

We do not accept outside contributions; see [CONTRIBUTING.md](CONTRIBUTING.md).
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Licence

Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
