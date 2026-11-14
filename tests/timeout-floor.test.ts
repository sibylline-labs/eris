/**
 * Every test file that spawns a process sets a default timeout of at least 60s.
 *
 * bun resets the default timeout for each test file, so a preload, a bunfig
 * key or a shared helper import cannot set it once for the suite (bun's
 * bunfig has no timeout key): each such file calls `setDefaultTimeout`
 * itself. A spawning file without the call inherits bun's 5s default, which a
 * file with several sequential spawns overruns under the whole suite's
 * concurrency while passing alone; this test goes red naming that file.
 */

import { expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FLOOR_MS = 60_000;
const SPAWNS = /Bun\.spawn|spawnSync|\bspawn\(|\bexecFile|helpers\/blackbox/;

// admits: integration — a spawning test file that omits setDefaultTimeout inherits bun's 5s default and flakes under suite concurrency; no type or lint rule sees bun's runtime default, so the source of every test file is read.
it("every spawning test file sets a default timeout of at least 60s", () => {
  const offenders: string[] = [];
  for (const name of readdirSync(import.meta.dir).filter((f) => f.endsWith(".test.ts") && f !== import.meta.file)) {
    const src = readFileSync(join(import.meta.dir, name), "utf8");
    if (!SPAWNS.test(src)) continue;
    const ms = [...src.matchAll(/setDefaultTimeout\(\s*([\d_]+)\s*\)/g)].map((m) => Number(m[1]!.replaceAll("_", "")));
    if (!ms.some((v) => v >= FLOOR_MS)) offenders.push(name);
  }
  expect(offenders).toEqual([]);
});
