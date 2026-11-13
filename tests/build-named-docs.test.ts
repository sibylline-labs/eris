/**
 * src/build.ts `namedDocs` — which docs a build carries into `eris:assets`.
 *
 * Seam: `namedDocs` over real source files and doc roots on disk.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { namedDocs } from "../src/build";

const SCRATCH = join(import.meta.dir, "..", "data", "scratch");
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A doc root holding the named docs, and one source file with `source` as its text. */
function fixture(docs: readonly string[], source: string): { sources: { abs: string }[]; roots: string[] } {
  mkdirSync(SCRATCH, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH, "named-docs-"));
  made.push(dir);
  for (const doc of docs) {
    mkdirSync(join(dir, doc, ".."), { recursive: true });
    writeFileSync(join(dir, doc), `# ${doc}\n`);
  }
  const abs = join(dir, "entry.ts");
  writeFileSync(abs, source);
  return { sources: [{ abs }], roots: [dir] };
}

describe("namedDocs", () => {
  it("When a doc is named only in a comment, this does not bundle it; a doc named in code is bundled", () => {
    /** When comment prose pulls a doc into the bundle, internal docs ride in `eris:assets` and every binary writes them into each user's cache: observed at the keys `namedDocs` returns. */
    const { sources, roots } = fixture(
      ["docs/ERRORS.md", "docs/YAK.md", "docs/UPDATE.md", "docs/OUTPUT.md"],
      [
        "/** See docs/UPDATE.md. */",
        "// and docs/OUTPUT.md",
        'export const a = "docs/ERRORS.md#slug"; // docs/OUTPUT.md again',
        "export const b = `docs/YAK.md`;",
        "export const re = /'\\/\\//; /* docs/UPDATE.md */",
      ].join("\n"),
    );
    expect(Object.keys(namedDocs(sources, roots))).toEqual(["docs/ERRORS.md", "docs/YAK.md"]);
  });

  it("When code names a doc under docs/dev, this does not bundle it and does not demand a doc root hold it", () => {
    /** When contributor docs ship in the binary (or a missing one fails the build), internal development docs reach users: observed at the keys `namedDocs` returns and at the absence of a throw. */
    const { sources, roots } = fixture(["docs/ERRORS.md"], 'export const a = ["docs/dev/INVARIANTS.md", "docs/ERRORS.md"];');
    expect(Object.keys(namedDocs(sources, roots))).toEqual(["docs/ERRORS.md"]);
  });
});
