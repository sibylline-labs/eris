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
      "readArgs",
      "readEnv",
      "readVerbArgs",
      "refuseArg",
      "renderFailureBlock",
      "renderWarnLines",
      "rowsOfGroup",
      "runMany",
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
  });
});

describe("the example distribution, composed", () => {
  it("routes core, this build's plugins and its own, and owns the bare program", async () => {
    /** When a distribution's composition drops a layer (core, this build's plugins, its own) or its menu, a private build silently loses verbs or its launcher: observed through `main` with the fixture's composition. */
    expect(await run([])).toEqual({ rc: 0, stdout: "example distribution: yak, demo (eris --help for usage)\n", stderr: "" });
    const help = await run(["--help"]);
    for (const line of ["\n  completion ", "\n  yak ", "\n  demo "]) expect(help.stdout).toContain(line);
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
    ["an asset root that does not exist", { assetRoots: ["examples/distribution/missing"] }, `asset root 'examples/distribution/missing' does not exist under ${REPO}`],
    ["a release repository that is not owner/name", { releaseRepo: "eris" }, 'releaseRepo must be owner/name: "eris"'],
  ];
  it.each(cases)("%s", async (_name, opts, message) => {
    /** When build() bundles past a plugin that does not compose, an asset it cannot carry, or a release repository update could not resolve, the binary ships broken or carries the wrong identity: observed at build()'s rejection, before any outfile exists. */
    const outfile = join(REPO, "dist", "fixture", "never-written");
    await expect(build({ ...BUILD, ...opts, outfile })).rejects.toThrow(message);
    expect(existsSync(outfile)).toBe(false);
  });
});

describe.skipIf(checkoutOnly("builds its own binary from this checkout's source"))("the example distribution, compiled by build()", () => {
  const outfile = join(REPO, "dist", "fixture", "eris-distribution");
  let sb: Sandbox;
  let script: string;
  beforeAll(async () => {
    rmSync(join(REPO, "dist", "fixture"), { recursive: true, force: true });
    const r = await build({ ...BUILD, outfile });
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
    expect({ status: asset.status, stdout: asset.stdout }).toEqual({ status: 0, stdout: readFileSync(join(REPO, "examples/distribution/assets/greeting.txt"), "utf8") });
    expect(await sb.run(["demo", "release"], { program: outfile })).toMatchObject({ status: 0, stdout: "example-org/eris-distribution\n" });
    const heavy = await sb.run(["demo", "heavy"], { program: outfile });
    expect({ status: heavy.status, stdout: heavy.stdout }).toEqual({ status: 1, stdout: "" });
    expect(heavy.stderr).toContain("./heavy is not bundled into the compiled eris binary (demo-heavy-needs-checkout)");
    // PAIRED: from the checkout, the same verbs read the checkout's file, report this repository, and load the module.
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
