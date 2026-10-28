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
  ensureDoc,
  parseTitle,
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
  it.each([
    ["", "empty"],
    ["two\nlines", "multi-line"],
    ["x".repeat(81), "too-long"],
    ["Guard block-env-reads.sh in hooks", "autolinkable"],
  ])("refuses %j (%s)", (title, reason) => {
    /** When a title spans lines, runs past 80 characters, or carries a bare `name.tld` Linear autolinks on save, the stored title never matches the sent one and title checks fail forever. */
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
