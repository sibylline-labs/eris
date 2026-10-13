/**
 * src/cli/registry.ts — the one list of eris verbs.
 *
 * The registry is data; these tests hold it against things that are not the
 * registry: the HANDLERS table and `--help` on every TS row through the real entrypoint. A verb's flags need no
 * test against its parser: the parser reads them from the row
 * (src/cli/args.ts, tests/cli-args.test.ts).
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupOf } from "../src/cli/registry";
import { HANDLERS, implOf, REGISTRY, rowsOfGroup } from "./helpers/build-cli";
import { ERIS, oracleEnv } from "./helpers/blackbox";

const groups = Object.keys(REGISTRY).filter((k) => !k.includes(" "));

describe("registry shape", () => {
  it("every sub row hangs off a row that exists, and every group row says its impl", () => {
    /** When a sub row is added under a group (or parent sub) that has no row, its impl inherits from nothing and completion offers an orphan. */
    for (const path of Object.keys(REGISTRY)) {
      const words = path.split(" ");
      expect({ path, words: words.length <= 3 }).toEqual({ path, words: true });
      if (words.length === 1) {
        expect({ path, impl: REGISTRY[path]!.impl }).toEqual({ path, impl: "ts" });
      } else {
        const parent = words.slice(0, -1).join(" ");
        expect({ path, parent: Object.hasOwn(REGISTRY, parent) }).toEqual({ path, parent: true });
      }
      for (const f of REGISTRY[path]!.flags ?? []) expect({ path, flag: f.name }).toEqual({ path, flag: expect.stringMatching(/^--[a-z][a-z-]*$/) });
    }
    expect(groups).toEqual(expect.arrayContaining(["completion", "yak"]));
  });

  it("a sub row inherits its group's impl, at any depth", () => {
    /** When inheritance breaks, a sub row has no implementation and the router never reaches it. */
    const nested = { w: { impl: "ts", summary: "" }, "w i": { summary: "" }, "w i s": { summary: "" } } as const;
    expect(implOf("completion bash")).toBe("ts");
    expect(implOf("yak issue")).toBe("ts");
    expect(implOf("w i s", nested)).toBe("ts");
    expect(() => implOf("x y", nested)).toThrow("no implementation for 'x y'");
    expect(groupOf("w i s")).toBe("w");
  });
});

describe("HANDLERS", () => {
  it("every group with a row the router runs in TypeScript has a handler", () => {
    /** When a row is flipped to ts without a handler, the verb dies with "no TypeScript handler" instead of running. */
    const tsGroups = groups.filter((g) => rowsOfGroup(g).some((p) => implOf(p) === "ts"));
    expect(tsGroups).toEqual(expect.arrayContaining(["completion", "yak"]));
    for (const g of tsGroups) expect({ g, handler: Object.hasOwn(HANDLERS, g) }).toEqual({ g, handler: true });
  });
});

describe("--help on every TypeScript row", () => {
  it(
    "prints usage on stdout, exits 0 and touches nothing, from a cwd with no eris.yaml and no git repo",
    async () => {
      /** When a sub handler reads its arguments (or the network, the disk) before `--help`, `eris <verb> <sub> --help` fails — or does real work: a verb treats `--help` as an operand, or resolves a config file. */
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "eris-help-cwd-")));
      const home = realpathSync(mkdtempSync(join(tmpdir(), "eris-help-home-")));
      const requests: string[] = [];
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          requests.push(`${req.method} ${new URL(req.url).pathname}`);
          return new Response("{}", { status: 500 });
        },
      });
      const sink = `http://127.0.0.1:${server.port}`;
      const env = {
        PATH: process.env.PATH ?? "",
        HOME: home,
        ERIS_YAKS_URL: sink,
        // bun's own transpiler cache lands under $HOME; off, so HOME measures eris.
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        ...oracleEnv(),
      };
      const argvs = Object.keys(REGISTRY)
        .filter((path) => implOf(path) === "ts")
        .flatMap((path) => ["--help", "-h"].map((flag) => [...path.split(" "), flag]));
      expect(argvs.length).toBeGreaterThanOrEqual(14);
      try {
        const results: { argv: string; rc: number | null; stdout: boolean; stderr: string }[] = [];
        for (let i = 0; i < argvs.length; i += 8) {
          const batch = argvs.slice(i, i + 8).map(async (argv) => {
            const p = Bun.spawn([ERIS, ...argv], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
            const [out, err, rc] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
            return { argv: argv.join(" "), rc, stdout: out.trim() !== "", stderr: err };
          });
          results.push(...(await Promise.all(batch)));
        }
        expect(results.filter((r) => r.rc !== 0 || !r.stdout || r.stderr !== "")).toEqual([]);
        expect(results.length).toBe(argvs.length);
        expect(requests).toEqual([]);
        expect({ home: readdirSync(home), cwd: readdirSync(cwd) }).toEqual({ home: [], cwd: [] });
      } finally {
        server.stop(true);
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
