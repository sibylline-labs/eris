/**
 * home.ts — the install root: the directory eris reads its own repo files from
 * (the docs a failure block's `docs:` line names). `main.ts` makes it the
 * command's `erisDir`; `erisHome()` (ts/lib/eris-fail.ts) falls back to it.
 *
 * Two ways to run, one answer each:
 *
 *   - From a checkout (the `eris` shim → `bun src/main.ts`): the checkout, two
 *     directories above this file. A distribution run from source is a checkout
 *     of its own: its entry names its root (`runProgram({ installRoot })`,
 *     `adoptSourceRoot`), so the files it reads and the docs its blocks name are
 *     its own, not those of the eris package in its node_modules.
 *   - As a compiled binary (`build()`, src/build.ts): the files ride inside the binary
 *     as the build-generated `eris:assets` module, and are written once per build
 *     to `${ERIS_CACHE_DIR:-${XDG_CACHE_HOME:-~/.cache}/eris}/<build id>/`, which is
 *     the root. The build id is a content hash of the assets and the source, so a
 *     build never reuses another build's files.
 *
 * Only the build defines `__ERIS_BUILD_ID__`, so `typeof` tells the two apart; a
 * plain `bun` run never reaches the `eris:assets` import, which only the build's
 * plugin can resolve.
 *
 * The write is race-safe, because one binary can start many processes at once:
 * a marker file names a finished home; otherwise the files go to a private
 * `<home>.tmp-<pid>-<rand>` beside it, which is renamed into place. A rename
 * that loses to a peer (EEXIST / ENOTEMPTY) removes its own temp dir and uses
 * the winner's. Nothing is ever executed from the home.
 *
 * A cache base eris cannot write is `HomeUnwritableError`, which `main` turns
 * into the `eris-cache-unwritable` block. It does not stop a command line that
 * reads no file from the home (see `readsNoAssets` in main.ts): that one carries
 * on with the home's path, which then names a directory that does not exist.
 */

/// <reference path="./eris-assets.d.ts" />
// The `eris:assets` module `build()` supplies at bundle time: referenced here so a
// program that imports this file (a distribution through eris/sdk) typechecks with
// no `files` entry of its own for the declaration.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

declare const __ERIS_BUILD_ID__: string | undefined;
declare const __ERIS_RELEASE_REPO__: string | undefined;
declare const __ERIS_VERSION__: string | undefined;
declare const __ERIS_VERSION_EXTRA__: string | null | undefined;
declare const __ERIS_DOCS_BASE__: string | undefined;

type Env = Record<string, string | undefined>;

/** The compiled binary's build id; null when running from a checkout. */
export const BUILD_ID: string | null = typeof __ERIS_BUILD_ID__ === "undefined" ? null : __ERIS_BUILD_ID__;

/** The GitHub repository (`owner/name`) this repository's releases are published to. */
export const DEFAULT_RELEASE_REPO = "sibylline-labs/eris";

/** Where this build's own releases are published: the `releaseRepo` its build
 *  was given (src/build.ts), else `DEFAULT_RELEASE_REPO`, a checkout included. */
export const RELEASE_REPO: string = typeof __ERIS_RELEASE_REPO__ === "undefined" ? DEFAULT_RELEASE_REPO : __ERIS_RELEASE_REPO__;

/** The release tag a build was given (`build({ tag })`); `dev` for an untagged build and for a checkout. */
export const VERSION: string = typeof __ERIS_VERSION__ === "string" ? __ERIS_VERSION__ : "dev";

/** The one line a distribution adds to `eris --version` (`build({ versionExtra })`); null when it adds none. */
export const VERSION_EXTRA: string | null = typeof __ERIS_VERSION_EXTRA__ === "string" ? __ERIS_VERSION_EXTRA__ : null;

/** Where a failure block's second `docs:` line points: this repository's public docs. */
export const DEFAULT_DOCS_BASE = "https://github.com/sibylline-labs/eris/blob/main";

/** The URL a repo-relative doc path is appended to in a failure block's second
 *  `docs:` line: the `docsBase` its build was given, else `DEFAULT_DOCS_BASE`. */
export const DOCS_BASE: string = typeof __ERIS_DOCS_BASE__ === "string" ? __ERIS_DOCS_BASE__ : DEFAULT_DOCS_BASE;

/** True inside a binary built by `build()` (src/build.ts). */
export const isCompiled = BUILD_ID !== null;

/** The file whose presence marks a home as completely written. */
export const HOME_MARKER = ".eris-home-complete";

/** The checkout this source file sits in. Meaningless inside a binary. */
export function checkoutRoot(): string {
  return resolve(import.meta.dir, "..", "..");
}

/** `${ERIS_CACHE_DIR:-${XDG_CACHE_HOME:-~/.cache}/eris}` — the parent of every build's home. */
export function cacheBase(env: Env): string {
  if (env.ERIS_CACHE_DIR) return env.ERIS_CACHE_DIR;
  const xdg = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
  return join(xdg, "eris");
}

/** A relative path with no `..`, no empty and no absolute segment. */
function safeRel(rel: string): boolean {
  return rel !== "" && !rel.startsWith("/") && rel.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

const errCode = (e: unknown) => (typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined);

/**
 * `<base>/<buildId>/`, holding `assets` (relative path → text) and the marker.
 * Returns the home. Writes nothing when the marker is already there.
 */
export function materializeHome(base: string, buildId: string, assets: Readonly<Record<string, string>>): string {
  const home = join(base, buildId);
  const marker = join(home, HOME_MARKER);
  if (existsSync(marker)) return home;
  mkdirSync(base, { recursive: true });
  const tmp = `${home}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    for (const [rel, text] of Object.entries(assets)) {
      if (!safeRel(rel)) throw new Error(`eris asset path is not a plain relative path: ${JSON.stringify(rel)}`);
      const file = join(tmp, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    writeFileSync(join(tmp, HOME_MARKER), `${buildId}\n`);
    renameSync(tmp, home);
    return home;
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    const code = errCode(e);
    if (code !== "EEXIST" && code !== "ENOTEMPTY") throw e;
  }
  // A peer renamed its copy into place first.
  if (existsSync(marker)) return home;
  throw new Error(`${home} exists but is not a complete eris asset home (no ${HOME_MARKER}) — remove it and run eris again`);
}

let compiledRoot: string | undefined;
let sourceRoot: string | undefined;

/**
 * A distribution's own root, for a run from source (`runProgram({ installRoot })`,
 * src/main.ts): `installRoot()` answers with it in place of `checkoutRoot()`.
 * A compiled binary ignores it, because its asset home is its root.
 */
export function adoptSourceRoot(dir: string): void {
  if (!isAbsolute(dir)) throw new Error(`installRoot must be an absolute path: ${JSON.stringify(dir)}`);
  sourceRoot = dir;
}

/** The binary's asset home could not be written: the cache base is read-only, full, or not a directory. */
export class HomeUnwritableError extends Error {
  constructor(
    /** The cache base, `${ERIS_CACHE_DIR:-${XDG_CACHE_HOME:-~/.cache}/eris}`. */
    readonly base: string,
    /** Where the home would have been: `<base>/<build id>`. */
    readonly home: string,
    readonly reason: string,
  ) {
    super(`cannot write eris's asset home ${home}: ${reason}`);
  }
}

/**
 * The install root for this process, materializing a binary's home on first
 * call. Throws `HomeUnwritableError` when the home cannot be written.
 */
export async function resolveInstallRoot(env: Env): Promise<string> {
  if (!isCompiled) return sourceRoot ?? checkoutRoot();
  if (compiledRoot === undefined) {
    const { ASSETS } = await import("eris:assets");
    const base = cacheBase(env);
    try {
      compiledRoot = materializeHome(base, BUILD_ID as string, ASSETS);
    } catch (e) {
      throw new HomeUnwritableError(base, join(base, BUILD_ID as string), e instanceof Error ? e.message : String(e));
    }
  }
  return compiledRoot;
}

/**
 * Carry on without a written home: `installRoot()` answers with the path the
 * home would have had, so a block rendered afterwards still names one. For a
 * command line that reads nothing from it, after `resolveInstallRoot` threw.
 */
export function adoptUnwrittenHome(home: string): void {
  compiledRoot = home;
  homeUnwritten = true;
}

let homeUnwritten = false;

/** Whether the install root was adopted without its files being written (`eris-cache-unwritable`). */
export function installRootIsUnwritten(): boolean {
  return homeUnwritten;
}

/** The install root without materializing: a binary's must already be resolved by `main`. */
export function installRoot(): string {
  if (!isCompiled) return sourceRoot ?? checkoutRoot();
  if (compiledRoot === undefined) throw new Error("eris install root read before main() resolved it");
  return compiledRoot;
}
