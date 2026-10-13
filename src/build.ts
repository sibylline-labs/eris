/**
 * build.ts — compile an eris distribution into one executable with `Bun.build`:
 * this repository's (scripts/build.ts), or another repository's that depends on
 * this package and calls `build` from `eris/sdk` (docs/dev/PLUGINS.md#distributions).
 * It builds for the host unless given a `target`.
 *
 * What the binary carries:
 *
 *   - the program: the distribution's entry and everything it imports, this
 *     package's core included, with every third-party package bundled, except a
 *     specifier a `stubs` entry matches, which bundles as a module that throws if
 *     evaluated. A stub is how a binary leaves out a module it must not carry (a
 *     native library would be extracted to a temp dir and loaded from there).
 *     Marking it `external` does not work: a single-file compile hoists an
 *     external's static import to the top of the bundle, so every verb would fail
 *     at startup without a `node_modules`;
 *   - the files eris reads at runtime, as the virtual module `eris:assets`
 *     (relative path → text): every file under each `assetRoots` entry, and every
 *     `docs/*.md` the bundled source names (a `docs:` line or a `fix:` text), taken
 *     from the first of `docRoots` that has it. `src/runtime/home.ts` writes them
 *     to a per-build cache home;
 *   - `__ERIS_BUILD_ID__`: a content hash of those assets, the release repository
 *     and the source (the distribution's and this package's), prefixed by `tag`
 *     when given, so a rebuild with any change gets a new home;
 *   - `__ERIS_RELEASE_REPO__`: where the build's own releases are published
 *     (`RELEASE_REPO`, src/runtime/home.ts), so one distribution's binary never
 *     takes another's release for its own;
 *   - `__ERIS_VERSION__`: the `tag`, or `dev` for an untagged build (`VERSION`), which
 *     `eris --version` prints and `eris update` compares with the release it finds;
 *   - `__ERIS_VERSION_EXTRA__`: the one line a distribution adds to `eris --version`
 *     (`versionExtra`: the core it was built on, say), or null;
 *   - `__ERIS_DOCS_BASE__`: the URL a failure block's second `docs:` line appends the
 *     doc path to (`docsBase`, `DOCS_BASE`), so a distribution links its own docs.
 *
 * The plugin list is composed here first (src/cli/compose.ts), so a refused plugin
 * fails the build, not the binary's first command.
 *
 * The executable never autoloads a `.env` or `bunfig.toml` from the caller's cwd
 * (both default ON for a bun executable): a service dir's generated `.env` would
 * land in the environment, and a `bunfig.toml` preload would run as eris code.
 * The `eris` shim passes `--no-env-file --config=/dev/null` for the same reason.
 *
 * Build time only: `eris/sdk` loads this module on the first `build()` call, so
 * a binary carries it but never evaluates it.
 */

import type { BunPlugin } from "bun";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { composeCli } from "./cli/compose";
import type { ErisPlugin } from "./cli/plugin";
import { REGISTRY } from "./cli/registry";
import { checkoutRoot, DEFAULT_DOCS_BASE, DEFAULT_RELEASE_REPO, firstDocRoot } from "./runtime/home";

/** This package's root: core's source, and the docs core names. */
const CORE = checkoutRoot();

/** The source a distribution is built from, when it names none. */
const SOURCE_ROOTS = ["src", "ts", "plugins"];
const SOURCE_FILES = ["package.json", "bun.lock", "bun.lockb"];

/** A doc the source names: `docs/ERRORS.md#slug`, `docs/YAK.md`, ... */
const DOC_REF = /docs\/[A-Za-z0-9_./-]+\.md/g;

const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RELEASE_REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
/** One line of printable ASCII, visible at both ends. */
const VERSION_LINE = /^[\x21-\x7e](?:[\x20-\x7e]{0,118}[\x21-\x7e])?$/;
/** An https URL with no query, fragment or space, whose trailing slashes are dropped. */
const DOCS_BASE_URL = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~%/-]*)?$/;

export interface BuildStub {
  /** The specifiers, as the source writes them, that bundle as the stub. */
  readonly match: RegExp;
  /** Said in the stub's error: `<specifier> is not bundled into the compiled eris binary (<reason>)`. */
  readonly reason: string;
}

export interface BuildOptions {
  /** The module that composes the distribution's CLI and calls `runProgram`. */
  readonly entry: string;
  /** The distribution's root; the paths below are relative to it. Default: the
   *  nearest directory at or above the entry's that holds a package.json. */
  readonly root?: string;
  /** The plugins the entry composes after core's rows, composed here before bundling. */
  readonly plugins?: readonly ErisPlugin[];
  /** Files, and directories (every file under them), the binary carries as assets. */
  readonly assetRoots?: readonly string[];
  /** Where each doc the source names is looked for, in order. Default: the root, then this package. */
  readonly docRoots?: readonly string[];
  /** Directories (their .ts/.tsx files) and files hashed into the build id and
   *  scanned for docs. Default: src, ts and plugins where present, the entry,
   *  package.json and the lockfile. This package's own source is always added. */
  readonly sourceRoots?: readonly string[];
  readonly stubs?: readonly BuildStub[];
  /** `owner/name`; this repository's when absent. */
  readonly releaseRepo?: string;
  /** One printable line `eris --version` prints after the version, for a build
   *  that reports more than its tag: the core a distribution was built on. */
  readonly versionExtra?: string;
  /** An https URL (no query or fragment) the doc paths in a failure block's
   *  second `docs:` line are appended to; this repository's public docs when absent. */
  readonly docsBase?: string;
  /** Default: `<root>/dist/eris-<os>-<arch>`, for the target. */
  readonly outfile?: string;
  /** A bun compile target (`bun-linux-x64`); the host's when absent. */
  readonly target?: Bun.Build.CompileTarget;
  /** A release tag: prefixed to the build id and reported by `eris --version`
   *  (an untagged build reports `dev`). */
  readonly tag?: string;
}

export interface BuildResult {
  outfile: string;
  buildId: string;
  assets: number;
  releaseRepo: string;
}

const isSource = (rel: string) => /\.tsx?$/.test(rel);

/** Every file under `base/dir` (base-relative), sorted; dot entries and node_modules skipped. */
function walk(base: string, dir: string, keep: (rel: string) => boolean = () => true): string[] {
  return readdirSync(join(base, dir))
    .filter((e) => !e.startsWith(".") && e !== "node_modules")
    .flatMap((e) => {
      const rel = join(dir, e);
      return statSync(join(base, rel)).isDirectory() ? walk(base, rel, keep) : keep(rel) ? [rel] : [];
    })
    .sort();
}

/** A root-relative path that stays inside the root. */
function inside(root: string, rel: string, what: string): string {
  if (rel === "" || isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) throw new Error(`${what} '${rel}' is not a path inside the root`);
  const abs = join(root, rel);
  if (!existsSync(abs)) throw new Error(`${what} '${rel}' does not exist under ${root}`);
  return abs;
}

/** `rel`'s files: itself, or the files under it (`keep`-filtered). */
function filesOf(root: string, rel: string, what: string, keep?: (rel: string) => boolean): string[] {
  return statSync(inside(root, rel, what)).isDirectory() ? walk(root, rel, keep) : [rel];
}

function nearestPackageRoot(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    if (dirname(dir) === dir) throw new Error(`no package.json at or above ${from}: pass root`);
  }
}

/** The source the build hashes and scans: the distribution's, then this package's, each file once. */
function sourcesOf(root: string, entry: string, given: readonly string[] | undefined): { key: string; abs: string }[] {
  const own = given ?? [...SOURCE_ROOTS.filter((d) => existsSync(join(root, d))), relative(root, entry), ...SOURCE_FILES.filter((f) => existsSync(join(root, f)))];
  const out = new Map<string, string>();
  for (const rel of own) for (const f of filesOf(root, rel, "source root", isSource)) out.set(join(root, f), `source:${f}`);
  for (const rel of [...SOURCE_ROOTS, "package.json"].filter((d) => existsSync(join(CORE, d)))) {
    for (const f of filesOf(CORE, rel, "core source", isSource)) if (!out.has(join(CORE, f))) out.set(join(CORE, f), `core:${f}`);
  }
  return [...out].map(([abs, key]) => ({ key, abs }));
}

/** Each `docs/*.md` the source names, from the first doc root that has it. */
function namedDocs(sources: readonly { abs: string }[], docRoots: readonly string[]): Record<string, string> {
  const named = new Set<string>();
  for (const s of sources) if (isSource(s.abs)) for (const m of readFileSync(s.abs, "utf8").matchAll(DOC_REF)) named.add(m[0]);
  const docs: Record<string, string> = {};
  const missing: string[] = [];
  for (const doc of [...named].sort()) {
    const from = firstDocRoot(docRoots, doc);
    if (from === undefined) missing.push(doc);
    else docs[doc] = readFileSync(join(from, doc), "utf8");
  }
  if (missing.length > 0) throw new Error(`the source names docs that no doc root holds: ${missing.join(", ")}`);
  return docs;
}

function compilePlugin(assets: Readonly<Record<string, string>>, stubs: readonly BuildStub[]): BunPlugin {
  return {
    name: "eris-compile",
    setup(build) {
      build.onResolve({ filter: /^eris:assets$/ }, () => ({ path: "eris:assets", namespace: "eris-assets" }));
      build.onLoad({ filter: /.*/, namespace: "eris-assets" }, () => ({
        contents: `export const ASSETS = ${JSON.stringify(assets)};\n`,
        loader: "js",
      }));
      stubs.forEach((stub, n) => {
        const namespace = `eris-stub-${n}`;
        build.onResolve({ filter: stub.match }, (args) => ({ path: args.path, namespace }));
        build.onLoad({ filter: /.*/, namespace }, (args) => ({
          contents: `throw new Error(${JSON.stringify(`${args.path} is not bundled into the compiled eris binary (${stub.reason})`)});\n`,
          loader: "js",
        }));
      });
    },
  };
}

export async function build(opts: BuildOptions): Promise<BuildResult> {
  if (opts.tag !== undefined && !TAG.test(opts.tag)) throw new Error(`--tag must match ${TAG}: ${JSON.stringify(opts.tag)}`);
  const releaseRepo = opts.releaseRepo ?? DEFAULT_RELEASE_REPO;
  if (!RELEASE_REPO.test(releaseRepo)) throw new Error(`releaseRepo must be owner/name: ${JSON.stringify(releaseRepo)}`);
  const versionExtra = opts.versionExtra ?? null;
  if (versionExtra !== null && !VERSION_LINE.test(versionExtra)) {
    throw new Error(`versionExtra must be one printable line of at most 120 characters: ${JSON.stringify(versionExtra)}`);
  }
  const docsBase = (opts.docsBase ?? DEFAULT_DOCS_BASE).replace(/\/+$/, "");
  if (!DOCS_BASE_URL.test(docsBase)) throw new Error(`docsBase must be an https URL with no query, fragment or space: ${JSON.stringify(opts.docsBase)}`);
  const entry = resolve(opts.entry);
  if (!existsSync(entry) || !statSync(entry).isFile()) throw new Error(`entry ${entry} is not a file`);
  const root = resolve(opts.root ?? nearestPackageRoot(dirname(entry)));
  composeCli(REGISTRY, {}, opts.plugins ?? []);

  const sources = sourcesOf(root, entry, opts.sourceRoots);
  const docRoots = [...new Set((opts.docRoots ?? [root, CORE]).map((d) => resolve(root, d)))];
  const assets: Record<string, string> = {};
  for (const rel of opts.assetRoots ?? []) for (const f of filesOf(root, rel, "asset root")) assets[f] = readFileSync(join(root, f), "utf8");
  for (const [doc, text] of Object.entries(namedDocs(sources, docRoots))) if (!Object.hasOwn(assets, doc)) assets[doc] = text;
  const sorted = Object.fromEntries(Object.keys(assets).sort().map((k) => [k, assets[k]!]));

  const h = createHash("sha256");
  const add = (key: string, bytes: Buffer) => {
    h.update(`${key}\0${bytes.length}\0`);
    h.update(bytes);
  };
  add("release", Buffer.from(releaseRepo, "utf8"));
  add("version-extra", Buffer.from(versionExtra ?? "", "utf8"));
  add("docs-base", Buffer.from(docsBase, "utf8"));
  for (const [rel, text] of Object.entries(sorted)) add(`asset:${rel}`, Buffer.from(text, "utf8"));
  for (const s of sources) add(s.key, readFileSync(s.abs));
  const hash = h.digest("hex").slice(0, 16);
  const buildId = opts.tag ? `${opts.tag}-${hash}` : hash;

  const platform = opts.target !== undefined ? opts.target.replace(/^bun-/, "") : `${process.platform}-${process.arch}`;
  const outfile = resolve(root, opts.outfile ?? join("dist", `eris-${platform}`));
  const result = await Bun.build({
    entrypoints: [entry],
    compile: {
      outfile,
      ...(opts.target !== undefined ? { target: opts.target } : {}),
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
    define: {
      __ERIS_BUILD_ID__: JSON.stringify(buildId),
      __ERIS_RELEASE_REPO__: JSON.stringify(releaseRepo),
      __ERIS_VERSION__: JSON.stringify(opts.tag ?? "dev"),
      __ERIS_VERSION_EXTRA__: JSON.stringify(versionExtra),
      __ERIS_DOCS_BASE__: JSON.stringify(docsBase),
    },
    plugins: [compilePlugin(sorted, opts.stubs ?? [])],
  });
  if (!result.success) {
    throw new Error(`bun build failed:\n${result.logs.map((l) => String(l)).join("\n")}`);
  }
  return { outfile, buildId, assets: Object.keys(sorted).length, releaseRepo };
}
