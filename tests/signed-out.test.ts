/**
 * A signed-out machine, BLACK-BOX through the real `eris` entrypoint: every verb that needs a login
 * fails the same way. Red when any verb keeps its own slug or exit code, or when a filing verb
 * exits 0 with nothing sent, which an agent reads as delivered.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type Sandbox, sandbox } from "./helpers/blackbox";

setDefaultTimeout(60_000);

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox("eris-signed-out-");
});
afterEach(() => {
  sb.cleanup();
});

const FILE = ["--summary", "a hook blocks a legal edit", "--body", "the pre-edit hook refuses a write"];

const VERBS: readonly (readonly string[])[] = [
  ["yak", "issue", ...FILE],
  ["yak", "suggest", ...FILE],
  ["yak", "fatal", ...FILE],
  ["yak", "status"],
  ["whoami"],
  ["tokens", "ls"],
  ["org", "members"],
  ["events", "list", "--product", "yak"],
];

describe("signed out", () => {
  // admits: a verb with its own signed-out slug or exit; observed as the block and exit of the real binary with an empty HOME
  test.each(VERBS.map((v) => [v.slice(0, 2).join(" "), v] as const))("%s: one slug, one exit", async (_name, argv) => {
    const r = await sb.run([...argv]);
    expect(r.status).toBe(3);
    expect(r.stderr.split("\n").filter((l) => l.startsWith("slug: "))).toEqual(["slug: eris-login-required"]);
    expect(r.stdout).toBe("");
  });

  // admits: a json consumer of a filing verb reading exit 0 as delivered; the bare record and exit of the real binary
  test("a filing verb under --output json is the bare record with exit 3", async () => {
    const r = await sb.run(["--output", "json", "yak", "issue", ...FILE]);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout)).toMatchObject({ verb: "issue", delivered: false, error: { slug: "eris-login-required" } });
    expect(r.stderr).toBe("");
  });
});
