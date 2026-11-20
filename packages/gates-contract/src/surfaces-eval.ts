/**
 * surfaces-eval.ts — pure `.claude/surfaces.yml` validation and v1 glob matching over `SurfacesFile`
 * (surfaces.ts). Data and pure functions only: zero filesystem or CLI runtime dependency, so both
 * `eris gate`, `eris surface`, lint passes, and any distribution share the exact validator and
 * matcher.
 *
 * Unknown keys are refused at every level (`decodeResultStrict`); anchors, aliases, merge keys and
 * multiple YAML documents are refused too.
 */

import { isAlias, isMap, isScalar, isSeq, LineCounter, parseAllDocuments, type Node as YamlNode } from "yaml";
import { decodeResultStrict } from "./decode";
import {
  type AuditTtl,
  type ChangeBudget,
  DEFAULT_SEVERITY_FLOOR,
  type Ledger,
  type OneWayUnlock,
  type SeverityFloor,
  type SurfaceEntry,
  SurfacesFile,
} from "./surfaces";

export interface SurfacesIssue {
  readonly line?: number | undefined;
  readonly message: string;
}

export type SurfacesValidationResult = { readonly ok: true; readonly value: SurfacesFile } | { readonly ok: false; readonly issues: ReadonlyArray<SurfacesIssue> };

function nodeLine(lines: LineCounter, node: { range?: readonly number[] | null } | null | undefined): number {
  return lines.linePos(node?.range?.[0] ?? 0).line;
}

function collectConstructIssues(lines: LineCounter, node: YamlNode | null | undefined, out: SurfacesIssue[]): void {
  if (node === null || node === undefined) return;
  if (isAlias(node)) {
    out.push({ line: nodeLine(lines, node), message: `alias '*${node.source}' is not supported in surfaces.yml` });
    return;
  }
  const anchor = (node as { anchor?: string }).anchor;
  if (anchor !== undefined && anchor !== "") out.push({ line: nodeLine(lines, node), message: `anchor '&${anchor}' is not supported in surfaces.yml` });
  if (isMap(node)) {
    for (const pair of node.items) {
      const k = pair.key as YamlNode | null;
      if (k !== null && !isScalar(k)) out.push({ line: nodeLine(lines, k), message: "collection map keys are not supported in surfaces.yml" });
      else if (k !== null && isScalar(k) && String(k.value ?? "") === "<<") out.push({ line: nodeLine(lines, k), message: "merge key '<<' is not supported in surfaces.yml" });
      collectConstructIssues(lines, pair.value as YamlNode | null, out);
    }
    return;
  }
  if (isSeq(node)) for (const item of node.items) collectConstructIssues(lines, item as YamlNode | null, out);
}

/** Validate `.claude/surfaces.yml` text: YAML syntax, one document, no anchors or merge keys, and the strict `SurfacesFile` decode. */
export function validateSurfacesYaml(text: string): SurfacesValidationResult {
  const lines = new LineCounter();
  const all = parseAllDocuments(text, { version: "1.2", uniqueKeys: true, lineCounter: lines });
  const docs = Array.isArray(all) ? all : [all];
  const syntax: SurfacesIssue[] = [];
  for (const d of docs) for (const e of d.errors) syntax.push({ line: e.linePos?.[0]?.line, message: `not valid YAML: ${e.message.split("\n")[0]}` });
  if (syntax.length > 0) return { ok: false, issues: syntax };
  if (docs.length > 1) return { ok: false, issues: [{ line: nodeLine(lines, docs[1]), message: "multiple YAML documents ('---') are not supported in surfaces.yml" }] };
  const doc = docs[0];
  if (doc === undefined || doc.contents === null || doc.contents === undefined) return { ok: false, issues: [{ line: 1, message: "registry must have a top-level 'surfaces:' mapping" }] };
  const constructs: SurfacesIssue[] = [];
  collectConstructIssues(lines, doc.contents as YamlNode | null, constructs);
  if (constructs.length > 0) return { ok: false, issues: constructs };
  const decoded = decodeResultStrict(SurfacesFile, doc.toJS() as unknown);
  if (decoded._tag === "Success") return { ok: true, value: decoded.success };
  const issues = decoded.failure.issues.map((i): SurfacesIssue => ({ message: `${i.path.length > 0 ? `${i.path.join(".")}: ` : ""}${i.message} (expected ${i.expected})` }));
  return { ok: false, issues: issues.length > 0 ? issues : [{ message: decoded.failure.message }] };
}

/** One line per issue, as the `gate-surfaces-invalid` block names them. */
export const issuesText = (issues: ReadonlyArray<SurfacesIssue>): string => issues.map((i) => (i.line !== undefined ? `line ${i.line}: ${i.message}` : i.message)).join("; ");

/** Expand brace alternation `{a,b}` (nested braces included); unbalanced braces are literal. */
export function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf("{");
  if (start === -1) return [pattern];
  let depth = 0;
  let end = -1;
  for (let j = start; j < pattern.length; j++) {
    if (pattern[j] === "{") depth++;
    else if (pattern[j] === "}") {
      depth--;
      if (depth === 0) {
        end = j;
        break;
      }
    }
  }
  if (end === -1) return [pattern];
  const parts: string[] = [];
  depth = 0;
  let current = "";
  for (const ch of pattern.slice(start + 1, end)) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts.flatMap((part) => expandBraces(`${pattern.slice(0, start)}${part}${pattern.slice(end + 1)}`));
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** A brace-expanded v1 surface glob (`*`, `**`, `?`) as an anchored regular expression. */
export function globToRegex(pattern: string): string {
  let out = "";
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const ch = pattern[i]!;
    if (pattern.startsWith("**", i) && (i === 0 || pattern[i - 1] === "/")) {
      if (i + 2 < n && pattern[i + 2] === "/") {
        out += "(?:[^/]+/)*";
        i += 3;
        continue;
      }
      if (i + 2 === n) {
        out += ".*";
        i += 2;
        continue;
      }
    }
    if (ch === "/" && pattern.slice(i + 1) === "**") {
      out += "(?:/.*)?";
      break;
    }
    if (pattern.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (ch === "*") {
      out += "[^/]*";
      i += 1;
    } else if (ch === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += ch.replace(REGEX_SPECIAL, "\\$&");
      i += 1;
    }
  }
  return `^${out}$`;
}

const compileGlobs = (patterns: readonly string[]): RegExp[] => patterns.flatMap((p) => expandBraces(p).map((e) => new RegExp(globToRegex(e))));

/** The default vocabulary path of a surface that names no `class_taxonomy`. */
export const vocabularyPath = (name: string, spec: Pick<SurfaceEntry, "class_taxonomy">): string => spec.class_taxonomy ?? `thoughts/vocabulary/${name}.md`;

export interface MatchedSurface {
  readonly name: string;
  readonly matched_files: readonly string[];
  readonly class_taxonomy: string;
  readonly severity_floor: SeverityFloor;
  readonly one_way_unlock?: OneWayUnlock;
  readonly audit_ttl?: AuditTtl;
  readonly change_budget?: ChangeBudget;
  readonly ledger?: Ledger;
}

/** The surfaces of `registry` that `changedFiles` cross, each with its matched files and the v1 defaults applied. */
export function matchSurfaces(registry: SurfacesFile, changedFiles: readonly string[]): readonly MatchedSurface[] {
  const out: MatchedSurface[] = [];
  for (const [name, spec] of Object.entries(registry.surfaces)) {
    const globs = compileGlobs(spec.paths);
    const matched = [...new Set(changedFiles.filter((f) => globs.some((g) => g.test(f))))].sort();
    if (matched.length === 0) continue;
    out.push({
      name,
      matched_files: matched,
      class_taxonomy: vocabularyPath(name, spec),
      severity_floor: spec.severity_floor ?? DEFAULT_SEVERITY_FLOOR,
      ...(spec.one_way_unlock !== undefined ? { one_way_unlock: spec.one_way_unlock } : {}),
      ...(spec.audit_ttl !== undefined ? { audit_ttl: spec.audit_ttl } : {}),
      ...(spec.change_budget !== undefined ? { change_budget: spec.change_budget } : {}),
      ...(spec.ledger !== undefined ? { ledger: spec.ledger } : {}),
    });
  }
  return out;
}
