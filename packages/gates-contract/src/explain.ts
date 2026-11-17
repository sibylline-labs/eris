/**
 * explain.ts — the plain-English explanation contract for control Schemas.
 *
 * The doctrine `policy:` block and `.claude/surfaces.yml` carry on the Schema itself what each
 * knob does, what it guards against, and what turning it up or down costs. Builders read it from
 * the JSON Schema document (`x-eris-explain`); `eris doctrine gates --explain` and the effect
 * renderer read it from the AST. Nothing restates it.
 *
 * Two annotations, so a shared enum and the field that uses it never overwrite each other
 * (`.annotate()` merges shallowly):
 *  - `explain` on a field: `summary`, `protects`, `raise`, `lower`, plus `keys` for an open record
 *    whose keys are known names (gate names under `gates`, stage names under `close`).
 *  - `meanings` on an enum: `summary`, one line per value, and `rank` (loosest first) where ordered.
 *
 * Each annotation also sets `description`, so the standard JSON Schema keyword and the structured
 * form cannot drift. Annotate before `.check()`: an annotation after a check lands on the check
 * and never reaches JSON.
 */

import * as Schema from "effect/Schema";
import * as AST from "effect/SchemaAST";

/** One known key of an open record (a gate under `gates`), or the shared part of a field's explanation. */
export interface KeyExplain {
  /** What it does, one sentence: the inline summary. */
  readonly summary: string;
  /** What it guards against, completing "Guards against …". */
  readonly protects: string;
  /** What turning it up (stricter) does and costs, a full sentence. */
  readonly raise: string;
  /** What turning it down (looser) saves and risks, a full sentence. */
  readonly lower: string;
}

export interface Explain extends KeyExplain {
  /** Explanations for the known keys of an open record. */
  readonly keys?: Readonly<Record<string, KeyExplain>> | undefined;
  /** What an absent value means for the effect direction: no cap (`loosest`) or no allowance (`strictest`). */
  readonly unset?: "loosest" | "strictest" | undefined;
  /** For a number, a duration or a list: whether `less` or `more` is stricter (a list defaults to `more`). */
  readonly stricter?: "less" | "more" | undefined;
  /** For a free string with ordered values (`profile_default`): the values from loosest to strictest. */
  readonly order?: readonly string[] | undefined;
}

export interface Meanings {
  /** What the value set is, one sentence. */
  readonly summary: string;
  /** One line per value. */
  readonly values: Readonly<Record<string, string>>;
  /** The values from loosest to strictest, when they are ordered. */
  readonly rank?: readonly string[] | undefined;
}

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      readonly explain?: Explain | undefined;
      readonly meanings?: Meanings | undefined;
    }
  }
}

/** The full description of a field or key: summary, what it guards against, and both directions. */
export function describe(e: KeyExplain): string {
  return `${e.summary} Guards against ${e.protects} Stricter: ${e.raise} Looser: ${e.lower}`;
}

/** The annotations for a control field: pass to `.annotate()` before any `.check()`. */
export function explained(e: Explain): Schema.Annotations.Annotations {
  return { description: describe(e), explain: e };
}

/** The annotations for an enum: what it is and what each value means. */
export function meant(m: Meanings): Schema.Annotations.Annotations {
  const values = Object.entries(m.values)
    .map(([v, text]) => `${v}: ${text}`)
    .join(" ");
  return { description: `${m.summary} ${values}`, meanings: m };
}

/** A described list item, record value or root: the summary alone. */
export function described(summary: string): Schema.Annotations.Annotations {
  return { description: summary };
}

const isNullish = (a: AST.AST): boolean => AST.isUndefined(a) || AST.isNull(a);

/**
 * The node that carries the annotations: `optional(X)` and `NullOr(X)` are
 * `Union[X, Undefined | Null]`, annotated on X when the union itself is not.
 */
export function unwrap(ast: AST.AST): AST.AST {
  if (!AST.isUnion(ast) || ast.annotations?.description !== undefined) return ast;
  const rest = ast.types.filter((t) => !isNullish(t));
  return rest.length === 1 && rest.length < ast.types.length ? unwrap(rest[0]!) : ast;
}

/** Every literal of an enum node (a Literal, or a Union of them, flattened), or the empty list. */
export function literalsOf(ast: AST.AST): string[] {
  if (AST.isLiteral(ast)) return [String(ast.literal)];
  if (!AST.isUnion(ast)) return [];
  return ast.types.flatMap((t) => (isNullish(t) ? [] : literalsOf(t)));
}

/** The members of a union that are neither literals nor null/undefined (a mixed union). */
function nonLiteralMembers(ast: AST.AST): AST.AST[] {
  if (!AST.isUnion(ast)) return [];
  return ast.types.flatMap((t) =>
    isNullish(t) || AST.isLiteral(t) ? [] : AST.isUnion(t) ? nonLiteralMembers(t) : [t],
  );
}

/** The `explain` annotation carried on an AST node (unwrapping `optionalKey` / `NullOr`). */
export function explainOf(ast: AST.AST): Explain | undefined {
  return unwrap(ast).annotations?.explain;
}

/** An enum's meanings: its own, else (a union of annotated enums, `NullOr(Mode)`) its members' merged. */
export function meaningsOf(raw: AST.AST): Meanings | undefined {
  const ast = unwrap(raw);
  const own = ast.annotations?.meanings;
  if (own !== undefined || !AST.isUnion(ast)) return own;
  const parts = ast.types
    .flatMap((t) => (isNullish(t) ? [] : [meaningsOf(t)]))
    .filter((m): m is Meanings => m !== undefined);
  if (parts.length === 0) return undefined;
  return {
    summary: parts.map((m) => m.summary).join(" "),
    values: Object.assign({}, ...parts.map((m) => m.values)) as Readonly<Record<string, string>>,
  };
}

type Role = "root" | "field" | "value" | "item";

export interface Gap {
  readonly path: string;
  readonly problem: string;
}

const blank = (s: unknown): boolean => typeof s !== "string" || s.trim() === "";

function explainGaps(e: Explain | undefined, at: string): Gap[] {
  if (e === undefined) return [{ path: at, problem: "no explain annotation (summary, protects, raise, lower)" }];
  const gaps: Gap[] = [];
  for (const k of ["summary", "protects", "raise", "lower"] as const) {
    if (blank(e[k])) gaps.push({ path: at, problem: `explain.${k} is empty` });
  }
  for (const [key, ke] of Object.entries(e.keys ?? {})) {
    for (const k of ["summary", "protects", "raise", "lower"] as const) {
      if (blank(ke[k])) gaps.push({ path: `${at}{${key}}`, problem: `explain.keys.${key}.${k} is empty` });
    }
  }
  return gaps;
}

function walk(raw: AST.AST, at: string, role: Role, out: Gap[]): void {
  const ast = unwrap(raw);
  if (AST.isDeclaration(ast) || AST.isSuspend(ast) || (ast.encoding !== undefined && ast.encoding.length > 0)) {
    out.push({
      path: at,
      problem: `unsupported shape (${ast._tag}${ast.encoding !== undefined ? ", encoded" : ""}): explain cannot walk it`,
    });
    return;
  }
  const a = ast.annotations;
  if (blank(a?.description)) out.push({ path: at, problem: "no description" });
  if (role === "field") out.push(...explainGaps(a?.explain, at));

  const literals = literalsOf(ast);
  if (literals.length > 0) {
    const m = meaningsOf(ast);
    if (m === undefined) out.push({ path: at, problem: `enum without meanings (${literals.join(", ")})` });
    else {
      for (const v of literals) if (blank(m.values[v])) out.push({ path: at, problem: `no meaning for value '${v}'` });
    }
  }
  for (const member of nonLiteralMembers(ast)) walk(member, at, "value", out);

  if (AST.isObjects(ast)) {
    for (const ps of ast.propertySignatures) walk(ps.type, `${at}.${String(ps.name)}`, "field", out);
    for (const is of ast.indexSignatures) walk(is.type, `${at}[*]`, "value", out);
  } else if (AST.isArrays(ast)) {
    for (const el of [...ast.elements, ...ast.rest]) walk(el, `${at}[]`, "item", out);
  }
}

/**
 * Every place `schema` is under-explained: a field without a
 * description and a full `explain`, a record value or list item without a
 * description, an enum without a meaning per value, or a shape the walk cannot
 * read. Empty means fully explained. Paths read `<root>.field[*]` / `[]`.
 */
export function undocumented(schema: Schema.Top, root = "$"): Gap[] {
  const out: Gap[] = [];
  walk(schema.ast, root, "root", out);
  return out;
}

type Json = Record<string, unknown>;
const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function inject(raw: AST.AST, node: unknown): void {
  if (!isJson(node)) return;
  const ast = unwrap(raw);
  // Some nodes drop the annotation on the way to JSON (Number emits as an anyOf).
  const description = ast.annotations?.description;
  if (typeof description === "string" && typeof node.description !== "string") node.description = description;
  const e = ast.annotations?.explain;
  const m = ast.annotations?.meanings;
  if (e !== undefined || m !== undefined) {
    node["x-eris-explain"] = {
      ...(m !== undefined
        ? { summary: m.summary, values: m.values, ...(m.rank !== undefined ? { rank: m.rank } : {}) }
        : {}),
      ...(e ?? {}),
    };
  }
  if (AST.isObjects(ast)) {
    const props = node.properties;
    if (isJson(props)) {
      for (const ps of ast.propertySignatures) inject(ps.type, props[String(ps.name)]);
    }
    const is = ast.indexSignatures[0];
    if (is !== undefined) inject(is.type, node.additionalProperties);
  } else if (AST.isArrays(ast)) {
    const prefix = Array.isArray(node.prefixItems) ? node.prefixItems : [];
    ast.elements.forEach((el, i) => inject(el, prefix[i]));
    const rest = ast.rest[0];
    if (rest !== undefined) inject(rest, node.items);
  } else if (AST.isUnion(ast) && Array.isArray(node.anyOf)) {
    const members = ast.types.filter((t) => !isNullish(t));
    members.forEach((t, i) => inject(t, (node.anyOf as unknown[])[i]));
  }
}

/**
 * `doc` (a `Schema.toJsonSchemaDocument(schema)` result) with each node's
 * `explain` and `meanings` merged in as `x-eris-explain`, which JSON Schema
 * generation drops. Node shapes are unchanged (enums stay `enum` arrays,
 * records stay `additionalProperties`), so existing readers are unaffected.
 */
export function explainDocument<D extends { readonly schema: unknown }>(schema: Schema.Top, doc: D): D {
  const copy = structuredClone(doc);
  inject(schema.ast, copy.schema);
  return copy;
}
