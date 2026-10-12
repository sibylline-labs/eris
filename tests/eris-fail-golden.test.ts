/**
 * Golden: every documented slug's failure block, bash vs TS.
 *
 * When the TS failure block (ts/lib/eris-fail.ts `reportFailure`) renders
 * any documented slug differently from the earlier Bash `eris::report` — the
 * grammar consumers line-prefix-parse (docs/OUTPUT-CONTRACT.md §4) — this goes
 * red, naming the slug and variant. The slug set is DERIVED from
 * docs/ERRORS.md's `### <slug>` headings (the slug headings are level 3; `##`
 * is section structure), never hand-listed.
 *
 * The Bash side is FROZEN: eris::report rendered every one of the
 * slugs documented at capture time byte-identically up to the slug and the
 * checkout path, so its output is one template per variant
 * (tests/fixtures/eris-fail/report-templates.json, `<SLUG>` / `<ERIS>`
 * placeholders; provenance in tests/fixtures/eris-fail/README.md). A slug
 * documented after the capture is still checked: the template is a function
 * of the slug, not a list of them.
 */

import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { reportFailure, type ErisFailureInput } from "../ts/lib/eris-fail";

const REPO_ROOT = join(import.meta.dir, "..");

const slugs = readFileSync(join(REPO_ROOT, "docs/ERRORS.md"), "utf8")
  .split("\n")
  .filter((l) => l.startsWith("### "))
  .map((l) => l.slice(4).trim());

const FROZEN = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/eris-fail/report-templates.json"), "utf8")) as {
  slugs_at_capture: number;
  templates: Record<string, string>;
};

/** Each variant is the positional args after <slug>, exactly as bash saw
 *  them — `undefined` means "argument not passed at all". */
type Variant = { name: string; what: string; fix?: string; docs?: string };
const VARIANTS: Variant[] = [
  { name: "no-fix-arg", what: "the thing failed" },
  { name: "multi-line-fix", what: `cannot read "k": 403`, fix: "run this:\n  eris config pull dev\nthen retry" },
  { name: "fix-trailing-newline", what: "w", fix: "a\n\nb\n" },
  { name: "empty-fix-custom-docs", what: "w", fix: "", docs: "docs/REGISTRY.md#configuration" },
  { name: "empty-docs-defaults", what: "w", fix: "one line", docs: "" },
];

/** What eris::report printed for (slug, variant). A variant with no template fails, never skips. */
function bashBlock(slug: string, v: Variant): string {
  const t = FROZEN.templates[v.name];
  if (t === undefined) throw new Error(`no frozen eris::report template for variant ${v.name}`);
  return t.replaceAll("<SLUG>", slug).replaceAll("<ERIS>", REPO_ROOT);
}

describe("docs/ERRORS.md slug golden — eris::report vs reportFailure", () => {
  it("harvests a non-trivial slug set (a regex drift must not pass on zero cases)", () => {
    // docs/ERRORS.md holds the slugs this build raises (39 when this floor was set);
    // tests/errors-doc.test.ts holds every raised slug to a heading.
    expect(slugs.length).toBeGreaterThan(30);
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)+$/);
  });

  it("every variant has its frozen template, and nothing else is frozen", () => {
    expect(Object.keys(FROZEN.templates).sort()).toEqual(VARIANTS.map((v) => v.name).sort());
  });

  it("every slug × variant is byte-identical", () => {
    const mismatches: string[] = [];
    for (const slug of slugs) {
      for (const v of VARIANTS) {
        let out = "";
        const input: ErisFailureInput = { slug, what: v.what, fix: v.fix, docs: v.docs };
        const rc = reportFailure(input, REPO_ROOT, { write: (s: string) => (out += s) });
        if (rc !== 1) mismatches.push(`${slug} [${v.name}]: rc ${rc}`);
        const want = bashBlock(slug, v);
        if (out !== want) mismatches.push(`${slug} [${v.name}]:\n--- bash\n${want}--- ts\n${out}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
