/**
 * Tests for ts/lib/eris-fail.ts.
 *
 * The load-bearing claim of this module is BYTE-IDENTITY with
 * the earlier Bash `eris::report`'s stderr output for the same inputs
 * (docs/OUTPUT-CONTRACT.md §4 — consumers line-prefix-parse this block). This
 * file proves that against what the real bash implementation printed in a
 * subprocess, recorded before it was deleted (`BASH_REPORTS` below) —
 * never by asserting the TS output looks right in isolation, which would
 * only prove the TS side agrees with itself.
 */

import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import {
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
 * the given inputs, recorded before that implementation was deleted. `eris::report` RETURNED 1 rather than
 * exiting (the non-exiting sibling of `eris::fail`), so it could run with `set -e` still active in the caller's
 * shell without aborting the script. Positional args map 1:1 onto
 * `eris::report <slug> <what> [<fix>] [<docs>]`; each key is the JSON of those args.
 * The answers cannot be regenerated: a change to the block is a change to the contract
 * (docs/OUTPUT-CONTRACT.md), never a reason to edit an entry. `<ERIS>` stands for the checkout.
 */
const BASH_REPORTS = new Map<string, { status: number; stderr: string }>([
  ["[\"demo-slug\",\"something broke\",\"line one\\nline two\",\"docs/GRAPH.md#configuration\"]", { status: 1, stderr: "ERROR something broke\nslug: demo-slug\nfix: line one\nfix: line two\ndocs: <ERIS>/docs/GRAPH.md#configuration\ndocs: https://github.com/sibylline-labs/eris/blob/main/docs/GRAPH.md#configuration\n" }],
  ["[\"my-slug\",\"broke\"]", { status: 1, stderr: "ERROR broke\nslug: my-slug\ndocs: <ERIS>/docs/ERRORS.md#my-slug\ndocs: https://github.com/sibylline-labs/eris/blob/main/docs/ERRORS.md#my-slug\n" }],
  ["[\"blank-line-slug\",\"broke too\",\"a\\n\\nb\"]", { status: 1, stderr: "ERROR broke too\nslug: blank-line-slug\nfix: a\nfix: \nfix: b\ndocs: <ERIS>/docs/ERRORS.md#blank-line-slug\ndocs: https://github.com/sibylline-labs/eris/blob/main/docs/ERRORS.md#blank-line-slug\n" }],
  ["[\"trailing-nl-slug\",\"broke thrice\",\"a\\nb\\n\"]", { status: 1, stderr: "ERROR broke thrice\nslug: trailing-nl-slug\nfix: a\nfix: b\nfix: \ndocs: <ERIS>/docs/ERRORS.md#trailing-nl-slug\ndocs: https://github.com/sibylline-labs/eris/blob/main/docs/ERRORS.md#trailing-nl-slug\n" }],
  ["[\"quoting-slug\",\"cannot read \\\"some file\\\": permission denied\",\"chmod 0600 \\\"some file\\\"\"]", { status: 1, stderr: "ERROR cannot read \"some file\": permission denied\nslug: quoting-slug\nfix: chmod 0600 \"some file\"\ndocs: <ERIS>/docs/ERRORS.md#quoting-slug\ndocs: https://github.com/sibylline-labs/eris/blob/main/docs/ERRORS.md#quoting-slug\n" }],

]);

function realErisReport(slug: string, what: string, fix?: string, docs?: string): { stderr: string; status: number } {
  const args = [slug, what];
  if (fix !== undefined || docs !== undefined) args.push(fix ?? "");
  if (docs !== undefined) args.push(docs);
  const r = BASH_REPORTS.get(JSON.stringify(args));
  if (r === undefined) throw new Error(`no recorded Bash answer for ${JSON.stringify(args)}; test an input BASH_REPORTS holds`);
  return { stderr: r.stderr.replaceAll("<ERIS>", REPO_ROOT), status: r.status };
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
