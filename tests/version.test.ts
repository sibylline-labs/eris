/**
 * `eris --version` and what `build()` bakes into a binary for it: the release
 * tag (`VERSION`), the release repository, an optional distribution line, and
 * the base of a failure block's second `docs:` line.
 *
 * Seams: `main` for the checkout, and the compiled binary `build()` writes for
 * the rest. The unwritable-cache row for `--version` is in
 * tests/compiled-binary.test.ts, beside the other help paths.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { PLUGINS } from "../plugins";
import { build, type BuildOptions } from "../src/build";
import { main } from "../src/main";
import { checkoutOnly, expectFailBlock, REPO, type Sandbox, sandbox } from "./helpers/blackbox";

setDefaultTimeout(120_000);

async function run(argv: string[]): Promise<{ rc: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const rc = await main(argv, { _ERIS_SHIM_DIR: REPO, PATH: process.env.PATH, HOME: process.env.HOME }, {
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: (s: string) => ((stderr += s), true) },
  });
  return { rc, stdout, stderr };
}

describe("eris --version from a checkout", () => {
  it("prints the version and the release repository, and a json record under --output json", async () => {
    /** When `--version` is not routed, a script asking which eris it has is told `Unknown command`; when the json record drops a field, a consumer pinning on `version` or `release_repo` reads undefined — observed at main's stdout, exit and stderr. */
    expect(await run(["--version"])).toEqual({ rc: 0, stdout: "eris dev (sibylline-labs/eris)\n", stderr: "" });
    const json = await run(["--output", "json", "--version"]);
    expect({ rc: json.rc, stderr: json.stderr }).toEqual({ rc: 0, stderr: "" });
    expect(JSON.parse(json.stdout)).toEqual({ version: "dev", release_repo: "sibylline-labs/eris", build_id: null, extra: null });
    expect(json.stdout.endsWith("}\n")).toBe(true);
  });

  it("is an argv shape of its own: a near miss is still an unknown command, and a verb still refuses json", async () => {
    /** When `--version` is matched by prefix, or when allowing it in the json allow-list opens the verbs beside it, `eris --versions` runs and `eris --output json completion bash` prints a script to a parser — observed at the refusals. */
    const near = await run(["--versions"]);
    expect({ rc: near.rc, stdout: near.stdout }).toEqual({ rc: 1, stdout: "" });
    expect(near.stderr).toContain("ERROR Unknown command: --versions");
    const refused = await run(["--output", "json", "completion", "bash"]);
    expect({ rc: refused.rc, stdout: refused.stdout }).toEqual({ rc: 1, stdout: "" });
    expect(refused.stderr).toContain("slug: output-json-unsupported");
    // PAIRED: the surfaces the refusal names include the new one.
    expect(refused.stderr).toContain("fix:   eris --version");
  });
});

describe("build() refuses a version line or docs base it cannot bake in", () => {
  const base: BuildOptions = { entry: join(REPO, "src/main.ts"), root: REPO, plugins: PLUGINS, outfile: join(REPO, "dist", "version-fixture", "never-written-version") };
  const cases: [string, Partial<BuildOptions>, string | RegExp][] = [
    ["a multi-line versionExtra", { versionExtra: "core one\ncore two" }, /versionExtra must be one printable line/],
    ["a control character in versionExtra", { versionExtra: "core \u001b[31mred" }, /versionExtra must be one printable line/],
    ["an empty versionExtra", { versionExtra: "  " }, /versionExtra must be one printable line/],
    ["a docsBase over http", { docsBase: "http://docs.example.com/eris" }, /docsBase must be an https URL/],
    ["a docsBase with a query", { docsBase: "https://docs.example.com/eris?x=1" }, /docsBase must be an https URL/],
    ["a docsBase with a space", { docsBase: "https://docs.example.com/my eris" }, /docsBase must be an https URL/],
  ];
  it.each(cases)("%s", async (_name, opts, message) => {
    /** When build() bakes a newline into the version line or a docs base the failure block would print as a broken URL, every `--version` and every `docs:` line of that binary is malformed — observed at build()'s rejection, before any outfile exists. */
    await expect(build({ ...base, ...opts })).rejects.toThrow(message);
  });
});

describe.skipIf(checkoutOnly("builds its own binaries from this checkout's source"))("a binary built with a tag, a version line and a docs base", () => {
  const dist = join(REPO, "dist", "version-fixture");
  const tagged = join(dist, "eris-version-tagged");
  const plain = join(dist, "eris-version-plain");
  let sb: Sandbox;
  beforeAll(async () => {
    const common = { entry: join(REPO, "src/main.ts"), root: REPO, plugins: PLUGINS };
    await build({
      ...common,
      outfile: tagged,
      tag: "v0.0.1",
      releaseRepo: "example-org/eris-fork",
      versionExtra: "core example-pin",
      docsBase: "https://docs.example.com/eris/blob/main/",
    });
    await build({ ...common, outfile: plain });
    sb = sandbox("eris-version-");
  });
  afterAll(() => sb?.cleanup());

  it("reports the tag, the release repository and the distribution's own line", async () => {
    /** When build() does not bake the tag, the repository or the extra line, a released binary says `dev`, names the wrong repository for `eris update`, or drops the line a distribution adds — observed at the compiled binary's stdout in both renderings. */
    const text = await sb.run(["--version"], { program: tagged });
    expect({ status: text.status, stdout: text.stdout, stderr: text.stderr }).toEqual({
      status: 0,
      stdout: "eris v0.0.1 (example-org/eris-fork)\ncore example-pin\n",
      stderr: "",
    });
    const json = await sb.run(["--output", "json", "--version"], { program: tagged });
    expect(json.status).toBe(0);
    const record = JSON.parse(json.stdout) as { version: string; release_repo: string; build_id: string; extra: string };
    expect(record).toMatchObject({ version: "v0.0.1", release_repo: "example-org/eris-fork", extra: "core example-pin" });
    expect(record.build_id).toStartWith("v0.0.1-");
  });

  it("an untagged build reports dev and the default repository, with no extra line", async () => {
    /** When an untagged build keeps a previous build's tag, or invents an extra line, `eris update` compares the wrong current version — observed at the compiled binary's stdout. Paired with the row above. */
    const text = await sb.run(["--version"], { program: plain });
    expect({ status: text.status, stdout: text.stdout, stderr: text.stderr }).toEqual({ status: 0, stdout: "eris dev (sibylline-labs/eris)\n", stderr: "" });
    const json = JSON.parse((await sb.run(["--output", "json", "--version"], { program: plain })).stdout) as { build_id: string; extra: unknown };
    expect(json.extra).toBeNull();
    expect(json.build_id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("points a failure block's second docs: line at the build's docs base, and the default build at this repository", async () => {
    /** When the docs base is not baked in, a distribution's failure blocks link to this repository's headings, which do not describe its own slugs — observed at the second docs: line of the same refusal from two binaries. */
    const refusal = ["--output", "json", "completion", "bash"];
    const mine = await sb.run(refusal, { program: tagged });
    expect({ status: mine.status, stdout: mine.stdout }).toEqual({ status: 1, stdout: "" });
    expect(mine.stderr).toContain("\nslug: output-json-unsupported\n");
    expect(mine.stderr.split("\n").filter((l) => l.startsWith("docs: "))).toHaveLength(2);
    expect(mine.stderr).toContain("\ndocs: https://docs.example.com/eris/blob/main/docs/OUTPUT-CONTRACT.md#3-machine-surfaces\n");
    expect(mine.stderr).not.toContain("github.com/sibylline-labs");
    const theirs = await sb.run(refusal, { program: plain });
    expectFailBlock(theirs, "output-json-unsupported");
    expect(theirs.stderr).toContain("\ndocs: https://github.com/sibylline-labs/eris/blob/main/docs/OUTPUT-CONTRACT.md#3-machine-surfaces\n");
  });
});
