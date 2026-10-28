/**
 * Readable entry IDs (`ACME-P3`, the third entry under prefix `ACME-P`), allocated from the doc body alone: the
 * next ID is one more than the highest already present, so allocation needs no state beyond the doc. Two writers
 * allocating from the same body get the same ID; the caller serialises writes per doc.
 */

export class EntryIdError extends Error {
  constructor(readonly prefix: string) {
    super(`entry-id prefix ${JSON.stringify(prefix)} is not <KEY>-<LETTERS> (for example ACME-P)`);
    this.name = "EntryIdError";
  }
}

/** A project key, a dash, then the kind letters. Nothing regex-special can pass, so a prefix cannot widen a match. */
const PREFIX_SHAPE = /^[A-Z][A-Z0-9]*-[A-Z]+$/;

/** A character that would make the match part of a longer token: `XACME-P3` or `B-ACME-P3` is not `ACME-P3`. */
const TOKEN_CHAR = /[A-Za-z0-9-]/;

function assertPrefix(prefix: string): void {
  if (!PREFIX_SHAPE.test(prefix)) throw new EntryIdError(prefix);
}

/**
 * Every ID under `prefix` in `body`, deduplicated and in numeric order. Numbers are canonical: `ACME-P03` is not
 * an ID. A longer stem does not match: `ACME-PX1` is not under `ACME-P`.
 */
export function entryIds(body: string, prefix: string): string[] {
  assertPrefix(prefix);
  return entryNumbers(body, prefix).map((n) => `${prefix}${n}`);
}

/** The next ID under `prefix`: one more than the highest present, or `<prefix>1` for a body that has none. */
export function nextEntryId(body: string, prefix: string): string {
  assertPrefix(prefix);
  const numbers = entryNumbers(body, prefix);
  const highest = numbers.length === 0 ? 0 : numbers[numbers.length - 1]!;
  return `${prefix}${highest + 1}`;
}

function entryNumbers(body: string, prefix: string): number[] {
  // The left boundary is checked in code: a lookbehind would make the pinned bun interpret the whole pattern.
  const pattern = new RegExp(`${prefix}([1-9][0-9]*)(?![0-9A-Za-z])`, "g");
  const seen = new Set<number>();
  for (const match of body.matchAll(pattern)) {
    const before = match.index === 0 ? "" : body[match.index - 1]!;
    if (before !== "" && TOKEN_CHAR.test(before)) continue;
    seen.add(Number(match[1]));
  }
  return [...seen].sort((a, b) => a - b);
}
