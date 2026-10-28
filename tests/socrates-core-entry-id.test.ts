/**
 * packages/socrates-core entry-ID allocation.
 *
 * Seam: `nextEntryId` / `entryIds` on the package's public entry, fed a living-doc body as the tenant actor reads
 * it back from Linear. Red when allocation reuses an ID (it counted entries instead of taking the highest, so a
 * deleted or superseded gap hands out a live ID again), when an ID under a longer or embedded stem is counted
 * against this prefix, or when a regex-special prefix widens the match.
 */
import { describe, expect, test } from "bun:test";
import { EntryIdError, entryIds, nextEntryId } from "../packages/socrates-core/src/index";

const body = [
  "# Acme - Practices",
  "",
  "## Current",
  "",
  "- `ACME-P7` Run the suite once at the end",
  "  - statement",
  "- `ACME-P2` Keep scratch probes out of temp dirs",
  "  - superseded-by: ACME-P7",
  "",
  "## Superseded",
  "",
  "- `ACME-P5` Older practice",
].join("\n");

describe("nextEntryId", () => {
  test("allocates one more than the highest ID, not one more than the count", () => {
    // Three entries with a gap at 1, 3, 4 and 6: counting would hand out ACME-P4, an ID a superseded entry may
    // still be cited by.
    expect(nextEntryId(body, "ACME-P")).toBe("ACME-P8");
  });

  test("starts at 1 in a body with no IDs under the prefix", () => {
    expect(nextEntryId("# Acme - Practices\n\n## Current\n", "ACME-P")).toBe("ACME-P1");
    expect(nextEntryId("", "ACME-P")).toBe("ACME-P1");
  });

  test("depends only on the body: reordering entries and adding unrelated text change nothing", () => {
    const reordered = body.split("\n").reverse().join("\n");
    expect(nextEntryId(reordered, "ACME-P")).toBe("ACME-P8");
    expect(nextEntryId(`${body}\n\nSee ACME-K40 and OTHER-P99 for context.`, "ACME-P")).toBe("ACME-P8");
  });

  test("an ID under a longer stem or inside a longer token is not under this prefix", () => {
    const noisy = "ACME-PX41 · XACME-P42 · B-ACME-P43 · ACME-P44a · ACME-P045 · `ACME-P3`";
    expect(entryIds(noisy, "ACME-P")).toEqual(["ACME-P3"]);
    expect(nextEntryId(noisy, "ACME-P")).toBe("ACME-P4");
  });

  test("an ID at the very start of the body counts", () => {
    expect(nextEntryId("ACME-P9 opens the doc", "ACME-P")).toBe("ACME-P10");
  });
});

describe("entryIds", () => {
  test("lists every ID under the prefix once, in numeric order", () => {
    // `ACME-P7` appears twice (as an entry and as a superseded-by target) and is listed once.
    expect(entryIds(body, "ACME-P")).toEqual(["ACME-P2", "ACME-P5", "ACME-P7"]);
  });

  test("orders numerically, not lexically", () => {
    expect(entryIds("ACME-P10 ACME-P9 ACME-P100", "ACME-P")).toEqual(["ACME-P9", "ACME-P10", "ACME-P100"]);
  });
});

describe("prefix validation", () => {
  for (const prefix of ["", "ACME", "acme-p", "ACME-P.", "ACME-.*", "ACME-P3", "-P", "ACME-P|OTHER-P"]) {
    test(`refuses ${JSON.stringify(prefix)}, so a malformed prefix cannot widen the match`, () => {
      expect(() => nextEntryId(body, prefix)).toThrow(EntryIdError);
      expect(() => entryIds(body, prefix)).toThrow(EntryIdError);
    });
  }
});
