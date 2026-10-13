/**
 * A distribution: another repository that depends on this package, imports
 * core only as `eris/sdk`, composes core with its own plugin list and builds
 * its own binary with `build()` (docs/dev/PLUGINS.md#distributions).
 *
 * The fixture is examples/distribution: an entry composing this build's
 * plugins plus a demo plugin whose slot carries a completion domain, owning
 * the bare program with a menu, built with an asset root, a stub and a release
 * repository of its own. Seams: the package specifier, `main` handed the
 * fixture's composition, and the compiled fixture driven as a subprocess.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildInChild } from "eris/sdk/testing";
import { BUILD } from "../examples/distribution/build";
import { DISTRIBUTION, DISTRIBUTION_PLUGINS } from "../examples/distribution/main";
import yak from "../plugins/yak";
import { build } from "../src/build";
import { composeCli, PluginCompositionError } from "../src/cli/compose";
import type { ErisPlugin } from "../src/cli/plugin";
import { REGISTRY } from "../src/cli/registry";
import { CLI, HANDLERS, main } from "../src/main";
import { checkoutOnly, ERIS, oracleEnv, REPO, type Sandbox, sandbox } from "./helpers/blackbox";

setDefaultTimeout(120_000);

/** The example distribution's root: its own directory, not this package's. */
const DIST_ROOT = join(REPO, "examples", "distribution");

async function run(argv: string[]): Promise<{ rc: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const rc = await main(argv, { _ERIS_SHIM_DIR: REPO, PATH: process.env.PATH, HOME: process.env.HOME }, {
    cli: DISTRIBUTION,
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: (s: string) => ((stderr += s), true) },
  });
  return { rc, stdout, stderr };
}

/** One tab press under macOS's /bin/bash 3.2: COMPREPLY, one word per entry. */
function press(script: string, words: string[]): string[] {
  const quoted = words.map((w) => `'${w}'`).join(" ");
  const r = spawnSync("/bin/bash", ["-c", `source '${script}'; COMP_WORDS=(${quoted}); COMP_CWORD=${words.length - 1}; _eris_completions; printf '%s\\n' "\${COMPREPLY[@]-}"`], {
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  expect({ words, status: r.status, stderr: r.stderr }).toEqual({ words, status: 0, stderr: "" });
  return r.stdout.split("\n").filter((l) => l !== "").sort();
}

describe("the package's exports", () => {
  it("eris/sdk resolves through the package's own exports map, with the documented names, and a deep path does not", async () => {
    /** When the exports map loses `./sdk`, or a name a distribution imports leaves the SDK, a repository pinned to this one stops building at its next pin bump; when a deep path resolves again, a distribution couples to a core file a refactor moves silently: observed through the package specifier, as a dependent repository imports it. */
    const sdk = await import("eris/sdk");
    expect(Object.keys(sdk).sort()).toEqual([
      "BUILD_ID",
      "CliExit",
      "GlobalFlagError",
      "HANDLERS",
      "NO_ENTITLEMENTS",
      "PLUGINS",
      "PluginCompositionError",
      "REGISTRY",
      "RELEASE_REPO",
      "argErrorWhat",
      "build",
      "childEnv",
      "composeCli",
      "definePlugin",
      "erisHome",
      "flagsOf",
      "groupArgs",
      "info",
      "installRoot",
      "installRootIsUnwritten",
      "isCompiled",
      "main",
      "nodeRunner",
      "ok",
      "onPath",
      "parseGlobal",
      "readArgs",
      "readEnv",
      "readVerbArgs",
      "refuseArg",
      "renderFailureBlock",
      "renderWarnLines",
      "resolveConcurrency",
      "resolveDeadlineMs",
      "rowsOfGroup",
      "runMany",
      "runPool",
      "runProgram",
      "sanitizeDisplay",
      "signalTree",
      "usageLine",
      "warn",
    ]);
    // The SDK's composition inputs are core's own, so a distribution composes what this build composes.
    expect(sdk.REGISTRY).toBe(REGISTRY);
    expect(sdk.PLUGINS.map((p) => p.name)).toEqual(["yak"]);
    // Through a variable: the type checker refuses the literal the same way.
    const deepPath = "eris/src/cli/compose";
    const deep = await import(deepPath).then(
      () => "resolved",
      (e: { code?: string }) => e.code,
    );
    expect(deep).toBe("ERR_MODULE_NOT_FOUND");
  });

  it("a distribution entry outside the router parses and refuses `--output` with the SDK's own parseGlobal and GlobalFlagError", async () => {
    /** When the SDK's GlobalFlagError is not the class its parseGlobal throws (a copy, or a re-export of another module), a standalone entry's `catch` never matches and a bad `--output` ends as a stack trace instead of the `output-format-unknown` block: observed through the package specifier, as such an entry imports it. */
    const { parseGlobal, GlobalFlagError } = await import("eris/sdk");
    expect(parseGlobal(["--output", "json", "demo", "--", "-x"], REPO)).toEqual({ format: "json", argv: ["demo", "-x"] });
    let caught: unknown;
    try {
      parseGlobal(["--output", "xml"], REPO);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GlobalFlagError);
    expect((caught as InstanceType<typeof GlobalFlagError>).block).toContain("slug: output-format-unknown\n");
  });

  it("eris/sdk/testing carries the test helpers a distribution's suites need, and eris/sdk (the list above) none of them", async () => {
    /** When a test helper moves into `eris/sdk` it ships in every distribution's SDK surface, and when one leaves the subpath a distribution's suites copy it again: observed through the package specifier, as a dependent repository's tests import it. */
    const testing = await import("eris/sdk/testing");
    expect(Object.keys(testing).sort()).toEqual(["buildInChild", "createFakeRunner"]);
  });
});

describe("this build's composition", () => {
  it("is core's rows plus the yak plugin's, exactly", () => {
    /** When a distribution's plugin or the example plugins leak into this build's list, the public binary ships verbs it neither documents nor tests: observed at the composed registry and at the top-level help of the program under test. */
    expect(Object.keys(CLI.registry).sort()).toEqual([...Object.keys(REGISTRY), ...Object.keys(yak.rows)].sort());
    expect(CLI.groups.map((g) => [g.group, g.plugin])).toEqual([["yak", "yak"]]);
    const help = spawnSync(ERIS, ["--help"], { env: { ...process.env, ...oracleEnv() }, encoding: "utf8" });
    expect(help.status).toBe(0);
    const commands = help.stdout.split("\nCommands:\n")[1]!.split("\n\n")[0]!.split("\n").map((l) => l.trim().split(/\s+/)[0]);
    expect(commands).toEqual(["completion", "update", "yak"]);
    // The public program has no menu, so it promises no interactive mode (the example distribution's usage does).
    expect(help.stdout).toContain("\nRun 'eris <command> --help' for command-specific usage.\n");
    expect(help.stdout).not.toContain("interactive mode");
  });
});

describe("the example distribution, composed", () => {
  it("routes core, this build's plugins and its own, and owns the bare program", async () => {
    /** When a distribution's composition drops a layer (core, this build's plugins, its own) or its menu, a private build silently loses verbs or its launcher: observed through `main` with the fixture's composition. */
    expect(await run([])).toEqual({ rc: 0, stdout: "example distribution: yak, demo (eris --help for usage)\n", stderr: "" });
    const help = await run(["--help"]);
    for (const line of ["\n  completion ", "\n  yak ", "\n  demo ", "\nRun 'eris' without arguments for interactive mode.\n"]) expect(help.stdout).toContain(line);
    expect((await run(["completion", "--help"])).stdout).toContain("never touches the network.\nAlso completes the names 'eris demo hello' greets (see the demo plugin).\nSee docs/COMPLETION.md.\n");
    expect(await run(["demo", "hello", "loud", "ada"])).toEqual({ rc: 0, stdout: "HELLO ADA\n", stderr: "" });
    expect((await run(["yak", "issue", "--help"])).stdout).toStartWith("usage: eris yak <issue|suggest|fatal>");
  });

  const mine = (rows: ErisPlugin["rows"]): ErisPlugin => ({ name: "mine", rows, handlers: Object.fromEntries(Object.keys(rows).map((g) => [g, HANDLERS.completion!])) });
  const collisions: [string, ErisPlugin, string][] = [
    ["a group of core's", mine({ completion: { impl: "ts", summary: "s" } }), "plugin 'mine': group 'completion' collides with a built-in command"],
    ["a group of this build's plugins", mine({ yak: { impl: "ts", summary: "s" } }), "plugin 'mine': group 'yak' collides with plugin 'yak'"],
    ["a group of its own plugins", mine({ demo: { impl: "ts", summary: "s" } }), "plugin 'mine': group 'demo' collides with plugin 'demo'"],
  ];
  it.each(collisions)("a further plugin taking %s is refused", (_name, plugin, message) => {
    /** When a distribution's plugin may take a name already composed, one of the two groups silently stops being reachable in the private build: observed at composeCli over the distribution's list. */
    expect(() => composeCli(REGISTRY, HANDLERS, [...DISTRIBUTION_PLUGINS, plugin])).toThrow(new PluginCompositionError(message));
  });
});

describe("build() refuses before it bundles", () => {
  const cases: [string, Partial<Parameters<typeof build>[0]>, string | RegExp][] = [
    ["a plugin list that does not compose", { plugins: [...DISTRIBUTION_PLUGINS, yak] }, "plugin 'yak' is composed twice"],
    ["an asset root outside the root", { assetRoots: ["../outside"] }, "asset root '../outside' is not a path inside the root"],
    ["an asset root that does not exist", { assetRoots: ["missing"] }, `asset root 'missing' does not exist under ${DIST_ROOT}`],
    ["a release repository that is not owner/name", { releaseRepo: "eris" }, 'releaseRepo must be owner/name: "eris"'],
  ];
  it.each(cases)("%s", async (_name, opts, message) => {
    /** When build() bundles past a plugin that does not compose, an asset it cannot carry, or a release repository update could not resolve, the binary ships broken or carries the wrong identity: observed at build()'s rejection, before any outfile exists. */
    const outfile = join(REPO, "dist", "fixture", "never-written");
    await expect(build({ ...BUILD, ...opts, outfile })).rejects.toThrow(message);
    expect(existsSync(outfile)).toBe(false);
  });
});

describe.skipIf(checkoutOnly("runs the example distribution and core from this checkout's source"))("a distribution run from source", () => {
  const bunRun = (sb: Sandbox, entry: string, argv: string[]) =>
    sb.run(["--no-env-file", "--config=/dev/null", entry, ...argv], { program: process.execPath, env: { _ERIS_SHIM_DIR: undefined } });
  let sb: Sandbox;
  beforeAll(() => {
    sb = sandbox("eris-dist-src-");
  });
  afterAll(() => sb?.cleanup());

  it("resolves its install root to its own directory: it reads its files there and its blocks name its docs there", async () => {
    /** When `runProgram` ignores `installRoot`, a distribution run from source (in a dependent repository, with core in node_modules/eris) reads its files and names its docs under the eris package's directory: `demo asset` cannot find its file and a failure block's `docs:` line points into core. Observed at the source run's stdout and stderr, with no shim. */
    const asset = await bunRun(sb, join(DIST_ROOT, "main.ts"), ["demo", "asset"]);
    expect({ status: asset.status, stdout: asset.stdout, stderr: asset.stderr }).toEqual({
      status: 0,
      stdout: readFileSync(join(DIST_ROOT, "assets", "greeting.txt"), "utf8"),
      stderr: "",
    });
    const refused = await bunRun(sb, join(DIST_ROOT, "main.ts"), ["--output", "xml", "demo", "asset"]);
    expect({ status: refused.status, stdout: refused.stdout }).toEqual({ status: 1, stdout: "" });
    expect(refused.stderr).toContain(`docs: ${DIST_ROOT}/docs/OUTPUT-CONTRACT.md#2-the-flag\n`);
    // PAIRED: core's own program, run the same way and handed no root, names this package's docs.
    const core = await bunRun(sb, join(REPO, "src", "main.ts"), ["--output", "xml", "yak"]);
    expect(core.stderr).toContain(`docs: ${REPO}/docs/OUTPUT-CONTRACT.md#2-the-flag\n`);
    expect(core.stderr).not.toContain(DIST_ROOT);
  });

  it("typechecks under a tsconfig that lists only the distribution's sources: core's ambient declarations come with the SDK", () => {
    /** When core's source reaches an ambient module nothing references (`eris:assets`, which `build()` supplies at bundle time), a dependent repository's own `tsc` fails inside the dependency (TS2307 in node_modules/eris) until it adds a `files` entry for a path in node_modules: observed by running tsc over the example distribution with a minimal tsconfig. */
    mkdirSync(join(REPO, ".scratch"), { recursive: true });
    const config = join(REPO, ".scratch", `consumer-${process.pid}.tsconfig.json`);
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true, skipLibCheck: true, types: ["bun-types"] },
        include: ["../examples/distribution/**/*.ts"],
      }),
    );
    try {
      const r = spawnSync(process.execPath, [join(REPO, "node_modules", "typescript", "bin", "tsc"), "-p", config, "--listFiles"], { cwd: REPO, encoding: "utf8" });
      // tsc reports on stdout, beside the file list.
      const files = r.stdout.split("\n");
      expect({ status: r.status, diagnostics: files.filter((l) => l.includes("error TS")), stderr: r.stderr }).toEqual({ status: 0, diagnostics: [], stderr: "" });
      // PAIRED: the program did reach the file that imports the ambient module, and pulled its declaration in by reference.
      expect(files).toContain(join(REPO, "src", "runtime", "home.ts"));
      expect(files).toContain(join(REPO, "src", "runtime", "eris-assets.d.ts"));
    } finally {
      rmSync(config, { force: true });
    }
  });

  it("refuses an install root that is not an absolute path", () => {
    /** When `runProgram` accepts a relative `installRoot`, a distribution's docs lines and file reads follow the caller's working directory, differently on every run: observed at the entry's exit status and message. */
    const r = spawnSync(process.execPath, ["--no-env-file", "--config=/dev/null", "-e", 'import { runProgram } from "eris/sdk"; runProgram({ installRoot: "examples/distribution" });'], {
      cwd: REPO,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('installRoot must be an absolute path: "examples/distribution"');
  });
});

describe.skipIf(checkoutOnly("builds its own binary from this checkout's source"))("the example distribution, compiled by build()", () => {
  const outfile = join(REPO, "dist", "fixture", "eris-distribution");
  let sb: Sandbox;
  let script: string;
  beforeAll(async () => {
    rmSync(join(REPO, "dist", "fixture"), { recursive: true, force: true });
    const r = buildInChild({ module: join(REPO, "examples", "distribution", "build.ts"), outfile });
    expect(r).toMatchObject({ outfile, releaseRepo: "example-org/eris-distribution" });
    sb = sandbox("eris-dist-");
    const c = await sb.run(["completion", "bash"], { program: outfile });
    expect({ status: c.status, stderr: c.stderr }).toEqual({ status: 0, stderr: "" });
    mkdirSync(join(REPO, ".scratch"), { recursive: true });
    script = join(REPO, ".scratch", `distribution-${process.pid}.bash`);
    writeFileSync(script, c.stdout);
  });
  afterAll(() => {
    sb?.cleanup();
    if (script !== undefined) rmSync(script, { force: true });
  });

  it("runs its own verbs, this build's plugins and its menu, from its own entry", async () => {
    /** When build() compiles core's entry instead of the distribution's, or the bundle cannot resolve `eris/sdk`, the private binary is the public one or does not start: observed at the compiled fixture's output. */
    expect(await sb.run([], { program: outfile })).toMatchObject({ status: 0, stdout: "example distribution: yak, demo (eris --help for usage)\n", stderr: "" });
    expect(await sb.run(["demo", "hello", "quiet", "grace"], { program: outfile })).toMatchObject({ status: 0, stdout: "hello grace\n", stderr: "" });
    const yakHelp = await sb.run(["yak", "issue", "--help"], { program: outfile });
    expect({ status: yakHelp.status, head: yakHelp.stdout.split("\n")[0] }).toEqual({ status: 0, head: "usage: eris yak <issue|suggest|fatal> [flags]" });
  });

  it("carries its asset roots, its release repository and its stubs", async () => {
    /** When build() drops an asset root, bakes another build's release repository, or bundles a stubbed module, the binary reads a file that is not there, updates itself from the wrong repository, or carries what it must not: observed at the compiled fixture's output. */
    const asset = await sb.run(["demo", "asset"], { program: outfile });
    expect({ status: asset.status, stdout: asset.stdout }).toEqual({ status: 0, stdout: readFileSync(join(DIST_ROOT, "assets", "greeting.txt"), "utf8") });
    expect(await sb.run(["demo", "release"], { program: outfile })).toMatchObject({ status: 0, stdout: "example-org/eris-distribution\n" });
    const heavy = await sb.run(["demo", "heavy"], { program: outfile });
    expect({ status: heavy.status, stdout: heavy.stdout }).toEqual({ status: 1, stdout: "" });
    expect(heavy.stderr).toContain("./heavy is not bundled into the compiled eris binary (demo-heavy-needs-checkout)");
    // PAIRED: from the checkout, the same verbs report this repository and load the module (the asset read from source is the source run's, above).
    expect(await run(["demo", "release"])).toEqual({ rc: 0, stdout: "sibylline-labs/eris\n", stderr: "" });
    expect(await run(["demo", "heavy"])).toEqual({ rc: 0, stdout: "heavy module loaded\n", stderr: "" });
  });

  it("completes its domain slot from the script the binary emits", () => {
    /** When the compiled completion drops a domain's helper or its slot wiring, the private build's env, key and name slots complete nothing: observed at a tab press on the script the binary emits. */
    expect(press(script, ["eris", "demo", "hello", ""])).toEqual(["loud", "quiet"]);
    expect(press(script, ["eris", "demo", "hello", "loud", ""])).toEqual(["ADA", "GRACE"]);
    expect(press(script, ["eris", "demo", "hello", "quiet", ""])).toEqual(["ada", "grace"]);
    expect(press(script, ["eris", ""])).toEqual(["--help", "--version", "completion", "demo", "update", "yak"]);
  });
});
