# Releasing eris

A release is a tag. Pushing `vMAJOR.MINOR.PATCH` (or `vMAJOR.MINOR.PATCH-prerelease`)
runs `.github/workflows/release.yml`, which builds a binary for each platform,
tests it, and publishes it. Everything that installs or updates eris reads the
result: `install.sh`, `eris update` ([UPDATE.md](../UPDATE.md)) and the Homebrew
formula. The same run publishes the npm package, `@sibylline-labs/eris`
([below](#the-npm-package)).

## The release's shape

A release carries exactly these assets, and the readers above depend on the names:

| Asset | What it is |
|---|---|
| `eris-linux-x64` | The compiled binary for Linux on x86-64, built on a Linux runner |
| `eris-darwin-arm64` | The compiled binary for macOS on Apple Silicon, built on a macOS runner |
| `SHA256SUMS` | One `<sha256>  <asset name>` line per binary, as `sha256sum` writes it |

The tag is the binary's version: the workflow builds with
`bun scripts/build.ts --tag <tag>`, so `eris --version` prints it. The workflow
refuses a binary that does not report its tag, and `eris update` refuses to keep
one that does not.

## Cutting a release

```bash
git tag v0.2.0 && git push origin v0.2.0
```

A tag is `vMAJOR.MINOR.PATCH[-prerelease]`: numbers of at most nine digits, and
dot-separated prerelease identifiers that are not empty (`RELEASE_TAG` in
`src/cli/commands/update/semver.ts`, the grammar `eris update` orders releases by).
The release job refuses any other tag before it builds.

A tag with a hyphen (`v0.3.0-rc.1`) is a pre-release. GitHub's "latest release"
skips pre-releases, so `install.sh`, `eris update` and the tap ignore it until a
person names it (`ERIS_VERSION=v0.3.0-rc.1 ./install.sh`, `eris update --to
v0.3.0-rc.1`).

To release a ref that is not tagged yet, or to rebuild, dispatch the workflow:

```bash
gh workflow run release.yml --ref <branch> -f tag=v0.3.0-rc.1 -f prerelease=true
```

Dispatching over a tag that already exists is refused unless the run builds that
tag's commit (`--ref <tag>`), so binaries from one commit are never published
under a tag that names another.

## What the workflow does

1. **plan** validates the tag against `^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`
   and the existing-tag rule above, and decides pre-release or not.
2. **build**, once per platform on a native runner (a bun compile targets its host):
   `bun scripts/build.ts --tag <tag>`, then the whole suite against the binary
   (`ERIS_BIN=<binary> bun test ./tests`), then a check that `eris --version` starts
   with `eris <tag> (`, then the upload. A red leg publishes nothing.
3. **publish**, the only job with `contents: write`, writes `SHA256SUMS` over both
   binaries and creates the release with all three assets in one step (so "latest"
   never names a release without them). Re-running updates the assets in place.
4. **tap** renders the Homebrew formula and pushes it to the tap repository, for a
   stable release and only when the tap token is set (below).
5. **npm** waits for **build** and **publish** (so a red oracle leg or a failed GitHub
   release publishes no package), stamps the
   tag's version into `package.json`, checks the tarball with `npm publish --dry-run`,
   and publishes it when the npm token is set (below).

No job reads a secret except **tap** (its token) and **npm** (its own), and every action is
pinned to a commit SHA; `tests/workflows.test.ts` holds both, and the permissions.

## The Homebrew tap

The formula template is `packaging/homebrew/eris.rb.tmpl`; the tap job fills it with
`scripts/render-formula.ts` (the tag, and each binary's checksum from the published
`SHA256SUMS`) and commits the result as `Formula/eris.rb`. Users install with:

```bash
brew install <owner>/tap/eris
```

One-time setup for a repository `<owner>/eris`:

1. Create the repository `<owner>/homebrew-tap` (public), with any initial commit.
2. Create a token that can push to that repository and nothing else (a fine-grained
   token with Contents: read and write on `<owner>/homebrew-tap` only).
3. Store it as the secret `TAP_PUSH_TOKEN` of the `eris` repository.

Until the secret exists, the tap job writes a notice and the release is otherwise
unaffected. The tap checkout is the only step that holds the token, and nothing from
this repository runs after it.

To look at a formula without releasing:

```bash
bun scripts/render-formula.ts --tag v0.2.0 --sums SHA256SUMS
```

## The npm package

`@sibylline-labs/eris` is this repository's source, run by bun, not a build: its `bin` is
`bin/eris.ts` and its `exports` name `.ts` files ([ARCHITECTURE.md](../ARCHITECTURE.md#the-packages-bin)).
`files` in `package.json` is the allow-list of what the tarball holds; `tests/package.test.ts`
reads `npm pack --dry-run --json` and fails when an `exports` or `bin` target is missing, when the
suite, CI workflows or scratch data are in, or when `docs/` or the license files are out (a failure
block's `docs:` line names a file under the package root). The version in `package.json` is
`0.0.0` in the repository; the release job stamps the tag's (`v0.3.0` is `0.3.0`) into the
checkout it publishes from, and commits nothing. A pre-release publishes under the `next`
dist-tag, so `npm install @sibylline-labs/eris` never picks it up.

Every pull request runs the `npm-pack` job of `ci.yml`: `npm pack`, `npm publish --dry-run`, then
the tarball installed with `npm install -g` and with `bun add -g` and run from a directory that
holds no checkout (`eris --help`; a cwd `bunfig.toml` preload must not run), and a consumer that
declares the dependency under the key `eris` and imports `eris/sdk`, `eris/yak-contract` and
`eris/yak-redact`. It
reads no secret and publishes nothing.

Setup, once: create a token that can publish `@sibylline-labs/eris` and store it as the
secret `NPM_TOKEN` of the repository. The **npm** job reads it into `env` only to test it (the
`secrets` context is not available to an `if`) and gives it to the last step alone, which writes
it to a file under `$RUNNER_TEMP` and runs `npm publish --ignore-scripts`; no repository code
runs after the token is on disk. Without the secret the job still checks the tarball, then
fails red with a notice: a tag is not re-run on its own, so a release that skipped npm must not
look green. Set the secret and re-run the job.

What an npm install does not have: the `eris-bun-missing` block (bun not on `PATH` is `env`'s
own message, since the shim is not what starts it), a working `eris update` (it runs from source, so
it refuses with `update-not-compiled`, whose `fix:` line names a git checkout), and a tagged
`eris --version` (it prints `dev`, as a checkout does).

## A distribution's releases

A distribution compiled with `build({ releaseRepo: "<owner>/<name>" })` updates itself
from that repository ([UPDATE.md](../UPDATE.md#which-repository)). To be updatable it
publishes, for each release, the same assets under the same names (`eris-<os>-<arch>`
for the platforms it ships, and `SHA256SUMS`), built with `build({ tag })` so each
binary reports its tag. A private repository works with `GH_TOKEN` set, which also
raises the anonymous rate limit.

## Checking a release by hand

```bash
gh release download v0.2.0 --repo <owner>/eris --pattern 'SHA256SUMS' --pattern 'eris-linux-x64'
sha256sum -c --ignore-missing SHA256SUMS      # shasum -a 256 -c on macOS
chmod +x eris-linux-x64 && ./eris-linux-x64 --version
```
