/**
 * src/runtime/home.ts — a compiled binary's asset home, written once per build
 * and shared by every process of that binary.
 *
 * Seam: `materializeHome` as separate processes call it, since the hazard is
 * between processes (the oracle starts many against one binary at once).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_MARKER, materializeHome } from "../src/runtime/home";

const SCRATCH = join(import.meta.dir, "..", ".scratch");
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  mkdirSync(SCRATCH, { recursive: true });
  const d = mkdtempSync(join(SCRATCH, "home-"));
  made.push(d);
  return d;
}

/** Enough files that the eight writers overlap. */
const ASSETS: Record<string, string> = Object.fromEntries(
  Array.from({ length: 200 }, (_, i) => [`patterns/p${i % 7}/rule-${i}.yml`, `id: rule-${i}\n${"x".repeat(2000)}\n`]),
);

describe("materializeHome", () => {
  it("When processes of one build race to write its home, each gets the one complete home and no temp dir survives", async () => {
    /** When a rename lost to a peer is treated as a failure (or its temp dir is left behind), concurrent first runs of one binary die or litter the cache. */
    const base = join(scratch(), "cache");
    const assetsFile = join(base, "..", "assets.json");
    writeFileSync(assetsFile, JSON.stringify(ASSETS));
    const go = join(base, "..", "go");
    // Each child waits for the go file, materializes, then reads every asset back.
    const child = `
      import { existsSync, readFileSync } from "node:fs";
      import { materializeHome } from ${JSON.stringify(join(import.meta.dir, "..", "src/runtime/home.ts"))};
      const [base, assetsFile, go] = process.argv.slice(1);
      const assets = JSON.parse(readFileSync(assetsFile, "utf8"));
      while (!existsSync(go)) await Bun.sleep(1);
      const home = materializeHome(base, "build-1", assets);
      const bad = Object.entries(assets).filter(([rel, text]) => readFileSync(home + "/" + rel, "utf8") !== text).length;
      process.stdout.write(JSON.stringify({ home, bad }));
    `;
    const runs = Array.from({ length: 8 }, () => {
      const p = spawn("bun", ["-e", child, base, assetsFile, go], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      return new Promise<{ code: number | null; out: string; err: string }>((res) => p.on("close", (code) => res({ code, out, err })));
    });
    await Bun.sleep(300);
    writeFileSync(go, "");
    const results = await Promise.all(runs);

    const home = join(base, "build-1");
    expect(results.map((r) => [r.code, r.err])).toEqual(results.map(() => [0, ""]));
    expect(results.map((r) => JSON.parse(r.out))).toEqual(results.map(() => ({ home, bad: 0 })));
    expect(readdirSync(base)).toEqual(["build-1"]);
    expect(readFileSync(join(home, HOME_MARKER), "utf8")).toBe("build-1\n");
  });

  it("When a home exists without its marker, this refuses by name and leaves no temp dir, rather than serving it", () => {
    /** When an incomplete home is accepted, eris runs with missing patterns or docs and reports nothing. */
    const base = scratch();
    mkdirSync(join(base, "build-2", "patterns"), { recursive: true });
    writeFileSync(join(base, "build-2", "patterns", "partial.yml"), "x");
    expect(() => materializeHome(base, "build-2", { "patterns/a.yml": "a" })).toThrow(`${join(base, "build-2")} exists but is not a complete eris asset home`);
    expect(readdirSync(base)).toEqual(["build-2"]);

    // A complete home is used as it stands: nothing is rewritten.
    writeFileSync(join(base, "build-2", HOME_MARKER), "build-2\n");
    expect(materializeHome(base, "build-2", { "patterns/a.yml": "a" })).toBe(join(base, "build-2"));
    expect(existsSync(join(base, "build-2", "patterns", "a.yml"))).toBe(false);
  });
});

describe("materializeHome eviction", () => {
  const HOUR = 3_600_000;
  const OPTS = { keep: 3, graceMs: HOUR };

  /** A home last used `ageMs` ago; `complete: false` leaves the marker out. */
  function home(base: string, name: string, ageMs: number, complete = true): void {
    const dir = join(base, name);
    mkdirSync(join(dir, "patterns"), { recursive: true });
    writeFileSync(join(dir, "patterns", "a.yml"), "a");
    if (complete) writeFileSync(join(dir, HOME_MARKER), `${name}\n`);
    const at = new Date(Date.now() - ageMs);
    if (complete) utimesSync(join(dir, HOME_MARKER), at, at);
    utimesSync(dir, at, at);
  }

  it("When more builds are cached than the cap, this keeps the active build and the most recently used ones, and removes the rest", () => {
    /** When nothing prunes the cache, every build leaves a home behind for good (338 dirs, 426 MB on one host): observed at the cache base's entries after a materialize. */
    const base = scratch();
    for (let i = 1; i <= 6; i++) home(base, `old-${i}`, (10 + i) * HOUR);
    materializeHome(base, "active", { "patterns/a.yml": "a" }, OPTS);
    expect(readdirSync(base).sort()).toEqual(["active", "old-1", "old-2"]);
  });

  it("When a home is recent, incomplete or not a build home, this leaves it alone and counts only complete aged homes against the cap", () => {
    /** When eviction takes a home a concurrent process wrote moments ago or is still writing, that process loses its files mid-run: observed at the entries that survive. */
    const base = scratch();
    home(base, "recent", HOUR / 2);
    home(base, "partial", 50 * HOUR, false);
    for (let i = 1; i <= 4; i++) home(base, `old-${i}`, (10 + i) * HOUR);
    mkdirSync(join(base, "active.tmp-1-ab"));
    writeFileSync(join(base, "stray-file"), "x");
    materializeHome(base, "active", { "patterns/a.yml": "a" }, OPTS);
    expect(readdirSync(base).sort()).toEqual(["active", "active.tmp-1-ab", "old-1", "old-2", "partial", "recent", "stray-file"]);
  });

  it("When the active home already exists, this marks it as just used so a later build's eviction keeps it", () => {
    /** When a build that is still in use ages out by its first write, the next newer builds evict it under a running process: observed at the marker's age and at what survives. */
    const base = scratch();
    home(base, "active", 30 * HOUR);
    for (let i = 1; i <= 4; i++) home(base, `old-${i}`, (10 + i) * HOUR);
    materializeHome(base, "active", {}, OPTS);
    expect(Date.now() - Bun.file(join(base, "active", HOME_MARKER)).lastModified).toBeLessThan(HOUR);
    materializeHome(base, "newer", { "patterns/a.yml": "a" }, { keep: 2, graceMs: 0 });
    expect(readdirSync(base).sort()).toEqual(["active", "newer"]);
  });
});
