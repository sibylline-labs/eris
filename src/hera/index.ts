/**
 * @sibylline-labs/hera — Shared TypeScript CLI, HTTP, and schema runtime.
 */

export {
  DEFAULT_CONCURRENCY,
  ErisError,
  EXIT_CODE_BY_CATEGORY,
  forEachBounded,
  HeraCli,
  completeFastPath,
  resolveConcurrency,
  resolveDeadlineMs,
  runPool,
  type BoundedPoolItemResult,
  type BoundedPoolOptions,
  type BoundedPoolResult,
  type CommandHandlerResult,
  type DispatchResult,
  type ErisErrorJsonEnvelope,
  type ErisErrorOptions,
  type FailureCategory,
  type FlagKind,
  type FlagSpec,
  type HeraAppSpec,
  type HeraCliCtx,
  type HeraCommandSpec,
  type InferFlags,
  type InferFlagValue,
  type JsonSuccessEnvelope,
  type OutputMode,
  type RunOptions,
} from "./cli";

export {
  HeraHttp,
  HeraHttpError,
  parseRetryAfter,
  RateLimitedError,
  type HeraHttpRequestOptions,
  type HeraHttpResponse,
  type HeraHttpRetryPolicy,
  type HttpErrorReason,
} from "./http";

export {
  decodeUnknownPromise,
  decodeUnknownSync,
  define,
  encodeSync,
  formatSchemaMessage,
  HeraSchema,
  type HeraSchemaContract,
  HeraSchemaValidationError,
  type SafeParseResult,
  validateInput,
  type SchemaIssue,
  type SchemaLike,
  type ValidateInputOptions,
} from "./schema";
