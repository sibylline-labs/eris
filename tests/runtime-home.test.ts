/**
 * src/runtime/home.ts — a compiled binary's asset home, written once per build
 * and shared by every process of that binary.
 *
 * Seam: `materializeHome` as separate processes call it, since the hazard is
 * between processes (the oracle starts many against one binary at once).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
