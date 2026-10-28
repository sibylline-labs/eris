/**
 * vendor-gitleaks.ts — regenerate packages/outbound-scan/src/gitleaks-rules.ts
 * from a gitleaks release's config/gitleaks.toml (MIT).
 *
 *   curl -sSfL -o data/scratch/gitleaks.toml \
 *     https://raw.githubusercontent.com/gitleaks/gitleaks/<tag>/config/gitleaks.toml
 *   bun scripts/vendor-gitleaks.ts --toml data/scratch/gitleaks.toml --tag <tag>          # write
 *   bun scripts/vendor-gitleaks.ts --toml data/scratch/gitleaks.toml --tag <tag> --check  # diff only
 *
 * gitleaks writes Go RE2. Each pattern is translated to a JS RegExp and kept
 * only if it compiles under this bun and carries no lookbehind
 * (rules/regex-no-lookbehind.yml). Translation:
 *   - a leading `(?i)` becomes the `i` flag; a later one becomes a `(?i:…)`
 *     modifier group running to the end of its enclosing group, which is the
 *     span RE2 applies it to;
 *   - `(?P<name>` becomes `(?<name>`; `\z` becomes `$` (no `m` flag);
 *   - POSIX bracket classes become their ASCII ranges.
 * A rule's allowlists keep only what can hold for a string with no path or
 * commit: `regexes` and `stopwords`. An allowlist that also needs a path (or
 * ANDs one in) can never hold here and is dropped.
 *
 * EXCLUDED holds rules that are heuristics rather than secret shapes. Their
 * hits could never be overridden, so a false positive would block a candidate
 * outright; our `assignment` redaction class covers the same shape and can be
 * overridden.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const EXCLUDED: Record<string, string> = {
  "generic-api-key": "a keyword + entropy heuristic; the `assignment` redaction class covers it, overridably",
};

const OUT = join(resolve(import.meta.dir, ".."), "packages/outbound-scan/src/gitleaks-rules.ts");

interface TomlAllowlist {
  regexes?: string[];
  stopwords?: string[];
  regexTarget?: "secret" | "match" | "line";
  condition?: "OR" | "AND";
  paths?: string[];
}
interface TomlRule {
  id: string;
  regex?: string;
  entropy?: number;
  keywords?: string[];
  secretGroup?: number;
  path?: string;
  allowlists?: TomlAllowlist[];
}
interface TomlConfig {
  allowlist?: { regexes?: string[]; stopwords?: string[] };
  rules: TomlRule[];
}

const POSIX: Record<string, string> = {
  alnum: "a-zA-Z0-9",
  alpha: "a-zA-Z",
  digit: "0-9",
  lower: "a-z",
  upper: "A-Z",
  space: "\\s",
  word: "\\w",
  xdigit: "0-9a-fA-F",
  punct: "!-\\/:-@\\[-`{-~",
};

/** The index of the `)` closing the group that encloses `from`, or the source length. */
function enclosingEnd(src: string, from: number): number {
  let depth = 0;
  let inClass = false;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return src.length;
}

export function translate(goSource: string): { source: string; flags: string } {
  let src = goSource;
  let flags = "";
  if (src.startsWith("(?i)")) {
    src = src.slice(4);
    flags = "i";
  }
  for (let at = src.indexOf("(?i)"); at !== -1; at = src.indexOf("(?i)")) {
    const end = enclosingEnd(src, at + 4);
    src = `${src.slice(0, at)}(?i:${src.slice(at + 4, end)})${src.slice(end)}`;
  }
  src = src.replace(/\(\?P</g, "(?<").replace(/\\z/g, "$");
  src = src.replace(/\[:(\w+):\]/g, (whole, name: string) => POSIX[name] ?? whole);
  return { source: src, flags };
}

interface OutRule {
  id: string;
  source: string;
  flags: string;
  keywords: string[];
  entropy?: number;
  secretGroup?: number;
  allow?: { regexes: { source: string; flags: string }[]; stopwords: string[]; target: "secret" | "match" };
}

function compiles(t: { source: string; flags: string }): boolean {
  if (/\(\?<[=!]/.test(t.source)) return false;
  try {
    new RegExp(t.source, t.flags);
    return true;
  } catch {
    return false;
  }
}

function build(tomlPath: string, tag: string): string {
  const config = Bun.TOML.parse(readFileSync(tomlPath, "utf8")) as unknown as TomlConfig;
  const kept: OutRule[] = [];
  const dropped: string[] = [];
  for (const rule of config.rules) {
    if (rule.regex === undefined) continue; // a path-only rule: nothing to match in text
    if (rule.id in EXCLUDED) continue;
    const t = translate(rule.regex);
    if (!compiles(t)) {
      dropped.push(rule.id);
      continue;
    }
    const out: OutRule = { id: rule.id, ...t, keywords: (rule.keywords ?? []).map((k) => k.toLowerCase()) };
    if (rule.entropy !== undefined) out.entropy = rule.entropy;
    if (rule.secretGroup !== undefined) out.secretGroup = rule.secretGroup;
    const allow = (rule.allowlists ?? []).filter((a) => a.paths === undefined && a.regexTarget !== "line");
    const regexes = allow.flatMap((a) => a.regexes ?? []).map(translate).filter(compiles);
    const stopwords = allow.flatMap((a) => a.stopwords ?? []).map((w) => w.toLowerCase());
    if (regexes.length + stopwords.length > 0) {
      out.allow = { regexes, stopwords, target: allow.some((a) => a.regexTarget === "match") ? "match" : "secret" };
    }
    kept.push(out);
  }
  const global = {
    regexes: (config.allowlist?.regexes ?? []).map(translate).filter(compiles),
    stopwords: (config.allowlist?.stopwords ?? []).map((w) => w.toLowerCase()),
  };
  const excluded = Object.entries(EXCLUDED).map(([id, why]) => ` *   - ${id}: ${why}`).join("\n");
  return `/**
 * GENERATED by scripts/vendor-gitleaks.ts from gitleaks ${tag} config/gitleaks.toml.
 * Do not edit by hand: change the script and regenerate.
 *
 * gitleaks, https://github.com/gitleaks/gitleaks, is MIT licensed; its license
 * travels with these rules in packages/outbound-scan/LICENSE.gitleaks.
 *
 * ${kept.length} rules kept. Excluded by policy:
${excluded}
 * Dropped (no JS translation under the pinned bun): ${dropped.length === 0 ? "none" : dropped.join(", ")}.
 */

export interface GitleaksPattern {
  readonly source: string;
  readonly flags: string;
}

export interface GitleaksRule extends GitleaksPattern {
  readonly id: string;
  /** Lowercase; a rule runs only on text containing one of them (none: always). */
  readonly keywords: readonly string[];
  readonly entropy?: number;
  readonly secretGroup?: number;
  readonly allow?: { readonly regexes: readonly GitleaksPattern[]; readonly stopwords: readonly string[]; readonly target: "secret" | "match" };
}

export const GITLEAKS_VERSION = ${JSON.stringify(tag)};

export const GITLEAKS_GLOBAL_ALLOW: { readonly regexes: readonly GitleaksPattern[]; readonly stopwords: readonly string[] } = ${JSON.stringify(global)};

export const GITLEAKS_RULES: readonly GitleaksRule[] = [
${kept.map((r) => `  ${JSON.stringify(r)},`).join("\n")}
];
`;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { toml: { type: "string" }, tag: { type: "string" }, check: { type: "boolean", default: false } },
    strict: true,
  });
  if (values.toml === undefined || values.tag === undefined) {
    process.stderr.write("usage: bun scripts/vendor-gitleaks.ts --toml <gitleaks.toml> --tag <tag> [--check]\n");
    process.exit(2);
  }
  const text = build(values.toml, values.tag);
  if (values.check) {
    const same = readFileSync(OUT, "utf8") === text;
    process.stderr.write(same ? "gitleaks-rules.ts matches\n" : "gitleaks-rules.ts differs from a fresh generation\n");
    process.exit(same ? 0 : 1);
  }
  writeFileSync(OUT, text);
  process.stderr.write(`wrote ${OUT}\n`);
}
