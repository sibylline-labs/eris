/**
 * Every command path answers `--help` with its own usage.
 *
 * The walk covers every key of the composed registry (`defaultCli().registry`) plus the
 * bare program, driven through `main` in process: per path, `--help` and `-h`
 * exit 0 with stdout's first line naming `eris <path>` and stderr empty, and
 * `--help --json` prints one help document of the `eris-help/1` schema
 * (docs/OUTPUT-CONTRACT.md#32-help-as-json). Every group refuses a sub it does not
 * have. HOME is an empty scratch directory and the endpoints are unreachable,
 * so a help path that reads a file or the network fails instead of passing.
 *
 * One spawned case runs the real entry (the shim, or `ERIS_BIN`): the bare
 * program with stdin closed exits 0 inside a second, printing the usage.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defaultCli, main } from "../src/main";
import { ERIS, oracleEnv, REPO } from "./helpers/blackbox";

setDefaultTimeout(60_000);

/** A port nothing listens on. */
const DEAD = "http://127.0.0.1:9";

let home: string;
beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  home = mkdtempSync(join(REPO, ".scratch", "help-tree-"));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

async function run(argv: string[]): Promise<{ rc: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const env = { _ERIS_SHIM_DIR: REPO, PATH: process.env.PATH, HOME: home, ERIS_YAKS_URL: DEAD, HTTPS_PROXY: DEAD, HTTP_PROXY: DEAD };
  const rc = await main(argv, env, {
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: (s: string) => ((stderr += s), true) },
  });
  return { rc, stdout, stderr };
}

const CLI = defaultCli();

/** The bare program, then every registered path. */
const PATHS: readonly string[] = ["", ...Object.keys(CLI.registry)];
const words = (path: string): string[] => (path === "" ? [] : path.split(" "));
const groups = Object.keys(CLI.registry).filter((p) => Object.keys(CLI.registry).some((k) => k.startsWith(`${p} `)));

const isString = (v: unknown): v is string => typeof v === "string";

/** The problems with `doc` as an `eris-help/1` document for `path`, none when it is one. */
function helpJsonProblems(doc: unknown, path: string): string[] {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return ["not an object"];
  const d = doc as Record<string, unknown>;
  const out: string[] = [];
  const allowed = new Set(["schema", "path", "usage", "summary", "commands", "flags", "output_schema"]);
  for (const k of Object.keys(d)) if (!allowed.has(k)) out.push(`unknown key ${k}`);
  if (d.schema !== "eris-help/1") out.push("schema");
  if (d.path !== path) out.push(`path ${String(d.path)}`);
  if (!isString(d.usage) || !d.usage.toLowerCase().startsWith(`eris ${path}`.trim().toLowerCase())) out.push("usage");
  if (!isString(d.summary) || d.summary === "") out.push("summary");
  if (d.output_schema !== undefined && !isString(d.output_schema)) out.push("output_schema");
  if (!Array.isArray(d.commands) || !d.commands.every((c) => isString(c?.name) && isString(c?.summary) && Object.keys(c).length === 2)) out.push("commands");
  const flagKeys = new Set(["name", "arg", "summary", "repeatable", "alias"]);
  const flagOk = (f: Record<string, unknown>): boolean =>
    isString(f.name) &&
    f.name.startsWith("--") &&
    Object.keys(f).every((k) => flagKeys.has(k)) &&
    (f.arg === undefined || isString(f.arg)) &&
    (f.summary === undefined || isString(f.summary)) &&
    (f.repeatable === undefined || f.repeatable === true) &&
    (f.alias === undefined || isString(f.alias));
  if (!Array.isArray(d.flags) || !d.flags.every((f) => typeof f === "object" && f !== null && flagOk(f))) out.push("flags");
  return out;
}

describe("every path answers --help with its own usage", () => {
  // admits: a handler that prints its group's usage (or runs, or writes stderr) for `<path> --help` leaves a caller with no usage for the path it asked about; observed through `main` for every registered path. Which text a handler prints is runtime dispatch no type or rule sees.
  it.each(PATHS.flatMap((p) => [[p, "--help"], [p, "-h"]] as const))("eris %p %s", async (path, token) => {
    const r = await run([...words(path), token]);
    const first = r.stdout.split("\n")[0] ?? "";
    expect({ path, token, rc: r.rc, stderr: r.stderr, ownUsage: first.toLowerCase().includes(`eris ${path}`.trim().toLowerCase()) }).toEqual({
      path,
      token,
      rc: 0,
      stderr: "",
      ownUsage: true,
    });
  });

  // admits: a path whose `--help --json` prints prose, or refuses because the verb has no JSON rendering, gives a machine caller nothing to parse; observed as the parsed document of every path. The shape crosses a process boundary, so only a runtime check sees it.
  it.each(PATHS)("eris %p --help --json", async (path) => {
    const r = await run([...words(path), "--help", "--json"]);
    let doc: unknown;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    expect({ path, rc: r.rc, stderr: r.stderr, problems: helpJsonProblems(doc, path) }).toEqual({ path, rc: 0, stderr: "", problems: [] });
  });

  // admits: a group whose `--help` wins over a sub it does not have answers a typo with exit 0, so a script never learns the command does not exist; observed at the exit code of every group.
  it.each(groups)("eris %p <unknown sub> exits non-zero", async (group) => {
    for (const argv of [[...words(group), "no-such-command"], [...words(group), "no-such-command", "--help"]]) {
      const r = await run(argv);
      expect({ argv, failed: r.rc !== 0, stdout: r.stdout }).toEqual({ argv, failed: true, stdout: "" });
    }
  });
});

describe("the real entry", () => {
  // admits: a bare `eris` that waits on stdin (a prompt, a menu) hangs every script and agent that runs it; observed at a spawned entry with stdin closed, against a one-second deadline.
  it("bare eris with stdin closed exits 0 inside one second, printing the usage", async () => {
    const started = performance.now();
    const p = Bun.spawn([ERIS], { cwd: REPO, env: { PATH: process.env.PATH, HOME: home, ...oracleEnv() }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), 5_000);
    const [stdout, stderr, rc] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    const ms = performance.now() - started;
    expect({ rc, stderr, head: stdout.split("\n")[0], fast: ms < 1_000 }).toEqual({ rc: 0, stderr: "", head: "Usage: eris <command> [args]", fast: true });
  });
});
