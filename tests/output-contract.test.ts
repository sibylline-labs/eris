/**
 * The output contract (docs/OUTPUT-CONTRACT.md), pinned BLACK-BOX
 * through the real `eris` entrypoint (tests/helpers/blackbox.ts). Ported from
 * tests/test_output_contract.bats; every test names the documented
 * clause it defends: a consumer parses stdout as pure JSON, and line-prefix-parses
 * the failure block, trailing space after `slug:` included.
 *
 * No test reaches a network: `eris yak` runs with no Yaks credentials in the
 * sandbox, so it ends at its "not configured" outcome.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  expectFailBlock,
  expectNoAnsi,
  expectStatus,
  expectStderrEmpty,
  expectStdoutEmpty,
  expectStdoutJson,
  type Run,
  type Sandbox,
  sandbox,
} from "./helpers/blackbox";

setDefaultTimeout(60_000);

let sb: Sandbox;
let repo: string;

beforeEach(() => {
  sb = sandbox("eris-contract-");
  repo = join(sb.dir, "repo");
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: repo });
  sb.cwd = repo;
});

afterEach(() => {
  sb.cleanup();
});

/** A yak report with no Yaks credentials in the sandbox: the verb runs to its
 *  "not configured" outcome and touches no network. */
const YAK = ["yak", "issue", "--summary", "a hook blocks a legal edit", "--body", "the pre-edit hook refuses a write"];

/** A refusal block the global pre-pass writes: `completion` has no JSON rendering. */
const REFUSED = ["--output", "json", "completion", "bash"];

// --- §1 the stream split ---------------------------------------------------------

describe("§1 the stream split", () => {
  test("a failure writes NOTHING to stdout — the whole block is on stderr", async () => {
    /** When a failure path prints to stdout, a consumer's JSON parse of stdout fails. */
    const r = await sb.run(REFUSED);
    expectStatus(r, 1);
    expectStdoutEmpty(r);
    expect(r.stderr).toContain("ERROR 'eris completion bash' has no JSON rendering");
  });

  test("a machine surface's stdout is JSON only — no diagnostics mixed in", async () => {
    /** When a diagnostic lands on a --output json stdout, a consumer cannot parse the payload. */
    const r = await sb.run(["--output", "json", ...YAK]);
    expectStatus(r, 0);
    expectStderrEmpty(r);
    const doc = expectStdoutJson(r) as { verb: string; delivered: boolean };
    // The record is the verb's own outcome, not an empty object.
    expect({ verb: doc.verb, delivered: doc.delivered }).toEqual({ verb: "issue", delivered: false });
  });

  test("--version is a machine surface: one JSON record on stdout, nothing on stderr", async () => {
    /** When a build's identity leaks a diagnostic onto stderr or stdout stops being one record, a script pinning on `version` or `release_repo` cannot read it. */
    const r = await sb.run(["--output", "json", "--version"]);
    expectStatus(r, 0);
    expectStderrEmpty(r);
    const doc = expectStdoutJson(r) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(["build_id", "extra", "release_repo", "version"]);
    expect(doc.release_repo).toBe("sibylline-labs/eris");
    // PAIRED: the human rendering names the same version and repository.
    const text = await sb.run(["--version"]);
    expectStatus(text, 0);
    expect(text.stdout).toStartWith(`eris ${doc.version as string} (sibylline-labs/eris)\n`);
  });

  test("no ANSI on stdout when stdout is not a TTY (human rendering too)", async () => {
    /** When a renderer hardcodes an escape, every piped consumer reads control bytes. */
    const r = await sb.run(["--help"]);
    expectStatus(r, 0);
    expectNoAnsi(r.stdout, r);
    // PAIRED: the render really ran — not passing because stdout is empty.
    expect(r.stdout).toContain("Usage: eris <command>");
  });
});

// --- §2 the flag ---------------------------------------------------------------

describe("§2 the global --output flag", () => {
  test("the global flag is positional-agnostic (--output=json after the group)", async () => {
    /** When the pre-pass only reads the flag before the group, `yak issue --output=json …` renders text to a parser. */
    const [group, verb, ...rest] = YAK;
    const r = await sb.run([group!, verb!, "--output=json", ...rest]);
    expectStatus(r, 0);
    expectStdoutJson(r);
  });

  test("--output json is REFUSED where no JSON rendering exists, never degraded", async () => {
    /** When a verb with no JSON rendering degrades to text under --output json, a parser chokes on text. */
    const r = await sb.run(REFUSED);
    expectFailBlock(r, "output-json-unsupported");
    // The refusal names where the flag IS accepted — a dead end is not actionable.
    expect(r.stderr).toMatch(/^fix: .*eris yak issue/m);
  });

  test.each([[["yak"]], [["yak", "frobnicate"]], [["completion", "zsh"]], [["completion"]]])(
    "a group whose subs render JSON did NOT open the group: %p refuses --output json",
    async (argv) => {
      /** When a group is registered wholesale, a verb with no machine rendering starts printing text to a parser. */
      const r = await sb.run(["--output", "json", ...argv]);
      expectFailBlock(r, "output-json-unsupported");
    },
  );

  test("an unknown --output value fails with its own slug", async () => {
    /** When an unknown format silently falls back to text, `--output yaml` callers parse text. */
    const r = await sb.run(["--output", "yaml", ...YAK]);
    expectFailBlock(r, "output-format-unknown");
  });

  test("-- terminates global parsing, so a positional may look like the flag", async () => {
    /** When the pre-pass eats `--output=json` after `--`, a value that looks like the flag can never be passed. */
    const r = await sb.run(["completion", "bash", "--", "--output=json"]);
    expect(r.stderr).not.toContain("output-format-unknown");
    // PAIRED: the verb was reached (it, not the pre-pass, answered).
    expect(r.stderr).toContain("ERROR Unexpected arg '--output=json' (usage: eris completion bash)");
  });
});

// --- §4 the failure block ---------------------------------------------------------

describe("§4 the failure block as a parseable format", () => {
  test("ERROR / slug: / fix: / docs: ×2, in that order, on stderr", async () => {
    /** When the block's order or count drifts, a line-prefix parser mis-assigns fields. */
    const r = await sb.run(REFUSED);
    expectFailBlock(r, "output-json-unsupported");
  });

  test("the block's prefixes carry their single trailing space, byte-exact", async () => {
    /** When `slug:x` or `slug:  x` is emitted, a prefix parser breaks — and both pass a naive substring check. */
    const r = await sb.run(REFUSED);
    const lines = r.stderr.split("\n");
    expect(lines).toContain("slug: output-json-unsupported");
    expect(r.stderr).toMatch(/^slug: [^ ]/m);
    expect(r.stderr).toMatch(/^fix: [^ ]/m);
    expect(r.stderr).toMatch(/^docs: [^ ]/m);
    // The ERROR line has no colon — it is 'ERROR <message>'.
    expect(r.stderr).toMatch(/^ERROR [^ ]/m);
    expect(r.stderr).not.toMatch(/^ERROR:/m);
    // No empty `fix: ` line: the last fix line carries text.
    expect(r.stderr).not.toMatch(/^fix: $/m);
  });

  test("one failure yields exactly ONE block — no cascade", async () => {
    /** When a failure cascades into a second block, a consumer reports the wrong slug. */
    const r = await sb.run(REFUSED);
    expect(r.stderr.match(/^ERROR /gm)?.length).toBe(1);
    expect(r.stderr.match(/^slug: /gm)?.length).toBe(1);
  });

  test("the failure's bytes do not vary with PATH", async () => {
    /**
     * When a logger shells out to an optional binary, "is it installed" becomes
     * an input to the bytes a machine consumer parses. A verb refuses an unknown
     * flag before reading anything. The floor PATH keeps only bun's and bash's
     * own directories plus /usr/bin:/bin — no yq, no ast-grep, no git extras.
     */
    const argv = ["completion", "bash", "--nope"];
    const full = await sb.run(argv);
    expectStatus(full, 1);
    expectStdoutEmpty(full);
    expect(full.stderrBytes.length).toBeGreaterThan(0);
    const bash = Bun.which("bash");
    const floor = [dirname(process.execPath), bash ? dirname(bash) : "/bin", "/usr/bin", "/bin"].join(":");
    const thin = await sb.run(argv, { env: { PATH: floor } });
    expectStatus(thin, 1);
    expectStdoutEmpty(thin);
    expect(thin.stderrBytes.equals(full.stderrBytes)).toBe(true);
  });
});

// --- §3 frozen text surfaces ---------------------------------------------------------

describe("§3 the frozen text surfaces", () => {
  test("completion bash is valid bash on stdout, exit 0, nothing on stderr", async () => {
    /** When the emitted completion is not valid bash, every operator shell start prints a syntax error. */
    const r = await sb.run(["completion", "bash"]);
    expectStatus(r, 0);
    expectStderrEmpty(r);
    expect(r.stdoutBytes.length).toBeGreaterThan(0);
    const check = spawnSync("bash", ["-n"], { input: r.stdoutBytes });
    expect(check.status, check.stderr?.toString()).toBe(0);
    expectNoAnsi(r.stdout, r);
  });
});

// --- the harness's own controls (a control that has never failed is not a control) ----

describe("harness controls (tests/helpers/blackbox.ts)", () => {
  const fails = (fn: () => void) => expect(fn).toThrow();

  test("expectStdoutEmpty FAILS when a byte reaches stdout", async () => {
    const r = await sb.run(["completion", "bash"]);
    fails(() => expectStdoutEmpty(r));
  });

  test("expectFailBlock FAILS on the wrong slug", async () => {
    const r = await sb.run(REFUSED);
    expectFailBlock(r, "output-json-unsupported");
    fails(() => expectFailBlock(r, "not-the-slug"));
  });

  test("expectNoAnsi FAILS on a stream that carries an escape", () => {
    fails(() => expectNoAnsi("x\x1b[1mbold\x1b[0m\n"));
  });

  test("fakes are PATH executables that record argv, seen from a non-bash child", async () => {
    sb.fake("curl", "exit 0");
    const r = spawnSync("bun", ["-e", 'Bun.spawnSync(["curl", "-sS", "http://yaks.test/v0/nodes/x"])'], { env: sb.env });
    expect(r.status).toBe(0);
    expect(sb.calls("curl")).toBe(1);
    expect(sb.argv("curl")).toContain("/v0/nodes/");
    expect(statSync(join(sb.fakes, "curl")).mode & 0o111).not.toBe(0);
  });

  test("hideReal makes a binary unresolvable while keeping its neighbours", () => {
    sb.fake("gcloud", "exit 0");
    sb.hideReal("gcloud");
    expect(spawnSync("sh", ["-c", "command -v gcloud"], { env: sb.env }).status).not.toBe(0);
    expect(spawnSync("sh", ["-c", "command -v bun"], { env: sb.env }).status).toBe(0);
  });

  test("the sandbox is physical and never names the developer's terminal colour", () => {
    expect(realpathSync(sb.dir)).toBe(sb.dir);
    expect(sb.env.NO_COLOR).toBe("1");
    expect(sb.env.FORCE_COLOR).toBeUndefined();
    expect(sb.env.ERIS_YAKS_URL).toBeUndefined();
    expect(readdirSync(sb.dir).sort()).toEqual(["argv", "fakes", "home", "repo", "tmp"]);
  });
});

export type { Run };
