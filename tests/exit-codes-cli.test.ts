/**
 * The CLI's exit-code and error-shape contract (docs/ERRORS.md), black-box
 * through the real `eris` entrypoint — ported from tests/test_exit_codes.bats.
 * eris runs as a gate in other repos' pipelines and an agentic
 * harness parses its failures as text: for those consumers the exit code and
 * the shape of a failure ARE the API. A command that starts exiting 0 on a failure turns somebody else's merge
 * queue green on a broken change.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ERIS, expectFailBlock, expectStatus, expectStdoutEmpty, gitInit, HAVE, REPO, type Sandbox, sandbox } from "./helpers/blackbox";

setDefaultTimeout(60_000);

let sb: Sandbox;
let work: string;

/** A refusal block the global pre-pass writes: `completion` has no JSON rendering. */
const REFUSED = ["--output", "json", "completion", "bash"];

beforeEach(() => {
  sb = sandbox("eris-exit-");
  work = join(sb.dir, "repo");
  mkdirSync(work, { recursive: true });
  gitInit(work);
  sb.cwd = work;
});
afterEach(() => sb.cleanup());

describe("the declared table: 1 = hard failure, 2 = idempotent no-op", () => {
  test("docs/ERRORS.md declares the two exit codes the code actually uses", () => {
    /** When the doc stops stating the table, no other repo can rely on rc 2 meaning "nothing to do". */
    const doc = readFileSync(join(REPO, "docs/ERRORS.md"), "utf8");
    expect(doc).toMatch(/Exit codes: `1` = hard failure/);
    expect(doc).toMatch(/`2` = idempotent/);
  });

  test("every ERRORS.md slug heading is slug-shaped and unique", () => {
    /** When a heading is duplicated it silently satisfies two slugs; when malformed (`### Some Slug`) it satisfies none. */
    const headings = readFileSync(join(REPO, "docs/ERRORS.md"), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("### "))
      .map((l) => l.slice(4));
    expect(headings.length).toBeGreaterThan(10); // vacuity guard
    expect(headings.filter((h) => !/^[a-z0-9]+(-[a-z0-9]+)+$/.test(h))).toEqual([]);
    expect(headings.filter((h, i) => headings.indexOf(h) !== i)).toEqual([]);
  });
});

describe("dispatch: an unknown command, an unknown subcommand", () => {
  test("eris <unknown-command> exits 1 and names how to get help", async () => {
    /** When an unknown command exits 0, `eris confgi sync prod` passes a CI gate having deployed nothing. */
    const r = await sb.run(["definitely-not-a-command"]);
    expectStatus(r, 1);
    expectStdoutEmpty(r);
    expect(r.stderr).toContain("Unknown command");
    expect(r.stderr).toContain("--help");
  });

  test("eris --help exits 0 and lists the command groups, from a directory outside any repo", async () => {
    /** When --help needs a repo or a config file, the first command a new operator runs fails. */
    const r = await sb.run(["--help"], { cwd: sb.tmp });
    expectStatus(r, 0);
    const all = r.stdout + r.stderr;
    expect(all).toContain("completion");
    expect(all).toContain("yak");
  });

  test("eris --help runs with an unusable TMPDIR (a verb that loads no config does no temp-dir work)", async () => {
    /** When startup touches $TMPDIR, a full or missing temp dir breaks even --help, the command an operator runs to diagnose the box. */
    const r = await sb.run(["--help"], { cwd: sb.tmp, env: { TMPDIR: "/nonexistent" } });
    expectStatus(r, 0);
    expect(r.stdout + r.stderr).toContain("Usage: eris <command>");
  });

});

describe("unknown flags: rejected, never absorbed", () => {
  test.each<[string[]]>([
    [["completion", "--bogus"]],
    [["completion", "bash", "--bogus"]],
    [["yak", "issue", "--summary", "s", "--body", "b", "--bogus"]],
    [["yak", "--bogus"]],
  ])("eris %j rejects the unknown flag", async (argv) => {
    /** When a verb absorbs an unknown flag, a misspelt flag (`--dry-runn`) is dropped and the command runs as if it were absent. */
    const r = await sb.run(argv);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--bogus");
  });

  test("the global --output flag is refused by name even by a verb that parses no flags, and the verb does not run", async () => {
    /** When `completion bash --output json` degrades instead of refusing, a parser reads shell text — or the verb runs anyway. */
    const r = await sb.run(["completion", "bash", "--output", "json"]);
    expectFailBlock(r, "output-json-unsupported");
    expect(r.stderr).toContain("completion bash");
    expectStdoutEmpty(r);
    // POSITIVE control: without the flag this slug is not raised, so the refusal is the flag's.
    const plain = await sb.run(["completion", "bash"]);
    expect(plain.stderr).not.toContain("output-json-unsupported");
    expect(plain.stdout).toContain("complete -F _eris_completions eris");
  });
});

describe("the failure block on stderr", () => {
  test("a failure block is machine-parseable on stderr with stdout left clean", async () => {
    /** When the block or the stdout split breaks, a harness piping stdout loses the failure or parses it as payload. */
    const r = await sb.run(REFUSED);
    expectFailBlock(r, "output-json-unsupported");
    expect(r.stderr).toMatch(/^fix: /m);
  });

  test.skipIf(!HAVE("script"))("the machine-readable lines survive a TTY", () => {
    /** When something done to the human ERROR line on a terminal swallows the slug/fix/docs lines, an agent on a pty matches nothing. */
    const log = join(sb.dir, "pty.log");
    const cmd = `${ERIS} ${REFUSED.join(" ")}`;
    // util-linux and BSD script(1) take different argv; try both.
    const linux = spawnSync("script", ["-qec", cmd, log], { cwd: work, env: sb.env, stdio: "ignore" });
    if (linux.status !== 0 || !existsSync(log) || readFileSync(log, "utf8") === "") {
      spawnSync("script", ["-q", log, ERIS, ...REFUSED], { cwd: work, env: sb.env, stdio: "ignore" });
    }
    const out = readFileSync(log, "utf8");
    expect(out).toContain("slug: output-json-unsupported");
    expect(out).toContain("fix: ");
    expect(out).toContain("docs: ");
  });
});
