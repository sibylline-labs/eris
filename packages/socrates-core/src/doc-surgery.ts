/**
 * Surgery on a Socrates living-doc body, and the one pipe that writes it back.
 *
 * Linear takes a document's content only as a whole markdown body, with no partial
 * patch and no compare-and-swap. So a write is: fetch, splice locally, re-fetch and
 * check the body is unchanged, write the full body, re-fetch and verify. Every
 * guard runs before the write: a frozen doc, a truncated fetch, a splice that would
 * drop an entry or a register row, and a bad title all refuse with a typed
 * `Refusal`, and nothing reaches the port's `write`.
 *
 * Entry identity is injected (`EntryIdentity`): this module never decides how an
 * entry is named, only that every named entry of the live doc survives.
 *
 * Web APIs only: the consumer is a Cloudflare Worker.
 */

// ---------------------------------------------------------------------------
// Types

/** Why a splice or a write did not happen. Every member is terminal for its call. */
export type Refusal =
  | { kind: "frozen" }
  | { kind: "truncated"; marker: string }
  | { kind: "shrink"; missingIds: string[]; missingRowKeys: string[] }
  | { kind: "bad-title"; reason: "empty" | "multi-line" | "too-long" | "autolinkable"; title: string }
  | { kind: "bad-entry"; reason: string }
  | { kind: "unidentified-entry" }
  | { kind: "section-not-found"; section: string }
  | { kind: "entry-not-found"; id: string }
  | { kind: "ambiguous-entry"; id: string; count: number }
  | { kind: "row-not-found"; decisionId: string }
  | { kind: "ambiguous-row"; decisionId: string; count: number }
  | { kind: "bad-row"; reason: string }
  | { kind: "anchor-not-found" }
  | { kind: "ambiguous-anchor"; count: number }
  | { kind: "doc-not-found"; docId: string }
  | { kind: "changed-before-write" }
  | { kind: "verify-failed"; missingIds: string[]; unexpectedIds: string[]; missingRowKeys: string[]; unexpectedRowKeys: string[] }
  | { kind: "existence-check-failed"; reason: string };

/** One splice. Ops apply in order, each to the body the previous one produced. */
export type SurgeryOp =
  /** Insert a rendered entry at the top of `section` (null: the top of a sectionless doc). */
  | { op: "append_entry"; section: string | null; entryMd: string }
  /** Move entry `targetId` from `## Current` to the top of `## Superseded` (optionally re-rendered), then append `newEntryMd` to Current. */
  | { op: "supersede_entry"; targetId: string; newEntryMd: string; supersededEntryMd?: string }
  /** Replace the narrative under `section` (up to the next heading or `---`). */
  | { op: "replace_section"; section: string; bodyMd: string }
  /** Replace the one register-table row keyed `` `decisionId` ``. */
  | { op: "replace_register_row"; decisionId: string; rowMd: string }
  /** Replace text that occurs exactly once in the body. */
  | { op: "patch_prose"; oldString: string; newString: string };

/** Names an entry. `entryId` sees one entry block (its title bullet and nested lines) and returns its own ID, or null. */
export interface EntryIdentity {
  entryId(block: string): string | null;
}

declare const verified: unique symbol;
/** A body that passed every guard. Only this module mints one, so only the guarded pipes can reach `write`/`create`. */
export type VerifiedBody = string & { readonly [verified]: true };

declare const titled: unique symbol;
/** A title that is one line of 1–80 characters with nothing Linear autolinks. Only `parseTitle` mints one. */
export type Title = string & { readonly [titled]: true };

export interface FetchedDoc {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export interface DocParent {
  readonly kind: "project" | "initiative" | "issue" | "team";
  readonly id: string;
}

/** The Linear client, injected so a caller can drive it with a leased token. `findByTitle` throws when it cannot tell. */
export interface LinearDocPort {
  fetch(docId: string): Promise<FetchedDoc | null>;
  write(docId: string, body: VerifiedBody): Promise<void>;
  findByTitle(parent: DocParent, title: Title): Promise<FetchedDoc | null>;
  create(parent: DocParent, title: Title, body: VerifiedBody): Promise<FetchedDoc>;
}

export interface OpReceipt {
  op: SurgeryOp["op"];
  id?: string;
}

export interface SkippedOp {
  op: SurgeryOp["op"];
  id: string;
  reason: "seen-already";
}

type Refused = { ok: false; refusal: Refusal };

export type ApplyResult = { ok: true; body: string; applied: OpReceipt[]; skipped: SkippedOp[] } | Refused;

export type WriteResult =
  | { ok: true; status: "written" | "unchanged"; applied: OpReceipt[]; skipped: SkippedOp[]; bodySha256: string; canonicalMatch: boolean }
  | { ok: false; written: boolean; refusal: Refusal };

export type EnsureResult = { ok: true; status: "exists" | "created"; doc: FetchedDoc } | Refused;

// ---------------------------------------------------------------------------
// Markers

const FREEZE_MARKER_RE = /<!--\s*socrates-freeze:/;
// The visible stamp alone also freezes: a doc can keep it and lose the marker, and
// entries appended after a freeze land above it, so it is matched anywhere.
const FROZEN_STAMP_RE = /^>[ \t]*\*\*Frozen:/m;

// A partial fetch can insert a placeholder and drop the rest of the doc; written
// back, it deletes everything past the cut.
const TRUNCATION_MARKERS: RegExp[] = [
  /content truncated/i,
  /truncated to first\b/i,
  /\bfirst\s*~?\s*\d+\s+entries\b/i,
  /\b\d+\s+(?:more|additional)\s+entries\b/i,
  /^\s*[[(]\s*(?:…|\.\.\.)\s*[\])]\s*$/m,
];

const PLACEHOLDER_RE = /^\((?:no entries yet|none)\)$/;
const H1_RE = /^#\s+\S/;
const H2_RE = /^##\s+(.+?)\s*$/;
const TOP_BULLET_RE = /^[-*+][ \t]/;
const ANCHOR_LINE_RE = /^\s*<a id="[^"]+"><\/a>\s*$/;
// A register row: its first cell is a code-spanned ID, backticks possibly escaped.
const ROW_KEY_RE = /^\|\s*\\?`([^`\\|]+)\\?`\s*\|/;

const MAX_TITLE_LEN = 80;
const TITLE_LINK_SAFE_RE = /`[^`]*`|\[[^\]]*\]\([^)]*\)/g;
const AUTOLINKABLE_RE = /\b[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/;

// ---------------------------------------------------------------------------
// Linear's save-time rewrites

// Each pair reverses one rewrite observed in a live save → fetch round trip, so a
// body and its stored form canonicalise to the same text. A rewrite nobody has seen
// gets no rule.
const LINEAR_REWRITES: [RegExp, string][] = [
  // A bare issue key is minted into a mention chip; the chip reduces to its label.
  [/<(issue|document|project)\b[^>]*>([\s\S]*?)<\/\1>/g, "$2"],
  // A link's URL comes back angle-wrapped.
  [/<(https?:\/\/[^\s<>]+)>/g, "$1"],
  // A bare URL is promoted to a self-labelled link.
  [/\[(https?:\/\/[^\]\s]+)\]\(\1\)/g, "$1"],
  // `- ` bullets come back as `* `.
  [/^(\s*)[*+] /gm, "$1- "],
  // A blank line is inserted between an anchor and its bullet.
  [/^([ \t]*<a id="[^"]*"><\/a>)\n(?:[ \t]*\n)+(?=[ \t]*[-*+][ \t])/gm, "$1\n"],
  // Consecutive nested-field entries are stored as a tight list.
  [/^([ \t]+- [^\n]*)\n(?:[ \t]*\n)+(?=- )/gm, "$1\n"],
  // Prose brackets and tildes come back escaped.
  [/\\([[\]])/g, "$1"],
  [/\\~/g, "~"],
];

/** Reverse Linear's observed save-time rewrites, then normalise blank lines and the trailing newline. */
export function canonicalizeLinear(body: string): string {
  let text = body.replace(/\r\n?/g, "\n");
  for (const [rx, repl] of LINEAR_REWRITES) text = text.replace(rx, repl);
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    } else out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Titles

/** Parse a doc or entry title. Linear autolinks a bare `name.tld`, after which the stored title never matches the sent one. */
export function parseTitle(raw: string): { ok: true; title: Title } | Refused {
  const title = raw.trim();
  const refuse = (reason: Extract<Refusal, { kind: "bad-title" }>["reason"]): Refused => ({ ok: false, refusal: { kind: "bad-title", reason, title: raw } });
  if (title === "") return refuse("empty");
  if (/[\r\n]/.test(title)) return refuse("multi-line");
  if (title.length > MAX_TITLE_LEN) return refuse("too-long");
  if (AUTOLINKABLE_RE.test(title.replace(TITLE_LINK_SAFE_RE, " "))) return refuse("autolinkable");
  return { ok: true, title: title as Title };
}

// ---------------------------------------------------------------------------
// Body structure

interface Section {
  name: string;
  header: number;
  /** First line after the header. */
  start: number;
  /** One past the last line: the next heading, a `---` footer rule, or the end. */
  end: number;
}

interface Block {
  start: number;
  end: number;
}

function sections(lines: string[]): Section[] {
  const heads = lines.flatMap((line, i) => {
    const m = H2_RE.exec(line);
    return m ? [{ name: `## ${m[1]}`, header: i }] : [];
  });
  return heads.map((h, j) => {
    let end = j + 1 < heads.length ? heads[j + 1]!.header : lines.length;
    for (let k = h.header + 1; k < end; k++) {
      if (lines[k]!.trim() === "---") {
        end = k;
        break;
      }
    }
    return { ...h, start: h.header + 1, end };
  });
}

/** Entry blocks in `[start, end)`: an optional anchor line, a top-level bullet, and every indented or comment line after it. */
function blocks(lines: string[], start: number, end: number): Block[] {
  const out: Block[] = [];
  let cur: (Block & { anchorOnly: boolean }) | null = null;
  const close = () => {
    if (cur && !cur.anchorOnly) out.push({ start: cur.start, end: cur.end });
    cur = null;
  };
  for (let i = start; i < end; i++) {
    const line = lines[i]!;
    if (TOP_BULLET_RE.test(line)) {
      if (cur?.anchorOnly) {
        cur.anchorOnly = false;
        cur.end = i + 1;
      } else {
        close();
        cur = { start: i, end: i + 1, anchorOnly: false };
      }
    } else if (ANCHOR_LINE_RE.test(line)) {
      close();
      cur = { start: i, end: i + 1, anchorOnly: true };
    } else if (line.trim() === "") {
      // A blank line neither ends nor extends a block; the next line decides.
    } else if (cur && (/^[ \t]/.test(line) || line.startsWith("<!--"))) {
      cur.end = i + 1;
    } else {
      close();
    }
  }
  close();
  return out;
}

function entryIds(body: string, identity: EntryIdentity): string[] {
  const lines = canonicalizeLinear(body).split("\n");
  const ids = blocks(lines, 0, lines.length).flatMap((b) => {
    const id = identity.entryId(lines.slice(b.start, b.end).join("\n"));
    return id === null ? [] : [id];
  });
  return [...new Set(ids)];
}

function rowKeys(body: string): string[] {
  return [...new Set(canonicalizeLinear(body).split("\n").flatMap((line) => {
    const m = ROW_KEY_RE.exec(line);
    return m ? [m[1]!.trim()] : [];
  }))];
}

const minus = (a: string[], b: string[]): string[] => {
  const drop = new Set(b);
  return a.filter((x) => !drop.has(x));
};

function frozen(body: string): boolean {
  return FREEZE_MARKER_RE.test(body) || FROZEN_STAMP_RE.test(body) || FROZEN_STAMP_RE.test(canonicalizeLinear(body));
}

function truncationMarker(body: string): string | null {
  for (const rx of TRUNCATION_MARKERS) {
    const m = rx.exec(body);
    if (m) return m[0];
  }
  return null;
}

/** Refuse a body no write may be built on or land on. */
function unwritable(body: string): Refusal | null {
  if (frozen(body)) return { kind: "frozen" };
  const marker = truncationMarker(body);
  return marker === null ? null : { kind: "truncated", marker };
}

// ---------------------------------------------------------------------------
// Splices

type Step = { ok: true; body: string } | Refused;

function refuse(refusal: Refusal): Refused {
  return { ok: false, refusal };
}

/** Check a rendered entry: one top-level title bullet that passes the title guard, and an ID. */
function checkEntry(entryMd: string, identity: EntryIdentity): { ok: true; id: string; lines: string[] } | Refused {
  const lines = entryMd.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  const found = blocks(lines, 0, lines.length);
  if (found.length !== 1 || found[0]!.end !== lines.length) return refuse({ kind: "bad-entry", reason: "an entry is exactly one top-level bullet and its nested lines" });
  const titleLine = lines.find((l) => TOP_BULLET_RE.test(l))!;
  const title = parseTitle(titleLine.slice(2));
  if (!title.ok) return title;
  const id = identity.entryId(canonicalizeLinear(entryMd));
  if (id === null) return refuse({ kind: "unidentified-entry" });
  return { ok: true, id, lines };
}

function insertTop(body: string, section: string | null, entryLines: string[]): Step {
  const lines = body.split("\n");
  let header: number;
  let end: number;
  if (section === null) {
    const first = lines.findIndex((l) => l.trim() !== "");
    header = first >= 0 && H1_RE.test(lines[first]!) ? first : -1;
    end = lines.length;
  } else {
    const sec = sections(lines).find((s) => s.name === section);
    if (!sec) return refuse({ kind: "section-not-found", section });
    header = sec.header;
    end = sec.end;
  }
  const kept: string[] = [];
  for (let i = header + 1; i < end; i++) {
    if (!PLACEHOLDER_RE.test(lines[i]!.trim())) kept.push(lines[i]!);
  }
  while (kept.length > 0 && kept[0]!.trim() === "") kept.shift();
  const lead = header >= 0 ? [...lines.slice(0, header + 1), ""] : [];
  const rest = kept.length > 0 || end < lines.length ? ["", ...kept] : kept;
  return { ok: true, body: [...lead, ...entryLines, ...rest, ...lines.slice(end)].join("\n") };
}

function findEntry(lines: string[], sec: Section, id: string, identity: EntryIdentity): { ok: true; block: Block } | Refused {
  const hits = blocks(lines, sec.start, sec.end).filter((b) => identity.entryId(canonicalizeLinear(lines.slice(b.start, b.end).join("\n"))) === id);
  if (hits.length === 0) return refuse({ kind: "entry-not-found", id });
  if (hits.length > 1) return refuse({ kind: "ambiguous-entry", id, count: hits.length });
  return { ok: true, block: hits[0]! };
}

function replaceSection(body: string, section: string, bodyMd: string): Step {
  const lines = body.split("\n");
  const sec = sections(lines).find((s) => s.name === section);
  if (!sec) return refuse({ kind: "section-not-found", section });
  const inner = bodyMd.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
  const tail = sec.end < lines.length ? [""] : [];
  return { ok: true, body: [...lines.slice(0, sec.header + 1), "", ...(inner === "" ? [] : inner.split("\n")), ...tail, ...lines.slice(sec.end)].join("\n") };
}

function replaceRow(body: string, decisionId: string, rowMd: string): Step {
  const row = rowMd.trim();
  if (/[\r\n]/.test(row)) return refuse({ kind: "bad-row", reason: "a register row is one line" });
  const key = ROW_KEY_RE.exec(row)?.[1]?.trim();
  if (key !== decisionId) return refuse({ kind: "bad-row", reason: `the row's key is ${key ?? "missing"}, not ${decisionId}` });
  const lines = body.split("\n");
  const hits = lines.flatMap((line, i) => (ROW_KEY_RE.exec(line)?.[1]?.trim() === decisionId ? [i] : []));
  if (hits.length === 0) return refuse({ kind: "row-not-found", decisionId });
  if (hits.length > 1) return refuse({ kind: "ambiguous-row", decisionId, count: hits.length });
  lines[hits[0]!] = row;
  return { ok: true, body: lines.join("\n") };
}

function patchProse(body: string, oldString: string, newString: string): Step {
  if (oldString === "") return refuse({ kind: "anchor-not-found" });
  const count = body.split(oldString).length - 1;
  if (count === 0) return refuse({ kind: "anchor-not-found" });
  if (count > 1) return refuse({ kind: "ambiguous-anchor", count });
  const at = body.indexOf(oldString);
  return { ok: true, body: body.slice(0, at) + newString + body.slice(at + oldString.length) };
}

/**
 * Apply `ops` to `body`, purely. A frozen or truncated body refuses before any op runs;
 * the result refuses if it lost an entry ID or a register-row key the input held.
 */
export function applyOps(body: string, ops: readonly SurgeryOp[], identity: EntryIdentity): ApplyResult {
  const stop = unwritable(body);
  if (stop) return refuse(stop);
  let cur = body;
  const applied: OpReceipt[] = [];
  const skipped: SkippedOp[] = [];
  for (const op of ops) {
    let step: Step;
    switch (op.op) {
      case "append_entry": {
        const entry = checkEntry(op.entryMd, identity);
        if (!entry.ok) return entry;
        if (entryIds(cur, identity).includes(entry.id)) {
          skipped.push({ op: op.op, id: entry.id, reason: "seen-already" });
          continue;
        }
        step = insertTop(cur, op.section, entry.lines);
        if (step.ok) applied.push({ op: op.op, id: entry.id });
        break;
      }
      case "supersede_entry": {
        const entry = checkEntry(op.newEntryMd, identity);
        if (!entry.ok) return entry;
        if (entryIds(cur, identity).includes(entry.id)) {
          skipped.push({ op: op.op, id: entry.id, reason: "seen-already" });
          continue;
        }
        const lines = cur.split("\n");
        const current = sections(lines).find((s) => s.name === "## Current");
        if (!current) return refuse({ kind: "section-not-found", section: "## Current" });
        const target = findEntry(lines, current, op.targetId, identity);
        if (!target.ok) return target;
        let moved = lines.slice(target.block.start, target.block.end);
        if (op.supersededEntryMd !== undefined) {
          const rerendered = checkEntry(op.supersededEntryMd, identity);
          if (!rerendered.ok) return rerendered;
          if (rerendered.id !== op.targetId) return refuse({ kind: "bad-entry", reason: `the re-rendered superseded entry is ${rerendered.id}, not ${op.targetId}` });
          moved = rerendered.lines;
        }
        let cut = target.block.end;
        while (cut < current.end && lines[cut]!.trim() === "") cut++;
        const without = [...lines.slice(0, target.block.start), ...lines.slice(cut)].join("\n");
        const parked = insertTop(without, "## Superseded", moved);
        if (!parked.ok) return parked;
        step = insertTop(parked.body, "## Current", entry.lines);
        if (step.ok) applied.push({ op: op.op, id: entry.id });
        break;
      }
      case "replace_section":
        step = replaceSection(cur, op.section, op.bodyMd);
        if (step.ok) applied.push({ op: op.op });
        break;
      case "replace_register_row":
        step = replaceRow(cur, op.decisionId, op.rowMd);
        if (step.ok) applied.push({ op: op.op, id: op.decisionId });
        break;
      case "patch_prose":
        step = patchProse(cur, op.oldString, op.newString);
        if (step.ok) applied.push({ op: op.op });
        break;
    }
    if (!step.ok) return step;
    cur = step.body;
  }
  const missingIds = minus(entryIds(body, identity), entryIds(cur, identity));
  const missingRowKeys = minus(rowKeys(body), rowKeys(cur));
  if (missingIds.length > 0 || missingRowKeys.length > 0) return refuse({ kind: "shrink", missingIds, missingRowKeys });
  return { ok: true, body: cur, applied, skipped };
}

// ---------------------------------------------------------------------------
// The write pipe

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Fetch `docId`, apply `ops`, re-fetch and check nothing changed, write the full body,
 * then re-fetch and verify every entry ID and register-row key the write carried is
 * stored, and nothing else appeared. Byte equality is reported (`canonicalMatch`),
 * never required: Linear rewrites markdown on save.
 */
export async function writeDoc(port: LinearDocPort, docId: string, ops: readonly SurgeryOp[], identity: EntryIdentity): Promise<WriteResult> {
  const notWritten = (refusal: Refusal): WriteResult => ({ ok: false, written: false, refusal });
  const base = await port.fetch(docId);
  if (!base) return notWritten({ kind: "doc-not-found", docId });
  const spliced = applyOps(base.body, ops, identity);
  if (!spliced.ok) return notWritten(spliced.refusal);
  const { applied, skipped } = spliced;
  if (applied.length === 0) return { ok: true, status: "unchanged", applied, skipped, bodySha256: await sha256(base.body), canonicalMatch: true };

  const live = await port.fetch(docId);
  if (!live) return notWritten({ kind: "doc-not-found", docId });
  const stop = unwritable(live.body);
  if (stop) return notWritten(stop);
  if (canonicalizeLinear(live.body) !== canonicalizeLinear(base.body)) return notWritten({ kind: "changed-before-write" });

  await port.write(docId, spliced.body as VerifiedBody);

  const stored = await port.fetch(docId);
  const storedBody = stored?.body ?? "";
  const wroteIds = entryIds(spliced.body, identity);
  const storedIds = entryIds(storedBody, identity);
  const wroteRows = rowKeys(spliced.body);
  const storedRows = rowKeys(storedBody);
  const missingIds = minus(wroteIds, storedIds);
  const unexpectedIds = minus(storedIds, wroteIds);
  const missingRowKeys = minus(wroteRows, storedRows);
  const unexpectedRowKeys = minus(storedRows, wroteRows);
  if (!stored || missingIds.length + unexpectedIds.length + missingRowKeys.length + unexpectedRowKeys.length > 0) {
    return { ok: false, written: true, refusal: { kind: "verify-failed", missingIds, unexpectedIds, missingRowKeys, unexpectedRowKeys } };
  }
  return {
    ok: true,
    status: "written",
    applied,
    skipped,
    bodySha256: await sha256(spliced.body),
    canonicalMatch: canonicalizeLinear(storedBody) === canonicalizeLinear(spliced.body),
  };
}

/**
 * Return the doc titled exactly `title` under `parent`, creating it only when the
 * lookup succeeded and found none. A lookup that fails refuses: read as "absent", a
 * transient error would mint a duplicate.
 */
export async function ensureDoc(port: LinearDocPort, parent: DocParent, title: Title, initialBody: string): Promise<EnsureResult> {
  let existing: FetchedDoc | null;
  try {
    existing = await port.findByTitle(parent, title);
  } catch (err) {
    return refuse({ kind: "existence-check-failed", reason: err instanceof Error ? err.message : String(err) });
  }
  if (existing) return { ok: true, status: "exists", doc: existing };
  const marker = truncationMarker(initialBody);
  if (marker !== null) return refuse({ kind: "truncated", marker });
  return { ok: true, status: "created", doc: await port.create(parent, title, initialBody as VerifiedBody) };
}
