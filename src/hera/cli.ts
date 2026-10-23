/**
 * @sibylline-labs/hera/cli — Typed CLI runtime, flag & subcommand router,
 * dual-mode (`--output json` / human) envelope formatter, bounded concurrency
 * helper, and canonical `ErisError` hierarchy.
 */

import { readEnv } from "../runtime/env";
import { docsRoot, identity, installRoot, installRootIsUnwritten } from "../runtime/home";

// ---------------------------------------------------------------------------
// 1. Canonical Error Hierarchy & Exit-Code Contract
// ---------------------------------------------------------------------------

/**
 * Failure category mapped deterministically to POSIX / CLI exit codes:
 * - `runtime` (1): general operational or runtime failure
 * - `misuse` (2): invalid CLI arguments, unknown flags, or contract misuse
 * - `precondition` (3): missing dependency, uninitialized state, or environment precondition failure
 * - `timeout` (124): subprocess, lock, or HTTP deadline exceeded
 */
export type FailureCategory = "misuse" | "runtime" | "precondition" | "timeout";

export const EXIT_CODE_BY_CATEGORY: Readonly<Record<FailureCategory, 1 | 2 | 3 | 124>> = {
  runtime: 1,
  misuse: 2,
  precondition: 3,
  timeout: 124,
};

export interface ErisFailureInput {
  slug: string;
  what: string;
  fix?: string;
  docs?: string;
}

export function erisHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const override = readEnv(env, "ERIS_DIR");
  if (override && override.length > 0) return override;
  return installRoot();
}

export function splitFixLines(fix: string | undefined): string[] {
  if (!fix || fix.length === 0) return [];
  const withTrailingNewline = `${fix}\n`;
  const parts = withTrailingNewline.split("\n");
  parts.pop();
  return parts;
}

export function failureLines(input: ErisFailureInput, home: string | null): string[] {
  const lines: string[] = [];
  lines.push(`ERROR ${input.what}`);
  lines.push(`slug: ${input.slug}`);
  for (const fixLine of splitFixLines(input.fix)) {
    lines.push(`fix: ${fixLine}`);
  }
  const docsRel = input.docs && input.docs.length > 0 ? input.docs : `docs/ERRORS.md#${input.slug}`;
  const local = home === null || (installRootIsUnwritten() && home === installRoot()) ? null : home;
  lines.push(`docs: ${local === null ? docsRel : `${docsRoot(local, docsRel)}/${docsRel}`}`);
  lines.push(`docs: ${identity().docsBase}/${docsRel}`);
  return lines;
}

export interface ErisErrorOptions {
  readonly category?: FailureCategory;
  readonly slug: string;
  readonly message?: string;
  readonly what?: string;
  readonly fix?: string;
  readonly docs?: string;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly hint?: string;
  readonly cause?: unknown;
  readonly exitCode?: number;
}

export interface ErisErrorJsonEnvelope {
  readonly ok: false;
  readonly verb?: string;
  readonly error: {
    readonly slug: string;
    readonly message: string;
    readonly category: FailureCategory;
    readonly exit_code: number;
    readonly fix: string;
    readonly docs: string;
    readonly hint?: string;
    readonly context?: Readonly<Record<string, unknown>>;
  };
}

/**
 * Canonical structured CLI error.
 * Renders the byte-identical failure block in human mode and a structured JSON
 * envelope when `--output json` is active.
 */
export class ErisError extends Error {
  readonly _tag = "ErisError" as const;
  readonly category: FailureCategory;
  readonly slug: string;
  override readonly message: string;
  readonly what: string;
  readonly fix: string;
  readonly docs: string;
  readonly explicitDocs: string | undefined;
  readonly context: Readonly<Record<string, unknown>> | undefined;
  readonly hint: string | undefined;
  override readonly cause: unknown;
  private readonly explicitExitCode: number | undefined;

  constructor(options: ErisErrorOptions) {
    const msg = options.message ?? options.what ?? "";
    super(msg, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ErisError";
    this.category = options.category ?? "runtime";
    this.slug = options.slug;
    this.message = msg;
    this.what = msg;
    this.fix = options.fix ?? "";
    this.explicitDocs = options.docs && options.docs.length > 0 ? options.docs : undefined;
    this.docs = this.explicitDocs ?? `docs/ERRORS.md#${options.slug}`;
    this.context = options.context;
    this.hint = options.hint;
    this.cause = options.cause;
    this.explicitExitCode = options.exitCode;
  }

  get exitCode(): number {
    return this.explicitExitCode ?? EXIT_CODE_BY_CATEGORY[this.category];
  }

  /**
   * Renders the canonical human-mode failure block byte-identically to `ts/lib/eris-fail.ts`.
   */
  renderFailureBlock(home: string | null = erisHome()): string {
    return failureLines(
      {
        slug: this.slug,
        what: this.message,
        fix: this.fix,
        docs: this.explicitDocs,
      },
      home,
    )
      .map((line) => `${line}\n`)
      .join("");
  }

  /**
   * Produces the canonical JSON error envelope for `--output json` mode.
   */
  toEnvelope(verb?: string): ErisErrorJsonEnvelope {
    return {
      ok: false,
      ...(verb !== undefined ? { verb } : {}),
      error: {
        slug: this.slug,
        message: this.message,
        category: this.category,
        exit_code: this.exitCode,
        fix: this.fix,
        docs: this.docs,
        ...(this.hint !== undefined ? { hint: this.hint } : {}),
        ...(this.context !== undefined ? { context: this.context } : {}),
      },
    };
  }

  static isErisError(u: unknown): u is ErisError {
    return (
      u instanceof ErisError ||
      (typeof u === "object" && u !== null && (u as { _tag?: unknown })._tag === "ErisError")
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Output Mode & Envelope Formatting
// ---------------------------------------------------------------------------

export type OutputMode = "human" | "json";

export interface JsonSuccessEnvelope<T = unknown> {
  readonly ok: true;
  readonly verb?: string;
  readonly data: T;
}

// ---------------------------------------------------------------------------
// 3. Flag & Command Specifications
// ---------------------------------------------------------------------------

export type FlagKind = "boolean" | "string" | "number" | "string[]";

export interface FlagSpec<K extends FlagKind = FlagKind> {
  readonly type: K;
  readonly alias?: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly default?: K extends "boolean"
    ? boolean
    : K extends "string"
      ? string
      : K extends "number"
        ? number
        : K extends "string[]"
          ? readonly string[]
          : unknown;
  readonly env?: string;
  readonly completions?: readonly string[];
}

export type InferFlagValue<F extends FlagSpec> = F["type"] extends "boolean"
  ? boolean
  : F["type"] extends "string"
    ? F["required"] extends true
      ? string
      : F["default"] extends string
        ? string
        : string | undefined
    : F["type"] extends "number"
      ? F["required"] extends true
        ? number
        : F["default"] extends number
          ? number
          : number | undefined
      : F["type"] extends "string[]"
        ? readonly string[]
        : unknown;

export type InferFlags<Flags extends Record<string, FlagSpec>> = {
  readonly [K in keyof Flags]: InferFlagValue<Flags[K]>;
};

export interface HeraCliCtx<Flags extends Record<string, FlagSpec> = Record<string, FlagSpec>> {
  readonly verb: string;
  readonly args: readonly string[];
  readonly flags: InferFlags<Flags>;
  readonly outputMode: OutputMode;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export type CommandHandlerResult<R> = Promise<R> | R;

export interface HeraCommandSpec<
  Flags extends Record<string, FlagSpec> = Record<string, FlagSpec>,
  R = unknown,
> {
  readonly name: string;
  readonly summary: string;
  readonly description?: string;
  readonly flags?: Flags;
  readonly supportsJson?: boolean;
  readonly subcommands?: Readonly<Record<string, HeraCommandSpec<Record<string, FlagSpec>, unknown>>>;
  renderHuman?(result: R, ctx: HeraCliCtx<Flags>): string | void;
  handler?(ctx: HeraCliCtx<Flags>): CommandHandlerResult<R>;
}

export interface HeraAppSpec {
  readonly name: string;
  readonly version: string;
  readonly summary?: string;
  readonly defaultConcurrency?: number;
  readonly defaultTimeoutMs?: number;
  readonly concurrencyEnvVar?: string;
  readonly timeoutEnvVar?: string;
  readonly commands: Readonly<Record<string, HeraCommandSpec<Record<string, FlagSpec>, unknown>>>;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly signal?: AbortSignal;
  readonly erisRoot?: string;
}

export interface DispatchResult<R = unknown> {
  readonly exitCode: number;
  readonly outputMode: OutputMode;
  readonly stdout: string;
  readonly stderr: string;
  readonly value?: R;
  readonly error?: ErisError;
}

// ---------------------------------------------------------------------------
// 4. Bounded Concurrency & Env Resolution (`forEachBounded` / `runPool`)
// ---------------------------------------------------------------------------

/** The clamp when `ERIS_BATCH_CONCURRENCY` is unset, empty, or invalid. */
export const DEFAULT_CONCURRENCY = 8;

/**
 * Resolves `ERIS_BATCH_CONCURRENCY` (from a raw env string or env record) and
 * clamps to `DEFAULT_CONCURRENCY` (8) when unset, empty, non-numeric, or `< 1`.
 * Never returns an unbounded value.
 */
export function resolveConcurrency(
  raw?: string | Readonly<Record<string, string | undefined>>,
): number {
  const val =
    typeof raw === "object" && raw !== null ? readEnv(raw, "ERIS_BATCH_CONCURRENCY") : raw;
  if (val === undefined) return DEFAULT_CONCURRENCY;
  const trimmed = val.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return DEFAULT_CONCURRENCY;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n >= 1 ? n : DEFAULT_CONCURRENCY;
}

/**
 * Resolves `ERIS_SUBPROCESS_TIMEOUT` (seconds, from a raw env string or env record)
 * into milliseconds. When unset, empty, or invalid, returns `fallbackMs` (default 60_000ms).
 */
export function resolveDeadlineMs(
  raw?: string | Readonly<Record<string, string | undefined>>,
  fallbackMs: number = 60_000,
): number {
  const val =
    typeof raw === "object" && raw !== null ? readEnv(raw, "ERIS_SUBPROCESS_TIMEOUT") : raw;
  if (val === undefined) return fallbackMs;
  const trimmed = val.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return fallbackMs;
  const secs = Number(trimmed);
  const ms = secs * 1000;
  return Number.isSafeInteger(ms) && ms >= 1000 ? ms : fallbackMs;
}

function readEnvInt(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = readEnv(env, key);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
}

function makeHeraError(
  category: FailureCategory,
  code: string,
  message: string,
  fix: string,
  cause?: unknown,
): ErisError {
  return new ErisError({ category, slug: code, message, fix, cause });
}

export interface BoundedPoolOptions {
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly deadlineSlug?: string;
}

export type BoundedPoolItemResult<B> =
  | { readonly status: "fulfilled"; readonly index: number; readonly value: B }
  | { readonly status: "rejected"; readonly index: number; readonly reason: unknown };

export type BoundedPoolResult<B> = readonly B[];

/**
 * Executes an async operation across `items` with bounded concurrency,
 * preserving input order and propagating abort / deadline cancellation.
 */
export async function forEachBounded<A, B>(
  items: readonly A[],
  fn: (item: A, index: number, signal: AbortSignal) => Promise<B>,
  options?: BoundedPoolOptions,
): Promise<B[]>;
export async function forEachBounded<A, B>(
  items: readonly A[],
  concurrency: number,
  fn: (item: A, index: number, signal: AbortSignal) => Promise<B>,
  options?: BoundedPoolOptions,
): Promise<B[]>;
export async function forEachBounded<A, B>(
  items: readonly A[],
  concurrencyOrFn: number | ((item: A, index: number, signal: AbortSignal) => Promise<B>),
  fnOrOptions?:
    | ((item: A, index: number, signal: AbortSignal) => Promise<B>)
    | BoundedPoolOptions,
  maybeOptions?: BoundedPoolOptions,
): Promise<B[]> {
  const fn =
    typeof concurrencyOrFn === "function"
      ? concurrencyOrFn
      : (fnOrOptions as (item: A, index: number, signal: AbortSignal) => Promise<B>);
  const options =
    typeof concurrencyOrFn === "function"
      ? (fnOrOptions as BoundedPoolOptions | undefined)
      : maybeOptions;
  const rawConcurrency =
    typeof concurrencyOrFn === "number"
      ? concurrencyOrFn
      : (options?.concurrency ?? DEFAULT_CONCURRENCY);

  if (items.length === 0) return [];
  const limit =
    Number.isFinite(rawConcurrency) && rawConcurrency >= 1 ? Math.floor(rawConcurrency) : 1;

  const controller = new AbortController();
  const onParentAbort = () => controller.abort(options?.signal?.reason);
  if (options?.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason);
    } else {
      options.signal.addEventListener("abort", onParentAbort, { once: true });
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  if (options?.deadlineMs !== undefined && options.deadlineMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(
        makeHeraError(
          "timeout",
          options.deadlineSlug ?? "batch-deadline-exceeded",
          `Batch execution exceeded deadline of ${options.deadlineMs}ms`,
          "Increase ERIS_SUBPROCESS_TIMEOUT or reduce batch size",
        ),
      );
    }, options.deadlineMs);
  }

  const results = new Array<B>(items.length);
  let nextIndex = 0;

  async function slot(): Promise<void> {
    while (true) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (ErisError.isErisError(reason)) throw reason;
        throw makeHeraError(
          timedOut ? "timeout" : "runtime",
          options?.deadlineSlug ?? "batch-aborted",
          reason instanceof Error ? reason.message : "Batch execution aborted",
          "Retry the command or increase ERIS_SUBPROCESS_TIMEOUT",
          reason,
        );
      }
      const idx = nextIndex++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]!, idx, controller.signal);
    }
  }

  try {
    const workerCount = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => slot()));
    return results;
  } catch (err) {
    if (ErisError.isErisError(err)) throw err;
    if (timedOut) {
      throw makeHeraError(
        "timeout",
        options?.deadlineSlug ?? "batch-deadline-exceeded",
        `Batch execution exceeded deadline of ${options?.deadlineMs}ms`,
        "Increase ERIS_SUBPROCESS_TIMEOUT or reduce batch size",
        err,
      );
    }
    if (err instanceof Error) throw err;
    throw makeHeraError(
      "runtime",
      "batch-worker-failed",
      String(err),
      "Inspect the failing item and retry",
      err,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (options?.signal) {
      options.signal.removeEventListener("abort", onParentAbort);
    }
  }
}

/**
 * Alias for `forEachBounded` preserving the `runPool` signature exported by
 * `src/sdk.ts`, `src/cli/plugin.ts`, and `src/runtime/process.ts`.
 */
export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  options?: BoundedPoolOptions,
): Promise<R[]> {
  return forEachBounded(items, concurrency, worker, options);
}

// ---------------------------------------------------------------------------
// 5. Fast-Path Completion & Help Rendering (<50ms Cold-Start Safe)
// ---------------------------------------------------------------------------

function formatCommandHelp(appName: string, verbPath: string, cmd: HeraCommandSpec): string {
  const lines: string[] = [];
  lines.push(`${appName} ${verbPath} — ${cmd.summary}`);
  if (cmd.description) {
    lines.push("", cmd.description);
  }
  lines.push("", `Usage: ${appName} ${verbPath} [options]`);

  if (cmd.subcommands && Object.keys(cmd.subcommands).length > 0) {
    lines.push("", "Subcommands:");
    for (const [subName, subSpec] of Object.entries(cmd.subcommands)) {
      lines.push(`  ${subName.padEnd(18)} ${subSpec.summary}`);
    }
  }

  const flagEntries = Object.entries(cmd.flags ?? {});
  lines.push("", "Options:");
  for (const [flagName, spec] of flagEntries) {
    const aliasPart = spec.alias ? `-${spec.alias}, ` : "    ";
    const typeHint = spec.type === "boolean" ? "" : ` <${spec.type}>`;
    const flagCol = `${aliasPart}--${flagName}${typeHint}`.padEnd(26);
    const reqPart = spec.required ? " (required)" : "";
    const envPart = spec.env ? ` [env: ${spec.env}]` : "";
    lines.push(`  ${flagCol} ${spec.description ?? ""}${reqPart}${envPart}`);
  }
  lines.push(`      --output <mode>        Output mode: human | json`);
  lines.push(`  -h, --help                 Show this help message`);
  return `${lines.join("\n")}\n`;
}

function formatAppHelp(spec: HeraAppSpec): string {
  const lines: string[] = [];
  lines.push(`${spec.name} v${spec.version}${spec.summary ? ` — ${spec.summary}` : ""}`);
  lines.push("", `Usage: ${spec.name} <command> [subcommand] [options]`);
  lines.push("", "Commands:");
  for (const [name, cmd] of Object.entries(spec.commands)) {
    lines.push(`  ${name.padEnd(18)} ${cmd.summary}`);
  }
  lines.push("", "Global Options:");
  lines.push("      --output <mode>        Output format (human | json)");
  lines.push("  -h, --help                 Show help");
  lines.push("  -V, --version              Show version");
  return `${lines.join("\n")}\n`;
}

/**
 * Generates completion candidates without loading heavy verb handlers.
 * Designed for `<50ms` tab-completion cold-start latency.
 */
export function completeFastPath(spec: HeraAppSpec, words: readonly string[]): readonly string[] {
  const cleaned = words.filter((w) => w.length > 0);
  if (cleaned.length === 0) {
    return Object.keys(spec.commands);
  }
  const first = cleaned[0]!;
  const cmd = spec.commands[first];
  if (!cmd) {
    return Object.keys(spec.commands).filter((k) => k.startsWith(first));
  }
  if (cleaned.length === 1) {
    const subKeys = Object.keys(cmd.subcommands ?? {});
    if (subKeys.length > 0) return subKeys;
    return Object.keys(cmd.flags ?? {}).map((f) => `--${f}`);
  }
  const second = cleaned[1]!;
  if (cmd.subcommands && cmd.subcommands[second]) {
    const sub = cmd.subcommands[second]!;
    const last = cleaned[cleaned.length - 1] ?? "";
    if (last.startsWith("-")) {
      return Object.keys(sub.flags ?? {})
        .map((f) => `--${f}`)
        .filter((f) => f.startsWith(last));
    }
    return Object.keys(sub.flags ?? {}).map((f) => `--${f}`);
  }
  if (cmd.subcommands) {
    const matchingSubs = Object.keys(cmd.subcommands).filter((k) => k.startsWith(second));
    if (matchingSubs.length > 0) return matchingSubs;
  }
  const last = cleaned[cleaned.length - 1] ?? "";
  const allFlags = [
    ...Object.keys(cmd.flags ?? {}).map((f) => `--${f}`),
    "--output",
    "--help",
  ];
  return last.startsWith("-") ? allFlags.filter((f) => f.startsWith(last)) : allFlags;
}

// ---------------------------------------------------------------------------
// 6. Flag Parser & Validator
// ---------------------------------------------------------------------------

interface ParsedCliTokens {
  readonly outputMode: OutputMode;
  readonly helpRequested: boolean;
  readonly versionRequested: boolean;
  readonly rawFlags: Map<string, string[]>;
  readonly positionals: string[];
}

function tokenizeArgv(
  argv: readonly string[],
  knownFlags: Readonly<Record<string, FlagSpec>>,
): ParsedCliTokens {
  let outputMode: OutputMode = "human";
  let helpRequested = false;
  let versionRequested = false;
  const rawFlags = new Map<string, string[]>();
  const positionals: string[] = [];

  const aliasToName = new Map<string, string>();
  for (const [name, spec] of Object.entries(knownFlags)) {
    if (spec.alias) aliasToName.set(spec.alias, name);
  }

  const pushFlag = (name: string, val: string) => {
    const existing = rawFlags.get(name);
    if (existing) existing.push(val);
    else rawFlags.set(name, [val]);
  };

  let i = 0;
  let passthrough = false;
  while (i < argv.length) {
    const token = argv[i]!;
    if (passthrough) {
      positionals.push(token);
      i++;
      continue;
    }
    if (token === "--") {
      passthrough = true;
      i++;
      continue;
    }
    if (token === "-h" || token === "--help") {
      helpRequested = true;
      i++;
      continue;
    }
    if (token === "-V" || token === "--version") {
      versionRequested = true;
      i++;
      continue;
    }
    if (token === "--output" || token.startsWith("--output=")) {
      const val = token.includes("=") ? token.slice("--output=".length) : argv[++i];
      if (val !== "human" && val !== "json") {
        throw makeHeraError(
          "misuse",
          "cli-invalid-output-mode",
          `Invalid --output mode '${val ?? ""}'. Expected 'human' or 'json'.`,
          "Pass --output human or --output json",
        );
      }
      outputMode = val;
      i++;
      continue;
    }
    if (token === "--json") {
      outputMode = "json";
      i++;
      continue;
    }

    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      const name = eqIdx >= 0 ? token.slice(2, eqIdx) : token.slice(2);
      const spec = knownFlags[name];
      if (!spec) {
        throw makeHeraError(
          "misuse",
          "cli-unknown-flag",
          `Unknown flag '--${name}'`,
          "Run with --help to see supported flags",
        );
      }
      if (spec.type === "boolean") {
        const boolVal = eqIdx >= 0 ? token.slice(eqIdx + 1) : "true";
        pushFlag(name, boolVal);
        i++;
        continue;
      }
      const val = eqIdx >= 0 ? token.slice(eqIdx + 1) : argv[++i];
      if (val === undefined || (eqIdx < 0 && val.startsWith("-") && val !== "-")) {
        throw makeHeraError(
          "misuse",
          "cli-missing-flag-value",
          `Flag '--${name}' requires a <${spec.type}> value`,
          `Provide a value after --${name}`,
        );
      }
      pushFlag(name, val);
      i++;
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const short = token.slice(1);
      const mapped = aliasToName.get(short);
      if (!mapped) {
        throw makeHeraError(
          "misuse",
          "cli-unknown-flag",
          `Unknown short flag '-${short}'`,
          "Run with --help to see supported flags",
        );
      }
      const spec = knownFlags[mapped]!;
      if (spec.type === "boolean") {
        pushFlag(mapped, "true");
        i++;
        continue;
      }
      const val = argv[++i];
      if (val === undefined) {
        throw makeHeraError(
          "misuse",
          "cli-missing-flag-value",
          `Flag '-${short}' (--${mapped}) requires a <${spec.type}> value`,
          `Provide a value after -${short}`,
        );
      }
      pushFlag(mapped, val);
      i++;
      continue;
    }

    positionals.push(token);
    i++;
  }

  return { outputMode, helpRequested, versionRequested, rawFlags, positionals };
}

function resolveValidatedFlags<Flags extends Record<string, FlagSpec>>(
  flagSpecs: Flags,
  rawFlags: Map<string, string[]>,
  env: Readonly<Record<string, string | undefined>>,
): InferFlags<Flags> {
  const resolved: Record<string, unknown> = {};

  for (const [name, spec] of Object.entries(flagSpecs)) {
    const rawValues = rawFlags.get(name);
    const envVal = spec.env ? readEnv(env, spec.env) : undefined;

    if (spec.type === "boolean") {
      if (rawValues && rawValues.length > 0) {
        const last = rawValues[rawValues.length - 1]!.toLowerCase();
        if (last === "true" || last === "1") resolved[name] = true;
        else if (last === "false" || last === "0") resolved[name] = false;
        else {
          throw makeHeraError(
            "misuse",
            "cli-invalid-flag-value",
            `Invalid boolean value '${last}' for --${name}`,
            `Use --${name}=true or --${name}=false`,
          );
        }
      } else if (envVal !== undefined && envVal !== "") {
        resolved[name] = envVal === "true" || envVal === "1";
      } else {
        resolved[name] = spec.default ?? false;
      }
      continue;
    }

    if (spec.type === "string[]") {
      if (rawValues && rawValues.length > 0) {
        resolved[name] = rawValues;
      } else if (envVal !== undefined && envVal !== "") {
        resolved[name] = envVal.split(",").map((s) => s.trim()).filter(Boolean);
      } else {
        resolved[name] = spec.default ?? [];
      }
      continue;
    }

    const rawSingle =
      rawValues && rawValues.length > 0 ? rawValues[rawValues.length - 1] : envVal;

    if (rawSingle === undefined || rawSingle === "") {
      if (spec.required) {
        throw makeHeraError(
          "misuse",
          "cli-missing-required-flag",
          `Missing required flag '--${name}'`,
          `Pass --${name} <${spec.type}>${spec.env ? ` or set ${spec.env}` : ""}`,
        );
      }
      resolved[name] = spec.default;
      continue;
    }

    if (spec.type === "number") {
      const num = Number(rawSingle);
      if (!Number.isFinite(num)) {
        throw makeHeraError(
          "misuse",
          "cli-invalid-flag-value",
          `Flag '--${name}' expected a finite number, got '${rawSingle}'`,
          `Pass a valid numeric value to --${name}`,
        );
      }
      resolved[name] = num;
      continue;
    }

    resolved[name] = rawSingle;
  }

  return resolved as InferFlags<Flags>;
}

// ---------------------------------------------------------------------------
// 7. Router & Dispatcher
// ---------------------------------------------------------------------------

function resolveCommandRoute(
  spec: HeraAppSpec,
  argv: readonly string[],
): {
  readonly verbPath: string;
  readonly command: HeraCommandSpec | undefined;
  readonly remainingArgv: readonly string[];
} {
  const firstNonFlagIdx = argv.findIndex((t) => !t.startsWith("-"));
  if (firstNonFlagIdx === -1) {
    return { verbPath: "", command: undefined, remainingArgv: argv };
  }
  const verbName = argv[firstNonFlagIdx]!;
  const topCmd = spec.commands[verbName];
  if (!topCmd) {
    return { verbPath: verbName, command: undefined, remainingArgv: argv };
  }

  const afterTop = [...argv.slice(0, firstNonFlagIdx), ...argv.slice(firstNonFlagIdx + 1)];
  if (topCmd.subcommands) {
    const nextPosIdx = afterTop.findIndex((t) => !t.startsWith("-"));
    if (nextPosIdx !== -1) {
      const subName = afterTop[nextPosIdx]!;
      const subCmd = topCmd.subcommands[subName];
      if (subCmd) {
        const remaining = [
          ...afterTop.slice(0, nextPosIdx),
          ...afterTop.slice(nextPosIdx + 1),
        ];
        return {
          verbPath: `${verbName} ${subName}`,
          command: subCmd,
          remainingArgv: remaining,
        };
      }
    }
  }

  return { verbPath: verbName, command: topCmd, remainingArgv: afterTop };
}

function detectOutputModePrePass(argv: readonly string[]): OutputMode {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") break;
    if (token === "--json" || token === "--output=json") return "json";
    if (token === "--output" && argv[i + 1] === "json") return "json";
  }
  return "human";
}

export const HeraCli = {
  ErisError,
  EXIT_CODE_BY_CATEGORY,
  DEFAULT_CONCURRENCY,
  resolveConcurrency,
  resolveDeadlineMs,
  forEachBounded,
  runPool,
  completeFastPath,

  /**
   * Defines a typed command specification with full flag inference.
   */
  command<Flags extends Record<string, FlagSpec> = Record<string, FlagSpec>, R = unknown>(
    spec: HeraCommandSpec<Flags, R>,
  ): HeraCommandSpec<Flags, R> {
    return spec;
  },

  /**
   * Defines a top-level CLI application specification.
   */
  app(spec: HeraAppSpec): HeraAppSpec {
    return spec;
  },

  /**
   * Parses raw `argv` against a map of `FlagSpec` definitions.
   */
  parseFlags<Flags extends Record<string, FlagSpec>>(
    argv: readonly string[],
    flags: Flags,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): {
    readonly flags: InferFlags<Flags>;
    readonly args: readonly string[];
    readonly outputMode: OutputMode;
    readonly helpRequested: boolean;
  } {
    const tokens = tokenizeArgv(argv, flags);
    const resolved = resolveValidatedFlags(flags, tokens.rawFlags, env);
    return {
      flags: resolved,
      args: tokens.positionals,
      outputMode: tokens.outputMode,
      helpRequested: tokens.helpRequested,
    };
  },

  /**
   * Dispatches `argv` against `appSpec` and captures exit code, stdout, stderr,
   * and typed return value / error.
   */
  async dispatch<R = unknown>(
    appSpec: HeraAppSpec,
    argv: readonly string[],
    options?: RunOptions,
  ): Promise<DispatchResult<R>> {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const writeOut = (text: string) => {
      stdoutChunks.push(text);
      options?.stdout?.(text);
    };
    const writeErr = (text: string) => {
      stderrChunks.push(text);
      options?.stderr?.(text);
    };

    const env = options?.env ?? process.env;
    const cwd = options?.cwd ?? process.cwd();
    const rootDir = options?.erisRoot ?? erisHome(env);
    const preOutputMode = detectOutputModePrePass(argv);

    // 1. Fast-path completion (`__complete` or `completion`)
    if (argv[0] === "__complete" || argv[0] === "completion") {
      const candidates = completeFastPath(appSpec, argv.slice(1));
      if ( candidates.length > 0) {
        writeOut(`${candidates.join("\n")}\n`);
      }
      return {
        exitCode: 0,
        outputMode: "human",
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
      };
    }

    // 2. Fast-path top-level `--version` / `-V`
    if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-V")) {
      if (preOutputMode === "json") {
        writeOut(`${JSON.stringify({ ok: true, data: { name: appSpec.name, version: appSpec.version } })}\n`);
      } else {
        writeOut(`${appSpec.name} ${appSpec.version}\n`);
      }
      return {
        exitCode: 0,
        outputMode: preOutputMode,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
      };
    }

    // 3. Fast-path bare invocation or top-level `--help` / `-h`
    if (argv.length === 0 || (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h"))) {
      writeOut(formatAppHelp(appSpec));
      return {
        exitCode: 0,
        outputMode: "human",
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
      };
    }

    const route = resolveCommandRoute(appSpec, argv);

    try {
      if (!route.command) {
        throw makeHeraError(
          "misuse",
          "cli-unknown-command",
          `Unknown command '${route.verbPath || argv[0] || ""}'`,
          `Run '${appSpec.name} --help' to list available commands`,
        );
      }

      const cmd = route.command;
      const tokens = tokenizeArgv(route.remainingArgv, cmd.flags ?? {});

      if (tokens.versionRequested) {
        writeOut(`${appSpec.name} ${appSpec.version}\n`);
        return {
          exitCode: 0,
          outputMode: tokens.outputMode,
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
        };
      }

      if (tokens.helpRequested || (!cmd.handler && cmd.subcommands)) {
        writeOut(formatCommandHelp(appSpec.name, route.verbPath, cmd));
        return {
          exitCode: 0,
          outputMode: "human",
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
        };
      }

      if (tokens.outputMode === "json" && cmd.supportsJson === false) {
        throw makeHeraError(
          "misuse",
          "output-json-unsupported",
          `'${appSpec.name} ${route.verbPath}' does not support --output json`,
          `Omit --output json when running '${appSpec.name} ${route.verbPath}'`,
        );
      }

      if (!cmd.handler) {
        throw makeHeraError(
          "misuse",
          "cli-missing-subcommand",
          `Command '${route.verbPath}' requires a subcommand`,
          `Run '${appSpec.name} ${route.verbPath} --help' to see available subcommands`,
        );
      }

      const validatedFlags = resolveValidatedFlags(cmd.flags ?? {}, tokens.rawFlags, env);

      const concurrency = readEnvInt(
        env,
        appSpec.concurrencyEnvVar ?? "ERIS_BATCH_CONCURRENCY",
        appSpec.defaultConcurrency ?? DEFAULT_CONCURRENCY,
        1,
        128,
      );
      const timeoutMs =
        readEnvInt(
          env,
          appSpec.timeoutEnvVar ?? "ERIS_SUBPROCESS_TIMEOUT",
          Math.floor((appSpec.defaultTimeoutMs ?? 30_000) / 1000),
          1,
          3600,
        ) * 1000;

      const controller = new AbortController();
      if (options?.signal) {
        if (options.signal.aborted) controller.abort(options.signal.reason);
        else options.signal.addEventListener("abort", () => controller.abort(options.signal?.reason), { once: true });
      }

      const ctx: HeraCliCtx<Record<string, FlagSpec>> = {
        verb: route.verbPath,
        args: tokens.positionals,
        flags: validatedFlags,
        outputMode: tokens.outputMode,
        cwd,
        env,
        concurrency,
        timeoutMs,
        signal: controller.signal,
        stdout: writeOut,
        stderr: writeErr,
      };

      const value = (await cmd.handler(ctx)) as R;

      if (tokens.outputMode === "json") {
        const envelope: JsonSuccessEnvelope<R> = {
          ok: true,
          verb: route.verbPath,
          data: value,
        };
        writeOut(`${JSON.stringify(envelope)}\n`);
      } else if (cmd.renderHuman) {
        const rendered = cmd.renderHuman(value, ctx);
        if (typeof rendered === "string" && rendered.length > 0) {
          writeOut(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
        }
      } else if (typeof value === "string" && value.length > 0) {
        writeOut(value.endsWith("\n") ? value : `${value}\n`);
      }

      return {
        exitCode: 0,
        outputMode: tokens.outputMode,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        value,
      };
    } catch (caught) {
      const erisErr = ErisError.isErisError(caught)
        ? caught
        : makeHeraError(
            "runtime",
            "unexpected-runtime-error",
            caught instanceof Error ? caught.message : String(caught),
            "Re-run with debug logging or report this failure",
            caught,
          );

      if (preOutputMode === "json") {
        writeOut(`${JSON.stringify(erisErr.toEnvelope(route.verbPath || undefined))}\n`);
      } else {
        writeErr(erisErr.renderFailureBlock(rootDir));
      }

      return {
        exitCode: erisErr.exitCode,
        outputMode: preOutputMode,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        error: erisErr,
      };
    }
  },
} as const;
