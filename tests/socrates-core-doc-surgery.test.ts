/**
 * packages/socrates-core doc surgery: the fetch → splice → check → write → verify pipe
 * a Socrates living-doc write runs through.
 *
 * Seam: the package's public entry, driven through an in-memory `LinearDocPort` that
 * stands where the leased-token Linear client will. Each test names the data loss or
 * wrong write that turns it red, observed as a refusal kind, the body the port
 * ended up holding, or whether `write`/`create` was called at all.
 *
 * Entry identity is deliberately a test-local function: which scheme production
 * uses (readable IDs or content hashes) is not decided by this package.
 */

import { describe, expect, it } from "bun:test";
import {
  applyOps,
  canonicalizeLinear,
  ENTRY_TITLE_MAX_LENGTH,
  ensureDoc,
  parseEntryTitleLine,
  parseTitle,
  renderDecision,
  renderPractice,
  writeDoc,
  type DocParent,
  type EntryIdentity,
  type FetchedDoc,
  type LinearDocPort,
  type SurgeryOp,
  type Title,
} from "../packages/socrates-core/src/index";

/** An entry's own ID is the `ABC-<n>` that opens its title bullet. */
const identity: EntryIdentity = {
  entryId: (block) => /^[-*+] (ABC-\d+)\b/m.exec(block)?.[1] ?? null,
};

const LBD = `# Test - Load-Bearing Decisions

## Current

- ABC-2 Second decision
  - statement two
  - scope: project
- ABC-1 First decision
  - statement one
  - scope: project

## Superseded

(no entries yet)

## Open conflicts

(none)
`;

const REGISTER = `# PRD — Test

Some intro with a bare reference to ABC-9.

| ID | Decision |
| -- | -- |
| \`ABC-101\` | The first decision. |
| \`ABC-102\` | The second decision. |
| \`ABC-103\` | The third decision. |

Closing prose.
`;

const FROZEN = `${LBD}
> **Frozen: 2026-10-01** — project graduated. This document is a historical snapshot.

<!-- socrates-freeze: 2026-10-01 -->
`;

/** An in-memory Linear: one doc body per id. `onFetch` lets a test change the doc between reads. */
function fakePort(docs: Record<string, string>, opts: { onFetch?: (n: number, id: string) => void; storeRewrite?: (body: string) => string } = {}) {
  let fetches = 0;
  const writes: string[] = [];
  const port: LinearDocPort = {
    async fetch(docId) {
      fetches += 1;
      opts.onFetch?.(fetches, docId);
      const body = docs[docId];
      return body === undefined ? null : { id: docId, title: docId, body };
    },
    async write(docId, body) {
      writes.push(body);
      docs[docId] = opts.storeRewrite ? opts.storeRewrite(body) : body;
    },
    async findByTitle() {
      return null;
    },
    async create() {
      throw new Error("not used");
    },
  };
  return { port, writes, docs };
}

describe("applyOps no-shrink", () => {
  it("aborts a splice that would drop an existing entry, before any write", async () => {
    /** When a section replace or prose patch removes a live entry and the write goes ahead anyway, Linear loses that entry for good (it keeps no history the pipe reads); observed as the refusal kind and an untouched port. */
    const { port, writes, docs } = fakePort({ doc: LBD });
    const result = await writeDoc(port, "doc", [{ op: "replace_section", section: "## Current", bodyMd: "- ABC-2 Second decision\n  - statement two" }], identity);
    expect(result).toMatchObject({ ok: false, written: false, refusal: { kind: "shrink", missingIds: ["ABC-1"] } });
    expect(writes).toHaveLength(0);
    expect(docs.doc).toBe(LBD);
  });

  it("aborts a prose patch that would delete a register row", () => {
    /** When a `patch_prose` anchor spans a decision row, the row vanishes from the PRD with no refusal; observed as `missingRowKeys`. */
    const result = applyOps(REGISTER, [{ op: "patch_prose", oldString: "| `ABC-102` | The second decision. |\n", newString: "" }], identity);
    expect(result).toMatchObject({ ok: false, refusal: { kind: "shrink", missingRowKeys: ["ABC-102"] } });
  });

  // admits: algorithmic: when entryIds splits on LINE_BREAK or admits a block carrying U+2028/U+2029, prose prefixes, indented continuations, whitespace-only separators, or title-bullet breaks orphan an entry past no-shrink; runtime block parsing is invisible to tsc and ast-grep.
  it.each(["\u2028", "\u2029"])("aborts a prose patch or section replace whose %j separator orphans an entry's hash or readable ID", async (sep) => {
    /** When `entryIds` splits on `LINE_BREAK` instead of `\n`, or keeps blocks whose lines hold U+2028/U+2029, or `canonicalizeLinear` collapses `  \u2028  ` to blank, `patch_prose` and `replace_section` return `ok: true` and orphan the entry; observed as pre-write `shrink` and zero writes. */
    const hash = "0c43" + "e7d3";
    const hashId: EntryIdentity = { entryId: (b) => /^ {2}- hash: ([0-9a-f]{8})$/m.exec(b)?.[1] ?? null };
    const hashed = `# Test - Load-Bearing Decisions\n\n## Current\n\n- First decision\n  - statement one\n  - hash: ${hash}\n`;
    const { port, writes, docs } = fakePort({ doc: hashed });
    const patched = await writeDoc(port, "doc", [{ op: "patch_prose", oldString: "statement one", newString: `statement one${sep}unindented break` }], hashId);
    expect(patched).toMatchObject({ ok: false, written: false, refusal: { kind: "shrink", missingIds: [hash] } });
    const indented = await writeDoc(port, "doc", [{ op: "patch_prose", oldString: "statement one", newString: `statement one${sep}  - injected` }], hashId);
    expect(indented).toMatchObject({ ok: false, written: false, refusal: { kind: "shrink", missingIds: [hash] } });
    const blankSep = await writeDoc(port, "doc", [{ op: "patch_prose", oldString: "  - statement one", newString: `  ${sep}  \n  - statement one` }], hashId);
    expect(blankSep).toMatchObject({ ok: false, written: false, refusal: { kind: "shrink", missingIds: [hash] } });
    const prefixedPatch = await writeDoc(port, "doc", [{ op: "patch_prose", oldString: "- First decision", newString: `prose${sep}- First decision` }], hashId);
    expect(prefixedPatch).toMatchObject({ ok: false, written: false, refusal: { kind: "shrink", missingIds: [hash] } });
    const replaced = await writeDoc(port, "doc", [{ op: "replace_section", section: "## Current", bodyMd: `- First decision\n  - statement one${sep}unindented break\n  - hash: ${hash}` }], hashId);
    expect(replaced).toMatchObject({ ok: false, written: false, refusal: { kind: "shrink", missingIds: [hash] } });
    const prefixedSection = await writeDoc(port, "doc", [{ op: "replace_section", section: "## Current", bodyMd: `prose${sep}- First decision\n  - statement one\n  - hash: ${hash}` }], hashId);
    expect(prefixedSection).toMatchObject({ ok: false, written: false, refusal: { kind: "shrink", missingIds: [hash] } });
    expect(writes).toHaveLength(0);
    expect(docs.doc).toBe(hashed);

    const readablePort = fakePort({ doc: LBD });
    const readablePrefixed = await writeDoc(readablePort.port, "doc", [{ op: "patch_prose", oldString: "- ABC-1 First decision", newString: `prose${sep}- ABC-1 First decision` }], identity);
    expect(readablePrefixed).toMatchObject({ ok: false, written: false, refusal: { kind: "shrink", missingIds: ["ABC-1"] } });
    const readableSplitTitle = await writeDoc(readablePort.port, "doc", [{ op: "patch_prose", oldString: "First decision", newString: `First${sep}decision` }], identity);
    expect(readableSplitTitle).toMatchObject({ ok: false, written: false, refusal: { kind: "shrink", missingIds: ["ABC-1"] } });
    const readableNested = await writeDoc(readablePort.port, "doc", [{ op: "patch_prose", oldString: "statement one", newString: `statement one${sep}  - injected` }], identity);
    expect(readableNested).toMatchObject({ ok: false, written: false, refusal: { kind: "shrink", missingIds: ["ABC-1"] } });
    const readableBlank = await writeDoc(readablePort.port, "doc", [{ op: "patch_prose", oldString: "  - statement one", newString: `  ${sep}  \n  - statement one` }], identity);
    expect(readableBlank).toMatchObject({ ok: false, written: false, refusal: { kind: "shrink", missingIds: ["ABC-1"] } });
    const readableSectionSplit = await writeDoc(
      readablePort.port,
      "doc",
      [{ op: "replace_section", section: "## Current", bodyMd: `- ABC-2 Second decision\n  - statement two\n- ABC-1 First${sep}decision\n  - statement one` }],
      identity,
    );
    expect(readableSectionSplit).toMatchObject({ ok: false, written: false, refusal: { kind: "shrink", missingIds: ["ABC-1"] } });
    const readableSectionNested = await writeDoc(
      readablePort.port,
      "doc",
      [{ op: "replace_section", section: "## Current", bodyMd: `- ABC-2 Second decision\n  - statement two\n- ABC-1 First decision\n  - statement one${sep}  - injected` }],
      identity,
    );
    expect(readableSectionNested).toMatchObject({ ok: false, written: false, refusal: { kind: "shrink", missingIds: ["ABC-1"] } });
    expect(readablePort.writes).toHaveLength(0);
    expect(readablePort.docs.doc).toBe(LBD);

    const anchoredLbd = LBD.replace("- ABC-1 First decision", '<a id="abc-1"></a>\n- ABC-1 First decision');
    const anchoredPort = fakePort({ doc: anchoredLbd });
    const readableAnchor = await writeDoc(anchoredPort.port, "doc", [{ op: "patch_prose", oldString: 'id="abc-1"', newString: `id="abc${sep}1"` }], identity);
    expect(readableAnchor).toMatchObject({ ok: false, written: false, refusal: { kind: "shrink", missingIds: ["ABC-1"] } });
    expect(anchoredPort.writes).toHaveLength(0);
  });

  // admits: algorithmic: when rowKeys splits on LINE_BREAK or retains lines carrying U+2028/U+2029, a prose prefix or cell split on a register row passes no-shrink and orphans the row; runtime row key extraction is invisible to tsc and ast-grep.
  it.each(["\u2028", "\u2029"])("aborts a prose patch whose %j separator prefixes or splits a register row", async (sep) => {
    /** When `rowKeys` splits on `LINE_BREAK` instead of `\n` or matches a line holding U+2028/U+2029, `patch_prose` prefixing or splitting a register row returns `ok: true` and orphans the row; observed as pre-write `shrink` on `missingRowKeys` and zero writes. */
    const { port, writes, docs } = fakePort({ doc: REGISTER });
    const prefixed = await writeDoc(port, "doc", [{ op: "patch_prose", oldString: "| `ABC-102` |", newString: `prose${sep}| \`ABC-102\` |` }], identity);
    expect(prefixed).toMatchObject({ ok: false, written: false, refusal: { kind: "shrink", missingRowKeys: ["ABC-102"] } });
    const cellSplit = await writeDoc(port, "doc", [{ op: "patch_prose", oldString: "The second decision.", newString: `The second${sep}decision.` }], identity);
    expect(cellSplit).toMatchObject({ ok: false, written: false, refusal: { kind: "shrink", missingRowKeys: ["ABC-102"] } });
    expect(writes).toHaveLength(0);
    expect(docs.doc).toBe(REGISTER);
  });
});

describe("frozen docs", () => {
  // Typed so that adding an op kind fails tsc until this list covers it.
  const EVERY_OP = {
    append_entry: { op: "append_entry", section: "## Current", entryMd: "- ABC-3 Third\n  - three" },
    supersede_entry: { op: "supersede_entry", targetId: "ABC-1", newEntryMd: "- ABC-3 Third\n  - three" },
    replace_section: { op: "replace_section", section: "## Open conflicts", bodyMd: "- a conflict" },
    replace_register_row: { op: "replace_register_row", decisionId: "ABC-101", rowMd: "| `ABC-101` | x |" },
    patch_prose: { op: "patch_prose", oldString: "statement one", newString: "statement uno" },
  } satisfies { [K in SurgeryOp["op"]]: Extract<SurgeryOp, { op: K }> };

  for (const op of Object.values(EVERY_OP)) {
    it(`refuses ${op.op} with a typed frozen refusal and never writes`, async () => {
      /** When any write path reaches a frozen (graduated) doc, Socrates rewrites a historical snapshot it promised to leave alone; observed as `kind: "frozen"` and zero port writes. */
      const { port, writes } = fakePort({ doc: FROZEN });
      const result = await writeDoc(port, "doc", [op], identity);
      expect(result).toMatchObject({ ok: false, written: false, refusal: { kind: "frozen" } });
      expect(writes).toHaveLength(0);
    });
  }

  it("refuses when the doc is frozen between the first fetch and the write", async () => {
    /** When a graduation lands while a write is in flight and only the first fetch is checked, the write clobbers the freshly frozen doc; observed as the refusal on the pre-write re-fetch. */
    const docs: Record<string, string> = { doc: LBD };
    const { port, writes } = fakePort(docs, { onFetch: (n) => { if (n === 2) docs.doc = FROZEN; } });
    const result = await writeDoc(port, "doc", [EVERY_OP.append_entry], identity);
    expect(result).toMatchObject({ ok: false, refusal: { kind: "frozen" } });
    expect(writes).toHaveLength(0);
  });

  it("recognises the blockquote stamp alone, without the HTML marker", () => {
    /** When a doc keeps its visible `> **Frozen:` stamp but has lost the marker comment and only the marker is checked, the doc reads as writable. */
    const stampOnly = FROZEN.replace(/<!-- socrates-freeze:[^>]*-->/, "");
    expect(applyOps(stampOnly, [EVERY_OP.append_entry], identity)).toMatchObject({ ok: false, refusal: { kind: "frozen" } });
  });

  // admits: algorithmic: when applyOps checks unwritable only on the input body and not on the spliced body, patch_prose or replace_section can inject a > **Frozen: stamp or truncation marker that locks out or truncates every later write; runtime post-splice state cannot be held by tsc or ast-grep.
  it("refuses a prose patch or section replace that would land on a frozen or truncated body", async () => {
    /** When `unwritable` runs only before splicing, an op introducing `> **Frozen:` (after `\n`, U+2028, or U+2029) or `[...]` writes a self-freezing or truncated body to Linear; observed as `frozen` or `truncated` and zero port writes. */
    const { port, writes } = fakePort({ doc: REGISTER });
    for (const sep of ["\n", "\u2028", "\u2029"]) {
      expect(await writeDoc(port, "doc", [{ op: "patch_prose", oldString: "Closing prose.", newString: `Closing prose.${sep}> **Frozen: 2026-10-01**` }], identity)).toMatchObject({
        ok: false,
        written: false,
        refusal: { kind: "frozen" },
      });
    }
    expect(await writeDoc(port, "doc", [{ op: "patch_prose", oldString: "Closing prose.", newString: "Closing prose.\n[...]" }], identity)).toMatchObject({
      ok: false,
      written: false,
      refusal: { kind: "truncated" },
    });
    const lbdPort = fakePort({ doc: LBD });
    expect(await writeDoc(lbdPort.port, "doc", [{ op: "replace_section", section: "## Open conflicts", bodyMd: "> **Frozen: 2026-10-01**" }], identity)).toMatchObject({
      ok: false,
      written: false,
      refusal: { kind: "frozen" },
    });
    expect(writes).toHaveLength(0);
    expect(lbdPort.writes).toHaveLength(0);
  });
});

describe("fetch → write → verify", () => {
  it("fails when the body changed between the fetch and the write, and does not write", async () => {
    /** When a person edits the doc after Socrates fetched it, a full-body write built on the stale fetch silently discards their edit; observed as `changed-before-write` and zero writes. */
    const docs: Record<string, string> = { doc: LBD };
    const { port, writes } = fakePort(docs, { onFetch: (n) => { if (n === 2) docs.doc = LBD.replace("statement one", "statement one, edited by a person"); } });
    const result = await writeDoc(port, "doc", [{ op: "append_entry", section: "## Current", entryMd: "- ABC-3 Third\n  - three" }], identity);
    expect(result).toMatchObject({ ok: false, written: false, refusal: { kind: "changed-before-write" } });
    expect(writes).toHaveLength(0);
  });

  it("fails verify when the stored body lost an entry after the write", async () => {
    /** When the stored doc does not hold what was written (a concurrent writer, a server-side truncation), the pipe reports success over missing data; observed as `verify-failed` naming the missing ID. */
    const { port } = fakePort({ doc: LBD }, { storeRewrite: (b) => b.replace(/- ABC-1 First decision\n {2}- statement one\n {2}- scope: project\n/, "") });
    const result = await writeDoc(port, "doc", [{ op: "append_entry", section: "## Current", entryMd: "- ABC-3 Third\n  - three" }], identity);
    expect(result).toMatchObject({ ok: false, written: true, refusal: { kind: "verify-failed", missingIds: ["ABC-1"] } });
  });

  it("verifies through Linear's own save-time rewrites", async () => {
    /** When verify compares raw bytes, every real write fails, because Linear re-serialises bullets, bare issue keys and brackets on save; observed as a written, verified result over a rewritten store. */
    const linearSave = (b: string) =>
      b.replace(/^(\s*)- /gm, "$1* ").replace(/\bABC-9\b/g, '<issue id="x" href="https://example.com/issue/ABC-9">ABC-9</issue>').replace(/\[cycle (\d+)\]/g, "\\[cycle $1\\]");
    const { port, docs } = fakePort({ doc: linearSave(LBD) }, { storeRewrite: linearSave });
    const result = await writeDoc(port, "doc", [{ op: "append_entry", section: "## Current", entryMd: "- ABC-3 Third [cycle 4], see ABC-9\n  - three" }], identity);
    expect(result).toMatchObject({ ok: true, status: "written", canonicalMatch: true });
    expect(canonicalizeLinear(docs.doc)).toContain("- ABC-3 Third [cycle 4], see ABC-9");
  });

  it("writes nothing when every op is already applied", async () => {
    /** When a retried append re-sends an entry the doc already holds and the pipe writes anyway, the entry is duplicated; observed as `unchanged` and zero writes. */
    const { port, writes } = fakePort({ doc: LBD });
    const result = await writeDoc(port, "doc", [{ op: "append_entry", section: "## Current", entryMd: "- ABC-1 First decision\n  - statement one" }], identity);
    expect(result).toMatchObject({ ok: true, status: "unchanged", skipped: [{ op: "append_entry", id: "ABC-1", reason: "seen-already" }] });
    expect(writes).toHaveLength(0);
  });
});

describe("splices", () => {
  it("replaces one register row by decision ID and leaves every other line byte-identical", () => {
    /** When a Conflict resolution rewrites the wrong row, or reflows the table, a locked PRD decision changes without review; observed line by line against the input. */
    const row = "| `ABC-102` | The second decision, as resolved. |";
    const result = applyOps(REGISTER, [{ op: "replace_register_row", decisionId: "ABC-102", rowMd: row }], identity);
    if (!result.ok) throw new Error(result.refusal.kind);
    const before = REGISTER.split("\n");
    const after = result.body.split("\n");
    expect(after).toHaveLength(before.length);
    const changed = after.flatMap((line, i) => (line === before[i] ? [] : [i]));
    expect(changed).toEqual([before.indexOf("| `ABC-102` | The second decision. |")]);
    expect(after[changed[0]!]).toBe(row);
  });

  it("refuses a row whose key does not match the decision ID it replaces", () => {
    /** When the replacement row carries another ID, the target decision disappears and a duplicate appears; observed as `bad-row`. */
    const result = applyOps(REGISTER, [{ op: "replace_register_row", decisionId: "ABC-102", rowMd: "| `ABC-103` | x |" }], identity);
    expect(result).toMatchObject({ ok: false, refusal: { kind: "bad-row" } });
  });

  // admits: algorithmic: when replaceRow trims before testing LINE_BREAK (or tests only CR/LF), interior or boundary U+2028/U+2029 passes the guard; runtime string validation cannot be held by tsc or ast-grep.
  it.each([
    "| `ABC-102` | two\u2028lines |",
    "| `ABC-102` | two\u2029lines |",
    "\u2028| `ABC-102` | one line |",
    "| `ABC-102` | one line |\u2028",
    "\u2029| `ABC-102` | one line |",
    "| `ABC-102` | one line |\u2029",
  ])("refuses a replacement row holding a line separator (%j)", (row) => {
    /** When a register row carries U+2028 or U+2029 inside or at its ends, `.trim()` strips boundary separators or a CR/LF-only check misses them, and Linear or a renderer breaks the row in two; observed as `bad-row`. */
    expect(applyOps(REGISTER, [{ op: "replace_register_row", decisionId: "ABC-102", rowMd: row }], identity)).toMatchObject({ ok: false, refusal: { kind: "bad-row" } });
  });

  // admits: algorithmic: when checkEntry and blocks split only on CR/LF, nested or blank lines holding U+2028/U+2029 pass blocks() and splice raw separators (including a > **Frozen: stamp) into the live doc; runtime multi-line entry parsing is invisible to tsc and ast-grep.
  it.each([
    "- ABC-3 Third\n  - statement\u2028> **Frozen: 2026-10-01**",
    "- ABC-3 Third\n  - statement\u2029unindented",
    "- ABC-3 Third\n  - statement\u2028  - scope: org",
    "- ABC-3 Third\n  - statement\u2029",
    "<a id=\"x\u2028y\"></a>\n- ABC-3 Third\n  - statement",
    "\u2028\n- ABC-3 Third\n  - statement",
  ])("refuses an entry whose body lines carry U+2028 or U+2029 (%j) before writing", async (entryMd) => {
    /** When `checkEntry` splits only on `\r`/`\n`, a nested line carrying U+2028 or U+2029 passes `blocks()` and splices unindented text or a `> **Frozen:` stamp into the doc; observed as `bad-entry` and zero writes across append and supersede. */
    const { port, writes } = fakePort({ doc: LBD });
    expect(await writeDoc(port, "doc", [{ op: "append_entry", section: "## Current", entryMd }], identity)).toMatchObject({ ok: false, written: false, refusal: { kind: "bad-entry" } });
    expect(await writeDoc(port, "doc", [{ op: "supersede_entry", targetId: "ABC-1", newEntryMd: entryMd }], identity)).toMatchObject({ ok: false, written: false, refusal: { kind: "bad-entry" } });
    expect(
      await writeDoc(port, "doc", [{ op: "supersede_entry", targetId: "ABC-1", newEntryMd: "- ABC-3 Third\n  - three", supersededEntryMd: entryMd.replace("ABC-3", "ABC-1") }], identity),
    ).toMatchObject({ ok: false, written: false, refusal: { kind: "bad-entry" } });
    expect(writes).toHaveLength(0);
  });

  it("finds a row Linear stored with escaped backticks", () => {
    /** When the stored table escapes the key's backticks and the matcher wants them bare, every register resolve reports `row-not-found`. */
    const stored = REGISTER.replace("| `ABC-102` |", "| \\`ABC-102\\` |");
    const result = applyOps(stored, [{ op: "replace_register_row", decisionId: "ABC-102", rowMd: "| `ABC-102` | new |" }], identity);
    expect(result.ok).toBe(true);
  });

  it("appends newest-at-top in its section and drops the placeholder", () => {
    /** When an append lands below older entries or beside a `(none)` placeholder, the doc's newest-first reading order breaks; observed in the spliced body. */
    const result = applyOps(LBD, [{ op: "supersede_entry", targetId: "ABC-1", newEntryMd: "- ABC-3 Replaces the first\n  - three" }], identity);
    if (!result.ok) throw new Error(result.refusal.kind);
    const current = result.body.slice(result.body.indexOf("## Current"), result.body.indexOf("## Superseded"));
    const superseded = result.body.slice(result.body.indexOf("## Superseded"), result.body.indexOf("## Open conflicts"));
    expect(current.indexOf("ABC-3")).toBeLessThan(current.indexOf("ABC-2"));
    expect(current).not.toContain("ABC-1");
    expect(superseded).toContain("- ABC-1 First decision");
    expect(superseded).not.toContain("(no entries yet)");
  });

  it("refuses a prose patch whose anchor is not exactly once in the fetched body", () => {
    /** When an anchor matches twice, the patch edits a site nobody chose; when it matches zero times (a bare key Linear turned into a chip), the patch silently does nothing. */
    expect(applyOps(LBD, [{ op: "patch_prose", oldString: "scope: project", newString: "scope: org" }], identity)).toMatchObject({ ok: false, refusal: { kind: "ambiguous-anchor", count: 2 } });
    expect(applyOps(LBD, [{ op: "patch_prose", oldString: "absent text", newString: "x" }], identity)).toMatchObject({ ok: false, refusal: { kind: "anchor-not-found" } });
  });

  // admits: algorithmic: when patch_prose and replace_section allow U+2028/U+2029 outside entry-id/row-key lines, column-0 nested breaks, section-header prefixes, and prose separators reach VerifiedBody and corrupt section boundaries; runtime input validation cannot be held by tsc or ast-grep.
  it.each(["\u2028", "\u2029"])("refuses patch_prose and replace_section inputs carrying %j while accepting clean '\\n' splices", async (sep) => {
    /** When `patch_prose` (`newString`) or `replace_section` (`bodyMd`) admits U+2028/U+2029 where no ID shrinks, `prose\u2028## Current` destroys section headers and `\u2028  - statement` severs nested lines from their readable-ID bullet; observed as `bad-entry` and zero writes. */
    const { port, writes } = fakePort({ doc: LBD, reg: REGISTER });
    expect(await writeDoc(port, "doc", [{ op: "patch_prose", oldString: "  - statement one", newString: `${sep}  - statement one` }], identity)).toMatchObject({
      ok: false,
      written: false,
      refusal: { kind: "bad-entry" },
    });
    expect(await writeDoc(port, "doc", [{ op: "patch_prose", oldString: "## Current", newString: `prose${sep}## Current` }], identity)).toMatchObject({
      ok: false,
      written: false,
      refusal: { kind: "bad-entry" },
    });
    expect(await writeDoc(port, "reg", [{ op: "patch_prose", oldString: "Closing prose.", newString: `Closing${sep}prose.` }], identity)).toMatchObject({
      ok: false,
      written: false,
      refusal: { kind: "bad-entry" },
    });
    expect(await writeDoc(port, "doc", [{ op: "replace_section", section: "## Open conflicts", bodyMd: `- a conflict${sep}continued` }], identity)).toMatchObject({
      ok: false,
      written: false,
      refusal: { kind: "bad-entry" },
    });
    expect(writes).toHaveLength(0);

    const clean = applyOps(
      LBD,
      [
        { op: "replace_section", section: "## Open conflicts", bodyMd: "- first conflict\n- second conflict" },
        { op: "patch_prose", oldString: "statement one", newString: "statement one\n  - resolved" },
      ],
      identity,
    );
    expect(clean).toMatchObject({ ok: true });
    if (clean.ok) {
      expect(clean.body).toContain("- first conflict\n- second conflict");
      expect(clean.body).toContain("  - statement one\n  - resolved");
    }
  });

  // admits: algorithmic: when patchProse leaves CR/CRLF unnormalized while canonicalizeLinear replaces \r\n? with \n, a CR before an entry bullet or register row passes no-shrink and orphans the entry or row on the single \n line; runtime line-ending normalization cannot be held by tsc or ast-grep.
  it("normalizes CR and CRLF in patch_prose so spliced lines stay aligned with canonicalizeLinear", () => {
    /** When `patchProse` splices raw `\r` while `canonicalizeLinear` splits `\r\n?` to `\n`, `prose\r- First decision` and `prose\r| \`ABC-102\` |` pass `no-shrink` and then fail `supersede_entry` (`entry-not-found`) and `replace_register_row` (`row-not-found`). */
    const hash = "0c43" + "e7d3";
    const nextHash = "1111" + "2222";
    const hashId: EntryIdentity = { entryId: (b) => /^ {2}- hash: ([0-9a-f]{8})$/m.exec(b)?.[1] ?? null };
    const hashed = `# Test - Load-Bearing Decisions\n\n## Current\n\n- First decision\n  - statement one\n  - hash: ${hash}\n\n## Superseded\n\n(no entries yet)\n`;
    const patchedEntry = applyOps(hashed, [{ op: "patch_prose", oldString: "- First decision", newString: "one\r\ntwo\r- First decision" }], hashId);
    expect(patchedEntry).toMatchObject({ ok: true });
    if (!patchedEntry.ok) return;
    expect(patchedEntry.body).not.toContain("\r");
    expect(patchedEntry.body).toContain("one\ntwo\n- First decision");
    expect(
      applyOps(patchedEntry.body, [{ op: "supersede_entry", targetId: hash, newEntryMd: `- Second decision\n  - statement two\n  - hash: ${nextHash}` }], hashId),
    ).toMatchObject({ ok: true });

    const patchedRow = applyOps(REGISTER, [{ op: "patch_prose", oldString: "| `ABC-102` |", newString: "one\r\ntwo\r| `ABC-102` |" }], identity);
    expect(patchedRow).toMatchObject({ ok: true });
    if (!patchedRow.ok) return;
    expect(patchedRow.body).not.toContain("\r");
    expect(patchedRow.body).toContain("one\ntwo\n| `ABC-102` |");
    expect(applyOps(patchedRow.body, [{ op: "replace_register_row", decisionId: "ABC-102", rowMd: "| `ABC-102` | Updated second decision. |" }], identity)).toMatchObject({
      ok: true,
    });
  });

  it("refuses an entry it cannot identify", () => {
    /** When an entry without an ID is written, no later no-shrink or verify can see it, so its loss would pass every check. */
    expect(applyOps(LBD, [{ op: "append_entry", section: "## Current", entryMd: "- An untagged decision" }], identity)).toMatchObject({ ok: false, refusal: { kind: "unidentified-entry" } });
  });

  it("refuses a truncated fetch as a write base", () => {
    /** When a partial fetch (a "content truncated" placeholder) becomes the base of a full-body write, everything past the cut is deleted from the live doc. */
    expect(applyOps(`${LBD}\n[...]\n`, [{ op: "patch_prose", oldString: "statement one", newString: "x" }], identity)).toMatchObject({ ok: false, refusal: { kind: "truncated" } });
  });
});

describe("titles", () => {
  // admits: algorithmic: when parseTitle trims before testing LINE_BREAK, leading or trailing U+2028/U+2029/CR/LF is stripped to ok:true while renderDecision refuses it as title-multiline; runtime string validation cannot be held by tsc or ast-grep.
  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["two\nlines", "multi-line"],
    ["\nTitle", "multi-line"],
    ["Title\r", "multi-line"],
    ["two\u2028lines", "multi-line"],
    ["two\u2029lines", "multi-line"],
    ["\u2028Title", "multi-line"],
    ["Title\u2028", "multi-line"],
    ["\u2029Title", "multi-line"],
    ["Title\u2029", "multi-line"],
    ["x".repeat(81), "too-long"],
    ["Guard block-env-reads.sh in hooks", "autolinkable"],
  ])("refuses %j (%s)", (title, reason) => {
    /** When a title spans lines, carries a leading or trailing line separator, runs past 80 characters, or carries a bare `name.tld` Linear autolinks on save, the stored title never matches the sent one and title checks fail forever. */
    expect(parseTitle(title)).toMatchObject({ ok: false, refusal: { kind: "bad-title", reason } });
  });

  it("accepts a code-spanned file name and an 80-character title", () => {
    /** When the guard over-refuses, a legitimate title wrapped as the guard itself advises can never be written. */
    expect(parseTitle("Guard `block-env-reads.sh` in hooks").ok).toBe(true);
    expect(parseTitle("y".repeat(80)).ok).toBe(true);
  });

  it("refuses an appended entry whose title bullet breaks the title rules", () => {
    /** When the title guard covers doc creation but not entries, an entry title Linear autolinks is written and never verifies. */
    const result = applyOps(LBD, [{ op: "append_entry", section: "## Current", entryMd: "- ABC-3 See docs.example.com\n  - three" }], identity);
    expect(result).toMatchObject({ ok: false, refusal: { kind: "bad-title", reason: "autolinkable" } });
  });

  // admits: algorithmic: when parseEntryTitleLine trims U+2028/U+2029 off a title after the handle while checkEntry splices the untrimmed title line, writeDoc writes raw U+2028/U+2029 into the doc and fails verify once Linear breaks the line; runtime splice validation requires a seam test.
  it.each([
    "- `ACME-K1` \u2028Title\n  - statement",
    "- `ACME-K1` Title\u2028\n  - statement",
    "- `ACME-K1` \u2029Title\n  - statement",
    "- `ACME-K1` Title\u2029\n  - statement",
    `- \u2028Title\n  - statement\n  - hash: ${"0c43" + "e7d3"}`,
    `- Title\u2029\n  - statement\n  - hash: ${"0c43" + "e7d3"}`,
  ])("refuses an appended entry with boundary U+2028 or U+2029 on its title (%j) before writing", async (entryMd) => {
    /** When `parseTitle` trims leading or trailing U+2028/U+2029 and `checkEntry` splices the untrimmed line, `writeDoc` writes the corrupted title bullet and fails post-write once Linear breaks the separator; observed as `bad-title` (`multi-line`) and zero port writes. */
    const anyId: EntryIdentity = {
      entryId: (b) => /^- `([A-Z][A-Z0-9-]*\d)` /m.exec(b)?.[1] ?? /^ {2}- hash: ([0-9a-f]{8})$/m.exec(b)?.[1] ?? null,
    };
    const { port, writes } = fakePort({ doc: LBD });
    expect(parseEntryTitleLine(entryMd.split("\n")[0]!.slice(2))).toMatchObject({ ok: false, refusal: { kind: "bad-title", reason: "multi-line" } });
    expect(await writeDoc(port, "doc", [{ op: "append_entry", section: "## Current", entryMd }], anyId)).toMatchObject({
      ok: false,
      written: false,
      refusal: { kind: "bad-title", reason: "multi-line" },
    });
    expect(writes).toHaveLength(0);
  });
});

describe("ensureDoc", () => {
  const parent: DocParent = { kind: "project", id: "p1" };
  const title = (s: string): Title => {
    const r = parseTitle(s);
    if (!r.ok) throw new Error(r.refusal.kind);
    return r.title;
  };
  function creatorPort(existing: FetchedDoc | null | Error) {
    const created: string[] = [];
    const port: LinearDocPort = {
      fetch: async () => null,
      write: async () => {},
      findByTitle: async () => {
        if (existing instanceof Error) throw existing;
        return existing;
      },
      create: async (_p, t, body) => {
        created.push(t);
        return { id: "new", title: t, body };
      },
    };
    return { port, created };
  }

  it("refuses to create when the existence check fails", async () => {
    /** When a failed lookup is read as "not there", a transient Linear error mints a duplicate living doc (P22). */
    const { port, created } = creatorPort(new Error("503"));
    const result = await ensureDoc(port, parent, title("Test - Practices"), "# Test - Practices\n");
    expect(result).toMatchObject({ ok: false, refusal: { kind: "existence-check-failed" } });
    expect(created).toHaveLength(0);
  });

  it("returns the existing doc instead of creating a second", async () => {
    /** When creation is not idempotent on the exact title within its parent, every lazy-create retry adds another doc. */
    const { port, created } = creatorPort({ id: "d1", title: "Test - Practices", body: "" });
    expect(await ensureDoc(port, parent, title("Test - Practices"), "")).toMatchObject({ ok: true, status: "exists", doc: { id: "d1" } });
    expect(created).toHaveLength(0);
  });

  it("creates when the check succeeds and finds nothing", async () => {
    /** When the happy path never reaches `create`, lazy doc creation is dead. */
    const { port, created } = creatorPort(null);
    expect(await ensureDoc(port, parent, title("Test - Practices"), "# Test - Practices\n")).toMatchObject({ ok: true, status: "created" });
    expect(created).toEqual(["Test - Practices"]);
  });
});

describe("an entry render accepts is an entry applyOps accepts", () => {
  /** A rendered entry is named by its backticked handle, or by its `hash:` field. */
  const rendered: EntryIdentity = {
    entryId: (block) => /^- `([A-Z][A-Z0-9-]*\d)` /m.exec(block)?.[1] ?? /^ {2}- hash: ([0-9a-f]{8})$/m.exec(block)?.[1] ?? null,
  };
  const doc = "# Test - Load-Bearing Decisions\n\n## Current\n\n(no entries yet)\n\n## Superseded\n\n(no entries yet)\n";
  const source = { label: "eris#42", url: "https://github.com/acme/app/pull/42" };
  const date = { date: "2026-11-02" };
  const longest = "x".repeat(ENTRY_TITLE_MAX_LENGTH);
  const handles = [{ id: "ACME-K10" }, { id: "ABCDEFGH-K999" }, { hash: "0c43" + "e7d3" }];

  for (const handle of handles) {
    for (const title of [longest, "y"]) {
      it(`appends a ${title.length}-char title under ${JSON.stringify(handle)}`, () => {
        /** When the handle counts against the title limit, a title render accepted is refused at resolve as too-long. */
        for (const md of [
          renderDecision({ handle, title, statement: "s", scope: "org", source, date }),
          renderPractice({ handle, title, statement: "s", source, date }),
        ]) {
          const result = applyOps(doc, [{ op: "append_entry", section: "## Current", entryMd: md }], rendered);
          expect(result).toMatchObject({ ok: true });
          if (!result.ok) return;
          expect(result.body).toContain(md.split("\n")[0]!);
        }
      });
    }
  }

  it("supersedes with an 80-char title on both sides", () => {
    /** When only append was fixed, a supersede whose new or re-rendered entry carries a full-length title is still refused. */
    const old = renderDecision({ handle: { id: "ACME-K1" }, title: longest, statement: "s", scope: "org", source, date });
    const seeded = applyOps(doc, [{ op: "append_entry", section: "## Current", entryMd: old }], rendered);
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.refusal));
    const next = renderDecision({ handle: { id: "ACME-K10" }, title: longest, statement: "t", scope: "org", source, date });
    const again = renderDecision({ handle: { id: "ACME-K1" }, title: longest, statement: "s", scope: "org", source, date, supersededBy: "ACME-K10" });
    expect(applyOps(seeded.body, [{ op: "supersede_entry", targetId: "ACME-K1", newEntryMd: next, supersededEntryMd: again }], rendered)).toMatchObject({ ok: true });
  });

  it("still refuses an 81-char title behind a handle", () => {
    /** When stripping the handle also loosened the limit, an over-long hand-written entry reaches the doc. */
    const md = `- \`ACME-K10\` ${"x".repeat(ENTRY_TITLE_MAX_LENGTH + 1)}\n  - statement: s`;
    expect(applyOps(doc, [{ op: "append_entry", section: "## Current", entryMd: md }], rendered)).toMatchObject({ ok: false, refusal: { kind: "bad-title", reason: "too-long" } });
  });

  it("parses the handle off a title line and leaves other code spans in the title", () => {
    /** When any leading code span is stripped as a handle, a title can hide characters from the limit. */
    expect(parseEntryTitleLine("`ACME-K10` Adopt the pipe")).toEqual({ ok: true, handleId: "ACME-K10", title: "Adopt the pipe" as Title });
    expect(parseEntryTitleLine("Adopt the pipe")).toEqual({ ok: true, handleId: null, title: "Adopt the pipe" as Title });
    expect(parseEntryTitleLine("`foo` bar")).toEqual({ ok: true, handleId: null, title: "`foo` bar" as Title });
    expect(parseEntryTitleLine(`\`foo\` ${"x".repeat(ENTRY_TITLE_MAX_LENGTH - 5)}`)).toMatchObject({ ok: false, refusal: { reason: "too-long" } });
  });
});
