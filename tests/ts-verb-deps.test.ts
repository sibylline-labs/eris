/**
 * `missingDependencyBlock` — which thrown values become the "run bun install"
 * block, and which stay crashes. The errors are real ones from bun, produced by
 * importing something that is not there, because the classifier reads their
 * shape (a ResolveMessage is not an Error subclass) and a hand-built fake would
 * only prove the code agrees with itself.
 */

import { describe, expect, it } from "bun:test";
import { missingDependencyBlock } from "../src/cli/ts-verb";

const HOME = "/opt/eris";
const caught = (spec: string): Promise<unknown> => import(spec).then(() => undefined, (e: unknown) => e);

describe("missingDependencyBlock", () => {
  it("names an unresolvable PACKAGE for both import and require, and nothing else", async () => {
    // When a deleted or misspelled SOURCE file is reported as "run bun install" (or a package
    // miss stays a raw crash), this goes red — observed at the one function every TS verb's
    // failure passes through.
    const pkg = "eris-no-such-package-for-this-test";
    let required: unknown;
    try {
      require(pkg);
    } catch (e) {
      required = e;
    }
    for (const err of [await caught(pkg), await caught(`${pkg}/sub/path`), required]) {
      const block = missingDependencyBlock(err, HOME);
      expect(block).toContain("slug: eris-deps-not-installed\n");
      expect(block).toContain(`cannot resolve '${pkg}`);
      expect(block).toContain("fix: from /opt/eris, run: bun install --frozen-lockfile\n");
    }
    const defects = [
      await caught("./no-such-sibling-module"),
      await caught("node:no-such-builtin"),
      new Error("Cannot find package 'yaml' from '/opt/eris/src/config/parse.ts'"),
      new TypeError("x is not a function"),
      "Cannot find package 'yaml'",
      null,
      undefined,
    ];
    for (const err of defects) expect({ err, block: missingDependencyBlock(err, HOME) }).toEqual({ err, block: null });
  });
});
