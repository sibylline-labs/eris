/**
 * Entry rendering: every entry body is produced here from fixed templates, never written freehand by a model.
 *
 * Rendering is pure string assembly from literals and inputs (no clock, no locale, no map iteration), so the same
 * input renders byte-identically every time. Inputs that would break an entry's shape are refused with a typed
 * `EntryRenderError`, never silently rewritten, because matching and hashing run on the rendered text.
 *
 * Two kinds live in living docs as nested-bullet blocks: `decision` and `practice`. Two are Linear issues and
 * render as `{ title, description }`: `prd` and `conflict`.
 */

/**
 * How a doc entry is identified. Either a readable ID, which goes in the title line (`` - `ACME-P3` Title ``), or
 * an 8-hex content hash, which goes in the last nested bullet (`hash: <8 hex>`). Both are supported so that the
 * identity scheme can be chosen without changing a caller.
 */
export type EntryHandle = { id: string } | { hash: string };

export type Link = { label: string; url: string };

/** A calendar date as `YYYY-MM-DD`, with the cycle active when the entry was written, if any. */
export type EntryDate = { date: string; cycle?: number };

export type DecisionEntry = {
  handle: EntryHandle;
  title: string;
  statement: string;
  scope: string;
  source: Link;
  date: EntryDate;
  /** The handle of the entry that replaced this one; rendered as `-` when absent. */
  supersededBy?: string;
};

export type PracticeEntry = Omit<DecisionEntry, "scope">;

export type PrdEntry = {
  prd: Link;
  /** The first and last decision IDs the PRD locked; equal when it locked one. */
  decisions: { first: string; last: string };
  /** The display name of the person who confirmed the decisions, rendered as an @-mention. */
  confirmedBy: string;
  /** Locked decisions that touch another project, each with a link to that project. */
  crossProject: readonly { decision: string; project: Link }[];
};

export type ConflictEntry = {
  title: string;
  summary: string;
  /** Every authoritative site involved: docs, register rows, issues, Canon, code. At least two. */
  sites: readonly Link[];
  /** A resolution a reviewer can accept, when one can be proposed. */
  proposedResolution?: string;
};

export type IssueEntry = { title: string; description: string };

export type EntryRenderReason =
  | "title-multiline"
  | "title-too-long"
  | "field-multiline"
  | "bad-link"
  | "bad-date"
  | "bad-handle"
  | "too-few-sites";

export class EntryRenderError extends Error {
  constructor(
    readonly reason: EntryRenderReason,
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "EntryRenderError";
  }
}

export const ENTRY_TITLE_MAX_LENGTH = 80;

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;

const LINE_BREAK = /[\r\n\u2028\u2029]/;

/** Single-line review footer for issue entries: the reply lands on this issue, never on a linked one. */
const ANSWER_HERE = "Answer on this issue. A comment here is authoritative, and Socrates carries it to every linked site.";

// ---------------------------------------------------------------------------
// doc entries
// ---------------------------------------------------------------------------

export function renderDecision(entry: DecisionEntry): string {
  return renderDocEntry(entry, [`scope: ${singleLine("scope", entry.scope)}`]);
}

export function renderPractice(entry: PracticeEntry): string {
  return renderDocEntry(entry, []);
}

function renderDocEntry(entry: PracticeEntry, kindFields: readonly string[]): string {
  const title = checkTitle(entry.title);
  const handle = checkHandle(entry.handle);
  const titleLine = "id" in handle ? `- \`${handle.id}\` ${title}` : `- ${title}`;
  const fields = [
    singleLine("statement", entry.statement),
    ...kindFields,
    `source: ${renderLink(entry.source)}`,
    formatEntryDate(entry.date),
    `superseded-by: ${entry.supersededBy === undefined ? "-" : singleLine("supersededBy", entry.supersededBy)}`,
    ...("hash" in handle ? [`hash: ${handle.hash}`] : []),
  ];
  return [titleLine, ...fields.map((field) => `  - ${field}`)].join("\n");
}

// ---------------------------------------------------------------------------
// issue entries
// ---------------------------------------------------------------------------

export function renderPrdEntry(entry: PrdEntry): IssueEntry {
  const first = singleLine("decisions.first", entry.decisions.first);
  const last = singleLine("decisions.last", entry.decisions.last);
  const range = first === last ? `decision \`${first}\` was` : `decisions \`${first}\`–\`${last}\` were`;
  const title = checkTitle(`PRD authored: ${singleLine("prd.label", entry.prd.label)}`);
  const lines = [
    `PRD authored: ${renderLink(entry.prd)}; ${range} discussed and confirmed by @${singleLine("confirmedBy", entry.confirmedBy)}.`,
  ];
  if (entry.crossProject.length > 0) {
    lines.push("", "Decisions that touch other projects:");
    for (const { decision, project } of entry.crossProject) {
      lines.push(`- \`${singleLine("crossProject.decision", decision)}\`: ${renderLink(project)}`);
    }
  }
  lines.push("", ANSWER_HERE);
  return { title, description: lines.join("\n") };
}

export function renderConflictEntry(entry: ConflictEntry): IssueEntry {
  const title = checkTitle(entry.title);
  if (entry.sites.length < 2) {
    throw new EntryRenderError("too-few-sites", `a conflict links at least two sites, got ${entry.sites.length}`);
  }
  const lines = [entry.summary.trim(), "", "Authoritative sites:", ...entry.sites.map((site) => `- ${renderLink(site)}`)];
  if (entry.proposedResolution !== undefined) {
    lines.push("", "Proposed resolution:", "", entry.proposedResolution.trim());
  }
  lines.push("", ANSWER_HERE);
  return { title, description: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// fields
// ---------------------------------------------------------------------------

/** `YYYY-MON-DD [cycle N]`, or `YYYY-MON-DD` with no cycle. */
export function formatEntryDate({ date, cycle }: EntryDate): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const [year, month, day] = match === null ? [0, 0, 0] : [Number(match[1]), Number(match[2]), Number(match[3])];
  if (match === null || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new EntryRenderError("bad-date", `${JSON.stringify(date)} is not a calendar date as YYYY-MM-DD`);
  }
  if (cycle !== undefined && !(Number.isSafeInteger(cycle) && cycle >= 0)) {
    throw new EntryRenderError("bad-date", `cycle ${cycle} is not a non-negative integer`);
  }
  const label = `${match[1]}-${MONTHS[month - 1]}-${match[3]}`;
  return cycle === undefined ? label : `${label} [cycle ${cycle}]`;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function checkTitle(title: string): string {
  if (LINE_BREAK.test(title)) throw new EntryRenderError("title-multiline", "an entry title is one line");
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > ENTRY_TITLE_MAX_LENGTH) {
    throw new EntryRenderError(
      "title-too-long",
      `an entry title is 1 to ${ENTRY_TITLE_MAX_LENGTH} characters, got ${trimmed.length}`,
    );
  }
  return trimmed;
}

function checkHandle(handle: EntryHandle): EntryHandle {
  if ("id" in handle) {
    if (!/^[A-Z][A-Z0-9]*-[A-Z]+[1-9][0-9]*$/.test(handle.id)) {
      throw new EntryRenderError("bad-handle", `${JSON.stringify(handle.id)} is not an entry ID such as ACME-P3`);
    }
    return handle;
  }
  if (!/^[0-9a-f]{8}$/.test(handle.hash)) {
    throw new EntryRenderError("bad-handle", `${JSON.stringify(handle.hash)} is not 8 lowercase hex characters`);
  }
  return handle;
}

/** A field rendered inside one nested bullet: a line break would end the bullet early. */
function singleLine(field: string, value: string): string {
  if (LINE_BREAK.test(value)) throw new EntryRenderError("field-multiline", `${field} must be one line`);
  return value.trim();
}

function renderLink({ label, url }: Link): string {
  if (LINE_BREAK.test(label) || /[[\]]/.test(label) || label.trim().length === 0) {
    throw new EntryRenderError("bad-link", `link label ${JSON.stringify(label)} must be one line with no brackets`);
  }
  if (!/^https?:\/\/[^\s()<>]+$/.test(url)) {
    throw new EntryRenderError("bad-link", `link url ${JSON.stringify(url)} must be an http(s) URL with no spaces or parentheses`);
  }
  return `[${label.trim()}](${url})`;
}
