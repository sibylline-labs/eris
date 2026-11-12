/**
 * `eris docs` at the CLI seam: the verb reference an agent's skill reads instead
 * of carrying its own, checked against the composed registry the program runs.
 */

import { describe, expect, it } from "bun:test";
import { helpJson, usageLine } from "../src/cli/args";
import { defaultCli } from "../src/main";
import { REPO, sandbox } from "./helpers/blackbox";

describe("eris docs", () => {
  // admits: a reference that misses a plugin's verb, or restates a flag differently from the parser, sends an agent to a command that fails.
  it("--json lists every composed command, each as the help document its own --help --json prints", async () => {
    /** When the reference is not derived from the composed rows, a verb or flag the build has is missing or wrong in it: observed at the parsed record against the registry and against one verb's own help document. */
    const sb = sandbox("eris-docs-");
    try {
      const r = await sb.run(["docs", "--json"]);
      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
      const doc = JSON.parse(r.stdout) as { schema: string; version: string; commands: { path: string }[] };
      expect(doc.schema).toBe("eris-docs/1");
      expect(typeof doc.version).toBe("string");
      const rows = defaultCli().registry;
      expect(doc.commands).toEqual([helpJson("", undefined, rows), ...Object.keys(rows).map((p) => helpJson(p, rows[p], rows))]);
      expect(doc.commands.map((c) => c.path)).toContain("socrates submit");

      const own = await sb.run(["socrates", "submit", "--help", "--json"]);
      expect(doc.commands.find((c) => c.path === "socrates submit")).toEqual(JSON.parse(own.stdout));
      expect((await sb.run(["--output", "json", "docs"])).stdout).toBe(r.stdout);
    } finally {
      sb.cleanup();
    }
  });

  // admits: a human reference that drops a group reads as a build without it.

  it("text names every composed command's usage line and summary", async () => {
    /** When the text rendering skips a row, a reader is told a verb does not exist: observed at stdout against each composed row. */
    const sb = sandbox("eris-docs-");
    try {
      const r = await sb.run(["docs"], { cwd: REPO });
      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
      for (const [path, row] of Object.entries(defaultCli().registry)) expect(r.stdout).toContain(`${usageLine(path, row)}\n  ${row.summary}\n`);
    } finally {
      sb.cleanup();
    }
  });
});
