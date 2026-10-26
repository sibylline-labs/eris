/**
 * The npm tarball: what `npm publish` would put on the registry, read from
 * `npm pack --dry-run --json` (the file list npm itself computed, offline).
 *
 * The package is source, run by bun: `exports` and `bin` name .ts files, and
 * the failure blocks a run prints name docs under the package root. So the
 * tarball is judged by what a consumer's install can resolve, not by a
 * hand-kept list of what it ought to hold.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkoutOnly, REPO } from "./helpers/blackbox";
import { erisPaths } from "./helpers/tsconfig-paths";

interface Manifest {
  exports: Record<string, string>;
  bin?: Record<string, string>;
}

const manifest = (): Manifest => JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as Manifest;

/** The tarball's file list, as npm computes it. `--offline` makes any registry read fail instead of hang. */
function packedFiles(): Set<string> {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--offline"], { cwd: REPO, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`npm pack --dry-run exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  const [pack] = JSON.parse(r.stdout) as [{ files: { path: string }[] }];
  return new Set(pack.files.map((f) => f.path));
}

describe.skipIf(checkoutOnly("npm packs the checkout's package.json; a compiled binary has none"))("the npm tarball", () => {
  let packed: Set<string> | undefined;
  const files = () => (packed ??= packedFiles());

  it("holds every file a consumer's install resolves: each exports target, the bin, and the contract's JSON Schema", () => {
    /** When an `exports` or `bin` target (or the yak-contract schema its package exports) is missing from the tarball, `bun add @sibylline-labs/eris` installs a package whose `eris/sdk` or `eris/yak-contract` import or `eris` command does not resolve, or whose Yaks wire contract ships without the JSON Schema non-TypeScript consumers validate against. Observed at the file list `npm pack --dry-run --json` computes. */
    const m = manifest();
    const targets = [...Object.values(m.exports), ...Object.values(m.bin ?? {}), "packages/yak-contract/schema/yak-v2.schema.json"].map((t) => t.replace(/^\.\//, ""));
    // Positive controls: the manifest names the command and several targets, so the filter below reads something.
    expect(Object.keys(m.bin ?? {})).toEqual(["eris"]);
    expect(targets.length).toBeGreaterThan(2);
    expect(targets.filter((t) => !files().has(t))).toEqual([]);
  });

  it("holds the license files and the docs a failure block names, and none of the repository's own tooling", () => {
    /** When the tarball carries the suite, the CI workflows or scratch data, every install ships them; when it drops `docs/` or LICENSE/NOTICE, a failure block's `docs:` line names a file that is not there and the Apache terms ride without their notice. Observed at the same npm file list. */
    for (const f of ["LICENSE", "NOTICE", "README.md", "package.json", "docs/ERRORS.md"]) expect(files().has(f)).toBe(true);
    const own = [...files()].filter((f) => /^(tests|scripts|rules|rule-tests|\.github|data|examples|packaging)\//.test(f) || /^(eris|install\.sh|bun\.lock|sgconfig\.yml|CLAUDE\.md|AGENTS\.md)$/.test(f));
    expect(own).toEqual([]);
  });

  it("reports the version the release stamped into package.json, once installed from the tarball", () => {
    /** When the version comes only from a build's baked tag, every npm install reports `eris dev`, and a user cannot say which release they run — observed by packing the real tarball, stamping a version into it as the release job's `npm version` does, and running its `bin`. */
    mkdirSync(join(REPO, ".scratch"), { recursive: true });
    const dir = mkdtempSync(join(REPO, ".scratch", "pack-"));
    try {
      const pack = spawnSync("npm", ["pack", "--ignore-scripts", "--offline", "--pack-destination", dir], { cwd: REPO, encoding: "utf8" });
      expect(pack.status).toBe(0);
      const tgz = join(dir, pack.stdout.trim().split("\n").pop()!);
      expect(spawnSync("tar", ["-xzf", tgz, "-C", dir]).status).toBe(0);
      const installed = join(dir, "package");
      const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as { version: string };
      // PAIRED: unstamped, the package says nothing of a release, so it reports dev.
      expect(pkg.version).toBe("0.0.0");
      // The dependencies an install would have fetched; this test stays offline.
      symlinkSync(join(REPO, "node_modules"), join(installed, "node_modules"));
      const version = () => spawnSync("bun", [join(installed, "bin", "eris.ts"), "--version"], { cwd: dir, encoding: "utf8" });
      expect(version().stdout).toBe("eris dev (sibylline-labs/eris)\n");
      writeFileSync(join(installed, "package.json"), JSON.stringify({ ...pkg, version: "1.2.3" }));
      expect({ status: version().status, stdout: version().stdout }).toEqual({ status: 0, stdout: "eris v1.2.3 (sibylline-labs/eris)\n" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves `eris/<subpath>` in this tree to exactly the files `exports` names, so a test that passes here passes in a dependent repository", () => {
    /** When `exports` gains, moves or drops a subpath and tsconfig `paths` (which stands in for a dependent repository's node_modules/eris here) is not updated with it, a test or example passes against a file the published package does not expose, or the reverse — observed as the two lists differing. */
    const subpaths = Object.entries(manifest().exports).filter(([key]) => key !== ".");
    expect(subpaths.length).toBeGreaterThan(2);
    expect(erisPaths()).toEqual(Object.fromEntries(subpaths.map(([key, target]) => [`eris/${key.slice(2)}`, [target]])));
  });
});
