/**
 * The argv shapes that are not verbs, behind the TS router:
 * `eris -h`, `eris --help` and bare `eris`, each the top-level usage.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { erisUsage } from "../src/cli/commands/usage";
import { ERIS } from "./helpers/blackbox";

const REPO = resolve(import.meta.dir, "..");

async function eris(argv: string[], path: string): Promise<{ rc: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([ERIS, ...argv], {
    cwd: REPO,
    env: { PATH: path, HOME: process.env.HOME ?? "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, rc] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { rc, stdout, stderr };
}

describe("eris -h / --help / bare, through the shim", () => {
  it("-h, --help and bare `eris` print the top-level usage on stdout, rc 0, with no yq on PATH", async () => {
    /** When top-level help needs yq (the Bash entrypoint checked it first), a host without yq cannot read the usage that names its fix. */
    mkdirSync(join(REPO, ".scratch"), { recursive: true });
    const bin = realpathSync(mkdtempSync(join(REPO, ".scratch", "top-")));
    try {
      for (const tool of ["bash", "bun"]) symlinkSync(Bun.which(tool)!, join(bin, tool));
      for (const argv of [["--help"], ["-h"], ["--output", "text", "--help"], [], ["--output", "text"]]) {
        expect({ argv, ...(await eris(argv, `${bin}:/usr/bin:/bin`)) }).toEqual({ argv, rc: 0, stdout: erisUsage(), stderr: "" });
      }
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
    for (const group of ["completion", "yak"]) expect(erisUsage()).toContain(`\n  ${group} `);
  });

  it("every command's summary starts in one column, core and plugin groups alike", () => {
    /** When core and plugin command lines are padded separately, `eris --help` staggers its summaries — observed at erisUsage(). */
    const block = erisUsage().split("Commands:\n")[1]!.split("\n\n")[0]!.split("\n");
    const columns = block.map((line) => line.match(/^ {2}\S+ +/)![0].length);
    expect(block.length).toBeGreaterThanOrEqual(2);
    expect(new Set(columns).size).toBe(1);
  });

  it("--output json on the bare program prints the top-level help document, never the human usage", async () => {
    /** When the bare program answers json with its human usage, a machine caller is handed text it would parse as JSON. */
    const r = await eris(["--output", "json"], process.env.PATH ?? "");
    expect({ rc: r.rc, stderr: r.stderr }).toEqual({ rc: 0, stderr: "" });
    expect(JSON.parse(r.stdout)).toMatchObject({ schema: "eris-help/1", path: "", usage: "eris <command> [args]" });
  });
});
