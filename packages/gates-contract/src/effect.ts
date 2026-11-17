/**
 * effect.ts — the effect-diff renderer: given the before and after values of a control Schema,
 * one sentence per changed knob, read from the Schema's own explanations (explain.ts), e.g.
 *
 *   gates.plan-review: lite → on. Plans now get the full review before any code, adding about one review round.
 *
 * `effects` is generic over any explained Schema. Doctrine semantics (an unnamed gate is `on`, a
 * class owes its floor) live in `policyEffects`'s normalizer, so the walk never learns them.
 * `eris doctrine effect` prints the result.
 */

import * as Schema from "effect/Schema";
import * as AST from "effect/SchemaAST";
import { effectiveAsk } from "./active";
import { decodeResult, decodeResultStrict } from "./decode";
import { effectiveRemediate, gateMode, requirementsFor } from "./doctrine";
import { type Explain, explainOf, type KeyExplain, literalsOf, meaningsOf, unwrap } from "./explain";
import { type ContractFailure, fail, type Outcome, succeed } from "./failure";
import { DoctrinePolicy, U_CLASSES } from "./policy";
import type { Profile } from "./profile";
import { DEFAULT_AUDIT_TTL, DEFAULT_CHANGE_BUDGET, DEFAULT_SEVERITY_FLOOR, SurfacesFile } from "./surfaces";

export const EffectValue = Schema.Union([Schema.String, Schema.Number, Schema.Array(Schema.String), Schema.Null]);
export type EffectValue = typeof EffectValue.Type;

export const EFFECT_DIRECTIONS = ["raise", "lower", "change"] as const;

/** One changed knob: where (`path`, joined as `knob`), from what, to what, which way, and the sentence a human reads. */
export const ControlEffect = Schema.Struct({
  path: Schema.Array(Schema.String),
  knob: Schema.String,
  before: EffectValue,
  after: EffectValue,
  direction: Schema.Literals(EFFECT_DIRECTIONS),
  sentence: Schema.String,
});
export type ControlEffect = typeof ControlEffect.Type;
type Direction = ControlEffect["direction"];

type Json = Record<string, unknown>;
const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** The value as an effect reports it: strings and numbers as they are, a list of strings, a present object as `registered`, absent as null. */
function shown(v: unknown): EffectValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" || typeof v === "number") return v;
  if (Array.isArray(v)) return v.map(String);
  return "registered";
}

function fmt(v: EffectValue): string {
  if (v === null) return "unset";
  if (Array.isArray(v)) return v.length > 0 ? v.join(", ") : "none";
  return String(v);
}

const DURATION = /^(\d+)([dh])$/;
function magnitude(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  const m = typeof v === "string" ? DURATION.exec(v) : null;
  return m === null ? undefined : Number(m[1]) * (m[2] === "d" ? 24 : 1);
}

/** Which way a leaf moved: by rank for an ordered enum, by size for a number or duration, by set inclusion for a list. */
function directionOf(ast: AST.AST, e: Explain | undefined, before: unknown, after: unknown): Direction {
  if ((before === undefined) !== (after === undefined) && e?.unset !== undefined && (Array.isArray(before) || Array.isArray(after)))
    return (after === undefined) === (e.unset === "loosest") ? "lower" : "raise";
  if (Array.isArray(before) || Array.isArray(after)) {
    const b = new Set((before as unknown[] | undefined) ?? []);
    const a = new Set((after as unknown[] | undefined) ?? []);
    const grew = [...b].every((x) => a.has(x));
    const shrank = [...a].every((x) => b.has(x));
    const dir: Direction = grew && !shrank ? "raise" : shrank && !grew ? "lower" : "change";
    // A list where more is looser (remediate.on: more triggers hand more failures to an agent).
    return e?.stricter === "less" && dir !== "change" ? (dir === "raise" ? "lower" : "raise") : dir;
  }
  const rank = meaningsOf(ast)?.rank ?? e?.order;
  if (rank !== undefined) {
    const pos = (v: unknown): number | undefined => {
      if (v === undefined || v === null) return e?.unset === "loosest" ? 0 : e?.unset === "strictest" ? rank.length : undefined;
      const i = rank.indexOf(String(v));
      return i === -1 ? undefined : i;
    };
    const b = pos(before);
    const a = pos(after);
    if (b !== undefined && a !== undefined && a !== b) return a > b ? "raise" : "lower";
    return "change";
  }
  const b = magnitude(before);
  const a = magnitude(after);
  if (b !== undefined && a !== undefined && e?.stricter !== undefined && a !== b) return (a < b) === (e.stricter === "less") ? "raise" : "lower";
  if ((before === undefined) !== (after === undefined) && e?.unset !== undefined)
    return (after === undefined) === (e.unset === "loosest") ? "lower" : "raise";
  return "change";
}

function sentence(knob: string, ast: AST.AST, text: KeyExplain | undefined, direction: Direction, before: unknown, after: unknown): string {
  const head = `${knob}: ${fmt(shown(before))} → ${fmt(shown(after))}.`;
  const body = text === undefined ? "" : direction === "raise" ? text.raise : direction === "lower" ? text.lower : text.summary;
  const parts = [head, body];
  const item = AST.isArrays(ast) ? ast.rest[0] : undefined;
  if (item !== undefined) {
    const meanings = meaningsOf(item)?.values ?? {};
    const b = new Set((before as unknown[] | undefined) ?? []);
    const a = new Set((after as unknown[] | undefined) ?? []);
    for (const x of a) if (!b.has(x)) parts.push(`Adds ${String(x)}${meanings[String(x)] !== undefined ? `: ${meanings[String(x)]}` : "."}`);
    for (const x of b) if (!a.has(x)) parts.push(`Drops ${String(x)}${meanings[String(x)] !== undefined ? `: ${meanings[String(x)]}` : "."}`);
  } else if (direction === "change" && literalsOf(ast).length > 0 && after !== undefined) {
    const meaning = meaningsOf(ast)?.values[String(after)];
    if (meaning !== undefined) parts.push(`${String(after)}: ${meaning}`);
  }
  return parts.filter((p) => p !== "").join(" ");
}

/** A list is a set here: reordering `escalate_on` or `paths` changes nothing. */
const canonical = (v: unknown): unknown => (Array.isArray(v) ? [...v].map(String).sort() : v ?? null);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function walk(raw: AST.AST, before: unknown, after: unknown, path: string[], text: KeyExplain | undefined, explain: Explain | undefined, out: ControlEffect[]): void {
  const ast = unwrap(raw);
  if (AST.isObjects(ast) && ast.propertySignatures.length > 0 && (isJson(before) || isJson(after))) {
    for (const ps of ast.propertySignatures) {
      const k = String(ps.name);
      const e = explainOf(ps.type);
      walk(ps.type, isJson(before) ? before[k] : undefined, isJson(after) ? after[k] : undefined, [...path, k], e, e, out);
    }
    return;
  }
  const is = AST.isObjects(ast) ? ast.indexSignatures[0] : undefined;
  if (is !== undefined && (isJson(before) || isJson(after))) {
    const b = isJson(before) ? before : {};
    const a = isJson(after) ? after : {};
    const keys = [...Object.keys(b), ...Object.keys(a).filter((k) => !(k in b))];
    for (const k of keys) {
      const value = unwrap(is.type);
      const bothObjects = isJson(b[k]) && isJson(a[k]);
      if (bothObjects) walk(value, b[k], a[k], [...path, k], explainOf(value), explainOf(value), out);
      else leaf(value, b[k], a[k], [...path, k], explain?.keys?.[k] ?? explain, explain, out);
    }
    return;
  }
  leaf(ast, before, after, path, text, explain, out);
}

function leaf(ast: AST.AST, before: unknown, after: unknown, path: string[], text: KeyExplain | undefined, explain: Explain | undefined, out: ControlEffect[]): void {
  if (same(before, after)) return;
  // An unset value that means the loosest one (no ceiling = R2) is no change.
  const loosest = meaningsOf(ast)?.rank?.[0];
  if (explain?.unset === "loosest" && loosest !== undefined && [before, after].includes(undefined) && [before, after].includes(loosest)) return;
  const mb = magnitude(before);
  if (mb !== undefined && mb === magnitude(after)) return; // 30d and 720h are the same window
  const direction = directionOf(ast, explain, before, after);
  const knob = path.join(".");
  out.push({ path, knob, before: shown(before), after: shown(after), direction, sentence: sentence(knob, ast, text, direction, before, after) });
}

/** One effect per knob whose value differs between `before` and `after` (either may be null: all unset). */
export function effects(schema: Schema.Top, before: unknown, after: unknown): ControlEffect[] {
  const out: ControlEffect[] = [];
  walk(schema.ast, before ?? {}, after ?? {}, [], undefined, undefined, out);
  return out;
}

/** The ask block as it takes effect: the timeout as the policy writes it (`none` or `<n>h`), the budget as a number. */
function askView(policy: DoctrinePolicy | null | undefined): Json {
  const a = effectiveAsk(policy);
  return { two_way_timeout: a.two_way_timeout_hours === null ? "none" : `${a.two_way_timeout_hours}h`, digest: a.digest, session_budget: a.session_budget };
}

/** The signoff block as it takes effect: `unlock` defaults to `"off"`, and `raise` shares one surface key universe across both sides. */
function signoffView(policy: DoctrinePolicy | null | undefined, other: DoctrinePolicy | null | undefined): Json | undefined {
  const s = policy?.signoff;
  const o = other?.signoff;
  if (s === undefined && o === undefined) return undefined;
  const raised = [...new Set([...Object.keys(s?.raise ?? {}), ...Object.keys(o?.raise ?? {})])];
  return {
    ...(s ?? {}),
    ...(s?.unlock !== undefined || o?.unlock !== undefined ? { unlock: s?.unlock ?? "off" } : {}),
    ...(raised.length > 0 ? { raise: Object.fromEntries(raised.map((k) => [k, s?.raise?.[k] ?? {}])) } : {}),
  };
}

/**
 * The policy as it takes effect, over one key universe for both sides: every
 * gate the profiles require or either side names, at its effective mode; every
 * close stage either side names, default `on`; each class's requirements as
 * floor ∪ raise; `signoff` with `unlock` default `off` and `raise` surfaces aligned; a `remediate` block with its defaults filled; an `ask` block, when either side has one, with its defaults filled. A null policy is the all-defaults posture.
 */
export function effectivePolicyView(profiles: Readonly<Record<string, Profile>>, policy: DoctrinePolicy | null | undefined, other: DoctrinePolicy | null | undefined): Json {
  const gates = new Set<string>();
  for (const p of Object.values(profiles)) for (const g of p.require) gates.add(g);
  for (const g of [...Object.keys(policy?.gates ?? {}), ...Object.keys(other?.gates ?? {})]) gates.add(g);
  const closes = [...new Set([...Object.keys(policy?.close ?? {}), ...Object.keys(other?.close ?? {})])];
  const signoff = signoffView(policy, other);
  return {
    ...(policy ?? {}),
    gates: Object.fromEntries([...gates].map((g) => [g, gateMode(policy, g)])),
    ...(closes.length > 0 ? { close: Object.fromEntries(closes.map((s) => [s, policy?.close?.[s] ?? "on"])) } : {}),
    ...(signoff !== undefined ? { signoff } : {}),
    user_impact: Object.fromEntries(U_CLASSES.map((u) => [u, requirementsFor(u, policy?.user_impact?.[u])])),
    ...(policy?.remediate !== undefined ? { remediate: effectiveRemediate(policy) } : {}),
    ...(policy?.ask !== undefined || other?.ask !== undefined ? { ask: askView(policy) } : {}),
  };
}

/** The effects of switching from posture policy `before` to `after`, as `gate check` would apply them. */
export function policyEffects(profiles: Readonly<Record<string, Profile>>, before: DoctrinePolicy | null | undefined, after: DoctrinePolicy | null | undefined): ControlEffect[] {
  return effects(DoctrinePolicy, effectivePolicyView(profiles, before, after), effectivePolicyView(profiles, after, before));
}

function surfacesView(file: SurfacesFile | null | undefined): Json {
  const surfaces = Object.fromEntries(
    Object.entries(file?.surfaces ?? {}).map(([name, s]) => [
      name,
      { ...s, severity_floor: s.severity_floor ?? DEFAULT_SEVERITY_FLOOR, audit_ttl: s.audit_ttl ?? DEFAULT_AUDIT_TTL, change_budget: s.change_budget ?? DEFAULT_CHANGE_BUDGET },
    ]),
  );
  return { surfaces };
}

/** The effects of an edit to `.claude/surfaces.yml`, with each surface's defaults filled in on both sides. */
export function surfacesEffects(before: SurfacesFile | null | undefined, after: SurfacesFile | null | undefined): ControlEffect[] {
  return effects(SurfacesFile, surfacesView(before), surfacesView(after));
}

/** What `eris doctrine effect` reads on stdin: which contract, and its two values (absent or null: all defaults). */
export const EffectInput = Schema.Struct({
  contract: Schema.Literals(["policy", "surfaces"]),
  before: Schema.optionalKey(Schema.Unknown),
  after: Schema.optionalKey(Schema.Unknown),
});

const usage = (what: string, fix: string): ContractFailure => ({ slug: "doctrine-usage", what: `doctrine effect: ${what}`, fix, docs: "docs/DOCTRINE.md#effect", exit: 2 });

/** One side of the pair decoded through its contract's Schema, or a failure naming the side and the first problem. */
function decodeSide<S extends Schema.Top>(schema: S, contract: "policy" | "surfaces", side: string, value: unknown): Outcome<S["Type"] | null> {
  if (value === undefined || value === null) return succeed(null);
  const r = contract === "policy" ? decodeResult(schema, value) : decodeResultStrict(schema, value);
  if (r._tag === "Success") return succeed(r.success as S["Type"]);
  const first = r.failure.issues[0];
  const at = first !== undefined && first.path.length > 0 ? `${first.path.join(".")}: ` : "";
  const what = `doctrine effect: ${side}: ${at}${first?.message ?? r.failure.message}`;
  return fail(
    contract === "policy"
      ? { slug: "doctrine-policy-invalid", what, fix: "Pass a policy: value that 'eris doctrine check' accepts.", docs: "docs/ERRORS.md#doctrine-policy-invalid", exit: 3 }
      : { slug: "gate-surfaces-invalid", what, fix: "Pass a surfaces value that matches the .claude/surfaces.yml Schema.", docs: "docs/ERRORS.md#gate-surfaces-invalid", exit: 3 },
  );
}

/**
 * The effects of the `{contract, before, after}` text `raw` (stdin): bad JSON or shape is
 * `doctrine-usage`; a side that does not decode is `doctrine-policy-invalid` /
 * `gate-surfaces-invalid`, naming `before:` or `after:`.
 */
export function effectsOfInput(raw: string, profiles: Readonly<Record<string, Profile>>, fix: string): Outcome<ControlEffect[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail(usage("stdin is not valid JSON", fix));
  }
  const input = decodeResult(EffectInput, parsed);
  if (input._tag === "Failure") return fail(usage(`stdin must be {"contract": "policy"|"surfaces", "before", "after"} (${input.failure.message})`, fix));
  const { contract, before, after } = input.success;
  if (contract === "policy") {
    const b = decodeSide(DoctrinePolicy, contract, "before", before);
    if (!b.ok) return b;
    const a = decodeSide(DoctrinePolicy, contract, "after", after);
    if (!a.ok) return a;
    return succeed(policyEffects(profiles, b.value, a.value));
  }
  const b = decodeSide(SurfacesFile, contract, "before", before);
  if (!b.ok) return b;
  const a = decodeSide(SurfacesFile, contract, "after", after);
  if (!a.ok) return a;
  return succeed(surfacesEffects(b.value, a.value));
}
