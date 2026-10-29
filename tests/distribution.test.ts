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
import { DISTRIBUTION, DISTRIBUTION_PLUGINS, IDENTITY } from "../examples/distribution/main";
import { RUBRIC_V1, score } from "../packages/socrates-core/src/index";
import { deriveIdempotencyKey, YakSubmission } from "../packages/yak-contract/src/index";
import socrates from "../plugins/socrates";
import yak from "../plugins/yak";
import { redact, redactDeep } from "../packages/outbound-scan/src/redact";
import { build } from "../src/build";
import { composeCli, PluginCompositionError } from "../src/cli/compose";
import type { ErisPlugin } from "../src/cli/plugin";
import { REGISTRY } from "../src/cli/registry";
import { CLI, HANDLERS, main } from "../src/main";
import { DEFAULT_DOCS_BASE, DEFAULT_RELEASE_REPO } from "../src/runtime/home";
import { checkoutOnly, ERIS, oracleEnv, REPO, type Sandbox, sandbox } from "./helpers/blackbox";
import { erisPaths } from "./helpers/tsconfig-paths";

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

/** The file the first `docs:` line of a failure block names, its `#anchor` dropped. */
const localDoc = (stderr: string): string => stderr.split("\n").find((l) => l.startsWith("docs: "))!.slice("docs: ".length).split("#")[0]!;

/** A failure block's second `docs:` line, the URL one. */
const remoteDoc = (stderr: string): string => stderr.split("\n").filter((l) => l.startsWith("docs: "))[1]!.slice("docs: ".length);

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
    // The package names itself `@sibylline-labs/eris`, which is how it reaches its own exports map from here; a dependent repository's key `eris` reaches the same map (tsconfig `paths` stands in for it in this tree).
    const sdk = await import("@sibylline-labs/eris/sdk");
    expect(Object.keys(sdk).sort()).toEqual([
      "BUILD_ID",
      "CliExit",
      "DEFAULT_YAKS_URL",
      "GlobalFlagError",
      "HANDLERS",
      "NO_ENTITLEMENTS",
      "PLUGINS",
      "PluginCompositionError",
      "REGISTRY",
      "RELEASE_UPDATE",
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
      "readYaksFileConfig",
      "refuseArg",
      "releaseRepo",
      "renderFailureBlock",
      "renderWarnLines",
      "resolveConcurrency",
      "resolveDeadlineMs",
      "resolveToken",
      "resolveUrl",
      "rowsOfGroup",
      "runErisVerb",
      "runMany",
      "runPool",
      "runProgram",
      "sanitizeDisplay",
      "scanStrings",
      "secretRules",
      "signalTree",
      "usageLine",
      "warn",
      "writeYaksFileConfig",
      "yaksConfigPath",
    ]);
    // The SDK's composition inputs are core's own, so a distribution composes what this build composes.
    expect(sdk.REGISTRY).toBe(REGISTRY);
    // The scan a distribution reaches is outbound-scan's own, not a copy, so it refuses on the rules core refuses on.
    const scan = await import("@sibylline-labs/eris/outbound-scan");
    expect(sdk.secretRules).toBe(scan.secretRules);
    expect(sdk.scanStrings).toBe(scan.scanStrings);
    expect(sdk.PLUGINS.map((p) => p.name)).toEqual(["yak", "socrates"]);
    // Through a variable: the type checker refuses the literal the same way.
    const deepPath = "@sibylline-labs/eris/src/cli/compose";
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
    const testing = await import("@sibylline-labs/eris/sdk/testing");
    expect(Object.keys(testing).sort()).toEqual(["buildInChild", "createFakeRunner"]);
  });

  it("eris/yak-contract resolves through the package's own exports map to the workspace contract package's module", async () => {
    /** When the exports map loses `./yak-contract`, or maps it to a copy of the contract rather than packages/yak-contract, a repository pinned to this one that imports the contract stops building at its next pin bump (or validates against a second, drifting schema): observed through the package specifier, as a dependent repository imports it. */
    const contract = await import("@sibylline-labs/eris/yak-contract");
    expect(contract.deriveIdempotencyKey).toBe(deriveIdempotencyKey);
    expect(contract.YakSubmission).toBe(YakSubmission);
  });

  it("eris/socrates-core resolves through the package's own exports map to the workspace socrates-core package's module", async () => {
    /** When the exports map loses `./socrates-core`, or maps it to a copy of the rubric rather than packages/socrates-core, a server pinned to this repository stops building at its next pin bump (or reclassifies with a rubric that drifts from the client's): observed through the package specifier, as a dependent repository imports it. */
    const core = await import("@sibylline-labs/eris/socrates-core");
    expect(core.RUBRIC_V1).toBe(RUBRIC_V1);
    expect(core.score).toBe(score);
  });

  it("eris/yak-redact resolves through the package's own exports map to the client's redaction module, which imports nothing", async () => {
    /** When the exports map loses `./yak-redact`, or maps it to a copy of the rules, a server that redacts a submission before it commits stops building at its next pin bump (or redacts by rules that drift from the client's); when the module gains an import, that server pulls the client's code in with it: observed through the package specifier, as a dependent repository imports it, and at the module's source. */
    const exported = await import("@sibylline-labs/eris/yak-redact");
    expect(exported.redact).toBe(redact);
    expect(exported.redactDeep).toBe(redactDeep);
    const source = readFileSync(join(REPO, "packages/outbound-scan/src/redact.ts"), "utf8");
    expect(source.match(/^\s*(?:import|export\s[^;]*\sfrom)\s/gm)).toBeNull();
  });

  it("root package.json dependencies carry no workspace: protocol so git-dependency consumers can install eris", () => {
    /** When root dependencies declare `workspace:*`, bun install in a repository that pins eris as a git dependency searches the consumer's workspaces and fails to resolve it: observed at the root manifest's dependency specs. */
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    const workspaceDeps = Object.entries(pkg.dependencies ?? {}).filter(([, spec]) => spec.startsWith("workspace:"));
    expect(workspaceDeps).toEqual([]);
  });
});

describe("this build's composition", () => {
  it("is core's rows plus the yak and socrates plugins', exactly", () => {
    /** When a distribution's plugin or the example plugins leak into this build's list, the public binary ships verbs it neither documents nor tests: observed at the composed registry and at the top-level help of the program under test. */
    expect(Object.keys(CLI.registry).sort()).toEqual([...Object.keys(REGISTRY), ...Object.keys(yak.rows), ...Object.keys(socrates.rows)].sort());
    expect(CLI.groups.map((g) => [g.group, g.plugin])).toEqual([
      ["yak", "yak"],
      ["login", "yak"],
      ["logout", "yak"],
      ["socrates", "socrates"],
    ]);
    const help = spawnSync(ERIS, ["--help"], { env: { ...process.env, ...oracleEnv() }, encoding: "utf8" });
    expect(help.status).toBe(0);
    const commands = help.stdout.split("\nCommands:\n")[1]!.split("\n\n")[0]!.split("\n").map((l) => l.trim().split(/\s+/)[0]);
    expect(commands).toEqual(["completion", "update", "yak", "login", "logout", "socrates"]);
    // The public program has no menu, so it promises no interactive mode (the example distribution's usage does).
    expect(help.stdout).toContain("\nRun 'eris <command> --help' for command-specific usage.\n");
    expect(help.stdout).not.toContain("interactive mode");
  });
});

describe("the example distribution, composed", () => {
  it("routes core, this build's plugins and its own, and owns the bare program", async () => {
    /** When a distribution's composition drops a layer (core, this build's plugins, its own) or its menu, a private build silently loses verbs or its launcher: observed through `main` with the fixture's composition. */
    expect(await run([])).toEqual({ rc: 0, stdout: "example distribution: yak, login, logout, socrates, demo (eris --help for usage)\n", stderr: "" });
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

  it("resolves its install root to its own directory: it reads its files there", async () => {
    /** When `runProgram` ignores `installRoot`, a distribution run from source (in a dependent repository, with core in node_modules/eris) reads its files under the eris package's directory: `demo asset` cannot find its file. Observed at the source run's stdout and stderr, with no shim. */
    const asset = await bunRun(sb, join(DIST_ROOT, "main.ts"), ["demo", "asset"]);
    expect({ status: asset.status, stdout: asset.stdout, stderr: asset.stderr }).toEqual({
      status: 0,
      stdout: readFileSync(join(DIST_ROOT, "assets", "greeting.txt"), "utf8"),
      stderr: "",
    });
  });

  it("names a doc under the first root that holds it, the distribution's own then core's: a docs line never names a file that is not there", async () => {
    /** When the local `docs:` line is always the install root's, a distribution that carries none of core's docs (the example's only files are its assets) prints a path that does not exist, as a compiled binary never does (`build()` takes each doc from its doc roots in order); when it is always core's, a doc the distribution carries names core's copy instead of its own. Observed at the source run's stderr, with no shim. */
    const refused = await bunRun(sb, join(DIST_ROOT, "main.ts"), ["--output", "xml", "demo", "asset"]);
    expect({ status: refused.status, stdout: refused.stdout }).toEqual({ status: 1, stdout: "" });
    expect(localDoc(refused.stderr)).toBe(join(REPO, "docs", "OUTPUT-CONTRACT.md"));
    expect(existsSync(localDoc(refused.stderr))).toBe(true);
    // PAIRED: a distribution that carries the doc (its own copy, here a root made for the run) names that copy, and core's own program, handed no root, names this package's.
    const own = join(REPO, ".scratch", `distribution-docs-${process.pid}`);
    mkdirSync(join(own, "docs"), { recursive: true });
    try {
      writeFileSync(join(own, "docs", "OUTPUT-CONTRACT.md"), "# the distribution's own copy\n");
      writeFileSync(join(own, "main.ts"), 'import { runProgram } from "eris/sdk";\nrunProgram({ installRoot: import.meta.dir });\n');
      const owned = await bunRun(sb, join(own, "main.ts"), ["--output", "xml", "version"]);
      expect({ status: owned.status, stdout: owned.stdout }).toEqual({ status: 1, stdout: "" });
      expect(localDoc(owned.stderr)).toBe(join(own, "docs", "OUTPUT-CONTRACT.md"));
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
    const core = await bunRun(sb, join(REPO, "src", "main.ts"), ["--output", "xml", "yak"]);
    expect(localDoc(core.stderr)).toBe(join(REPO, "docs", "OUTPUT-CONTRACT.md"));
    expect(core.stderr).not.toContain(DIST_ROOT);
  });

  it("reports the identity its entry hands runProgram: --version, a plugin's release repository, a failure block's docs base", async () => {
    /** When `runProgram` drops `identity`, a distribution run from source (its checkout, its own shim) says it is public eris in `--version` and links public eris's docs, which hold none of its slugs, in every failure block's second `docs:` line: observed at the source run's stdout and stderr, with no shim. */
    const entry = join(DIST_ROOT, "main.ts");
    const text = await bunRun(sb, entry, ["--version"]);
    expect({ status: text.status, stdout: text.stdout, stderr: text.stderr }).toEqual({
      status: 0,
      stdout: `eris dev (${IDENTITY.releaseRepo})\n${IDENTITY.versionExtra}\n`,
      stderr: "",
    });
    const json = await bunRun(sb, entry, ["--output", "json", "--version"]);
    expect(JSON.parse(json.stdout)).toEqual({ version: "dev", release_repo: IDENTITY.releaseRepo, build_id: null, extra: IDENTITY.versionExtra });
    expect((await bunRun(sb, entry, ["demo", "release"])).stdout).toBe(`${IDENTITY.releaseRepo}\n`);
    const refused = await bunRun(sb, entry, ["--output", "xml", "demo", "asset"]);
    expect(refused.status).toBe(1);
    const rel = localDoc(refused.stderr).slice(`${REPO}/`.length);
    expect(remoteDoc(refused.stderr).split("#")[0]).toBe(`${IDENTITY.docsBase}/${rel}`);
    // PAIRED: core's own program, handed no identity, reports core's defaults from the same checkout.
    const core = await bunRun(sb, join(REPO, "src", "main.ts"), ["--version"]);
    expect({ status: core.status, stdout: core.stdout }).toEqual({ status: 0, stdout: `eris dev (${DEFAULT_RELEASE_REPO})\n` });
    const coreRefused = await bunRun(sb, join(REPO, "src", "main.ts"), ["--output", "xml", "yak"]);
    expect(remoteDoc(coreRefused.stderr).split("#")[0]).toBe(`${DEFAULT_DOCS_BASE}/${rel}`);
  });

  it("typechecks under a tsconfig that lists only the distribution's sources: core's ambient declarations come with the SDK", () => {
    /** When core's source reaches an ambient module nothing references (`eris:assets`, which `build()` supplies at bundle time), a dependent repository's own `tsc` fails inside the dependency (TS2307 in node_modules/eris) until it adds a `files` entry for a path in node_modules: observed by running tsc over the example distribution with a minimal tsconfig. */
    mkdirSync(join(REPO, ".scratch"), { recursive: true });
    const config = join(REPO, ".scratch", `consumer-${process.pid}.tsconfig.json`);
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ["bun-types"],
          // Where a dependent repository's node_modules/eris would be; this tree has none.
          paths: Object.fromEntries(Object.entries(erisPaths()).map(([specifier, targets]) => [specifier, targets.map((t) => join(REPO, t))])),
        },
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

  const refusedOptions: [string, string, string][] = [
    ["an install root that is not an absolute path", '{ installRoot: "examples/distribution" }', 'installRoot must be an absolute path: "examples/distribution"'],
    ["a docs base build() refuses", '{ identity: { docsBase: "http://example.org/docs" } }', 'docsBase must be an https URL with no query, fragment or space: "http://example.org/docs"'],
  ];
  it.each(refusedOptions)("refuses %s", (_name, opts, message) => {
    /** When `runProgram` accepts a relative `installRoot`, a distribution's docs lines and file reads follow the caller's working directory, differently on every run; when it accepts an identity `build()` refuses, a run from source reports what its binary never could: observed at the entry's exit status and message. */
    const r = spawnSync(process.execPath, ["--no-env-file", "--config=/dev/null", "-e", `import { runProgram } from "eris/sdk"; runProgram(${opts});`], {
      cwd: REPO,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(message);
  });
});

describe.skipIf(checkoutOnly("builds its own binary from this checkout's source"))("the example distribution, compiled by build()", () => {
  const outfile = join(REPO, "dist", "fixture", "eris-distribution");
  /** A version line the build bakes and the entry does not hand `runProgram`, so the binary shows whose identity wins. */
  const BAKED_EXTRA = "example distribution, as built";
  let sb: Sandbox;
  let script: string;
  beforeAll(async () => {
    rmSync(join(REPO, "dist", "fixture"), { recursive: true, force: true });
    const r = buildInChild({ module: join(REPO, "examples", "distribution", "build.ts"), outfile, versionExtra: BAKED_EXTRA });
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
    expect(await sb.run([], { program: outfile })).toMatchObject({ status: 0, stdout: "example distribution: yak, login, logout, socrates, demo (eris --help for usage)\n", stderr: "" });
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

  it("reports the identity it was built with, not the one its entry hands runProgram", async () => {
    /** When the entry's `runProgram({ identity })` overrides what `build()` baked, a binary reports (and `eris update` fetches from) whatever its entry says rather than what it was built and released as: observed at the compiled fixture's `--version` and a failure block's docs base. */
    const v = await sb.run(["--version"], { program: outfile });
    expect({ status: v.status, stdout: v.stdout }).toEqual({ status: 0, stdout: `eris dev (${IDENTITY.releaseRepo})\n${BAKED_EXTRA}\n` });
    // PAIRED: the entry's own line is not printed, and the docs base the build was given (the entry's too) is.
    expect(v.stdout).not.toContain(IDENTITY.versionExtra!);
    const refused = await sb.run(["--output", "xml", "demo", "asset"], { program: outfile });
    expect(remoteDoc(refused.stderr)).toStartWith(`${IDENTITY.docsBase}/docs/`);
  });

  it("names core's doc in a file its asset home holds, as the source run does", async () => {
    /** When build() stops taking a doc the source names from core's root after the distribution's (`docRoots`), or the binary's block names a path outside its asset home, the compiled distribution's local `docs:` line names a file that is not there: observed at the compiled fixture's stderr, read back from disk. */
    const refused = await sb.run(["--output", "xml", "demo", "asset"], { program: outfile });
    expect({ status: refused.status, stdout: refused.stdout }).toEqual({ status: 1, stdout: "" });
    const doc = localDoc(refused.stderr);
    expect(readFileSync(doc, "utf8")).toBe(readFileSync(join(REPO, "docs", "OUTPUT-CONTRACT.md"), "utf8"));
    // PAIRED: the binary's own copy in its asset home, not the checkout's file the content equals.
    expect(doc).not.toBe(join(REPO, "docs", "OUTPUT-CONTRACT.md"));
  });

  it("completes its domain slot from the script the binary emits", () => {
    /** When the compiled completion drops a domain's helper or its slot wiring, the private build's env, key and name slots complete nothing: observed at a tab press on the script the binary emits. */
    expect(press(script, ["eris", "demo", "hello", ""])).toEqual(["loud", "quiet"]);
    expect(press(script, ["eris", "demo", "hello", "loud", ""])).toEqual(["ADA", "GRACE"]);
    expect(press(script, ["eris", "demo", "hello", "quiet", ""])).toEqual(["ada", "grace"]);
    expect(press(script, ["eris", ""])).toEqual(["--help", "--version", "completion", "demo", "login", "logout", "socrates", "update", "yak"]);
  });
});
