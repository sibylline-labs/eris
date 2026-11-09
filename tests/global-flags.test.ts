/**
 * The global output flags (docs/OUTPUT-CONTRACT.md#2-the-flag): `--json` is
 * `--output json`, and both are read anywhere before `--`, ahead of the
 * command, between a group and its verb, or after the verb. A row that
 * declares `--json` itself keeps it for its own parse. `--json` with
 * `--output text` is refused. Driven through `main` with the example plugin
 * composed, plus a fixture row that declares `--json`.
 */

import { describe, expect, it } from "bun:test";
import widgets from "../examples/plugins/widgets";
import { composeCli } from "../src/cli/compose";
import { definePlugin, groupArgs, readArgs, type VerbHandler } from "../src/cli/plugin";
import { REGISTRY } from "../src/cli/registry";
import { HANDLERS, main } from "../src/main";
import { REPO } from "./helpers/blackbox";

/** A group whose `lint` verb declares its own `--json` and has no JSON rendering. */
const own = definePlugin({
  name: "own",
  rows: {
    own: { impl: "ts", summary: "A fixture whose verb declares --json" },
    "own lint": { summary: "Print whether --json was passed to the verb", flags: [{ name: "--json", takesValue: false }] },
  },
  handlers: {
    own: async () => ownHandler,
  },
});

const ownHandler: VerbHandler = async (args, ctx) => {
  const g = groupArgs(own.rows, "own", args);
  if (g.kind !== "sub") return 1;
  const a = readArgs(own.rows, "own lint", g.rest, ctx);
  if (a === null) return 0;
  ctx.stdout.write(`format=${ctx.format} json=${a.flags["--json"]}\n`);
  return 0;
};

const cli = composeCli(REGISTRY, HANDLERS, [widgets, own]);

async function run(argv: string[]): Promise<{ rc: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const rc = await main(argv, { _ERIS_SHIM_DIR: REPO, PATH: process.env.PATH, HOME: process.env.HOME }, {
    cli,
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: (s: string) => ((stderr += s), true) },
  });
  return { rc, stdout, stderr };
}

describe("--json is --output json, at any position before --", () => {
  // admits: `--json` read only after the verb (or not at all) routes `eris --json widgets ping` as an unknown command `--json`, or hands a parser text; observed at the output of every spelling against `--output json`'s.
  it("every position and spelling prints what --output json prints", async () => {
    const want = await run(["--output", "json", "widgets", "ping"]);
    expect(want).toEqual({ rc: 0, stdout: '{"pong":"world"}\n', stderr: "" });
    for (const argv of [
      ["--json", "widgets", "ping"],
      ["widgets", "--json", "ping"],
      ["widgets", "ping", "--json"],
      ["widgets", "ping", "--output=json"],
      ["widgets", "--output", "json", "ping"],
      ["--json", "--output", "json", "widgets", "ping"],
    ]) {
      expect({ argv, ...(await run(argv)) }).toEqual({ argv, ...want });
    }
  });

  // admits: a `--json` after `--` swallowed as the global flag takes an operand away from the verb; observed at the operand the verb reports.
  it("after --, --json is an operand, not the flag", async () => {
    const r = await run(["widgets", "count", "--", "--json"]);
    expect({ rc: r.rc, stdout: r.stdout }).toEqual({ rc: 1, stdout: "" });
    expect(r.stderr).toContain("'--json' is not a count");
  });

  // admits: `--json` with `--output text` silently picking one format gives a caller the rendering it did not ask for; observed at the slug, with stdout empty.
  it.each([[["--json", "--output", "text", "widgets", "ping"]], [["widgets", "ping", "--output=text", "--json"]]])("%p is refused as output-format-conflict", async (argv) => {
    const r = await run(argv);
    expect({ rc: r.rc, stdout: r.stdout }).toEqual({ rc: 1, stdout: "" });
    expect(r.stderr).toContain("ERROR ");
    expect(r.stderr).toContain("\nslug: output-format-conflict\n");
  });
});

describe("a row that declares --json keeps it", () => {
  // admits: a pre-pass that always strips `--json` turns a verb's own `--json` into the global format and refuses it as output-json-unsupported; observed at what the verb's parse received, before and after the group word.
  it.each([[["own", "lint", "--json"]], [["own", "--json", "lint"]], [["--json", "own", "lint"]]])("%p reaches the verb's own flag", async (argv) => {
    expect(await run(argv)).toEqual({ rc: 0, stdout: "format=text json=true\n", stderr: "" });
  });

  // admits: help for a declared-`--json` row read as the verb's flag prints prose where JSON was asked for; observed at the parsed document.
  it("--help --json on such a row is still help as JSON", async () => {
    const r = await run(["own", "lint", "--help", "--json"]);
    expect({ rc: r.rc, stderr: r.stderr, path: (JSON.parse(r.stdout) as { path: string }).path }).toEqual({ rc: 0, stderr: "", path: "own lint" });
  });
});
