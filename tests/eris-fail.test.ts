/**
 * Tests for ts/lib/eris-fail.ts.
 *
 * The load-bearing claim of this module is BYTE-IDENTITY with
 * the earlier Bash `eris::report`'s stderr output for the same inputs
 * (docs/OUTPUT-CONTRACT.md §4 — consumers line-prefix-parse this block). This
 * file proves that against what the real bash implementation printed in a
 * subprocess, frozen before it was deleted (tests/helpers/frozen-oracle.ts) —
 * never by asserting the TS output looks right in isolation, which would
 * only prove the TS side agrees with itself.
 */

import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { errorsReport } from "./helpers/frozen-oracle";
import {
  ErisError,
  EXIT_CODE_BY_CATEGORY,
  erisHome,
  splitFixLines,
  failureLines,
  renderFailureBlock,
  renderWarnLines,
  type ErisFailureInput,
} from "../ts/lib/eris-fail";

const REPO_ROOT = join(import.meta.dir, "..");
const GITHUB_BLOB = "https://github.com/sibylline-labs/eris/blob/main";

/**
 * What the REAL Bash `eris::report` printed in a bash subprocess for
 * the given inputs. `eris::report` RETURNED 1 rather than
 * exiting (the non-exiting sibling of `eris::fail`), so it could run with `set -e` still active in the caller's
 * shell without aborting the script. Positional args map 1:1 onto
 * `eris::report <slug> <what> [<fix>] [<docs>]`.
 */
function realErisReport(slug: string, what: string, fix?: string, docs?: string): { stderr: string; status: number } {
  const args = [slug, what];
  if (fix !== undefined || docs !== undefined) args.push(fix ?? "");
  if (docs !== undefined) args.push(docs);
  // What eris::report printed, frozen (tests/helpers/frozen-oracle.ts).
  const r = errorsReport(args);
  return { stderr: r.stderr, status: r.status };
}

const REPO_HOME = erisHome({ ERIS_DIR: REPO_ROOT });

describe("erisHome", () => {
  it("prefers ERIS_DIR when set", () => {
    expect(erisHome({ ERIS_DIR: "/some/other/path" })).toBe("/some/other/path");
  });

  it("derives the repo root from this file's own location when ERIS_DIR is unset", () => {
    // ts/lib/eris-fail.ts -> ts/lib -> ts -> <repo root>. Compare against the
    // independently-known REPO_ROOT (derived from THIS test file's location,
    // one directory shallower) rather than hardcoding a path.
    expect(erisHome({})).toBe(REPO_ROOT);
  });
});

describe("splitFixLines", () => {
  it("returns [] for an absent fix — bash's `if [[ -n \"$fix\" ]]` guard skips the loop entirely", () => {
    expect(splitFixLines(undefined)).toEqual([]);
    expect(splitFixLines("")).toEqual([]);
  });

  it("returns one element for a single line with no trailing newline", () => {
    expect(splitFixLines("single line")).toEqual(["single line"]);
  });

  it("splits multiple lines without inventing a trailing empty one", () => {
    expect(splitFixLines("line one\nline two")).toEqual(["line one", "line two"]);
  });

  it("reproduces bash's quirk: a fix ending in \\n emits one trailing empty line, not zero", () => {
    // This is the byte-identity test's whole reason to exist as a SEPARATE
    // case from the no-trailing-newline one above — see file header.
    expect(splitFixLines("a\nb\n")).toEqual(["a", "b", ""]);
  });

  it("preserves an embedded blank line", () => {
    expect(splitFixLines("a\n\nb")).toEqual(["a", "", "b"]);
  });
});

describe("failureLines / renderFailureBlock — byte-identity against frozen Bash output", () => {
  it("matches bash for a multi-line fix and a custom docs path (the Bash suite's first case)", () => {
    const input: ErisFailureInput = {
      slug: "demo-slug",
      what: "something broke",
      fix: "line one\nline two",
      docs: "docs/GRAPH.md#configuration",
    };
    const ts = renderFailureBlock(input, REPO_HOME);
    const real = realErisReport(input.slug, input.what, input.fix, input.docs);

    expect(real.status).toBe(1);
    expect(ts).toBe(real.stderr);
  });

  it("matches bash when docs defaults to docs/ERRORS.md#<slug> and there is no fix", () => {
    const input: ErisFailureInput = { slug: "my-slug", what: "broke" };
    const ts = renderFailureBlock(input, REPO_HOME);
    const real = realErisReport(input.slug, input.what);

    expect(ts).toBe(real.stderr);
  });

  it("matches bash for a fix with an embedded blank line", () => {
    const input: ErisFailureInput = { slug: "blank-line-slug", what: "broke too", fix: "a\n\nb" };
    const ts = renderFailureBlock(input, REPO_HOME);
    const real = realErisReport(input.slug, input.what, input.fix);

    expect(ts).toBe(real.stderr);
  });

  it("matches bash for a fix ending in a trailing newline (the bash quirk case)", () => {
    const input: ErisFailureInput = { slug: "trailing-nl-slug", what: "broke thrice", fix: "a\nb\n" };
    const ts = renderFailureBlock(input, REPO_HOME);
    const real = realErisReport(input.slug, input.what, input.fix);

    expect(ts).toBe(real.stderr);
  });

  it("matches bash when what/fix contain characters that need no special escaping (quotes, colons)", () => {
    const input: ErisFailureInput = {
      slug: "quoting-slug",
      what: `cannot read "some file": permission denied`,
      fix: `chmod 0600 "some file"`,
    };
    const ts = renderFailureBlock(input, REPO_HOME);
    const real = realErisReport(input.slug, input.what, input.fix);

    expect(ts).toBe(real.stderr);
  });

  it("field order, prefixes and their trailing space match the documented grammar exactly", () => {
    const input: ErisFailureInput = { slug: "grammar-slug", what: "x", fix: "one\ntwo", docs: "docs/FOO.md#bar" };
    const lines = failureLines(input, "/repo");
    expect(lines).toEqual([
      "ERROR x",
      "slug: grammar-slug",
      "fix: one",
      "fix: two",
      "docs: /repo/docs/FOO.md#bar",
      `docs: ${GITHUB_BLOB}/docs/FOO.md#bar`,
    ]);
  });

  it("defaults the docs relpath to docs/ERRORS.md#<slug> exactly like bash's \"${4:-docs/ERRORS.md#$1}\"", () => {
    const lines = failureLines({ slug: "default-docs", what: "x" }, "/repo");
    expect(lines).toEqual([
      "ERROR x",
      "slug: default-docs",
      "docs: /repo/docs/ERRORS.md#default-docs",
      `docs: ${GITHUB_BLOB}/docs/ERRORS.md#default-docs`,
    ]);
  });

  it("every emitted line ends in exactly one \\n and the block has no leading/trailing blank line", () => {
    const block = renderFailureBlock({ slug: "s", what: "w" }, "/repo");
    expect(block.endsWith("\n")).toBe(true);
    expect(block.startsWith("\n")).toBe(false);
    // No blank line anywhere in the block (every line is non-empty content).
    expect(block.split("\n").filter((l, i, arr) => l === "" && i !== arr.length - 1)).toEqual([]);
  });
});

describe("renderWarnLines", () => {
  it("emits WARN + slug on two lines, distinct from the four-line failure block", () => {
    expect(renderWarnLines("actor unreachable", "yak-unreachable")).toBe(
      "WARN actor unreachable\nslug: yak-unreachable\n",
    );
  });
});

describe("ErisError", () => {
  it("renders byte-identically to renderFailureBlock and maps failure categories to canonical exit codes", () => {
    const input: ErisFailureInput = {
      slug: "demo-slug",
      what: "something broke",
      fix: "line one\nline two",
      docs: "docs/GRAPH.md#configuration",
    };
    const err = new ErisError({ ...input, category: "precondition" });
    expect(ErisError.isErisError(err)).toBe(true);
    expect(err.exitCode).toBe(3);
    expect(err.renderFailureBlock(REPO_HOME)).toBe(renderFailureBlock(input, REPO_HOME));
    expect(renderFailureBlock(err, REPO_HOME)).toBe(renderFailureBlock(input, REPO_HOME));
    expect(EXIT_CODE_BY_CATEGORY).toEqual({
      runtime: 1,
      misuse: 2,
      precondition: 3,
      timeout: 124,
    });
  });
});
