/**
 * `eris loop`'s operand normalisers (plugins/loop/names.ts): every operand is normalised, or refused
 * with `loop-usage` (exit 2), before any claim, request or spawn.
 *
 * The seam is the normaliser called with the operand as typed, and `checkCwd` over real directories
 * under the gitignored `data/scratch/`.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { LoopFailure } from "../plugins/loop/failure";
import { checkCwd, normaliseCaller, normaliseContext, normaliseIssue, normaliseModel, normaliseReportTo, normaliseResumePrompt, normaliseSlug, sessionName, SESSION_RE } from "../plugins/loop/names";

const REPO = resolve(import.meta.dir, "..");
mkdirSync(join(REPO, "data", "scratch"), { recursive: true });
const SCRATCH = realpathSync(mkdtempSync(join(REPO, "data", "scratch", "loop-names-")));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** The slug a refusal carries, or the value. */
function run<A>(f: () => A): A | string {
  try {
    return f();
  } catch (e) {
    if (e instanceof LoopFailure) return `${e.failure.slug}/${e.failure.exit}`;
    throw e;
  }
}

describe("operand normalisers", () => {
  it("normalise or refuse each operand as the table says", () => {
    /** When an operand passes unnormalised, a session name, claim loop or argv word carries a path climb, a flag-shaped model or a wrong-case key, and the launch writes the tracker before anything refuses: observed on each normaliser's value or slug. */
    const cases: Array<[string, () => unknown, unknown]> = [
      ["slug folds case and spaces", () => normaliseSlug("  One Shot "), "one-shot"],
      ["slug keeps _ and -", () => normaliseSlug("fix_it-2"), "fix_it-2"],
      ["slug refuses a path climb", () => normaliseSlug("../x"), "loop-usage/2"],
      ["slug refuses a slash", () => normaliseSlug("a/b"), "loop-usage/2"],
      ["slug refuses nothing usable", () => normaliseSlug("!!!"), "loop-usage/2"],
      ["slug refuses over 64", () => normaliseSlug("a".repeat(65)), "loop-usage/2"],
      ["issue upper-cases", () => normaliseIssue(" abc-7 "), "ABC-7"],
      ["issue refuses a non-key", () => normaliseIssue("ABC7"), "loop-usage/2"],
      ["report-to upper-cases", () => normaliseReportTo("abc-9"), "ABC-9"],
      ["report-to refuses a session name", () => normaliseReportTo("eris-loop-x"), "loop-usage/2"],
      ["report-to absent", () => normaliseReportTo(undefined), undefined],
      ["context is one line", () => normaliseContext("a\n  b\tc"), "a b c"],
      ["context blank is absent", () => normaliseContext("  \n"), undefined],
      ["context refuses over 1024", () => normaliseContext("x".repeat(1025)), "loop-usage/2"],
      ["caller refuses NUL", () => normaliseCaller("a\0b"), "loop-usage/2"],
      ["caller refuses over 128", () => normaliseCaller("c".repeat(129)), "loop-usage/2"],
      ["model is required", () => normaliseModel(undefined), "loop-usage/2"],
      ["model refuses a flag", () => normaliseModel("--dangerously"), "loop-usage/2"],
      ["model keeps a full name", () => normaliseModel(" claude-sonnet-4-5 "), "claude-sonnet-4-5"],
      ["resume prompt defaults", () => typeof normaliseResumePrompt(undefined), "string"],
      ["resume prompt refuses blank", () => normaliseResumePrompt("  "), "loop-usage/2"],
    ];
    for (const [name, f, want] of cases) expect([name, run(f)]).toEqual([name, want]);
  });

  it("names a session so its slug and issue read back", () => {
    /** When the session name and its reader disagree, stop, status and the live-session check cannot find a loop by its issue: observed on the name and the regex groups. */
    const name = sessionName("one-shot", "ABC-7");
    expect(name).toBe("eris-loop-one-shot-abc-7");
    expect(SESSION_RE.exec(name)?.slice(1)).toEqual(["one-shot", "abc-7"]);
  });
});

describe("checkCwd", () => {
  it("takes an absolute directory, and refuses a relative path, a missing one, and HOME through any link", () => {
    /** When --cwd may be HOME (or a link to it), the session opens an untrusted workspace there and fails after the claim was taken: observed on each refusal's slug. */
    const home = join(SCRATCH, "home");
    const target = join(SCRATCH, "repo");
    mkdirSync(home);
    mkdirSync(target);
    symlinkSync(home, join(SCRATCH, "home-link"));
    expect(run(() => checkCwd(target, home))).toBe(target);
    expect(run(() => checkCwd("repo", home))).toBe("loop-usage/2");
    expect(run(() => checkCwd(join(SCRATCH, "nope"), home))).toBe("loop-usage/2");
    expect(run(() => checkCwd(home, home))).toBe("loop-usage/2");
    expect(run(() => checkCwd(join(SCRATCH, "home-link"), home))).toBe("loop-usage/2");
  });
});
