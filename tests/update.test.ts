/**
 * Core's `eris update`: it prints how to get the latest release from npm and
 * exits 0, driven through `main` (the seam every command line crosses). The
 * in-place verb a distribution that publishes binaries composes instead is
 * tests/update-release.test.ts.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { main } from "../src/main";
import { REPO } from "./helpers/blackbox";

async function run(argv: string[], env: Record<string, string> = {}): Promise<{ rc: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const rc = await main(argv, { _ERIS_SHIM_DIR: REPO, PATH: process.env.PATH, HOME: process.env.HOME, ...env }, {
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: (s: string) => ((stderr += s), true) },
  });
  return { rc, stdout, stderr };
}

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
});

describe("eris update", () => {
  it("prints the npx, bunx and global-install commands for the latest release, and exits 0", async () => {
    /** When the verb drifts back to replacing a binary, or names a package or command that does not install eris, an npm user who runs it is refused or told to run something that fails — observed at main's stdout, exit and stderr. */
    expect(await run(["update"])).toEqual({
      rc: 0,
      stdout: [
        "eris dev. Run the latest release with:",
        "  npx @sibylline-labs/eris@latest <command>",
        "  bunx @sibylline-labs/eris@latest <command>",
        "or install it globally (bun runs it, so bun must be on PATH):",
        "  bun add -g @sibylline-labs/eris@latest",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  it("prints {current, commands} under --output json", async () => {
    /** When the json record drops a field or reorders the commands, a script that runs `commands[0]` runs the wrong thing — observed at the parsed record. */
    const r = await run(["--output", "json", "update"]);
    expect({ rc: r.rc, stderr: r.stderr }).toEqual({ rc: 0, stderr: "" });
    expect(JSON.parse(r.stdout)).toEqual({
      current: "dev",
      commands: ["npx @sibylline-labs/eris@latest <command>", "bunx @sibylline-labs/eris@latest <command>", "bun add -g @sibylline-labs/eris@latest"],
    });
  });

  it("makes no request, even with an update API set", async () => {
    /** When the release verb's code path is reachable from core's verb again, `eris update` on an npm install calls the releases API — observed at a loopback server that counts every request. */
    let hits = 0;
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => ((hits += 1), new Response("{}")) });
    const r = await run(["update"], { ERIS_UPDATE_API: `http://127.0.0.1:${server.port}` });
    expect(r.rc).toBe(0);
    expect(hits).toBe(0);
  });

  it("refuses the release verb's flags", async () => {
    /** When core's row keeps --check or --to, a script gating on `eris update --check` exits 0 and believes it is up to date — observed as the argument refusal and exit 1. */
    for (const argv of [["update", "--check"], ["update", "--to", "v0.2.0"]]) {
      const r = await run(argv);
      expect({ rc: r.rc, stdout: r.stdout }).toEqual({ rc: 1, stdout: "" });
      expect(r.stderr).toContain("(usage: eris update)");
    }
  });
});
