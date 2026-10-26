import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutOnly } from "./helpers/blackbox";

/**
 * Guard: no tracked source file may contain a RAW NUL byte.
 *
 * A raw NUL makes git classify the file as binary, so it stops producing a text
 * diff — the change becomes invisible in review — and it drops out of grep, so
 * the symbol inside it stops being findable. Both happened here: a raw NUL was
 * fixed, reintroduced, and had to be fixed a second time.
 *
 * NUL is a perfectly good separator for a composite map key; it just has to be
 * written as the ESCAPE `\x00` in the literal, which is byte-identical at
 * runtime and stays plain text on disk. This test is the thing that makes the
 * second occurrence the last one.
 */
const ROOTS = ["bin", "ts", "src", "plugins", "packages", "examples", "tests", "scripts"];
const EXTS = [".ts", ".sh", ".json", ".yml", ".yaml"];

/** The repo root is scanned SHALLOWLY, by name — a recursive walk from `.`
 *  would drag in thoughts/, data/ and every vendored tree. These are the
 *  sources that live at the top level and would otherwise be unguarded,
 *  including the extension-less `eris` shim. */
const ROOT_FILES = ["eris"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTS.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

/** The shell eris still ships: the shim. */
function shellSources(): string[] {
  return ["eris"];
}

describe.skipIf(checkoutOnly("a scan of the checkout's source files, not of the program under test"))("source hygiene", () => {
  it("contains no raw NUL bytes — they break git diffs and grep", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      let files: string[];
      try {
        files = walk(root);
      } catch {
        continue; // root absent in this checkout
      }
      for (const f of files) {
        if (readFileSync(f).includes(0x00)) offenders.push(f);
      }
    }
    for (const f of ROOT_FILES) {
      try {
        if (readFileSync(f).includes(0x00)) offenders.push(f);
      } catch {
        continue; // absent in this checkout
      }
    }
    expect(offenders).toEqual([]);
  });

  it("actually reads every repo-root source it claims to guard", () => {
    // A name that silently stopped resolving would make the guard above pass
    // vacuously for that file — the exact way this class of guard rots.
    for (const f of ROOT_FILES) {
      expect(statSync(f).isFile()).toBe(true);
    }
  });

  /**
   * Guard: no shell file may blank-test a variable by substituting its
   * whitespace away — `[[ -n "${v//[[:space:]]/}" ]]`. Use a glob,
   * `case "$v" in *[![:space:]]*) …`, or for a genuinely large value stream it
   * to a file and use `grep -q '[^[:space:]]'`.
   *
   * A bash GLOBAL substitution is quadratic in the string length: 0.13s at
   * 16 KB, 28.7s at 256 KB, 117.6s at 512 KB. Applied to an ast-grep match
   * stream that was ~26 and ~35 MINUTES of pure-bash spin at 100% CPU with no
   * child process alive, which is precisely why both read as scanner problems
   * for weeks.
   *
   * The idiom is banned outright rather than size-gated, because the size that
   * makes it fatal is a property of the *input*, which no reviewer can see at
   * the callsite.
   */
  it("blank-tests with a glob or grep, never a global substitution", () => {
    const offenders: string[] = [];
    for (const f of shellSources()) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        // Prose is allowed to name the idiom.
        if (/^\s*#/.test(line)) return;
        if (line.includes("//[[:space:]]/")) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------
 * FREEZE — no new Bash.
 *
 * eris's Bash implementation is deleted. What shell remains is the POSIX `eris`
 * shim. This ratchet keeps it that way: the surface — `.sh`
 * files, code lines and function definitions — is DOWN-ONLY as a whole.
 *
 * Units: `loc` is code lines — non-blank and not a whole-line comment, so a bug
 * fix that explains itself is not charged for the explanation. `functions`
 * counts every definition (`name() {`, `function name() {`).
 *
 * Growth fails pointing at TypeScript. Raising the baseline stays possible —
 * for a bug fix that genuinely needs a line — and it is a reviewed line in the
 * diff, never a quiet one. A shrink fails too until the baseline is lowered, so
 * freed room is never silently re-spent.
 * ------------------------------------------------------------------------- */

type Baseline = {
  /** Prose header inside the JSON, so the file explains itself in a diff. */
  _README: string[];
  FREEZE: Record<string, number>;
};

const BASELINE_PATH = "tests/fixtures/ratchet-baseline.json";
const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

/** Lines with the FULL-LINE comments removed, paired with their 1-based number. */
function codeLines(file: string): Array<[string, number]> {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l, i) => [l, i + 1] as [string, number])
    .filter(([l]) => !/^\s*#/.test(l));
}

/** Shell function definitions: `name() {`, `function name() {`. */
const DEFINITION = /^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_:.-]*)\s*\(\)\s*\{?/;

function measureShell(files: string[]): Record<string, number> {
  let loc = 0;
  let functions = 0;
  for (const f of files) {
    for (const [line] of codeLines(f)) {
      if (line.trim() === "") continue;
      loc++;
      if (DEFINITION.test(line)) functions++;
    }
  }
  return { files: files.filter((f) => f.endsWith(".sh")).length, loc, functions };
}

function ratchet(actual: Record<string, number>, recorded: Record<string, number>): string[] {
  const out: string[] = [];
  for (const key of [...new Set([...Object.keys(actual), ...Object.keys(recorded)])].sort()) {
    const now = actual[key] ?? 0;
    const was = recorded[key] ?? 0;
    if (now > was) {
      out.push(
        `FREEZE ${key}: ${now} > baseline ${was} — the remaining shell is frozen. New logic goes to TypeScript ` +
          `behind the eris TS router. If a fix genuinely needs this, ` +
          `raise the count in ${BASELINE_PATH} in this PR so a reviewer sees it.`,
      );
    } else if (now < was) {
      out.push(
        `FREEZE ${key}: ${now} < baseline ${was} — progress. Lower the count in ${BASELINE_PATH} ` +
          `to ${now} so it is captured and cannot be silently re-spent.`,
      );
    }
  }
  return out;
}

describe.skipIf(checkoutOnly("the checkout's shell surface (the shim); a binary has none"))("shell freeze", () => {
  it("the shell surface does not grow, and every shrink is recorded", () => {
    /** When the shim gains logic or a new .sh lands, this names the count that grew. */
    expect(ratchet(measureShell(shellSources()), baseline.FREEZE)).toEqual([]);
  });

  /**
   * POSITIVE CONTROL. The measurement over the real tree plus one synthetic
   * `.sh` holding one function must trip all three counts and name TypeScript;
   * the tree minus one real file must fail as an unrecorded decrease. Without
   * both, an all-green here could mean a measurement that sees nothing.
   */
  it("a synthetic .sh file trips the freeze, and a deletion demands a lower baseline", () => {
    const real = shellSources();
    expect(real).toEqual(["eris"]);

    const dir = mkdtempSync(join(tmpdir(), "eris-freeze-"));
    try {
      const synthetic = join(dir, "new_verb.sh");
      writeFileSync(synthetic, `#!/usr/bin/env bash\n# a new verb\n\nnewverb::run() {\n  echo hi\n}\n`);
      const grown = ratchet(measureShell([...real, synthetic]), baseline.FREEZE);
      expect(grown.map((m) => m.split(":")[0])).toEqual(["FREEZE files", "FREEZE functions", "FREEZE loc"]);
      for (const m of grown) expect(m).toContain("TypeScript behind the eris TS router");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const shrunk = ratchet(measureShell(real.filter((f) => f !== "eris")), baseline.FREEZE);
    expect(shrunk.map((m) => m.split(":")[0])).toEqual(["FREEZE loc"]);
    for (const m of shrunk) {
      expect(m).toContain("< baseline");
      expect(m).toContain(`Lower the count in ${BASELINE_PATH}`);
    }
  });
});
