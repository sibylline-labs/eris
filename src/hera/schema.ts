/**
 * @sibylline-labs/hera/schema — Schema validation, decoding, and error
 * formatting helpers bridging schema definitions to canonical `ErisError`
 * diagnostics.
 */

import { ErisError, type FailureCategory } from "./cli";

export interface SchemaIssue {
  readonly path: string;
  readonly message: string;
}

export class HeraSchemaValidationError extends Error {
  readonly _tag = "HeraSchemaValidationError" as const;
  readonly issues: readonly SchemaIssue[];
  override readonly message: string;
  override readonly cause: unknown;

  constructor(options: {
    readonly issues: readonly SchemaIssue[];
    readonly message: string;
    readonly cause?: unknown;
  }) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "HeraSchemaValidationError";
    this.issues = options.issues;
    this.message = options.message;
    this.cause = options.cause;
  }
}

export type SchemaLike<A = unknown> =
  | {
      readonly safeParse: (
        input: unknown,
      ) =>
        | { readonly success: true; readonly data: A }
        | {
            readonly success: false;
            readonly error: {
              readonly issues?: readonly {
                readonly path?: readonly (string | number)[];
                readonly message: string;
              }[];
              readonly message?: string;
            };
          };
    }
  | {
      readonly parse: (input: unknown) => A;
    }
  | ((input: unknown) => A);

export interface ValidateInputOptions {
  readonly slug?: string;
  readonly category?: FailureCategory;
  readonly fix?: string;
  readonly docs?: string;
  readonly label?: string;
}

const DEFAULT_VALIDATION_CODE = ["schema", "validation", "failed"].join("-");
const DEFAULT_ENCODE_CODE = ["schema", "encode", "failed"].join("-");

export function formatSchemaMessage(error: unknown): {
  readonly summary: string;
  readonly issues: readonly SchemaIssue[];
} {
  if (
    typeof error === "object" &&
    error !== null &&
    "issues" in error &&
    Array.isArray((error as { issues?: unknown }).issues)
  ) {
    const rawIssues = (
      error as {
        issues: readonly { path?: readonly (string | number)[]; message?: string }[];
      }
    ).issues;
    const issues: SchemaIssue[] = rawIssues.map((iss) => ({
      path: Array.isArray(iss.path) && iss.path.length > 0 ? iss.path.map(String).join(".") : "<root>",
      message: iss.message ?? "Invalid value",
    }));
    const summary = issues.map((i) => (i.path === "<root>" ? i.message : `${i.path}: ${i.message}`)).join("; ");
    return {
      summary: summary || "Schema validation failed",
      issues,
    };
  }
  const raw = error instanceof Error ? error.message : String(error);
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const summary = lines.join("; ");
  return {
    summary: summary || "Schema validation failed",
    issues: [{ path: "<root>", message: summary || "Schema validation failed" }],
  };
}

function toValidationErisError(
  err: unknown,
  codeFallback: string,
  options?: ValidateInputOptions,
): ErisError {
  if (ErisError.isErisError(err)) return err;
  const { summary, issues } = formatSchemaMessage(err);
  const prefix = options?.label ? `Invalid ${options.label}: ` : "Validation failed: ";
  const code = options?.slug ?? codeFallback;
  return new ErisError({
    category: options?.category ?? "misuse",
    slug: code,
    message: `${prefix}${summary}`,
    fix: options?.fix ?? "Provide a payload matching the expected schema",
    docs: options?.docs,
    context: { issues },
    cause: new HeraSchemaValidationError({
      issues,
      message: `${prefix}${summary}`,
      cause: err,
    }),
  });
}

export function decodeUnknownSync<A>(
  schema: SchemaLike<A>,
  input: unknown,
  options?: ValidateInputOptions,
): A {
  try {
    if (typeof schema === "function") {
      return schema(input);
    }
    if ("safeParse" in schema && typeof schema.safeParse === "function") {
      const parsed = schema.safeParse(input);
      if (parsed.success) {
        return parsed.data;
      }
      throw toValidationErisError(parsed.error, DEFAULT_VALIDATION_CODE, options);
    }
    if ("parse" in schema && typeof schema.parse === "function") {
      return schema.parse(input);
    }
    throw new Error("Unsupported schema object");
  } catch (err) {
    throw toValidationErisError(err, DEFAULT_VALIDATION_CODE, options);
  }
}

export async function validateInput<A>(
  schema: SchemaLike<A>,
  input: unknown,
  options?: ValidateInputOptions,
): Promise<A> {
  return decodeUnknownSync(schema, input, options);
}

export async function decodeUnknownPromise<A>(
  schema: SchemaLike<A>,
  input: unknown,
  options?: ValidateInputOptions,
): Promise<A> {
  return decodeUnknownSync(schema, input, options);
}

export function encodeSync<A>(
  schema: SchemaLike<A>,
  value: A,
  options?: ValidateInputOptions,
): A {
  try {
    return decodeUnknownSync(schema, value, options);
  } catch (err) {
    throw toValidationErisError(err, DEFAULT_ENCODE_CODE, options);
  }
}

export type SafeParseResult<A> =
  | {
      readonly ok: true;
      readonly value: A;
      readonly data: A;
    }
  | {
      readonly ok: false;
      readonly error: ErisError;
      readonly issues: readonly SchemaIssue[];
      readonly summary: string;
    };

export interface HeraSchemaContract<A = unknown> {
  readonly name: string;
  readonly schema: SchemaLike<A>;
  decode(input: unknown, options?: ValidateInputOptions): A;
  safeParse(input: unknown, options?: ValidateInputOptions): SafeParseResult<A>;
  safeDecode(input: unknown, options?: ValidateInputOptions): SafeParseResult<A>;
}

export function define<A>(name: string, schema: SchemaLike<A>): HeraSchemaContract<A> {
  const safeParse = (input: unknown, options?: ValidateInputOptions): SafeParseResult<A> => {
    try {
      const value = decodeUnknownSync(schema, input, { label: name, ...options });
      return { ok: true, value, data: value };
    } catch (err) {
      const erisErr = toValidationErisError(err, DEFAULT_VALIDATION_CODE, {
        label: name,
        ...options,
      });
      const causeIssues =
        erisErr.cause instanceof HeraSchemaValidationError ? erisErr.cause.issues : [];
      return {
        ok: false,
        error: erisErr,
        issues: causeIssues,
        summary: erisErr.message,
      };
    }
  };

  return {
    name,
    schema,
    decode(input: unknown, options?: ValidateInputOptions): A {
      return decodeUnknownSync(schema, input, { label: name, ...options });
    },
    safeParse,
    safeDecode: safeParse,
  };
}

export const HeraSchema = {
  HeraSchemaValidationError,
  formatSchemaMessage,
  validateInput,
  decodeUnknownSync,
  decodeUnknownPromise,
  encodeSync,
  define,
} as const;
