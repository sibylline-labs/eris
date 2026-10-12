/**
 * build.ts — compile eris into one executable with `Bun.build`.
 *
 *   bun scripts/build.ts [--outfile <path>] [--tag <release tag>]
 *
 * Writes `dist/eris-<os>-<arch>` (gitignored) for the HOST's own target, and
 * prints its path and build id. Each target builds on its own runner.
 *
 * What the binary carries:
 *
 *   - the program, `src/main.ts` and everything it imports, the build's plugins
 *     (plugins/index.ts) included, with every third-party package bundled;
 *   - the repo files eris reads at runtime, as the virtual module `eris:assets`
 *     (relative path → text): every `docs/*.md` the source names (a `docs:` line
 *     or a `fix:` text). `src/runtime/home.ts` writes them to a per-build cache home;
 *   - `__ERIS_BUILD_ID__`: a content hash of those assets and the bundled source,
 *     prefixed by `--tag` when given, so a rebuild with any change gets a new home.
 *
 * The executable never autoloads a `.env` or `bunfig.toml` from the caller's cwd
 * (both default ON for a bun executable): a service dir's generated `.env` would
 * land in the environment, and a `bunfig.toml` preload would run as eris code.
 * The `eris` shim passes `--no-env-file --config=/dev/null` for the same reason.
 */

import type { BunPlugin } from "bun";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs as parseCliArgs } from "node:util";
import { PLUGINS } from "../plugins";
import { composeCli } from "../src/cli/compose";
import { REGISTRY } from "../src/cli/registry";

const REPO = join(import.meta.dir, "..");

/** The source the bundle is built from: its hash is half the build id. */
const SOURCE_ROOTS = ["src", "ts", "plugins"];
const SOURCE_FILES = ["scripts/build.ts", "package.json", "bun.lock"];

/** A doc the source names: `docs/ERRORS.md#slug`, `docs/YAK.md`, ... */
const DOC_REF = /docs\/[A-Za-z0-9_./-]+\.md/g;

const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Every file under `dir` (repo-relative), sorted. */
function walk(dir: string, keep: (rel: string) => boolean = () => true): string[] {
  return readdirSync(join(REPO, dir))
    .flatMap((e) => {
      const rel = join(dir, e);
      return statSync(join(REPO, rel)).isDirectory() ? walk(rel, keep) : keep(rel) ? [rel] : [];
    })
    .sort();
}

const isSource = (rel: string) => /\.tsx?$/.test(rel);

function sourceFiles(): string[] {
  return [...SOURCE_ROOTS.flatMap((d) => walk(d, isSource)), ...SOURCE_FILES];
}

/** The `docs/*.md` files the bundled source names, each checked to exist. */
export function namedDocs(): string[] {
  const docs = new Set<string>();
  for (const f of sourceFiles().filter(isSource)) {
    for (const m of readFileSync(join(REPO, f), "utf8").matchAll(DOC_REF)) docs.add(m[0]);
  }
  const missing = [...docs].filter((d) => {
    try {
      return !statSync(join(REPO, d)).isFile();
    } catch {
      return true;
    }
  });
  if (missing.length > 0) throw new Error(`the source names docs that do not exist: ${missing.join(", ")}`);
  return [...docs].sort();
}

/** Relative path → text, for every file the binary carries. */
export function collectAssets(): Record<string, string> {
  const files = namedDocs();
  return Object.fromEntries(files.map((f) => [f, readFileSync(join(REPO, f), "utf8")]));
}

/** sha256 over every asset and source file (path, length, bytes), first 16 hex. */
export function buildId(assets: Readonly<Record<string, string>>, tag?: string): string {
  const h = createHash("sha256");
  const add = (rel: string, bytes: Buffer) => {
    h.update(`${rel}\0${bytes.length}\0`);
    h.update(bytes);
  };
  for (const [rel, text] of Object.entries(assets)) add(`asset:${rel}`, Buffer.from(text, "utf8"));
  for (const rel of sourceFiles()) add(`source:${rel}`, readFileSync(join(REPO, rel)));
  const hash = h.digest("hex").slice(0, 16);
  return tag ? `${tag}-${hash}` : hash;
}

function erisPlugin(assets: Readonly<Record<string, string>>): BunPlugin {
  return {
    name: "eris-compile",
    setup(build) {
      build.onResolve({ filter: /^eris:assets$/ }, () => ({ path: "eris:assets", namespace: "eris-assets" }));
      build.onLoad({ filter: /.*/, namespace: "eris-assets" }, () => ({
        contents: `export const ASSETS = ${JSON.stringify(assets)};\n`,
        loader: "js",
      }));
    },
  };
}

export interface BuildResult {
  outfile: string;
  buildId: string;
  assets: number;
}

export async function build(opts: { outfile?: string; tag?: string } = {}): Promise<BuildResult> {
  if (opts.tag !== undefined && !TAG.test(opts.tag)) throw new Error(`--tag must match ${TAG}: ${JSON.stringify(opts.tag)}`);
  // The build's plugin list composes here first, so a refused plugin (a name
  // collision, a non-`ts` row, a group with no handler) fails the build, not the
  // binary's first command (src/cli/compose.ts).
  composeCli(REGISTRY, {}, PLUGINS);
  const assets = collectAssets();
  const id = buildId(assets, opts.tag);
  const outfile = opts.outfile ?? join(REPO, "dist", `eris-${process.platform}-${process.arch}`);
  const result = await Bun.build({
    entrypoints: [join(REPO, "src/main.ts")],
    compile: { outfile, autoloadDotenv: false, autoloadBunfig: false, autoloadTsconfig: false, autoloadPackageJson: false },
    define: { __ERIS_BUILD_ID__: JSON.stringify(id) },
    plugins: [erisPlugin(assets)],
  });
  if (!result.success) {
    throw new Error(`bun build failed:\n${result.logs.map((l) => String(l)).join("\n")}`);
  }
  return { outfile, buildId: id, assets: Object.keys(assets).length };
}

function parseArgs(argv: string[]): { outfile?: string; tag?: string } {
  try {
    const { values } = parseCliArgs({
      args: argv,
      options: { outfile: { type: "string" }, tag: { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
    return { outfile: values.outfile, tag: values.tag };
  } catch (e) {
    throw new Error(`usage: bun scripts/build.ts [--outfile <path>] [--tag <release tag>] (${(e as Error).message})`);
  }
}

if (import.meta.main) {
  try {
    const r = await build(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${relative(process.cwd(), r.outfile) || r.outfile}\n`);
    process.stderr.write(`INFO build ${r.buildId}, ${r.assets} assets\n`);
  } catch (e) {
    process.stderr.write(`ERROR ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
