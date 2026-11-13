/**
 * `eris skills lint`: the skill-kind contract check, at two seams.
 *
 *   - `readSkillKind` and `lintSkills` (src/runtime/skills-lint.ts), the SDK
 *     functions another repository codes against, over fixture trees.
 *   - the CLI (`eris skills lint [<dir>]`), run as a subprocess in a sandbox,
 *     asserted on its exit status and its two streams.
 *
 * The oracle for every expected value is the Python lint this port replaces:
 * each table row was run through it and its answer is the literal here.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lintSkills, readSkillKind, SKILL_KINDS, type SkillKindRead } from "../src/runtime/skills-lint";
import { REPO, type Sandbox, sandbox } from "./helpers/blackbox";

const SCRATCH = join(REPO, ".scratch");
const made: string[] = [];
let sb: Sandbox | undefined;
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  sb?.cleanup();
  sb = undefined;
});

function tree(): string {
  mkdirSync(SCRATCH, { recursive: true });
  const d = mkdtempSync(join(SCRATCH, "skills-lint-"));
  made.push(d);
  return d;
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function skill(root: string, name: string, kind: string, body = "", opts: { scripts?: boolean; rel?: string } = {}): void {
  const d = join(root, opts.rel ?? "skills", name);
  write(join(d, "SKILL.md"), `---\nname: ${name}\nkind: ${kind}\ndescription: d\n---\n${body}`);
  if (opts.scripts) write(join(d, "scripts", "run.py"), "");
}

function agent(root: string, skills: string, rel = "agents"): void {
  write(join(root, rel, "impl-x.md"), `---\nname: impl-x\nskills: ${skills}\n---\nbody\n`);
}

const rules = (root: string): string[] => [...new Set(lintSkills(root).findings.map((f) => f.rule))].sort();
const pairs = (root: string): [string, string][] => lintSkills(root).findings.map((f) => [f.skill, f.rule]);

const ok = (kind: (typeof SKILL_KINDS)[number]): SkillKindRead => ({ kind, error: null });
const err = (error: "kind-missing" | "kind-duplicate" | "kind-unknown"): SkillKindRead => ({ kind: null, error });

describe("readSkillKind", () => {
  // admits: a misread `kind:` sends a skill to the wrong contract or none; the reader is a line grammar over Markdown no type sees.
  it.each([
    // The Python reader's own table.
    ["---\nname: x\nkind: tool\n---\n", ok("tool")],
    ['---\nkind: "tool"\n---\n', ok("tool")],
    ["---\nkind: 'tool'\n---\n", ok("tool")],
    ["---\nkind: Tool\n---\n", err("kind-unknown")],
    ["---\nkind: tool  # judgment over scripts\n---\n", ok("tool")],
    ["---\nname: x\n---\n", err("kind-missing")],
    ["# no frontmatter\nkind: tool\n", err("kind-missing")],
    ["---\nkind:\n---\n", err("kind-missing")],
    ["---\nkind: tools\n---\n", err("kind-unknown")],
    ["---\nmetadata:\n  kind: tool\n---\n", err("kind-missing")],
    ["---\nname: x\n---\nkind: tool\n", err("kind-missing")],
    ["---\ndescription: >-\n  kind: tool\n---\n", err("kind-missing")],
    ["---\r\nname: x\r\nkind: gate\r\n---\r\n", ok("gate")],
    ["\ufeff---\nkind: mode\n---\n", ok("mode")],
    ["---\nkind: tool\nkind: gate\n---\n", err("kind-duplicate")],
    ["---\nkind: [tool, gate]\n---\n", err("kind-unknown")],
    // Value stripping: only an unquoted value splits on a literal " #".
    ['---\nkind: "tool" # c\n---\n', err("kind-unknown")],
    ["---\nkind: # c\n---\n", err("kind-unknown")],
    ["---\nkind: tool#c\n---\n", err("kind-unknown")],
    ["---\nkind: tool\t# c\n---\n", err("kind-unknown")],
    ["---\nkind: 'tool\n---\n", err("kind-unknown")],
    ['---\nkind: ""\n---\n', err("kind-missing")],
    ["---\nkind:tool\n---\n", ok("tool")],
    // Python's whitespace set, not JavaScript's: U+001F strips, U+FEFF does not.
    ["---\nkind: tool\x1f\n---\n", ok("tool")],
    ["---\nkind: \ufefftool\n---\n", err("kind-unknown")],
    // Only a column-0, lower-case `kind:` declares.
    ["---\nKind: tool\n---\n", err("kind-missing")],
    ["---\nkind : tool\n---\n", err("kind-missing")],
    ["---\n- kind: tool\n---\n", err("kind-missing")],
    ["---\n  kind: tool\n---\n", err("kind-missing")],
    // The frontmatter block: anchored at the start, lazy, every leading BOM dropped.
    ["\ufeff\ufeff---\nkind: mode\n---\n", ok("mode")],
    ["x\n---\nkind: tool\n---\n", err("kind-missing")],
    ["---\nkind: tool\n---\nkind: gate\n---\n", ok("tool")],
    ["---\n---\nkind: tool\n---\n", ok("tool")],
    ["---\nkind: tool\n---", ok("tool")],
    ["---\nkind: tool\n---  \n", ok("tool")],
    ["---\nkind: tool\n--- x\n", err("kind-missing")],
    ["---\rkind: tool\r---\r", err("kind-missing")],
    // Python's line separators: U+2028 ends the `kind:` line.
    ["---\nkind: tool\u2028x: y\n---\n", ok("tool")],
  ] as [string, SkillKindRead][])("%j", (text, want) => {
    expect(readSkillKind(text)).toEqual(want);
  });
});

describe("lintSkills: tool", () => {
  // admits: a tool skill shipping no script is judgment over nothing; scripts/ is filesystem shape no schema over Markdown holds.
  it("flags a tool with no scripts/, an empty one, and passes one holding only a dotfile", () => {
    const root = tree();
    skill(root, "bare", "tool");
    skill(root, "empty", "tool");
    mkdirSync(join(root, "skills", "empty", "scripts"));
    skill(root, "dotted", "tool");
    write(join(root, "skills", "dotted", "scripts", ".keep"), "");
    skill(root, "scripted", "tool", "", { scripts: true });
    expect(pairs(root)).toEqual([
      ["bare", "tool-without-scripts"],
      ["empty", "tool-without-scripts"],
    ]);
  });
});

describe("lintSkills: reference", () => {
  // admits: a reference carrying a procedure hides a workflow from the workflow contract; fence and list grammar is not a type.
  it.each([
    ["1. do this\n2. then that\n", true],
    ["## Step 1 — look\n", true],
    ["###### Phase  2\n", true],
    ["####### Step 1\n", false],
    ["## Steps 1\n", false],
    ["- a fact\n- another\n", false],
    ["1. only one item\n", false],
    ["```\n1. in code\n2. still code\n```\n", false],
    // Any fence marker toggles: ``` opens and ~~~ closes.
    ["```\n1. in code\n~~~\n2. out\n3. out\n", true],
    // The item count never resets across prose or a fence.
    ["1. a\n\nprose\n\n2. b\n", true],
    ["1. a\n```\n9. x\n```\n2. b\n", true],
    ["    1. a\n    2. b\n", false],
    ["   1) a\n   2) b\n", true],
    // Python's \d is any decimal digit.
    ["١. a\n٢. b\n", true],
  ] as [string, boolean][])("%j fires: %p", (body, fires) => {
    const root = tree();
    skill(root, "ref", "reference", body);
    expect(rules(root).includes("reference-has-procedure")).toBe(fires);
  });

  // admits: a numbered list inside the frontmatter is not body; counting it flags clean references.
  it("reads only the body: a numbered list in the frontmatter does not count", () => {
    const root = tree();
    write(join(root, "skills", "ref", "SKILL.md"), "---\nkind: reference\nnote: |\n  1. a\n  2. b\n1. x: y\n2. z: w\n---\nbody\n");
    expect(lintSkills(root).findings).toEqual([]);
  });
});

describe("lintSkills: workflow", () => {
  // admits: a long single-file workflow passes, or a references/ holding no .md clears it; cross-file shape no schema holds.
  it.each([
    [300, [], true],
    [300, ["plan.md"], false],
    [300, ["notes.txt"], true],
    [300, ["stages/plan.md"], false],
    [150, [], false],
  ] as [number, string[], boolean][])("%p lines, references %j, fires: %p", (lines, refs, fires) => {
    const root = tree();
    skill(root, "flow", "workflow", "step\n".repeat(lines));
    for (const r of refs) write(join(root, "skills", "flow", "references", r), "stage\n");
    expect(rules(root).includes("workflow-stages-inline")).toBe(fires);
  });

  // admits: an empty references/ is the cheapest false pass; only a fixture tree shows it.
  it("an empty references/ does not clear a long workflow", () => {
    const root = tree();
    skill(root, "flow", "workflow", "step\n".repeat(300));
    mkdirSync(join(root, "skills", "flow", "references"));
    expect(lintSkills(root).findings).toEqual([
      { skill: "flow", rule: "workflow-stages-inline", message: "305 lines, over 200, with no references/: move each stage to references/<stage>.md" },
    ]);
  });

  // admits: an off-by-one at the ceiling, or a line count that adds one for the final newline, flags or frees the wrong skills.
  it.each([
    ["\n", "\n", 200, false],
    ["\n", "\n", 201, true],
    ["\n", "", 201, true],
    ["\n", "\n\n", 200, true],
    ["\r\n", "\r\n", 201, true],
    ["\r", "\r", 200, false],
    ["\u2028", "\u2028", 201, true],
    ["\f", "\f", 200, false],
  ])("x lines joined by %j, ending %j: %p fires: %p", (sep, end, n, fires) => {
    const root = tree();
    write(join(root, "skills", "flow", "SKILL.md"), `---\nkind: workflow\n---\n${Array.from({ length: n - 3 }, () => "x").join(sep)}${end}`);
    expect(rules(root)).toEqual(fires ? ["workflow-stages-inline"] : []);
  });
});

describe("lintSkills: rubric", () => {
  // admits: a rubric with no producer or judge is never applied; the wiring is cross-file frontmatter and prose.
  it("flags a long rubric with no producer and no judge, in that order", () => {
    const root = tree();
    skill(root, "shape", "rubric", "line\n".repeat(70));
    expect(lintSkills(root).findings).toEqual([
      { skill: "shape", rule: "rubric-too-long", message: "75 lines, at most 60" },
      { skill: "shape", rule: "rubric-no-producer", message: "no agent or skill preloads it in `skills:`" },
      { skill: "shape", rule: "rubric-no-judge", message: "no kind: gate skill names it" },
    ]);
  });

  // admits: an off-by-one at the rubric ceiling.
  it.each([
    [60, false],
    [61, true],
  ])("%p lines fires: %p", (n, fires) => {
    const root = tree();
    write(join(root, "skills", "shape", "SKILL.md"), `---\nkind: rubric\n---\n${"x\n".repeat(n - 3)}`);
    expect(rules(root).includes("rubric-too-long")).toBe(fires);
  });

  // admits: each producer form and judge form either wires the rubric or does not; a wrong call hides or invents a finding.
  it.each([
    ["an agent preload", (r: string) => agent(r, "implement-task, shape"), "Judge with `shape@1`.\n", []],
    ["a .claude/agents preload", (r: string) => agent(r, "shape", ".claude/agents"), "shape", []],
    ["a quoted flow-list preload", (r: string) => agent(r, `["shape", 'other']`), "shape", []],
    ["a skill's preload", (r: string) => write(join(r, "skills", "flow", "SKILL.md"), "---\nkind: workflow\nskills: [shape, other]\n---\nb\n"), "shape", []],
    ["a block-list preload", (r: string) => write(join(r, "agents", "a.md"), "---\nskills:\n  - shape\n---\n"), "shape", ["rubric-no-producer"]],
    ["an indented preload", (r: string) => write(join(r, "agents", "a.md"), "---\nx:\n  skills: shape\n---\n"), "shape", ["rubric-no-producer"]],
    ["a preload in a skill body", (r: string) => skill(r, "flow", "workflow", "skills: [shape]\n"), "shape", ["rubric-no-producer"]],
    ["a judge naming only a longer name", (r: string) => agent(r, "shape"), "see shape-x, myshape and shape_y", ["rubric-no-judge"]],
    ["a judge naming it after a Unicode letter", (r: string) => agent(r, "shape"), "éshape", ["rubric-no-judge"]],
    ["a judge naming it before and after punctuation", (r: string) => agent(r, "shape"), "(shape@12).", []],
    ["a judge whose name is a prefix of a longer word, then the name", (r: string) => agent(r, "shape"), "shapeshape shape", []],
  ] as [string, (r: string) => void, string, string[]][])("%s", (_label, producer, gateText, want) => {
    const root = tree();
    skill(root, "shape", "rubric", "PASS when …\n");
    skill(root, "judge", "gate", gateText);
    producer(root);
    expect(rules(root)).toEqual(want);
  });

  // admits: a dotted rubric name whose real mention starts inside a rejected one (`yx.x.x`) is missed by a scan that resumes past the rejected match.
  it("finds a mention that overlaps a rejected one", () => {
    const root = tree();
    skill(root, "x.x", "rubric", "PASS\n");
    agent(root, "x.x");
    skill(root, "judge", "gate", "yx.x.x\n");
    expect(lintSkills(root).findings).toEqual([]);
  });

  // admits: a judge mention kept in a gate's references/ counts; reading only SKILL.md reports the rubric judge-less.
  it("a gate's references/*.md and a .claude/skills gate judge it; a non-gate skill does not", () => {
    const root = tree();
    skill(root, "shape", "rubric", "PASS\n");
    agent(root, "shape");
    skill(root, "other", "workflow", "names shape\n");
    expect(rules(root)).toEqual(["rubric-no-judge"]);
    skill(root, "judge", "gate", "", { rel: ".claude/skills" });
    write(join(root, ".claude", "skills", "judge", "references", "deep", "x.md"), "uses shape@1\n");
    expect(rules(root)).toEqual([]);
  });

  // admits: the strip the rubric-binding tests do (remove the name from producers or judges) must turn the lint red, and an incidental `improvement-loop` must not count as the judge.
  it("stripping a rubric's name from the producers or the judges flags it", () => {
    const strip = (file: string) => writeFileSync(file, readFileSync(file, "utf8").replace(/(?<![\w-])improvement(?:@\d+)?(?![\w-])/g, "REMOVED"));
    const build = (): string => {
      const root = tree();
      skill(root, "improvement", "rubric", "PASS when leaner\n");
      skill(root, "verify", "gate", "Judge with improvement@1 at the improvement-loop stage.\n");
      agent(root, "implement-task, improvement");
      return root;
    };
    expect(pairs(build())).toEqual([]);
    const noProducer = build();
    strip(join(noProducer, "agents", "impl-x.md"));
    expect(pairs(noProducer)).toEqual([["improvement", "rubric-no-producer"]]);
    const noJudge = build();
    strip(join(noJudge, "skills", "verify", "SKILL.md"));
    expect(pairs(noJudge)).toEqual([["improvement", "rubric-no-judge"]]);
  });
});

describe("lintSkills: the tree", () => {
  // admits: findings in another order break the line-for-line parity a caller diffs against; order is behaviour.
  it("reports kind errors first, then contracts, each in skill order, skills before .claude/skills", () => {
    const root = tree();
    skill(root, "z-tool", "tool");
    skill(root, "a-b", "nope");
    skill(root, "a", "tool");
    skill(root, "B", "tool");
    write(join(root, "skills", "dup", "SKILL.md"), "---\nkind: tool\nkind: gate\n---\n");
    skill(root, "c-tool", "tool", "", { rel: ".claude/skills" });
    write(join(root, ".claude", "skills", "bare", "SKILL.md"), "no frontmatter\n");
    write(join(root, "skills", "no-skill-md", "README.md"), "x\n");
    const kinds = "['gate', 'mode', 'reference', 'rubric', 'tool', 'workflow']";
    expect(lintSkills(root)).toEqual({
      skills: 7,
      findings: [
        { skill: "a-b", rule: "kind-unknown", message: `declare one of ${kinds}` },
        { skill: "dup", rule: "kind-duplicate", message: `declare one of ${kinds}` },
        { skill: "bare", rule: "kind-missing", message: `declare one of ${kinds}` },
        { skill: "B", rule: "tool-without-scripts", message: "a tool ships scripts/" },
        { skill: "a", rule: "tool-without-scripts", message: "a tool ships scripts/" },
        { skill: "z-tool", rule: "tool-without-scripts", message: "a tool ships scripts/" },
        { skill: "c-tool", rule: "tool-without-scripts", message: "a tool ships scripts/" },
      ],
    });
  });

  // admits: a skill dir installed as a symlink (the skills CLI's layout) or a file with lone-CR endings would be skipped or misread.
  it("follows a symlinked skill dir, and reads lone-CR line endings as Python's universal newlines do", () => {
    const root = tree();
    const elsewhere = tree();
    skill(elsewhere, "linked", "tool");
    mkdirSync(join(root, "skills"));
    symlinkSync(join(elsewhere, "skills", "linked"), join(root, "skills", "linked"));
    write(join(root, "skills", "cr", "SKILL.md"), "---\rkind: tool\r---\r");
    expect(pairs(root)).toEqual([
      ["cr", "tool-without-scripts"],
      ["linked", "tool-without-scripts"],
    ]);
  });

  // admits: a root with no skill roots must be clean and countable, not a crash; an SDK caller lints arbitrary dirs.
  it("a root with no skills is clean", () => {
    expect(lintSkills(tree())).toEqual({ skills: 0, findings: [] });
  });
});

describe("eris skills lint (CLI)", () => {
  function fixture(): string {
    sb = sandbox("eris-skills-lint-");
    const root = join(sb.dir, "repo");
    skill(root, "good", "tool", "", { scripts: true });
    skill(root, "bare", "tool");
    skill(root, "x", "nope");
    return root;
  }

  // admits: a lint that exits 0 on findings, or prints them to the wrong stream, passes every CI job that runs it.
  it("prints one line per finding on stdout, the count on stderr, and exits 1", async () => {
    const root = fixture();
    const r = await sb!.run(["skills", "lint", root]);
    expect(r).toMatchObject({
      status: 1,
      stdout: "x: kind-unknown: declare one of ['gate', 'mode', 'reference', 'rubric', 'tool', 'workflow']\nbare: tool-without-scripts: a tool ships scripts/\n",
      stderr: "2 finding(s) over 3 skills\n",
    });
  });

  // admits: a clean tree that exits non-zero, or a default dir other than the cwd, fails the hook that runs bare `eris skills lint`.
  it("exits 0 on a clean tree, linting the cwd by default", async () => {
    const root = fixture();
    rmSync(join(root, "skills", "bare"), { recursive: true });
    rmSync(join(root, "skills", "x"), { recursive: true });
    const r = await sb!.run(["skills", "lint"], { cwd: root });
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ status: 0, stdout: "", stderr: "0 finding(s) over 1 skills\n" });
  });

  // admits: the JSON record is the machine contract; a changed key or a lost exit code breaks a caller parsing it.
  it.each([[["--json"]], [["--output", "json"]]])("%j prints {skills, findings} and keeps the exit code", async (flags) => {
    const root = fixture();
    const r = await sb!.run([...flags, "skills", "lint", root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual({
      skills: 3,
      findings: [
        { skill: "x", rule: "kind-unknown", message: "declare one of ['gate', 'mode', 'reference', 'rubric', 'tool', 'workflow']" },
        { skill: "bare", rule: "tool-without-scripts", message: "a tool ships scripts/" },
      ],
    });
  });

  // admits: a typo'd dir must not lint as clean (0 skills, exit 0); only the run shows the slug and the empty stdout.
  it.each([["missing"], ["a file"]])("refuses a %s dir with skills-lint-unreadable and nothing on stdout", async (what) => {
    const root = fixture();
    const target = what === "missing" ? join(root, "nope") : join(root, "skills", "good", "SKILL.md");
    const r = await sb!.run(["skills", "lint", target]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("slug: skills-lint-unreadable\n");
  });
});
