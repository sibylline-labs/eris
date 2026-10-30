/**
 * Issue entries from a candidate: a `prd` or `conflict` candidate's statement is a fixed markdown grammar, parsed
 * here into a `PrdEntry` or `ConflictEntry` and rendered by `render.ts`. The client checks a statement with
 * `issueEntryOf` before it leaves the machine, and the server files exactly what it returns, so both read one
 * grammar.
 *
 * PRD statement, in this order (blank lines ignored):
 *
 *     Decisions: `ACME-K1`–`ACME-K57`             (en dash, `-` or `..`; one ID when the PRD locked one)
 *     Confirmed by: dana                           (a leading @ is dropped)
 *     Decisions that touch other projects:         (optional)
 *     - `ACME-K4`: [Accounts](https://…)
 *
 * The PRD link is the candidate's title and source.
 *
 * Conflict statement:
 *
 *     <summary: one or more lines>
 *
 *     Authoritative sites:
 *     - [Label](https://…)
 *     - `ACME-K11`, `ACME-K12` in [PRD — Acme](https://…)
 *
 *     Proposed resolution:                         (optional)
 *
 *     <text>
 *
 * Invariants:
 *  - Parsing is strict: a line the grammar does not place is refused with the reason, never dropped.
 *  - Every ID is a register ID (`DECISION_ID`), the shape the resolver reads back.
 *  - The answer-here footer is the renderer's: a statement that carries it is refused.
 */

import {
  type ConflictEntry,
  type ConflictSite,
  DECISION_ID,
  EntryRenderError,
  type IssueEntry,
  type Link,
  type PrdEntry,
  renderConflictEntry,
  renderPrdEntry,
} from "./render";

export type IssueEntryKind = "prd" | "conflict";

export type IssueEntryCandidate = { kind: IssueEntryKind; title: string; statement: string; source: string };

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

const ID = `\`(${DECISION_ID})\``;
const LINK = String.raw`\[([^\]\r\n]+)\]\((\S+)\)`;
const DECISIONS_LINE = new RegExp(String.raw`^Decisions:\s*${ID}(?:\s*(?:–|-|\.\.)\s*${ID})?\s*$`);
const CONFIRMED_LINE = /^Confirmed by:\s*@?(\S.*?)\s*$/;
const CROSS_HEADING = /^Decisions that touch other projects:\s*$/;
const CROSS_LINE = new RegExp(String.raw`^[-*+]\s+${ID}:\s*${LINK}\s*$`);
const SITES_HEADING = /^Authoritative sites:\s*$/;
const PROPOSED_HEADING = /^Proposed resolution:\s*$/;
const SITE_LINE = new RegExp(String.raw`^[-*+]\s+(?:(${ID}(?:\s*,\s*${ID})*)\s+in\s+)?${LINK}\s*$`);
const BACKTICKED = /`([^`]+)`/g;
const FOOTER = /^Answer on this issue\./;

/** `ACME-K11` as its prefix `ACME-K` and number 11. */
function idParts(id: string): { prefix: string; n: number } {
  const m = /^(.*?)([1-9][0-9]*)$/.exec(id)!;
  return { prefix: m[1]!, n: Number(m[2]) };
}

function lines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/** A PRD candidate's statement as the entry it renders, with the PRD itself linked as `prd`. */
export function parsePrdStatement(statement: string, prd: Link): Parsed<PrdEntry> {
  let decisions: PrdEntry["decisions"] | undefined;
  let confirmedBy: string | undefined;
  let inCross = false;
  const crossProject: { decision: string; project: Link }[] = [];
  for (const raw of lines(statement)) {
    const line = raw.trim();
    if (line === "") continue;
    if (FOOTER.test(line)) return refuse("leave out the answer-here footer: the entry adds it");
    const d = DECISIONS_LINE.exec(line);
    if (d !== null) {
      if (decisions !== undefined) return refuse("the statement has two Decisions: lines");
      if (inCross) return refuse("the Decisions: line comes before the cross-project list");
      decisions = { first: d[1]!, last: d[2] ?? d[1]! };
      continue;
    }
    const c = CONFIRMED_LINE.exec(line);
    if (c !== null) {
      if (confirmedBy !== undefined) return refuse("the statement has two Confirmed by: lines");
      if (inCross) return refuse("the Confirmed by: line comes before the cross-project list");
      confirmedBy = c[1]!;
      continue;
    }
    if (CROSS_HEADING.test(line)) {
      if (inCross) return refuse("the statement has two cross-project lists");
      inCross = true;
      continue;
    }
    const x = inCross ? CROSS_LINE.exec(line) : null;
    if (x !== null) {
      crossProject.push({ decision: x[1]!, project: { label: x[2]!, url: x[3]! } });
      continue;
    }
    return refuse(`the line ${JSON.stringify(line)} is not part of a PRD statement`);
  }
  if (decisions === undefined) return refuse("the statement has no Decisions: line naming the decision range");
  if (confirmedBy === undefined) return refuse("the statement has no Confirmed by: line");
  const first = idParts(decisions.first);
  const last = idParts(decisions.last);
  if (first.prefix !== last.prefix) return refuse(`${decisions.first} and ${decisions.last} are from different registers`);
  if (last.n < first.n) return refuse(`the range ends at ${decisions.last}, before it starts at ${decisions.first}`);
  for (const { decision } of crossProject) {
    const p = idParts(decision);
    if (p.prefix !== first.prefix || p.n < first.n || p.n > last.n) return refuse(`${decision} is outside ${decisions.first}–${decisions.last}`);
  }
  return { ok: true, value: { prd, decisions, confirmedBy, crossProject } };
}

/** A conflict candidate's statement as the entry it renders, titled `title`. */
export function parseConflictStatement(statement: string, title: string): Parsed<ConflictEntry> {
  const all = lines(statement);
  const at = all.findIndex((l) => SITES_HEADING.test(l.trim()));
  if (at < 0) return refuse("the statement has no Authoritative sites: list");
  const summary = all.slice(0, at).join("\n").trim();
  if (summary === "") return refuse("the statement has no summary before Authoritative sites:");
  const sites: ConflictSite[] = [];
  const seen = new Set<string>();
  let i = at + 1;
  for (; i < all.length; i++) {
    const line = all[i]!.trim();
    if (line === "") continue;
    if (PROPOSED_HEADING.test(line) || FOOTER.test(line)) break;
    const m = SITE_LINE.exec(line);
    if (m === null) return refuse(`the line ${JSON.stringify(line)} is not a site: - [label](url), or - \`ID\`, \`ID\` in [label](url)`);
    if (seen.has(line)) return refuse(`the site ${JSON.stringify(line)} is listed twice`);
    seen.add(line);
    const decisions = m[1] === undefined ? [] : [...m[1].matchAll(BACKTICKED)].map((b) => b[1]!);
    sites.push({ label: m[m.length - 2]!, url: m[m.length - 1]!, ...(decisions.length > 0 ? { decisions } : {}) });
  }
  if (sites.length < 2) return refuse(`a conflict links at least two sites, got ${sites.length}`);
  let proposedResolution: string | undefined;
  if (i < all.length && PROPOSED_HEADING.test(all[i]!.trim())) {
    const rest = all.slice(i + 1);
    if (rest.some((l) => FOOTER.test(l.trim()))) return refuse("leave out the answer-here footer: the entry adds it");
    proposedResolution = rest.join("\n").trim();
    if (proposedResolution === "") return refuse("the Proposed resolution: section is empty");
  } else if (i < all.length) {
    return refuse("leave out the answer-here footer: the entry adds it");
  }
  return { ok: true, value: { title, summary, sites, ...(proposedResolution !== undefined ? { proposedResolution } : {}) } };
}

/** The issue a `prd` or `conflict` candidate files as, or why its statement cannot be filed. */
export function issueEntryOf(candidate: IssueEntryCandidate): Parsed<IssueEntry> {
  try {
    if (candidate.kind === "prd") {
      const parsed = parsePrdStatement(candidate.statement, { label: candidate.title, url: candidate.source });
      return parsed.ok ? { ok: true, value: renderPrdEntry(parsed.value) } : parsed;
    }
    const parsed = parseConflictStatement(candidate.statement, candidate.title);
    return parsed.ok ? { ok: true, value: renderConflictEntry(parsed.value) } : parsed;
  } catch (error) {
    if (error instanceof EntryRenderError) return refuse(error.message);
    throw error;
  }
}
