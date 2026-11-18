/**
 * runtime.ts — the seam a build uses to run loops on a runtime other than Claude Code
 * (docs/LOOP.md#distribution-seams). `claude` is built in; a build adds others through
 * `LoopDefaults.runtimes`, keyed by the name `--runtime` takes.
 *
 * Invariants:
 *  - a runtime refuses with a thrown `LoopFailure` (failure.ts), as the built-in verbs do; `prepare`
 *    refuses an operand with `loop-usage` before any request or spawn;
 *  - a runtime never sees the caller's raw env: `LoopRuntimeEnv.env` is the scrubbed child env
 *    (deps.ts `childEnv`), so whatever it spawns inherits no session marker or bearer;
 *  - the session names it is handed and finds are `sessionName`'s (names.ts) or a build's legacy
 *    prefix, so the claim ledger and the live check read them back by issue.
 */

/** One session a runtime holds, as the verbs that resolve a `<ref>` read it. */
export interface LoopRuntimeSession {
  /** What `stop`, `resume` and the ledger name the session by. */
  readonly id: string;
  readonly name: string;
  /** The runtime's own word for the session's state (`working`, `idle`, `failed`, ...). */
  readonly state: string;
  readonly cwd?: string;
  /** Epoch milliseconds of the session's last update: status picks the newest of several matches. */
  readonly updatedAt?: number;
}

/** What a runtime runs on: the verb's home, directory, clock and the scrubbed env its children get. */
export interface LoopRuntimeEnv {
  readonly home: string;
  /** The directory the verb acts from (`launch`'s `--cwd`). */
  readonly cwd: string;
  /** The caller's env less the session markers, eris's bearer and every name the build scrubs. */
  readonly env: Readonly<Record<string, string>>;
  /** The fetch a test injected, else undefined (the global one). */
  readonly fetch: typeof globalThis.fetch | undefined;
  /** Wall-clock epoch milliseconds. */
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** One WARN line on stderr. */
  readonly warn: (line: string) => void;
}

/** A launch flag a runtime reads; it is added to the `loop launch` row and refused for any other runtime. */
export interface LoopRuntimeFlag {
  readonly name: `--${string}`;
  readonly takesValue: true;
}

/** A runtime's launch flags, by name, as the operator passed them (absent: undefined). */
export type LoopRuntimeFlags = Readonly<Record<string, string | undefined>>;

/** A loop runtime a build supplies. */
export interface LoopRuntime {
  /** Launch flags this runtime reads (merged into the `loop launch` row). */
  readonly flags?: ReadonlyArray<LoopRuntimeFlag>;
  /** Normalise the model and flags before any request; refuse with `loop-usage`. The model the receipt names ("" when none). */
  prepare(env: LoopRuntimeEnv, input: { readonly model: string | undefined; readonly flags: LoopRuntimeFlags }): Promise<{ readonly model: string }>;
  /** Start the session named `name` in `cwd` on `prompt`; the new session's id. */
  spawn(env: LoopRuntimeEnv, input: { readonly prompt: string; readonly name: string; readonly cwd: string; readonly model: string; readonly flags: LoopRuntimeFlags }): Promise<string>;
  /** `<id> · <name> · <state>` for each of its loop sessions on `issue` still at work (with `slug`, only that loop's). */
  live(env: LoopRuntimeEnv, issue: string, slug?: string): Promise<ReadonlyArray<string>>;
  /** The sessions `ref` names (an id, an exact name, an issue key); [] when none. */
  find(env: LoopRuntimeEnv, ref: string): Promise<ReadonlyArray<LoopRuntimeSession>>;
  stop(env: LoopRuntimeEnv, session: LoopRuntimeSession): Promise<void>;
  /** Continue a finished session on `prompt`; the resumed session's id. */
  resume(env: LoopRuntimeEnv, session: LoopRuntimeSession, prompt: string): Promise<string>;
  /** `resume --all`: its failed loop sessions. */
  failed(env: LoopRuntimeEnv): Promise<ReadonlyArray<LoopRuntimeSession>>;
  /**
   * The status text for one session. `lines.claim` is this machine's ledger line for its issue (null
   * when none) and `lines.also` the other sessions the ref names (`<id> <state>`), for the runtime to
   * print as `claim:` and `also:`.
   */
  status(env: LoopRuntimeEnv, session: LoopRuntimeSession, lines: { readonly claim: string | null; readonly also: ReadonlyArray<string> }): Promise<string>;
  /** Whether the session is working now: status shows the working match, and resume refuses it. */
  working(session: LoopRuntimeSession): boolean;
}
