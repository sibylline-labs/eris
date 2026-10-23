/**
 * @sibylline-labs/hera/http — HTTP client with timeout, bounded retry/backoff,
 * typed `RateLimitedError` fail-fast on HTTP 429 (`Retry-After`), and response
 * schema decoding.
 */

import { HeraSchema, type SchemaLike } from "./schema";

// ---------------------------------------------------------------------------
// 1. Typed HTTP & Rate-Limit Errors
// ---------------------------------------------------------------------------

/**
 * Emitted immediately (fail-fast, never retried by default) when an upstream
 * endpoint responds with HTTP `429 Too Many Requests`.
 */
export class RateLimitedError extends Error {
  readonly _tag = "RateLimitedError" as const;
  readonly url: string;
  readonly method: string;
  readonly status = 429 as const;
  readonly retryAfterMs: number | null;
  readonly body: unknown;
  override readonly message: string;

  constructor(
    urlOrOptions:
      | string
      | {
          readonly url: string;
          readonly method?: string;
          readonly retryAfterMs?: number | null;
          readonly body?: unknown;
          readonly message?: string;
        },
    retryAfterMs?: number | null,
    message?: string,
  ) {
    const opts =
      typeof urlOrOptions === "string"
        ? {
            url: urlOrOptions,
            method: "POST",
            retryAfterMs: retryAfterMs ?? null,
            body: undefined,
            message:
              message ??
              `Rate limited (HTTP 429) on ${urlOrOptions}${
                retryAfterMs != null ? ` — retry after ${retryAfterMs}ms` : ""
              }`,
          }
        : {
            url: urlOrOptions.url,
            method: urlOrOptions.method ?? "GET",
            retryAfterMs: urlOrOptions.retryAfterMs ?? null,
            body: urlOrOptions.body,
            message:
              urlOrOptions.message ??
              `Rate limited (HTTP 429) on ${urlOrOptions.method ?? "GET"} ${urlOrOptions.url}${
                urlOrOptions.retryAfterMs != null ? ` — retry after ${urlOrOptions.retryAfterMs}ms` : ""
              }`,
          };
    super(opts.message);
    this.name = "RateLimitedError";
    this.url = opts.url;
    this.method = opts.method;
    this.retryAfterMs = opts.retryAfterMs;
    this.body = opts.body;
    this.message = opts.message;
  }

  static isRateLimitedError(u: unknown): u is RateLimitedError {
    return (
      u instanceof RateLimitedError ||
      (typeof u === "object" && u !== null && (u as { _tag?: unknown })._tag === "RateLimitedError")
    );
  }
}

export type HttpErrorReason = "NetworkError" | "TimeoutError" | "StatusError" | "DecodeError";

/**
 * General HTTP transport, timeout, non-2xx status, or payload decode error.
 */
export class HeraHttpError extends Error {
  readonly _tag = "HeraHttpError" as const;
  readonly reason: HttpErrorReason;
  readonly url: string;
  readonly method: string;
  readonly status: number | undefined;
  readonly body: unknown;
  override readonly message: string;
  override readonly cause: unknown;

  constructor(options: {
    readonly reason: HttpErrorReason;
    readonly url: string;
    readonly method: string;
    readonly status?: number;
    readonly body?: unknown;
    readonly message: string;
    readonly cause?: unknown;
  }) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "HeraHttpError";
    this.reason = options.reason;
    this.url = options.url;
    this.method = options.method;
    this.status = options.status;
    this.body = options.body;
    this.message = options.message;
    this.cause = options.cause;
  }

  static isHeraHttpError(u: unknown): u is HeraHttpError {
    return (
      u instanceof HeraHttpError ||
      (typeof u === "object" && u !== null && (u as { _tag?: unknown })._tag === "HeraHttpError")
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Retry-After Header Parsing
// ---------------------------------------------------------------------------

/**
 * Parses an HTTP `Retry-After` header value (seconds integer or HTTP-date)
 * into milliseconds. Returns `null` when missing or unparseable.
 */
export function parseRetryAfter(
  headerValue: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
  }

  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    return Math.max(0, parsedDate - nowMs);
  }

  return null;
}

// ---------------------------------------------------------------------------
// 3. Request Configuration & Retry Policy
// ---------------------------------------------------------------------------

export interface HeraHttpRetryPolicy {
  /** Maximum retry attempts after the initial request (default: `2`). */
  readonly maxRetries?: number;
  /** Base backoff delay in milliseconds (default: `100`). */
  readonly baseDelayMs?: number;
  /** Maximum backoff delay in milliseconds (default: `2_000`). */
  readonly maxDelayMs?: number;
  /** Retry on HTTP 429? Default is `false` (fail-fast with `RateLimitedError`). */
  readonly retryOn429?: boolean;
  /** Retryable status codes (default: `[408, 500, 502, 503, 504]`). */
  readonly retryStatusCodes?: readonly number[];
}

export interface HeraHttpRequestOptions<A = unknown> {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** Per-attempt timeout in milliseconds (default: `10_000`). */
  readonly timeoutMs?: number;
  readonly retry?: HeraHttpRetryPolicy;
  /** Optional schema to validate and decode the JSON response payload. */
  readonly schema?: SchemaLike<A>;
  /** Custom `fetch` implementation for deterministic unit testing. */
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Deterministic sleep override for testing backoff without wall-clock delay. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Optional deterministic RNG `[0, 1)` for jitter calculation in tests. */
  readonly random?: () => number;
  readonly signal?: AbortSignal;
}

export interface HeraHttpResponse<A = unknown> {
  readonly status: number;
  readonly headers: Headers;
  readonly data: A;
  readonly attempts: number;
}

const DEFAULT_RETRY_STATUS_CODES: ReadonlySet<number> = new Set([408, 500, 502, 503, 504]);

function computeBackoffMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  randomFn: () => number,
): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  const jitter = 0.5 + randomFn() * 0.5;
  return Math.max(1, Math.floor(exp * jitter));
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (text.length === 0) return null;
  if (contentType.includes("application/json") || text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// 4. Execution Engine
// ---------------------------------------------------------------------------

async function executeRequest<A = unknown>(
  url: string,
  options: HeraHttpRequestOptions<A> = {},
): Promise<HeraHttpResponse<A>> {
  const method = options.method ?? (options.body !== undefined ? "POST" : "GET");
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxRetries = options.retry?.maxRetries ?? 2;
  const baseDelayMs = options.retry?.baseDelayMs ?? 100;
  const maxDelayMs = options.retry?.maxDelayMs ?? 2_000;
  const retryOn429 = options.retry?.retryOn429 ?? false;
  const retryStatusSet = options.retry?.retryStatusCodes
    ? new Set(options.retry.retryStatusCodes)
    : DEFAULT_RETRY_STATUS_CODES;

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleepImpl =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const randomImpl = options.random ?? Math.random;

  const headers: Record<string, string> = {
    accept: "application/json",
    ...(options.headers ?? {}),
  };

  let serializedBody: BodyInit | undefined;
  if (options.body !== undefined) {
    if (typeof options.body === "string" || options.body instanceof Uint8Array) {
      serializedBody = options.body as BodyInit;
    } else {
      if (!headers["content-type"] && !headers["Content-Type"]) {
        headers["content-type"] = "application/json";
      }
      serializedBody = JSON.stringify(options.body);
    }
  }

  let attempts = 0;

  while (true) {
    attempts++;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onExternalAbort = () => controller.abort(options.signal?.reason);
    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer);
        throw new HeraHttpError({
          reason: "NetworkError",
          url,
          method,
          message: `Request to ${method} ${url} was aborted before dispatch`,
          cause: options.signal.reason,
        });
      }
      options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: serializedBody,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);

      if (timedOut) {
        const timeoutErr = new HeraHttpError({
          reason: "TimeoutError",
          url,
          method,
          message: `HTTP ${method} ${url} timed out after ${timeoutMs}ms (attempt ${attempts})`,
          cause: err,
        });
        if (attempts <= maxRetries) {
          const delay = computeBackoffMs(attempts, baseDelayMs, maxDelayMs, randomImpl);
          await sleepImpl(delay);
          continue;
        }
        throw timeoutErr;
      }

      const netErr = new HeraHttpError({
        reason: "NetworkError",
        url,
        method,
        message: `HTTP ${method} ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
      if (attempts <= maxRetries && !options.signal?.aborted) {
        const delay = computeBackoffMs(attempts, baseDelayMs, maxDelayMs, randomImpl);
        await sleepImpl(delay);
        continue;
      }
      throw netErr;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }

    const parsedBody = await parseResponseBody(response);

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      const rateLimitErr = new RateLimitedError({
        url,
        method,
        retryAfterMs,
        body: parsedBody,
        message: `Rate limited (HTTP 429) on ${method} ${url}${
          retryAfterMs !== null ? ` — retry after ${retryAfterMs}ms` : ""
        }`,
      });

      if (retryOn429 && attempts <= maxRetries) {
        const delay =
          retryAfterMs !== null
            ? Math.min(retryAfterMs, maxDelayMs)
            : computeBackoffMs(attempts, baseDelayMs, maxDelayMs, randomImpl);
        await sleepImpl(delay);
        continue;
      }

      throw rateLimitErr;
    }

    if (response.status < 200 || response.status >= 300) {
      const statusErr = new HeraHttpError({
        reason: "StatusError",
        url,
        method,
        status: response.status,
        body: parsedBody,
        message: `HTTP ${method} ${url} returned ${response.status}`,
      });

      if (retryStatusSet.has(response.status) && attempts <= maxRetries) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        const delay =
          retryAfterMs !== null
            ? Math.min(retryAfterMs, maxDelayMs)
            : computeBackoffMs(attempts, baseDelayMs, maxDelayMs, randomImpl);
        await sleepImpl(delay);
        continue;
      }

      throw statusErr;
    }

    if (options.schema) {
      try {
        const decoded = HeraSchema.decodeUnknownSync(options.schema, parsedBody, {
          label: `${method} ${url} response`,
        });
        return {
          status: response.status,
          headers: response.headers,
          data: decoded,
          attempts,
        };
      } catch (decodeErr) {
        throw new HeraHttpError({
          reason: "DecodeError",
          url,
          method,
          status: response.status,
          body: parsedBody,
          message: `Failed to decode response from ${method} ${url}: ${
            decodeErr instanceof Error ? decodeErr.message : String(decodeErr)
          }`,
          cause: decodeErr,
        });
      }
    }

    return {
      status: response.status,
      headers: response.headers,
      data: parsedBody as A,
      attempts,
    };
  }
}

export const HeraHttp = {
  parseRetryAfter,
  RateLimitedError,
  HeraHttpError,

  /**
   * Executes an HTTP request with timeout, retry/backoff, `429` fail-fast,
   * and optional schema validation.
   */
  request: executeRequest,

  /**
   * Convenience helper for `GET` requests returning decoded JSON.
   */
  async getJson<A = unknown>(
    url: string,
    options?: Omit<HeraHttpRequestOptions<A>, "method" | "body">,
  ): Promise<A> {
    const res = await executeRequest<A>(url, { ...options, method: "GET" });
    return res.data;
  },

  /**
   * Convenience helper for `POST` requests with a JSON body returning decoded JSON.
   */
  async postJson<A = unknown>(
    url: string,
    body: unknown,
    options?: Omit<HeraHttpRequestOptions<A>, "method" | "body">,
  ): Promise<A> {
    const res = await executeRequest<A>(url, { ...options, method: "POST", body });
    return res.data;
  },
} as const;
