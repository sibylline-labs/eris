# Releasing eris

A release is a tag. Pushing `vMAJOR.MINOR.PATCH` (or `vMAJOR.MINOR.PATCH-prerelease`)
runs `.github/workflows/release.yml`, which builds a binary for each platform,
tests it against the whole suite, publishes it to a GitHub release, and then
publishes the npm package, `@sibylline-labs/eris` ([below](#the-npm-package)).
npm is how eris is installed ([UPDATE.md](../UPDATE.md)); the GitHub release is the
record the npm job waits on, in the shape a distribution's release `eris update`
reads.

## The release's shape

A release carries exactly these assets, and a release `eris update` depends on the names:

| Asset | What it is |
|---|---|
| `eris-linux-x64` | The compiled binary for Linux on x86-64, built on a Linux runner |
| `eris-darwin-arm64` | The compiled binary for macOS on Apple Silicon, built on a macOS runner |
| `SHA256SUMS` | One `<sha256>  <asset name>` line per binary, as `sha256sum` writes it |

The tag is the binary's version: the workflow builds with
`bun scripts/build.ts --tag <tag>`, so `eris --version` prints it. The workflow
refuses a binary that does not report its tag, and a release `eris update` refuses
to keep one that does not.

## Cutting a release

```bash
git tag v0.2.0 && git push origin v0.2.0
```

A tag is `vMAJOR.MINOR.PATCH[-prerelease]`: numbers of at most nine digits, and
dot-separated prerelease identifiers that are not empty (`RELEASE_TAG` in
`src/cli/commands/update/semver.ts`, the grammar a release `eris update` orders releases by).
The release job refuses any other tag before it builds.

A tag with a hyphen (`v0.3.0-rc.1`) is a pre-release. GitHub's "latest release"
skips pre-releases, and npm publishes them under the `next` dist-tag, so
`@sibylline-labs/eris@latest` never resolves to one; name it to run it
(`npx @sibylline-labs/eris@0.3.0-rc.1`).

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
4. **npm** waits for **build** and **publish** (so a red oracle leg or a failed GitHub
   release publishes no package), stamps the
   tag's version into `package.json`, checks the tarball with `npm publish --dry-run`,
   and publishes it through npm trusted publishing (below).

No job reads a secret, no job but **npm** holds `id-token: write`, and every action is
pinned to a commit SHA; `tests/workflows.test.ts` holds all three, and the permissions.

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

The **npm** job holds no npm token. It publishes through
[trusted publishing](https://docs.npmjs.com/trusted-publishers): with `id-token: write`, npm
exchanges the job's GitHub OIDC token for a short-lived publish token, and the registry accepts it
only from the repository and workflow file the package names as its trusted publisher. A trusted
publish also attaches a provenance attestation, with no `--provenance` flag. What it needs, each
held by `tests/workflows.test.ts` or the job itself:

- a GitHub-hosted runner (`ubuntu-latest`): npm refuses the exchange from a self-hosted one;
- Node 24 from `actions/setup-node` (every Node 22 bundles npm 10) and npm 11.5.1 or later, which
  a step checks before publishing, since an older npm fails the exchange as `ENEEDAUTH`;
- no `registry-url` on setup-node and no `.npmrc` token: the publish is `npm publish --access
  public --ignore-scripts` and nothing else;
- `repository.url` in `package.json` naming this repository. npm normalizes
  `https://github.com/sibylline-labs/eris` to `git+https://github.com/sibylline-labs/eris.git`, so
  the manifest holds that form (`tests/package.test.ts`); a fork must change it to publish.

The OIDC token can be minted by any step of the job, so no step runs repository code: every npm
command carries `--ignore-scripts`, and no step runs bun or node.

Setup, once:

1. **Bootstrap publish.** A trusted publisher is configured on a package that exists, so the
   first version goes up by hand, from a clean checkout at a release tag, by a maintainer of the
   `@sibylline-labs` org with 2FA:

   ```bash
   git checkout v0.3.0                       # the tag the release job published to GitHub
   npm version 0.3.0 --no-git-tag-version --ignore-scripts
   npm publish --access public --ignore-scripts
   git checkout package.json
   ```

   That publish is token-authenticated and carries no provenance; every later one comes from the
   release job.
2. **Configure the trusted publisher** at npmjs.com → `@sibylline-labs/eris` → Settings → Trusted
   publishing → GitHub Actions: organization `sibylline-labs`, repository `eris`, workflow
   filename `release.yml`, no environment. Under allowed actions, allow `npm publish`: a
   configuration made after Sep-03-2026 allows only `npm stage publish` by default, and the job
   runs `npm publish`. Every field is case-sensitive and npm checks none of them when you save.
3. **Publish within two days.** A new configuration expires unless a publish through it succeeds
   within two days of its creation. Cut the next tag, or re-run the **npm** job of a release whose
   version is not yet on the registry.
4. **Lock it down.** Once a trusted publish has succeeded, set Settings → Publishing access to
   "Require two-factor authentication and disallow tokens", and revoke any automation token.

A re-run of the job for a version already on the registry says so and passes.

What an npm install does not have: the `eris-bun-missing` block (bun not on `PATH` is `env`'s
own message, since the shim is not what starts it). Its `eris --version` reports the stamped
version as `v<version>` (`src/runtime/home.ts`, `versionOf`), and its `eris update` prints the
npx / bunx / `bun add -g` commands ([UPDATE.md](../UPDATE.md)).

## A distribution's releases

A distribution compiled with `build({ releaseRepo: "<owner>/<name>" })` that composes
`RELEASE_UPDATE` ([PLUGINS.md](PLUGINS.md#distributions)) updates itself from that repository ([UPDATE.md](../UPDATE.md#which-repository)). To be updatable it
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
