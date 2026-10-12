/**
 * Repository-level invariants that outlive the bats suite, ported
 * from tests/test_gitignore.bats, tests/test_consumed_by.bats and
 * tests/test_harness_integrity.bats:
 *
 *   - the repo's .gitignore keeps the generated secrets file (and its editor
 *     artifacts) out of git while its sample stays tracked;
 *   - tests/required-tools.txt is the complete, honest list of the tools a
 *     `bun test` suite skips without — because `describe.skipIf(!HAVE_X)`
 *     reports GREEN when X is absent, a missing tool would silently SHRINK the
 *     suite instead of failing it (a false green seen once, one runner later).
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO } from "./helpers/blackbox";

// --- .gitignore ------------------------------------------------------------------

describe(".gitignore (probed in a fresh `git init`, not the working tree)", () => {
  const probe = realpathSync(mkdtempSync(join(tmpdir(), "eris-gitignore-")));
  spawnSync("git", ["init", "-q"], { cwd: probe });
  copyFileSync(join(REPO, ".gitignore"), join(probe, ".gitignore"));
  const ignored = (f: string) => spawnSync("git", ["-C", probe, "check-ignore", "-q", f]).status === 0;

  test.each([".secret.env", ".secret.env.bak", ".secret.env.orig", ".secret.env.swp", ".secret.env~"])("%s is ignored", (f) => {
    // When this line goes missing, `git add .` commits plaintext secret material
    // (`.env.*` does NOT match `.secret.env`, so the file needs its own rule).
    expect(ignored(f)).toBe(true);
  });

  test(".secret.env.example stays tracked", () => {
    // When a broader rule swallows the sample, the documentation of the file's shape is untracked.
    expect(ignored(".secret.env.example")).toBe(false);
    rmSync(probe, { recursive: true, force: true });
  });
});

// --- tests/required-tools.txt vs the bun suites' skip guards -------------------------

const TOOLS_FILE = readFileSync(join(REPO, "tests/required-tools.txt"), "utf8");
const REQUIRED = new Set(
  TOOLS_FILE.split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#")),
);
const EXEMPT = new Set([...TOOLS_FILE.matchAll(/^# EXEMPT: ([a-zA-Z0-9_.+-]+)/gm)].map((m) => m[1]!));

/**
 * Gates in tests/*.test.ts that are NOT a missing tool, each with why it may
 * skip: a host property the suite cannot provide, not a dependency to install.
 */
const NON_TOOL_GATES: Record<string, string> = {
  isRoot: "root bypasses file modes, so an unwritable-path test cannot hold",
  getuid: "root bypasses file modes, so an unwritable-path test cannot hold",
  checkoutOnly: "the binary oracle (ERIS_BIN): a test of the checkout itself skips against a compiled eris; its reason is the call's argument",
  binaryOnly: "the binary oracle (ERIS_BIN): a test of a compiled eris's own behaviour runs only against one; its reason is the call's argument",
};

/** HAVE_AST_GREP / HAS_ZSH → ast-grep / zsh; HAVE("x") → x. */
function gatedTools(): { tools: Map<string, string[]>; unknown: string[] } {
  const tools = new Map<string, string[]>();
  const unknown: string[] = [];
  const add = (tool: string, file: string) => tools.set(tool, [...(tools.get(tool) ?? []), file]);
  for (const f of readdirSync(join(REPO, "tests"))) {
    if (!/\.test\.tsx?$/.test(f)) continue;
    // Code lines only: a comment may name a guard without being one.
    const src = readFileSync(join(REPO, "tests", f), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    for (const m of src.matchAll(/\.(?:skipIf|if)\(/g)) {
      // The condition is the balanced-paren argument.
      let depth = 1;
      let i = m.index! + m[0].length;
      const start = i;
      for (; i < src.length && depth > 0; i++) depth += src[i] === "(" ? 1 : src[i] === ")" ? -1 : 0;
      const cond = src.slice(start, i - 1);
      const have = /HAVE\("([^"]+)"\)/.exec(cond);
      const flag = /\bHA(?:VE|S)_([A-Z0-9_]+)\b/.exec(cond);
      if (have) add(have[1]!, f);
      else if (flag) add(flag[1]!.toLowerCase().replace(/_/g, "-"), f);
      else if (!Object.keys(NON_TOOL_GATES).some((k) => cond.includes(k))) unknown.push(`${f}: skipIf(${cond})`);
    }
  }
  return { tools, unknown };
}

describe("tests/required-tools.txt covers every tool a bun suite skips without", () => {
  const { tools, unknown } = gatedTools();

  test("the guard scan finds the gates it must (positive control)", () => {
    // When the scan regex rots, every check below passes having read nothing.
    expect(tools.has("script")).toBe(true);
    expect(tools.has("zsh")).toBe(true);
  });

  test("every skip guard is a recognised tool gate or a named non-tool gate", () => {
    // When a new skipIf condition is neither, it can delete coverage invisibly.
    expect(unknown).toEqual([]);
  });

  test("every tool behind a skip guard is required or exempted with a reason", () => {
    // When a bun suite gates on a tool the list does not name, a host without
    // it runs a smaller suite and reports green.
    const undeclared = [...tools.keys()].filter((t) => !REQUIRED.has(t) && !EXEMPT.has(t));
    expect(undeclared).toEqual([]);
  });

  test("every EXEMPT line states a reason after the documented ' -- ' separator", () => {
    // When `# EXEMPT: x` carries no reason, an oversight wears an exemption's clothes.
    expect(TOOLS_FILE).not.toMatch(/^# EXEMPT: [a-zA-Z0-9_.+-]+[ \t]*$/m);
    expect([...TOOLS_FILE.matchAll(/^# EXEMPT: [a-zA-Z0-9_.+-]+ -- ./gm)].length).toBe(EXEMPT.size);
  });

  test("nothing is both required and exempt", () => {
    expect([...REQUIRED].filter((t) => EXEMPT.has(t))).toEqual([]);
  });

  test("every required tool a bun suite gates on is present in THIS run (self-check)", () => {
    // When a gated tool is absent, its describe.skipIf blocks report green
    // having run nothing; this one test fails loudly instead.
    const gatedRequired = [...tools.keys()].filter((t) => REQUIRED.has(t));
    expect(gatedRequired.length).toBeGreaterThan(0);
    expect(gatedRequired.filter((t) => Bun.which(t) === null)).toEqual([]);
  });
});
