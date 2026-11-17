/**
 * decode.ts — value-stripping synchronous Schema decode for the contract.
 *
 * `decodeResult` strips object keys the Schema does not declare; `decodeResultStrict` refuses
 * them with an `UnexpectedKey` issue (path segment `$key`), for operator-authored config. A
 * failure carries structural issues only: the path, an issue code, the `expected` text a check
 * declares, and a static message. The rejected value is never echoed, and neither is a record key
 * that came from the input (it renders as `$key`), so a problem line never repeats a secret a user
 * pasted into a policy.
 *
 * The problem text (`Expected <expected>`, `Missing required key`, `Expected any of: …`) is the
 * text every doctrine problem line prints, so it is fixed here and not left to Effect's own
 * formatter, whose wording can change between releases.
 */

import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import type * as SchemaIssue from "effect/SchemaIssue";

export type IssueCode = "InvalidType" | "InvalidValue" | "MissingKey" | "UnexpectedKey" | "Filter" | "Encoding" | "Forbidden" | "Composite" | "AnyOf" | "OneOf";

/** One value-stripped problem: where, what kind, what the Schema expected, and the line a human reads. */
export interface DecodeIssue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly code: IssueCode;
  readonly expected: string;
  readonly message: string;
}

/** A failed decode: every issue, and their one-line summary. */
export interface DecodeFailure {
  readonly message: string;
  readonly issues: ReadonlyArray<DecodeIssue>;
}

export type DecodeResult<A> = Result.Result<A, DecodeFailure>;

const PARSE_STRIPPED: SchemaAST.ParseOptions = Object.freeze({ errors: "all", reportInput: false });
const PARSE_STRICT: SchemaAST.ParseOptions = Object.freeze({ ...PARSE_STRIPPED, onExcessProperty: "error" });

/** A path as a reader writes it: `a.b`, `a[0]`, `a["kebab-key"]`. */
export function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${String(seg)}]`;
    else if (typeof seg === "symbol") {
      const text = seg.description ? `Symbol(${seg.description})` : "Symbol()";
      out += out.length === 0 ? text : `.${text}`;
    } else {
      const str = String(seg);
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(str)) out += out.length === 0 ? str : `.${str}`;
      else out += `[${JSON.stringify(str)}]`;
    }
  }
  return out;
}

function summary(issues: ReadonlyArray<DecodeIssue>): string {
  if (issues.length === 0) return "Schema validation failed";
  return issues
    .map((issue) => {
      const at = formatIssuePath(issue.path);
      return at.length > 0 ? `${at}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/** An `expected`, `identifier` or `title` annotation, never `message` (a filter may build that from the input). */
function staticAnnotation(annotations: Schema.Annotations.Annotations | undefined): string | undefined {
  if (!annotations) return undefined;
  if (typeof annotations.expected === "string" && annotations.expected.length > 0) return annotations.expected;
  if (typeof annotations.identifier === "string" && annotations.identifier.length > 0) return annotations.identifier;
  if (typeof annotations.title === "string" && annotations.title.length > 0) return annotations.title;
  return undefined;
}

function describeChecks(checks: ReadonlyArray<SchemaAST.Check<any>> | undefined): string | undefined {
  if (!checks) return undefined;
  for (let i = checks.length - 1; i >= 0; i--) {
    const found = staticAnnotation(checks[i]?.annotations);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** What a node expects, from its annotations, else its checks, else its shape. Never reads input. */
function describeAst(ast: SchemaAST.AST): string {
  const own = staticAnnotation(ast.annotations) ?? describeChecks(ast.checks);
  if (own !== undefined) return own;
  switch (ast._tag) {
    case "String":
      return "string";
    case "Number":
      return "number";
    case "Boolean":
      return "boolean";
    case "BigInt":
      return "bigint";
    case "Symbol":
      return "symbol";
    case "Null":
      return "null";
    case "Undefined":
      return "undefined";
    case "Void":
      return "void";
    case "Never":
      return "never";
    case "Unknown":
      return "unknown";
    case "Any":
      return "any";
    case "ObjectKeyword":
      return "object";
    case "UniqueSymbol":
      return typeof ast.symbol.description === "string" ? `Symbol(${ast.symbol.description})` : "symbol";
    case "Literal":
      return typeof ast.literal === "string" ? JSON.stringify(ast.literal) : String(ast.literal);
    case "Enum":
      return ast.enums.map(([, val]) => JSON.stringify(val)).join(" | ") || "enum";
    case "TemplateLiteral":
      return "template literal";
    case "Arrays":
      return "array";
    case "Objects":
      return "object";
    case "Union": {
      const parts = ast.types.map((member) => describeAst(member));
      return parts.length > 0 ? parts.join(" | ") : "never";
    }
    case "Suspend":
      return describeAst(ast.thunk());
    case "Declaration":
      return "Declaration";
  }
}

function describeFilter(filter: SchemaAST.Filter<any>, fallback?: SchemaAST.AST): string {
  return staticAnnotation(filter.annotations) ?? (fallback !== undefined ? describeAst(fallback) : "constraint satisfaction");
}

/** A pointer path with every input-derived key (a record key, an undeclared key) replaced by `$key`. */
function sanitizePointer(pointer: ReadonlyArray<PropertyKey>, parent: SchemaAST.AST | undefined): { sanitized: PropertyKey[]; child: SchemaAST.AST | undefined } {
  const sanitized: PropertyKey[] = [];
  let current = parent;
  for (const seg of pointer) {
    if (current !== undefined) {
      const node = current._tag === "Suspend" ? current.thunk() : current;
      if (node._tag === "Objects") {
        const prop = node.propertySignatures.find((ps) => ps.name === seg);
        if (prop !== undefined) {
          sanitized.push(seg);
          current = prop.type;
          continue;
        }
        sanitized.push("$key");
        current = node.indexSignatures[0]?.type;
        continue;
      }
      if (node._tag === "Arrays") {
        if (typeof seg === "number") {
          sanitized.push(seg);
          current = seg < node.elements.length ? node.elements[seg] : node.rest[0];
          continue;
        }
        sanitized.push("$index");
        current = node.rest[0] ?? node.elements[0];
        continue;
      }
    }
    sanitized.push(seg);
    current = undefined;
  }
  return { sanitized, child: current };
}

function collect(issue: SchemaIssue.Issue, path: ReadonlyArray<PropertyKey>, parent?: SchemaAST.AST): DecodeIssue[] {
  switch (issue._tag) {
    case "Pointer": {
      if (issue.issue._tag === "UnexpectedKey") return collect(issue.issue, [...path, "$key"], parent);
      const { sanitized, child } = sanitizePointer(issue.path, parent);
      return collect(issue.issue, [...path, ...sanitized], child);
    }
    case "Composite": {
      const out = issue.issues.flatMap((child) => collect(child, path, issue.ast));
      if (out.length > 0) return out;
      const expected = describeAst(issue.ast);
      return [{ path, code: "Composite", expected, message: `Expected ${expected}` }];
    }
    case "Filter": {
      const expected = describeFilter(issue.filter, parent);
      if (issue.issue._tag === "InvalidValue") return [{ path, code: "Filter", expected, message: `Expected ${expected}` }];
      return collect(issue.issue, path, parent).map((item) => ({
        path: item.path,
        code: "Filter",
        expected: item.expected === "valid value" ? expected : item.expected,
        message: item.expected === "valid value" ? `Expected ${expected}` : item.message,
      }));
    }
    case "Encoding": {
      if (issue.issue._tag === "InvalidValue" || issue.issue._tag === "Forbidden") {
        const expected = describeAst(issue.ast);
        return [{ path, code: "Encoding", expected, message: `Encoding failed for ${expected}` }];
      }
      return collect(issue.issue, path, issue.ast).map((item) => ({ ...item, code: item.code === "InvalidValue" ? "Encoding" : item.code }));
    }
    case "MissingKey": {
      const expected = staticAnnotation(issue.annotations) ?? (parent !== undefined ? describeAst(parent) : "required property");
      return [{ path, code: "MissingKey", expected, message: "Missing required key" }];
    }
    case "UnexpectedKey":
      return [{ path, code: "UnexpectedKey", expected: "no unexpected keys", message: "Unexpected key in object" }];
    case "InvalidType": {
      const expected = describeAst(issue.ast);
      return [{ path, code: "InvalidType", expected, message: `Expected ${expected}` }];
    }
    case "InvalidValue": {
      const expected = staticAnnotation(issue.annotations) ?? (parent !== undefined ? describeAst(parent) : "valid value");
      return [{ path, code: "InvalidValue", expected, message: `Expected ${expected}` }];
    }
    case "Forbidden": {
      const expected = staticAnnotation(issue.annotations) ?? (parent !== undefined ? describeAst(parent) : "permitted operation");
      return [{ path, code: "Forbidden", expected, message: `Forbidden operation (${expected})` }];
    }
    case "AnyOf": {
      // One member failing on unknown keys alone is that member plus typos: report the keys, not the union.
      const onlyUnknownKeys = issue.issues
        .map((child) => collect(child, path, issue.ast))
        .filter((items) => items.length > 0 && items.every((item) => item.code === "UnexpectedKey"));
      if (onlyUnknownKeys.length === 1 && onlyUnknownKeys[0] !== undefined) return onlyUnknownKeys[0];
      const expected = describeAst(issue.ast);
      return [{ path, code: "AnyOf", expected, message: `Expected any of: ${expected}` }];
    }
    case "OneOf": {
      const expected = describeAst(issue.ast);
      return [{ path, code: "OneOf", expected, message: `Expected exactly one of: ${expected}` }];
    }
  }
}

function failure(issues: ReadonlyArray<DecodeIssue>): DecodeFailure {
  return { message: summary(issues), issues };
}

function run<S extends Schema.Top>(schema: S, options: SchemaAST.ParseOptions, input: unknown): DecodeResult<S["Type"]> {
  const exit = Schema.decodeUnknownExit(schema as S & { readonly DecodingServices: never })(input, options);
  if (exit._tag === "Success") return Result.succeed(exit.value);
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail");
  if (reason !== undefined && reason._tag === "Fail") return Result.fail(failure(collect(reason.error.issue, [])));
  return Result.fail(failure([]));
}

/** Decode `input` through `schema`, stripping undeclared keys; never throws. */
export function decodeResult<S extends Schema.Top>(schema: S, input: unknown): DecodeResult<S["Type"]> {
  return run(schema, PARSE_STRIPPED, input);
}

/** `decodeResult` that refuses any undeclared key (`$key: Unexpected key in object`). */
export function decodeResultStrict<S extends Schema.Top>(schema: S, input: unknown): DecodeResult<S["Type"]> {
  return run(schema, PARSE_STRICT, input);
}
