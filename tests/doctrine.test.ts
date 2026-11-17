/**
 * `eris doctrine check|schema|gates|effect`, at two seams:
 *
 *   - the CLI, run as a subprocess in a sandbox (the checkout's shim, or the compiled binary under
 *     ERIS_BIN), asserted on its exit status and its two streams;
 *   - `main` with a composition that hands the plugin defaults, as a distribution does.
 *
 * The oracle for every golden under tests/fixtures/doctrine/golden is the reference
 * implementation these verbs were ported from, run on the same synthetic fixtures. Its output is
 * stored with one change applied: a few explanation strings that cited internal planning
 * documents or product names were reworded for this public tree. Everything else is byte for byte
 * what the reference printed.
 */

import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import doctrine, { doctrinePlugin } from "../plugins/doctrine";
import { PLUGINS } from "../plugins";
import { composeCli } from "../src/cli/compose";
import { REGISTRY } from "../src/cli/registry";
import { HANDLERS, main } from "../src/main";
import { REPO, type Sandbox, sandbox } from "./helpers/blackbox";

setDefaultTimeout(60_000);

const FIX = join(REPO, "tests", "fixtures", "doctrine");
/**
 * A golden, with each `{{sha256:<slug>}}` / `{{hash:<slug>}}` filled in from the fixture: the sha256
 * of that posture's ```yaml fence body (and its first 12 hex). The goldens carry no hex literal, so the
 * tree's scrub never reads a policy hash as a commit SHA, and the test hashes the fence itself.
 */
const golden = (name: string): string =>
  readFileSync(join(FIX, "golden", name), "utf8").replace(/\{\{(sha256|hash):([a-z0-9-]+)\}\}/g, (_, kind: string, slug: string) => {
    const full = fenceSha256(slug);
    return kind === "hash" ? full.slice(0, 12) : full;
  });

function fenceSha256(slug: string): string {
  const doc = readFileSync(join(FIX, "doctrine.md"), "utf8");
  const section = doc.split(/^## /m).find((s) => s.startsWith(`${slug}\n`));
  const body = section === undefined ? undefined : /```yaml\n([\s\S]*?)\n```/.exec(section)?.[1];
  if (body === undefined) throw new Error(`fixture has no policy fence for ${slug}`);
  return createHash("sha256").update(body).digest("hex");
}
const input = (name: string): string => readFileSync(join(FIX, name), "utf8");

let sb: Sandbox | undefined;
afterEach(() => {
  sb?.cleanup();
  sb = undefined;
});
const box = (): Sandbox => (sb ??= sandbox("eris-doctrine-"));

describe("eris doctrine: output parity with the reference implementation", () => {
  // admits: integration: when the vendored contract or a verb drifts from the reference (a renamed key, a reordered row, a changed sentence, a JSON field dropped), builders and hooks parsing this output break; observed at the CLI's stdout against goldens the reference printed, which no type sees.
  it.each([
    ["check-text.out", ["doctrine", "check", "--file", join(FIX, "doctrine.md")], undefined],
    ["check-json.out", ["doctrine", "check", "--file", join(FIX, "doctrine.md"), "--output", "json"], undefined],
    ["check-cite.out", ["doctrine", "check", "--file", join(FIX, "doctrine.md"), "--cite"], undefined],
    ["schema.out", ["doctrine", "schema"], undefined],
    ["gates-explain.out", ["doctrine", "gates", "--file", join(FIX, "doctrine.md"), "--profiles", join(FIX, "profiles.yaml"), "--explain"], undefined],
    ["effect-policy.out", ["doctrine", "effect", "--profiles", join(FIX, "profiles.yaml")], "effect-policy.json"],
    ["effect-policy-json.out", ["doctrine", "effect", "--profiles", join(FIX, "profiles.yaml"), "--output", "json"], "effect-policy.json"],
    ["effect-surfaces.out", ["doctrine", "effect"], "effect-surfaces.json"],
  ] as const)("%s", async (out, argv, stdin) => {
    const r = await box().run([...argv], stdin === undefined ? {} : { stdin: input(stdin) });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    expect(r.stdout).toBe(golden(out));
  });

  // admits: integration: when the built-in profiles drift (a gate added to spine, deep reordered), every gate map a build without a profiles file prints changes; observed as the default run equalling the --profiles run over the same two profiles written out.
  it("with no --profiles, the gate map is taken over the built-in spine and deep", async () => {
    const s = box();
    const builtins = join(s.dir, "builtins.yaml");
    await Bun.write(builtins, "spine: [premise-gate, plan-review, final-gates]\ndeep: [premise-gate, define-future, sdk-check, plan-review, final-gates]\n");
    const file = join(FIX, "doctrine.md");
    const bare = await s.run(["doctrine", "gates", "--file", file]);
    const named = await s.run(["doctrine", "gates", "--file", file, "--profiles", builtins]);
    expect(bare.status).toBe(0);
    expect(bare.stdout).toContain("deep\tsdk-check\tonce-at-end\n");
    expect(bare.stdout).toBe(named.stdout);
  });
});

describe("eris doctrine: failures", () => {
  // admits: boundary-io: when an unparseable or floor-lowering doctrine is accepted, or its problems lose their file:line, a posture that waives the U2 floor is read as valid; observed as exit 3, nothing on stdout, and the reference's problem lines on stderr.
  it("a doctrine that lowers the floor exits 3 with one '<file>:<line>: <message>' line per problem and nothing on stdout", async () => {
    const r = await box().run(["doctrine", "check", "--file", "invalid.md"], { cwd: FIX });
    expect(r.status).toBe(3);
    expect(r.stdout).toBe("");
    const problems = r.stderr.split("\n").filter((l) => l.startsWith("invalid.md:"));
    expect(`${problems.join("\n")}\n`).toBe(golden("invalid.err"));
    expect(r.stderr).toContain("slug: doctrine-policy-invalid\n");
    // gates reads the same file and refuses it rather than printing a map.
    const g = await box().run(["doctrine", "gates", "--file", "invalid.md"], { cwd: FIX });
    expect({ status: g.status, stdout: g.stdout }).toEqual({ status: 3, stdout: "" });
    expect(g.stderr).toContain("ERROR invalid.md:6: lock-in: policy.gates: Expected final-gates and user-impact not off");
  });

  // admits: integration: when a build with no doctrine file defaults to some posture (or crashes), check reports a doctrine that does not exist and gates prints a map nobody chose; observed as check's doctrine-file-missing exit 3 and gates' empty exit 0.
  it("with no --file, no default and no pulled policy, check fails doctrine-file-missing and gates prints nothing", async () => {
    // From a directory that holds a doctrine.md: no verb guesses a file by its name.
    const c = await box().run(["doctrine", "check"], { cwd: FIX });
    expect({ status: c.status, stdout: c.stdout }).toEqual({ status: 3, stdout: "" });
    expect(c.stderr).toContain("slug: doctrine-file-missing\nfix: Pass --file <path>, or run 'eris login', then 'eris doctrine pull'.\n");
    const g = await box().run(["doctrine", "gates"], { cwd: FIX });
    expect({ status: g.status, stdout: g.stdout, stderr: g.stderr }).toEqual({ status: 0, stdout: "", stderr: "" });
  });

  // admits: boundary-io: when stdin that is not the {contract, before, after} object, or a side that does not decode, is read as all-defaults, effect prints a diff of values nobody wrote; observed as exit 2 (usage) and exit 3 (invalid side) with the slug on stderr.
  it.each([
    ["not json", 2, "doctrine-usage"],
    ['{"contract": "ladder"}', 2, "doctrine-usage"],
    ['{"contract": "policy", "after": {"gates": {"final-gates": "off"}}}', 3, "doctrine-policy-invalid"],
    ['{"contract": "surfaces", "after": {"surfaces": {"auth": {"paths": ["a"], "globs": ["b"]}}}}', 3, "gate-surfaces-invalid"],
  ] as const)("effect refuses %s", async (stdin, status, slug) => {
    const r = await box().run(["doctrine", "effect"], { stdin });
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status, stdout: "" });
    expect(r.stderr).toContain(`slug: ${slug}\n`);
  });
});

describe("eris doctrine: a distribution's defaults", () => {
  // admits: integration: when the injected defaults stop reaching the verbs, a distribution's doctrine verbs silently fall back to 'no doctrine file' and its hooks see no posture; observed through main with a composition that swaps in doctrinePlugin({ doctrineFile, profilesFile }).
  it("doctrinePlugin(defaults) reads its doctrine and profiles files when the flags are absent", async () => {
    const cli = composeCli(REGISTRY, HANDLERS, [...PLUGINS.filter((p) => p !== doctrine), doctrinePlugin(() => ({ doctrineFile: join(FIX, "doctrine.md"), profilesFile: join(FIX, "profiles.yaml") }))]);
    let stdout = "";
    let stderr = "";
    const run = (argv: string[]) =>
      main(argv, { _ERIS_SHIM_DIR: REPO, PATH: process.env.PATH, HOME: process.env.HOME }, {
        cli,
        stdout: { write: (s: string) => ((stdout += s), true) },
        stderr: { write: (s: string) => ((stderr += s), true) },
      });
    expect(await run(["doctrine", "check"])).toBe(0);
    expect(stdout).toBe(golden("check-text.out"));
    stdout = "";
    expect(await run(["doctrine", "gates", "--explain"])).toBe(0);
    expect({ stdout, stderr }).toEqual({ stdout: golden("gates-explain.out"), stderr: "" });
  });
});
