/**
 * scan.ts — what runs over text before eris sends it anywhere.
 *
 * Two layers, in this order:
 *
 *   1. The secret scan: the vendored gitleaks rules (gitleaks-rules.ts). A hit
 *      can never be overridden. The caller refuses and sends nothing.
 *   2. Our redaction classes (redact.ts): a match becomes `«redacted:<class>»`
 *      unless the caller allows that class. An allowed class is an override,
 *      and `prepareOutbound` reports what it let through so the caller can file
 *      it.
 *
 * Invariants:
 *   - A hit names the field and the rule, never the matched text, so a refusal
 *     cannot print the secret it refused.
 *   - A rule runs only on text holding one of its keywords (lowercase), and is
 *     compiled on first use, so most rules never compile for a given input.
 *   - `scanStrings` walks every string leaf of a value. A caller runs it over
 *     the request body it is about to send, so a field added later is scanned
 *     without being named here.
 */

import { GITLEAKS_GLOBAL_ALLOW, GITLEAKS_RULES, type GitleaksPattern, type GitleaksRule } from "./gitleaks-rules";
import { REDACTION_CLASSES, redact, type RedactionClass } from "./redact";

export interface SecretHit {
  /** The field (or the dotted path of a string leaf) the secret sits in. */
  readonly field: string;
  /** The gitleaks rule id. */
  readonly rule: string;
}

const compiled = new Map<GitleaksPattern, RegExp>();

function regex(p: GitleaksPattern, global: boolean): RegExp {
  let re = compiled.get(p);
  if (re === undefined) {
    re = new RegExp(p.source, global ? `${p.flags}g` : p.flags);
    compiled.set(p, re);
  }
  re.lastIndex = 0;
  return re;
}

function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** The secret a match carries: the rule's `secretGroup`, else gitleaks' default of the first non-empty group, else the whole match. */
function secretOf(rule: GitleaksRule, m: RegExpExecArray): string {
  if (rule.secretGroup !== undefined) return m[rule.secretGroup] ?? "";
  for (let i = 1; i < m.length; i++) if (m[i]) return m[i];
  return m[0];
}

function allowed(rule: GitleaksRule, secret: string, match: string): boolean {
  const lower = secret.toLowerCase();
  if (GITLEAKS_GLOBAL_ALLOW.stopwords.some((w) => lower.includes(w))) return true;
  if (GITLEAKS_GLOBAL_ALLOW.regexes.some((p) => regex(p, false).test(secret))) return true;
  const a = rule.allow;
  if (a === undefined) return false;
  if (a.stopwords.some((w) => lower.includes(w))) return true;
  const target = a.target === "match" ? match : secret;
  return a.regexes.some((p) => regex(p, false).test(target));
}

function ruleHits(rule: GitleaksRule, text: string): boolean {
  const re = regex(rule, true);
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const secret = secretOf(rule, m);
    if (secret.length === 0) continue;
    if (rule.entropy !== undefined && entropy(secret) <= rule.entropy) continue;
    if (allowed(rule, secret, m[0])) continue;
    return true;
  }
  return false;
}

/** The rules that fire on `text`, by id. */
export function secretRules(text: string): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  for (const rule of GITLEAKS_RULES) {
    if (rule.keywords.length > 0 && !rule.keywords.some((k) => lower.includes(k))) continue;
    if (ruleHits(rule, text)) out.push(rule.id);
  }
  return out;
}

/** Every secret in every named field. */
export function scanSecrets(fields: Readonly<Record<string, string | undefined>>): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const [field, text] of Object.entries(fields)) {
    if (text === undefined) continue;
    for (const rule of secretRules(text)) hits.push({ field, rule });
  }
  return hits;
}

/** Every secret in every string leaf of `value`, each named by its dotted path. */
export function scanStrings(value: unknown, path = ""): SecretHit[] {
  if (typeof value === "string") return secretRules(value).map((rule) => ({ field: path || "(value)", rule }));
  if (Array.isArray(value)) return value.flatMap((v, i) => scanStrings(v, path ? `${path}.${i}` : String(i)));
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => scanStrings(v, path ? `${path}.${k}` : k));
  }
  return [];
}

export function isRedactionClass(s: string): s is RedactionClass {
  return (REDACTION_CLASSES as readonly string[]).includes(s);
}

/** A class the caller allowed that matched, and where. */
export interface Override {
  readonly class: RedactionClass;
  readonly field: string;
  readonly count: number;
}

export type Outbound<F extends string> =
  | { readonly kind: "secret"; readonly hits: readonly SecretHit[] }
  | {
      readonly kind: "clean";
      readonly fields: Readonly<Record<F, string | undefined>>;
      /** What was redacted: the total and the classes, in pipeline order. */
      readonly redactions: { readonly count: number; readonly classes: readonly RedactionClass[] };
      /** What an allowed class let through, one entry per class and field. */
      readonly overrides: readonly Override[];
    };

/**
 * Scan `fields` for secrets; if there are none, redact them, leaving the text
 * of every class in `allow` as written. A secret hit returns before any
 * redaction runs: `allow` cannot reach it.
 */
export function prepareOutbound<F extends string>(fields: Readonly<Record<F, string | undefined>>, allow: ReadonlySet<RedactionClass> = new Set()): Outbound<F> {
  const hits = scanSecrets(fields);
  if (hits.length > 0) return { kind: "secret", hits };
  const out = {} as Record<F, string | undefined>;
  const counts = new Map<RedactionClass, number>();
  const overrides: Override[] = [];
  for (const field of Object.keys(fields) as F[]) {
    const text = fields[field];
    if (text === undefined) {
      out[field] = undefined;
      continue;
    }
    const r = redact(text, { skip: allow });
    out[field] = r.text;
    for (const c of REDACTION_CLASSES) if (r.counts[c] > 0) counts.set(c, (counts.get(c) ?? 0) + r.counts[c]);
    if (allow.size > 0) {
      const full = redact(text);
      for (const c of REDACTION_CLASSES) if (allow.has(c) && full.counts[c] > 0) overrides.push({ class: c, field, count: full.counts[c] });
    }
  }
  const classes = REDACTION_CLASSES.filter((c) => counts.has(c));
  const count = classes.reduce((n, c) => n + (counts.get(c) ?? 0), 0);
  return { kind: "clean", fields: out, redactions: { count, classes }, overrides };
}
