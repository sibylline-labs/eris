/**
 * eris-fail.ts — the `ERROR`/`slug:`/`fix:`/`docs:` failure block, in TS.
 *
 * The block predates this module: an earlier Bash implementation of eris
 * printed it (`eris::report`), and this module reproduces it BYTE FOR BYTE
 * for the same inputs, because `docs/OUTPUT-CONTRACT.md` §4 says the shape is
 * a **contract**: consumers line-prefix-parse it, and a re-implementation is
 * required to *reproduce* the grammar, never to re-derive it.
 * `tests/eris-fail.test.ts` proves byte-identity against what that Bash
 * implementation printed, captured in a real bash subprocess and frozen
 * (tests/helpers/frozen-oracle.ts) — not by eyeballing the two
 * implementations side by side.
 *
 * The grammar (docs/OUTPUT-CONTRACT.md §4), reproduced here exactly:
 *
 *   ERROR <what failed>
 *   slug: <slug>
 *   fix: <line>            — zero or more, one per line of the fix text
 *   docs: <local path>     — $ERIS_HOME/<relpath>
 *   docs: <github url>     — <docs base>/<relpath>
 *
 * The docs base is https://github.com/sibylline-labs/eris/blob/main unless a
 * distribution named its own: baked by `build({ docsBase })` (src/build.ts), or
 * handed to `runProgram({ identity })` for a run from source (`identity()` in
 * src/runtime/home.ts).
 *
 * All on stderr; stdout is never touched by anything in this file. Field
 * order is fixed, every prefix carries its single trailing space, and the
 * two `docs:` lines are always both present (local first). `<relpath>`
 * defaults to `docs/ERRORS.md#<slug>`, exactly matching the Bash
 * `eris::report`'s `docs="${4:-docs/ERRORS.md#$1}"`.
 *
 * The `fix:` line-splitting mirrors a bash quirk deliberately, not
 * accidentally: `eris::report` feeds `$fix` through
 * `<<< "$fix"` into a `while IFS= read -r _line || [[ -n "$_line" ]]`
 * loop. A here-string ALWAYS appends one `\n` to its content before
 * feeding it to the loop, so the loop's real input is `${fix}\n` — and
 * `read` terminates the instant it hits EOF with a truly empty buffer,
 * never on the placeholder `\n` it appended. Reproducing that requires the
 * same transform: append one `\n`, split on `\n`, and drop exactly the
 * one trailing empty element the appended `\n` introduces (see
 * `splitFixLines` below). That transform is equal to a plain
 * `fix.split("\n")` for every non-empty `fix` (a trailing `\n` yields one
 * trailing empty `fix: ` line either way — mutation-checked); the
 * only case that needs care is the EMPTY fix, which emits no `fix:` line at
 * all. `tests/eris-fail-golden.test.ts` compares every documented slug,
 * including a trailing-newline fix and an empty fix, against the real bash.
 */

import {
  ErisError,
  type ErisErrorOptions,
  type ErisFailureInput,
  EXIT_CODE_BY_CATEGORY,
  erisHome,
  type FailureCategory,
  failureLines,
  splitFixLines,
} from "../../src/hera/cli";

export {
  ErisError,
  type ErisErrorOptions,
  type ErisFailureInput,
  EXIT_CODE_BY_CATEGORY,
  erisHome,
  type FailureCategory,
  failureLines,
  splitFixLines,
};

/** The full block, `\n`-terminated on every line — byte-identical to what
 *  `eris::report`/`eris::fail` writes to stderr for the same inputs. */
export function renderFailureBlock(input: ErisFailureInput | ErisError, home: string | null = erisHome()): string {
  return failureLines(input, home)
    .map((line) => `${line}\n`)
    .join("");
}

/** A write-only stream: process.stderr, or a capture in tests. */
export interface FailureSink {
  write(chunk: string): unknown;
}

/**
 * The TS `eris::report`: write the block and RETURN 1 (or the `ErisError`'s
 * exit code) instead of exiting, for a caller that owns something which must
 * run after the failure (e.g. a failed WAL result after a failed write). Prefer
 * `emitFailureAndExit`; the caller of this adds its own summary.
 * `tests/eris-fail-golden.test.ts` pins it against every documented slug.
 */
export function reportFailure(input: ErisError, home?: string, sink?: FailureSink): number;
export function reportFailure(input: ErisFailureInput, home?: string, sink?: FailureSink): 1;
export function reportFailure(
  input: ErisFailureInput | ErisError,
  home: string = erisHome(),
  sink: FailureSink = process.stderr,
): number {
  sink.write(renderFailureBlock(input, home));
  return ErisError.isErisError(input) ? input.exitCode : 1;
}

/** Write the block to stderr and exit 1 (or the `ErisError`'s exit code) —
 *  the TS `eris::fail` equivalent. Stdout is never touched (§1 of the output
 *  contract: a failure writes nothing to stdout). */
export function emitFailureAndExit(
  input: ErisFailureInput | ErisError,
  home: string = erisHome(),
  sink: FailureSink = process.stderr,
  exit: (code: number) => never = (code) => process.exit(code),
): never {
  sink.write(renderFailureBlock(input, home));
  return exit(ErisError.isErisError(input) ? input.exitCode : 1);
}

/**
 * The `WARN` line `eris yak` emits for its environment/config/
 * transport outcomes: concise, on
 * stderr, exit 0 — never the four-line failure block, which is reserved
 * for agent misuse. Two lines, not a bare `WARN <reason>`: the slug alone
 * is what makes an unset-token/unreachable-endpoint/timeout warning
 * machine-legible on stderr without promoting it to the exit-1 failure
 * contract, and `docs/ERRORS.md`'s per-slug headings apply.
 */
export function renderWarnLines(reason: string, slug: string): string {
  return `WARN ${reason}\nslug: ${slug}\n`;
}

export function emitWarn(reason: string, slug: string): void {
  process.stderr.write(renderWarnLines(reason, slug));
}
