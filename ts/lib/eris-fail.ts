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
 * build overrode it (`build({ docsBase })`, src/build.ts; DOCS_BASE in
 * src/runtime/home.ts), as a distribution does for its own docs.
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

import { DOCS_BASE, docsRoot, installRoot, installRootIsUnwritten } from "../../src/runtime/home";

export interface ErisFailureInput {
  /** Stable machine key, `^[a-z0-9]+(-[a-z0-9]+)+$` — a `docs/ERRORS.md`
   *  heading anchor. `tests/errors-doc.test.ts` harvests every `slug: "…"`
   *  literal and fails when its heading is missing. */
  slug: string;
  /** The `ERROR <what>` line's message. Never a secret value — name the
   *  slot/path being resolved, per `docs/OUTPUT-CONTRACT.md` §4. */
  what: string;
  /** Zero or more `fix:` lines, `\n`-joined — mirrors `eris::report`'s
   *  third positional exactly (multi-line fixes are literal, indentation
   *  included). Omit or pass `""` for no fix lines at all. */
  fix?: string;
  /** Repo-relative doc path, optionally with a `#anchor`. Defaults to
   *  `docs/ERRORS.md#<slug>`, same as bash's `"${4:-docs/ERRORS.md#$1}"`. */
  docs?: string;
}

/**
 * `$ERIS_HOME`: `ERIS_DIR` wins when set; otherwise the install root (src/runtime/home.ts): the
 * checkout this file sits in, a distribution's own root, or a compiled binary's
 * asset home. The local `docs:` line names the doc under that root, or under this
 * package's when a distribution run from source does not carry it (`docsRoot`), so it
 * names a file that exists every way eris runs.
 */
export function erisHome(env: Record<string, string | undefined> = process.env): string {
  const override = env.ERIS_DIR;
  if (override && override.length > 0) return override;
  return installRoot();
}

/**
 * Split a `fix:` block into its per-line renderings, reproducing
 * `eris::report`'s here-string + `read` loop byte for byte (see file
 * header). Returns `[]` for an absent/empty `fix` — matching bash's
 * `if [[ -n "$fix" ]]` guard, which skips the loop entirely rather than
 * emitting one empty `fix: ` line.
 */
export function splitFixLines(fix: string | undefined): string[] {
  if (!fix || fix.length === 0) return [];
  // Simulate the here-string's appended `\n`, split, then drop the ONE
  // trailing empty element that append introduces — never a real line.
  const withTrailingNewline = `${fix}\n`;
  const parts = withTrailingNewline.split("\n");
  parts.pop();
  return parts;
}

/** The failure block's lines, in order, with NO trailing `\n` on any of
 *  them — `renderFailureBlock` is what adds one per line. Exposed
 *  separately so a test can assert on individual lines without
 *  re-parsing the joined block.
 *
 *  With no local copy of the docs to name (`home` null, or the install root of a
 *  compiled binary whose asset home could not be written, `eris-cache-unwritable`),
 *  the first `docs:` line is the repo-relative
 *  path, so the block keeps its two `docs:` lines and the GitHub one stays the
 *  readable one. */
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
  lines.push(`docs: ${DOCS_BASE}/${docsRel}`);
  return lines;
}

/** The full block, `\n`-terminated on every line — byte-identical to what
 *  `eris::report`/`eris::fail` writes to stderr for the same inputs. */
export function renderFailureBlock(input: ErisFailureInput, home: string | null = erisHome()): string {
  return failureLines(input, home)
    .map((line) => `${line}\n`)
    .join("");
}

/** A write-only stream: process.stderr, or a capture in tests. */
export interface FailureSink {
  write(chunk: string): unknown;
}

/**
 * The TS `eris::report`: write the block and RETURN 1
 * instead of exiting, for a caller that owns something which must run after
 * the failure (e.g. a failed WAL result after a failed write). Prefer
 * `emitFailureAndExit`; the caller of this adds its own summary.
 * `tests/eris-fail-golden.test.ts` pins it against every documented slug.
 */
export function reportFailure(
  input: ErisFailureInput,
  home: string = erisHome(),
  sink: FailureSink = process.stderr,
): 1 {
  sink.write(renderFailureBlock(input, home));
  return 1;
}

/** Write the block to stderr and exit 1 — the TS `eris::fail` equivalent.
 *  Stdout is never touched (§1 of the output contract: a failure writes
 *  nothing to stdout). */
export function emitFailureAndExit(
  input: ErisFailureInput,
  home: string = erisHome(),
  sink: FailureSink = process.stderr,
  exit: (code: number) => never = (code) => process.exit(code),
): never {
  sink.write(renderFailureBlock(input, home));
  return exit(1);
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
