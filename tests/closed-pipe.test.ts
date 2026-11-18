/**
 * A reader that closes stdout early (`eris <verb> | head`) ends the run quietly.
 * Turns red if core stops handling EPIPE once for every verb: the process then
 * dies with a stack trace on stderr and exit 1, observed black-box through the
 * real entrypoint with a reader that never reads.
 */

import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { ERIS, type Sandbox, sandbox } from "./helpers/blackbox";

setDefaultTimeout(60_000);

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox("eris-pipe-");
});
afterEach(() => sb.cleanup());

/** Run `eris <args>` with its stdout destroyed before it writes; resolve its exit status and stderr. */
function runWithClosedReader(args: string[]): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ERIS, args, { cwd: sb.cwd, env: sb.env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.destroy();
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

// Each verb writes to a pipe nobody reads; the status is 128 + SIGPIPE.
test.each([[["docs"]], [["--help"]], [["docs", "--output", "json"]]])("eris %p with a closed reader exits 141 quietly", async (args) => {
  const r = await runWithClosedReader(args);
  expect(r.stderr).toBe("");
  expect(r.status).toBe(141);
});
