/**
 * Help as JSON (docs/OUTPUT-CONTRACT.md#32-help-as-json): under `--json` (or
 * `--output json`) a help request, a bare group and the bare program print one
 * `eris-help/1` document on stdout, served by core from the composed rows
 * before the verb's JSON allow-list and before its handler. Driven through
 * `main`, the seam every command line crosses.
 */

import { describe, expect, it } from "bun:test";
import { main } from "../src/main";
import { REPO } from "./helpers/blackbox";

async function run(argv: string[]): Promise<{ rc: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const rc = await main(argv, { _ERIS_SHIM_DIR: REPO, PATH: process.env.PATH, HOME: process.env.HOME }, {
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: (s: string) => ((stderr += s), true) },
  });
  return { rc, stdout, stderr };
}

/** The parsed document of a run that must have succeeded with stderr empty. */
async function helpDoc(argv: string[]): Promise<Record<string, unknown>> {
  const r = await run(argv);
  expect({ argv, rc: r.rc, stderr: r.stderr }).toEqual({ argv, rc: 0, stderr: "" });
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

const names = (doc: Record<string, unknown>, key: "commands" | "flags"): string[] => (doc[key] as { name: string }[]).map((c) => c.name);

const SOCRATES_SUBS = ["submit", "classify", "resolve", "settings", "discover", "consult", "status", "policy"].sort();

describe("the four journeys", () => {
  // admits: `eris --json socrates`, `eris socrates --json` and `eris socrates --help --json` answering with prose, a refusal or an unknown-command error leave an agent unable to discover a group's verbs by machine; observed at the parsed stdout of each spelling.
  it.each([[["--json", "socrates"]], [["socrates", "--json"]], [["socrates", "--help", "--json"]], [["--output", "json", "socrates"]]])("%p prints the group's help document", async (argv) => {
    const doc = await helpDoc(argv);
    expect({ schema: doc.schema, path: doc.path, usage: doc.usage, commands: names(doc, "commands").sort() }).toEqual({
      schema: "eris-help/1",
      path: "socrates",
      usage: "eris socrates <command>",
      commands: SOCRATES_SUBS,
    });
  });

  // admits: a leaf's help document missing its own flags (or naming its group's) gives an agent the wrong grammar for the verb it asked about; observed at the flag names of `socrates consult`.
  it("socrates consult --help --json prints the verb's own document", async () => {
    const doc = await helpDoc(["socrates", "consult", "--help", "--json"]);
    expect({ path: doc.path, commands: doc.commands }).toEqual({ path: "socrates consult", commands: [] });
    expect(names(doc, "flags")).toEqual(expect.arrayContaining(["--canon", "--practices", "--brief", "--project", "--help"]));
    expect(String(doc.usage)).toStartWith("eris socrates consult ");
  });
});

describe("help JSON comes before the JSON allow-list", () => {
  // admits: a verb with no JSON rendering refusing `--help --json` with output-json-unsupported leaves its grammar undiscoverable by machine; observed at `completion bash` and `login`, which both refuse --output json.
  it.each([[["completion", "bash"]], [["login"]]])("%p --help --json serves help although the verb refuses --output json", async (path) => {
    const doc = await helpDoc([...path, "--help", "--json"]);
    expect(doc.path).toBe(path.join(" "));
    // POSITIVE control: without the help token the verb still refuses the format.
    const refused = await run([...path, "--json"]);
    expect({ rc: refused.rc, stdout: refused.stdout }).toEqual({ rc: 1, stdout: "" });
    expect(refused.stderr).toContain("slug: output-json-unsupported");
  });
});

describe("the top level", () => {
  // admits: `eris --help --json` or a bare `eris --json` printing the prose usage (or a refusal) gives a machine caller no list of the composed groups; observed at the parsed document's commands.
  it.each([[["--help", "--json"]], [["--json"]], [["-h", "--output", "json"]]])("%p lists the composed groups", async (argv) => {
    const doc = await helpDoc(argv);
    expect({ path: doc.path, usage: doc.usage }).toEqual({ path: "", usage: "eris <command> [args]" });
    expect(names(doc, "commands")).toEqual(["completion", "update", "yak", "login", "logout", "socrates"]);
    expect(names(doc, "flags")).toEqual(expect.arrayContaining(["--output", "--json", "--version", "--help"]));
  });
});
