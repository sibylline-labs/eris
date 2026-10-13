/**
 * update.ts — `eris update [--check] [--to <tag>]`: replace this binary with a
 * release of the repository it was built from (`releaseRepo()`, baked in by
 * `build()`), so a distribution's binary never takes the public one for its own.
 *
 *   1. Refuse, before any request, what cannot be updated in place: a source
 *      checkout, a platform with no release binary, a copy Homebrew owns, a bad
 *      `ERIS_UPDATE_API`, a directory that cannot be written.
 *   2. Ask the releases API for the latest release (or `--to`'s tag). A
 *      prerelease is installed only when named; `--to` may also go backwards.
 *   3. Read the release's `SHA256SUMS`, download this platform's `eris-<os>-<arch>`
 *      into a temp file beside the binary, hash it as it streams, and refuse a
 *      mismatch.
 *   4. Rename it over the binary (keeping `<binary>.old`), run it once
 *      (`--output json --version` must report the release's tag) and restore the
 *      old one if it does not. Success removes `.old`.
 *
 * Exit codes: 0 done or already current; 1 refused (a failure block). With
 * `--check`, 0 current, 10 an update is available, 1 could not tell. The record
 * under `--output json` is `{current, latest, update_available, updated}`.
 *
 * The network and the file work are in ./update/. Everything the verb learns
 * about its surroundings comes from an `UpdateHost`, so a test runs the real
 * thing against a loopback server and a stand-in binary.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { renderFailureBlock } from "../../../ts/lib/eris-fail";
import type { VerbContext, VerbHandler } from "../../main";
import { isCompiled, releaseRepo, VERSION } from "../../runtime/home";
import { readEnv } from "../../runtime/env";
import { info, ok } from "../../runtime/logging";
import { nodeRunner, type Runner } from "../../runtime/process";
import { readVerbArgs, usageLine } from "../args";
import { sanitizeDisplay } from "../output";
import { GitHub, MAX_BINARY_BYTES, notFound, parseApiBase, sendsToken, TAG } from "./update/github";
import { checkWritable, discard, forgetOld, oldPath, onInterrupt, replace, restore, stage } from "./update/replace";
import { Refusal } from "./update/refusal";
import { compareVersions } from "./update/semver";

export { allowedRedirect, parseApiBase } from "./update/github";
export { compareVersions } from "./update/semver";

const USAGE = `Usage: eris update [--check] [--to <tag>]

Replace this eris binary with a release of the repository it was built from.
With no flag, install the latest release when it is newer than this build.

Flags:
  --check       Say whether an update is available and change nothing.
                Exit 0: up to date. Exit 10: an update is available.
                Exit 1: could not tell.
  --to <tag>    Install that release instead, a prerelease or an older one
                included.
  --help, -h    Print this usage text

The binary is checked against the release's SHA256SUMS, run once before the old
one is dropped, and the old one is put back if the new one does not answer.
A source checkout and a copy Homebrew installed are refused: update those with
git pull or brew upgrade eris.

Environment:
  GH_TOKEN, GITHUB_TOKEN   A GitHub token (GH_TOKEN first). Needed for a private
                           repository; raises the anonymous rate limit. Sent to
                           api.github.com only (or a loopback test server),
                           never to the download host.
  ERIS_UPDATE_API          Another API base, for a GitHub Enterprise host or a
                           test server: https, or http on a loopback host. A
                           host other than api.github.com or loopback is sent
                           no token.

--output json prints {current, latest, update_available, updated}.
Refusals are explained in docs/ERRORS.md.
`;

/** The platforms releases publish a binary for. */
const SUPPORTED = new Set(["darwin-arm64", "linux-x64"]);

/** Where Homebrew keeps the files it owns under its default prefixes; a keg under any other prefix is found by its path (`brewManaged`). */
const BREW_CELLARS = ["/opt/homebrew/Cellar/", "/usr/local/Cellar/", "/home/linuxbrew/.linuxbrew/Cellar/"] as const;

/** How long the new binary has to answer `--version`. */
const SMOKE_TIMEOUT_MS = 20_000;

export interface UpdateHost {
  /** Whether this is a binary `build()` compiled, as opposed to a source checkout. */
  readonly compiled: boolean;
  /** The running binary's path. */
  readonly execPath: string;
  readonly platform: string;
  readonly arch: string;
  /** This build's tag (`dev` when it has none). */
  readonly version: string;
  /** `owner/name` of the repository its releases are published to. */
  readonly releaseRepo: string;
  /** Path prefixes under which Homebrew owns a file. */
  readonly cellars: readonly string[];
  /** Runs the new binary. */
  readonly runner: Runner;
  /** How long the API may stay silent, in ms. */
  readonly apiTimeoutMs: number;
  /** How long a download may stay silent between two chunks, in ms. */
  readonly downloadTimeoutMs: number;
}

/** This process. */
export function defaultHost(): UpdateHost {
  return {
    compiled: isCompiled,
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    version: VERSION,
    releaseRepo: releaseRepo(),
    cellars: BREW_CELLARS,
    runner: nodeRunner,
    apiTimeoutMs: 30_000,
    downloadTimeoutMs: 60_000,
  };
}

/** A keg: `<prefix>/Cellar/<formula>/<version>/`, wherever the prefix is (HOMEBREW_PREFIX may be anywhere). */
const KEG = /\/Cellar\/[^/]+\/[^/]+\//;

/** Whether `realPath` (symlinks resolved) is a file Homebrew installed: under a known cellar, or in a keg under any prefix. */
export function brewManaged(realPath: string, cellars: readonly string[]): boolean {
  return KEG.test(realPath) || cellars.some((cellar) => realPath.startsWith(cellar));
}

/** The checksum SHA256SUMS lists for `name` (`<hex>  <name>`, or `<hex> *<name>`), lower-case. */
function checksumOf(sums: string, name: string): string | undefined {
  for (const line of sums.split("\n")) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+?)\r?$/.exec(line);
    if (m !== null && m[2] === name) return m[1]!.toLowerCase();
  }
  return undefined;
}

/**
 * The token from `GH_TOKEN`, else `GITHUB_TOKEN`: trimmed, and a blank one is skipped.
 * A token holds visible ASCII only; anything else is refused here, by variable name,
 * because a header value with a line break makes `fetch` throw an error that quotes
 * the whole value, and the failure block would print the secret.
 */
function tokenFrom(env: VerbContext["env"]): string | undefined {
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = readEnv(env, name)?.trim();
    if (value === undefined || value === "") continue;
    if (!/^[\x21-\x7e]+$/.test(value)) {
      throw new Refusal({
        slug: "update-token-invalid",
        what: `${name} is not a usable token: it holds a space, a line break or another character a token cannot (its value is not shown)`,
        fix: `set ${name} to the token alone, or unset it`,
      });
    }
    return value;
  }
  return undefined;
}

/** `ERIS_UPDATE_API` as it may be shown: scheme and host only, so a credential in it is never echoed. */
function shownApi(raw: string | undefined): string {
  try {
    const url = new URL(raw ?? "");
    return `${url.protocol}//${url.host}`;
  } catch {
    return "(not a URL)";
  }
}

interface Target {
  readonly path: string;
  readonly api: URL;
  readonly token: string | undefined;
}

/** Everything that can be refused without a request. */
function preflight(host: UpdateHost, ctx: VerbContext, check: boolean): Target {
  if (!host.compiled) {
    throw new Refusal({
      slug: "update-not-compiled",
      what: "this eris runs from a source checkout, which eris update does not replace",
      fix: `update the checkout instead: cd ${sanitizeDisplay(ctx.erisDir)} && git pull && bun install --frozen-lockfile`,
    });
  }
  const platform = `${host.platform}-${host.arch}`;
  if (!SUPPORTED.has(platform)) {
    throw new Refusal({
      slug: "update-unsupported-platform",
      what: `releases carry no eris binary for ${sanitizeDisplay(platform)} (darwin-arm64 and linux-x64 only)`,
      fix: "build eris from source for this platform: see 'From source' in the README",
    });
  }
  let path = host.execPath;
  try {
    path = realpathSync(host.execPath);
  } catch {
    // Keep the path as given; writing beside it fails with its own reason below.
  }
  if (brewManaged(path, host.cellars)) {
    throw new Refusal({ slug: "update-brew-managed", what: `this eris is managed by Homebrew (${sanitizeDisplay(path)})`, fix: "brew upgrade eris" });
  }
  const raw = readEnv(ctx.env, "ERIS_UPDATE_API");
  const api = parseApiBase(raw);
  if (api === null) {
    throw new Refusal({
      slug: "update-api-invalid",
      what: `ERIS_UPDATE_API is not an API base eris will use: ${shownApi(raw)}`,
      fix: "set it to an https URL with no credentials, query or fragment (http only for a loopback host), or unset it to use https://api.github.com",
    });
  }
  // Another host gets no token: the variable may be stray or planted.
  const token = sendsToken(api) ? tokenFrom(ctx.env) : undefined;
  if (!check) checkWritable(path);
  return { path, api, token };
}

/** Why the new binary is not good, or null when it answered with the release's tag. */
async function smoke(host: UpdateHost, path: string, tag: string, env: VerbContext["env"]): Promise<string | null> {
  // The new binary needs no token; it is not handed one.
  const { GH_TOKEN: _gh, GITHUB_TOKEN: _github, ...rest } = env;
  const r = await host.runner.run([path, "--output", "json", "--version"], { timeoutMs: SMOKE_TIMEOUT_MS, env: rest });
  if (r.kind === "spawn-failed") return `it did not start (${sanitizeDisplay(r.errno)})`;
  if (r.kind === "timeout") return `it did not answer within ${SMOKE_TIMEOUT_MS / 1000}s`;
  if (r.kind === "signal") return `it was killed by ${sanitizeDisplay(r.signal)}`;
  if (r.kind === "exit") {
    const said = sanitizeDisplay(r.stderr.toString("utf8").split("\n")[0] ?? "").slice(0, 120);
    return `it exited ${r.code}${said !== "" ? `: ${said}` : ""}`;
  }
  let reported: unknown;
  try {
    reported = (JSON.parse(r.stdout.toString("utf8")) as { version?: unknown }).version;
  } catch {
    return "it did not print a version record";
  }
  if (reported !== tag) return `it reports ${typeof reported === "string" ? sanitizeDisplay(reported).slice(0, 60) : "no version"}, not ${tag}`;
  return null;
}

export interface UpdateRecord {
  current: string;
  latest: string;
  update_available: boolean;
  updated: boolean;
}

async function update(host: UpdateHost, ctx: VerbContext, check: boolean, to: string | undefined): Promise<number> {
  const target = preflight(host, ctx, check);
  const repo = host.releaseRepo;
  const gh = new GitHub({
    base: target.api,
    token: target.token,
    repo,
    userAgent: `eris-update/${host.version}`,
    apiTimeoutMs: host.apiTimeoutMs,
    downloadTimeoutMs: host.downloadTimeoutMs,
  });

  if (!check) info(`checking ${repo} for ${to ?? "the latest release"}`, ctx.stderr);
  const release = await gh.release(to);
  if (release.draft || (release.prerelease && to === undefined)) {
    throw notFound(repo, to ?? release.tag, release.draft ? ` (${release.tag} is a draft)` : ` (${release.tag} is a prerelease; name it with --to)`);
  }
  const order = compareVersions(release.tag, host.version);
  const newer = order === null ? release.tag !== host.version : order > 0;
  const emit = (updated: boolean) => {
    const record: UpdateRecord = { current: host.version, latest: release.tag, update_available: newer, updated };
    if (ctx.format === "json") ctx.stdout.write(`${JSON.stringify(record)}\n`);
  };

  if (check) {
    if (ctx.format !== "json") ctx.stdout.write(newer ? `update available: ${host.version} -> ${release.tag}\n` : `up to date: ${host.version}\n`);
    emit(false);
    return newer ? 10 : 0;
  }
  if (to === undefined ? !newer : release.tag === host.version) {
    ok(`eris ${host.version} is up to date`, ctx.stderr);
    emit(false);
    return 0;
  }

  const name = `eris-${host.platform}-${host.arch}`;
  const missing = (what: string) =>
    new Refusal({ slug: "update-asset-missing", what, fix: `choose another release with eris update --to <tag>: see https://github.com/${repo}/releases` });
  const binary = release.assets.find((a) => a.name === name);
  const sumsAsset = release.assets.find((a) => a.name === "SHA256SUMS");
  if (binary === undefined) throw missing(`${repo}'s release ${release.tag} has no ${name}`);
  if (sumsAsset === undefined) throw missing(`${repo}'s release ${release.tag} has no SHA256SUMS`);

  info(`downloading ${name} ${release.tag}`, ctx.stderr);
  const expected = checksumOf(await gh.downloadText(sumsAsset), name);
  if (expected === undefined) throw missing(`SHA256SUMS in ${repo}'s release ${release.tag} lists no checksum for ${name}`);
  const hash = createHash("sha256");
  // One guard from the first byte staged until the new binary has answered, so
  // no signal lands between two guards with no listener and kills by default:
  // before the rename an interrupt removes the staged file, after it puts the
  // old binary back. (stage() also removes a partial file on its own.)
  let staged: string | undefined;
  let replaced = false;
  const stand = onInterrupt(() => {
    if (replaced) void restore(target.path);
    else if (staged !== undefined) discard(staged);
  });
  let why: string | null;
  try {
    staged = await stage(target.path, (write) =>
      gh.download(binary, MAX_BINARY_BYTES, (chunk) => {
        hash.update(chunk);
        write(chunk);
      }),
    );
    const got = hash.digest("hex");
    if (got !== expected) {
      discard(staged);
      throw new Refusal({
        slug: "update-checksum-mismatch",
        what: `${name} does not match its checksum in SHA256SUMS (expected ${expected}, got ${got})`,
        fix: "nothing was changed\nretry; if it repeats, the release is corrupt or has been tampered with, so do not install it",
      });
    }
    replace(target.path, staged);
    replaced = true;
    why = await smoke(host, target.path, release.tag, ctx.env);
  } finally {
    stand();
  }
  if (why !== null) {
    const stuck = restore(target.path);
    throw new Refusal({
      slug: "update-smoke-failed",
      what: `the new eris ${release.tag} failed its check: ${why}; ${stuck === null ? `the previous eris ${host.version} is restored` : `the previous eris could not be put back (${stuck})`}`,
      fix:
        stuck === null
          ? `the release may be broken: retry later, or install another with eris update --to <tag> (see https://github.com/${repo}/releases)`
          : `put the previous eris back by hand: mv ${oldPath(target.path)} ${target.path}`,
    });
  }
  forgetOld(target.path);
  ok(`updated eris ${host.version} -> ${release.tag} (${target.path})`, ctx.stderr);
  emit(true);
  return 0;
}

/** The verb on a given host. */
export function createUpdateHandler(host: UpdateHost): VerbHandler {
  return async (args, ctx) => {
    const a = readVerbArgs("update", args, ctx, { help: USAGE });
    if (a === null) return 0;
    const to = a.flags["--to"];
    if (to !== undefined && !TAG.test(to)) {
      ctx.stderr.write(`ERROR --to takes a release tag such as v0.2.1, got '${sanitizeDisplay(to)}' (usage: ${usageLine("update")})\n`);
      return 1;
    }
    try {
      return await update(host, ctx, a.flags["--check"], to);
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      ctx.stderr.write(renderFailureBlock(e.input, ctx.erisDir));
      return 1;
    }
  };
}

export const runUpdate: VerbHandler = createUpdateHandler(defaultHost());
