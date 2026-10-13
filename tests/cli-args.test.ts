/**
 * src/cli/args.ts — the registry-driven argv parser every TS verb reads its
 * argv through. Cases run against the real registry rows where this build
 * declares them, and against the row shapes each historic fix was found on.
 */

import { describe, expect, it } from "bun:test";
import { argErrorText, groupArgs, helpText, parseRow, readVerbArgs, usageLine } from "../src/cli/args";
import { REGISTRY, type Row } from "../src/cli/registry";
import { CliExit } from "../src/cli/ts-verb";

const err = (p: ReturnType<typeof parseRow>) => (p.kind === "error" ? p.error : p.kind);
const flag = (p: ReturnType<typeof parseRow>, name: string): unknown => (p.kind === "ok" ? (p.flags as Record<string, unknown>)[name] : p);

describe("the grammar", () => {
  const row: Row = {
    summary: "s",
    flags: [
      { name: "--yes", takesValue: false, alias: "-y" },
      { name: "--issue", takesValue: true },
      { name: "--skip", takesValue: true, repeatable: true },
    ],
    pos: ["env", "name?"],
  };

  it("an undeclared flag is refused, wherever it sits", () => {
    /** When the parser lets an undeclared flag through, `KEY=value --nosuchflag` writes the value and drops the flag at exit 0. */
    expect(err(parseRow(row, ["dev", "--bogus"]))).toEqual({ kind: "unknown-flag", token: "--bogus" });
    expect(err(parseRow(row, ["--bogus", "dev"]))).toEqual({ kind: "unknown-flag", token: "--bogus" });
    expect(err(parseRow(row, ["-x"]))).toEqual({ kind: "unknown-flag", token: "-x" });
    expect(err(parseRow(row, ["--bogus=1"]))).toEqual({ kind: "unknown-flag", token: "--bogus=1" });
  });

  it("a value flag reads the next word or its `=` form, and never swallows the next flag", () => {
    /** When `--issue --yes` takes `--yes` as the issue, the mutation is linked to a flag name and runs unconfirmed. */
    const ok = (argv: string[]) => {
      const p = parseRow(row, argv);
      return p.kind === "ok" ? { flags: p.flags, pos: p.pos } : p;
    };
    expect(ok(["dev", "--issue", "ABC-1"])).toEqual({ flags: { "--yes": false, "--issue": "ABC-1", "--skip": [] }, pos: ["dev"] });
    expect(ok(["--issue=ABC-1", "dev"])).toEqual({ flags: { "--yes": false, "--issue": "ABC-1", "--skip": [] }, pos: ["dev"] });
    expect(ok(["--issue=a=b", "dev"])).toEqual({ flags: { "--yes": false, "--issue": "a=b", "--skip": [] }, pos: ["dev"] });
    expect(err(parseRow(row, ["dev", "--issue", "--yes"]))).toEqual({ kind: "missing-value", flag: "--issue", next: "--yes", inline: false });
    expect(err(parseRow(row, ["dev", "--issue"]))).toEqual({ kind: "missing-value", flag: "--issue", next: undefined, inline: false });
    expect(err(parseRow(row, ["dev", "--issue="]))).toEqual({ kind: "missing-value", flag: "--issue", next: undefined, inline: true });
    expect(err(parseRow(row, ["dev", "--yes=1"]))).toEqual({ kind: "unexpected-value", flag: "--yes" });
    expect(ok(["dev", "-y"])).toEqual({ flags: { "--yes": true, "--issue": undefined, "--skip": [] }, pos: ["dev"] });
  });

  it("a repeatable flag keeps every value in order; any other value flag given twice is refused", () => {
    /** When a second value of a single-value flag silently replaces the first, one of the user's words is dropped at exit 0 (a repeated --from). */
    const p = parseRow(row, ["--skip", "a", "dev", "--skip=b"]);
    expect(flag(p, "--skip")).toEqual(["a", "b"]);
    expect(err(parseRow(row, ["dev", "--issue", "A", "--issue", "B"]))).toEqual({ kind: "repeated-flag", flag: "--issue" });
  });

  it("a word past the declared operands is refused; `-`, a negative number and anything after `--` are operands", () => {
    /** When an extra word is dropped, `widget list dev --bogus` lists dev at rc 0 and `note add <node> -- "-x"` refuses a statement it documents. */
    expect(err(parseRow(row, ["dev", "n", "extra"]))).toEqual({ kind: "unexpected-arg", token: "extra" });
    const p = parseRow(row, ["dev", "--", "-5"]);
    expect(p.kind === "ok" ? p.pos : p).toEqual(["dev", "-5"]);
    const q = parseRow(row, ["--", "--yes", "-"]);
    expect(q.kind === "ok" ? q.pos : q).toEqual(["--yes", "-"]);
    expect(flag(q, "--yes")).toBe(false);
    expect(err(parseRow(row, ["dev", "--", "a", "b"]))).toEqual({ kind: "unexpected-arg", token: "b" });
    const rest = parseRow({ summary: "s", pos: ["env", "words..."] }, ["a", "b", "c"]);
    expect(rest.kind === "ok" ? rest.pos : rest).toEqual(["a", "b", "c"]);
  });

  it("-h/--help anywhere before `--` is help, and wins over a refusal; after `--` it is an operand", () => {
    /** When help is read as an operand or refused, `widget set prod KEY=on --help` writes the value instead of printing usage. */
    expect(parseRow(row, ["dev", "--bogus", "--help"]).kind).toBe("help");
    expect(parseRow(row, ["-h"]).kind).toBe("help");
    const p = parseRow(row, ["dev", "--", "--help"]);
    expect(p.kind === "ok" ? p.pos : p).toEqual(["dev", "--help"]);
  });
});

/** The row shapes the historic fixes below were found on, as declared when
 *  each fix landed. The verbs themselves are not in this build; the grammar
 *  that refused each command line is. */
const SHARED_FLAGS = [
  { name: "--issue", takesValue: true },
  { name: "--no-issue", takesValue: false },
  { name: "--force", takesValue: false },
  { name: "--token-env", takesValue: true },
  { name: "--yes", takesValue: false, alias: "-y" },
] as const;
const ROWS: Readonly<Record<string, Row>> = {
  "widget set": {
    summary: "Set one key's value",
    flags: [...SHARED_FLAGS, { name: "--from", takesValue: true, deferredValue: true, file: true }],
    pos: ["env?", "assignment..."],
    usage: "<env> [KEY=value | --from <file>] [--yes]",
  },
  "widget check": { summary: "Validate a widget file", pos: ["file?"], usage: "[file]" },
  "widget list": { summary: "One row per key with its state", json: true, pos: ["env?"], usage: "<env>" },
  "widget export": { summary: "Print the widget as one flag", pos: ["env?"], usage: "<env>" },
  "widget get": { summary: "Fetch one key into a local file", pos: ["env?", "KEY?"], usage: "<env> KEY  |  eris widget get undo" },
  "gadget delete": { summary: "Delete a gadget", pos: ["page-name"] },
  "gadget list": { summary: "List gadgets" },
  "gadget init": { summary: "Set up the gadget store" },
  "gadget root find": { summary: "Find the checkout whose origin names a repo", pos: ["repo?", "search-root..."], usage: "<repo> [<search-root>…]" },
  "note add": {
    summary: "Attach a note to a node or edge",
    flags: [
      { name: "--edge", takesValue: true },
      { name: "--scope", takesValue: true },
      { name: "--token-env", takesValue: true },
    ],
    pos: ["node?", "statement?"],
    usage: '<node> "<statement>" [--edge <edge_id>] [--scope <scope>] [--token-env NAME]',
    extraHint: "quote the statement",
  },
  "note ls": {
    summary: "List a node's (or one edge's) notes",
    flags: [
      { name: "--edge", takesValue: true },
      { name: "--token-env", takesValue: true },
    ],
    pos: ["node?"],
    usage: "<node> [--edge <edge_id>] [--token-env NAME]",
  },
  "gadget rollback": {
    summary: "Undo a previous install, or list them",
    flags: [
      { name: "--to", takesValue: true },
      { name: "--list", takesValue: false },
    ],
  },
  "queue drain": {
    summary: "Post journal entries to the server and delete each once dispatched",
    flags: [
      { name: "--dry-run", takesValue: false },
      { name: "--yes", takesValue: false, alias: "-y" },
      { name: "--skip", takesValue: true, repeatable: true },
      { name: "--max-nodes", takesValue: true },
      { name: "--token-env", takesValue: true },
    ],
    usage: "[--dry-run] [--yes] [--skip <journal-id>]... [--max-nodes N] [--token-env NAME]",
  },
};
const rowAt = (path: string): Row => ROWS[path]!;

describe("the historic fixes, as cases over the rows they were found on", () => {
  // [path, argv, expected refusal]: each is a command line an earlier parser accepted at exit 0.
  const CASES: Array<[string, string[], string]> = [
    // widget set took an unknown flag as a word, wrote the value, dropped the flag.
    ["widget set", ["dev", "KEY=value", "--nosuchflag"], "unknown-flag"],
    // a second --from was dropped.
    ["widget set", ["dev", "--from", "a.env", "--from", "b.env"], "repeated-flag"],
    // validate read a flag as the file, and dropped a second file.
    ["widget check", ["--bogus"], "unknown-flag"],
    ["widget check", ["eris.yaml", "other.yaml"], "unexpected-arg"],
    // list / export dropped every word after the env.
    ["widget list", ["dev", "--bogus"], "unknown-flag"],
    ["widget list", ["dev", "extra"], "unexpected-arg"],
    ["widget export", ["dev", "extra"], "unexpected-arg"],
    // Words each verb dropped at exit 0.
    ["widget get", ["dev", "KEY", "extra"], "unexpected-arg"],
    ["gadget delete", ["page", "other"], "unexpected-arg"],
    ["gadget list", ["--bogus"], "unknown-flag"],
    ["gadget init", ["extra"], "unexpected-arg"],
    ["gadget root find", ["o/r", "--bogus"], "unknown-flag"],
  ];
  it.each(CASES)("%s %p is refused (%s)", (path, argv, kind) => {
    /** When this command line is accepted, a word the user typed is dropped and the verb runs at exit 0. */
    expect(err(parseRow(rowAt(path), argv))).toEqual(expect.objectContaining({ kind }));
  });

  it("a deferred value flag: a known flag may sit before its file, and a dash-led word right after it is the file", () => {
    /** When --from reads the next word like any value flag, `--from --yes seed.env` or `--from -seed.env` is refused. */
    const from = (argv: string[]) => {
      const p = parseRow(rowAt("widget set"), argv);
      return p.kind === "ok" ? { from: flag(p, "--from"), yes: flag(p, "--yes"), pos: p.pos } : p;
    };
    expect(from(["dev", "--from", "--yes", "seed.env"])).toEqual({ from: "seed.env", yes: true, pos: ["dev"] });
    expect(from(["dev", "--from", "-seed.env", "--yes"])).toEqual({ from: "-seed.env", yes: true, pos: ["dev"] });
    expect(err(parseRow(rowAt("widget set"), ["dev", "--from", "--yes", "-x"]))).toEqual({ kind: "unknown-flag", token: "-x" });
    expect(err(parseRow(rowAt("widget set"), ["dev", "--from", "--yes"]))).toEqual(expect.objectContaining({ kind: "missing-value", flag: "--from" }));
  });
});

describe("the words", () => {
  it("a refusal quotes the row's usage line; one-line, sanitised", () => {
    /** When the refusal loses the usage or echoes a control character, the operator cannot see the shape, or a newline forges a failure-block line. */
    expect(usageLine("note ls", rowAt("note ls"))).toBe("eris note ls <node> [--edge <edge_id>] [--token-env NAME]");
    expect(argErrorText("note ls", { kind: "unknown-flag", token: "--x\u0007\nslug: y" }, "/h", rowAt("note ls"))).toBe(
      "ERROR Unknown flag '--x\\nslug: y' (usage: eris note ls <node> [--edge <edge_id>] [--token-env NAME])\n",
    );
    expect(argErrorText("note add", { kind: "unexpected-arg", token: "word" }, "/h", rowAt("note add"))).toBe(
      `ERROR Unexpected arg 'word' — quote the statement (usage: eris note add <node> "<statement>" [--edge <edge_id>] [--scope <scope>] [--token-env NAME])\n`,
    );
    expect(argErrorText("note ls", { kind: "missing-value", flag: "--edge", next: undefined, inline: false }, "/h", rowAt("note ls"))).toContain(
      "slug: flag-value-missing",
    );
  });

  it("a row with no usage line of its own generates one, and help, from its declaration", () => {
    /** When generated usage drifts from the row, help and refusals advertise a shape the parser does not accept. */
    expect(usageLine("gadget delete", rowAt("gadget delete"))).toBe("eris gadget delete <page-name>");
    expect(usageLine("gadget rollback", rowAt("gadget rollback"))).toBe("eris gadget rollback [--to <value>] [--list]");
    expect(helpText("queue drain", rowAt("queue drain"))).toContain("  --skip <value>   (repeatable)\n");
    expect(helpText("queue drain", rowAt("queue drain"))).toContain("  --yes, -y\n");
  });

  it("readVerbArgs prints help and returns null, or refuses with exit 1", () => {
    /** When help falls through to the verb, or a refusal does not stop it, the verb runs on argv it refused. */
    let out = "";
    let errs = "";
    const io = { erisDir: "/h", stdout: { write: (s: string) => (out += s) }, stderr: { write: (s: string) => (errs += s) } };
    expect(readVerbArgs("completion bash", ["--help"], io)).toBeNull();
    expect(out).toStartWith("Usage: eris completion bash\n");
    expect(() => readVerbArgs("completion bash", ["x"], io)).toThrow(CliExit);
    expect(errs).toBe("ERROR Unexpected arg 'x' (usage: eris completion bash)\n");
  });
});

describe("groupArgs", () => {
  it("names a group's sub from the registry, or says help, bare or unknown", () => {
    /** When a dispatcher's sub list drifts from the registry, a declared verb is refused as unknown. */
    expect(groupArgs("completion", ["zsh", "x"])).toEqual({ kind: "sub", sub: "zsh", rest: ["x"] });
    expect(groupArgs("completion", [])).toEqual({ kind: "bare" });
    expect(groupArgs("completion", ["--help", "zsh"])).toEqual({ kind: "help" });
    expect(groupArgs("completion", ["frob"])).toEqual({ kind: "unknown", sub: "frob" });
    expect(groupArgs("completion", ["--", "zsh"])).toEqual({ kind: "sub", sub: "zsh", rest: [] });
  });
});

describe("every TS leaf parses", () => {
  it("declares only well-formed flags and operands", () => {
    /** When a row declares a flag the grammar cannot read (no `--`, a bad alias) or an operand after a `...`, the verb is unreachable. */
    for (const [path, row] of Object.entries({ ...REGISTRY, ...ROWS })) {
      for (const f of row.flags ?? []) {
        expect({ path, f: f.name }).toEqual({ path, f: expect.stringMatching(/^--[a-z][a-z-]*$/) });
        if (f.alias !== undefined) expect({ path, a: f.alias }).toEqual({ path, a: expect.stringMatching(/^-[a-z]$/) });
        if (f.repeatable === true) expect({ path, f: f.name, v: f.takesValue }).toEqual({ path, f: f.name, v: true });
      }
      const pos = row.pos ?? [];
      pos.forEach((p, i) => {
        if (p.endsWith("...")) expect({ path, last: i === pos.length - 1 }).toEqual({ path, last: true });
      });
    }
  });
});
