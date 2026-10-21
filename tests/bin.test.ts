/**
 * `bin/eris.ts`, the command an npm or bun install links as `eris`, driven as
 * a caller runs it: executed directly, so its shebang is what starts bun.
 *
 * What it owes every command is what the POSIX shim owes (tests/cli-shim.test.ts):
 * bun reads nothing from the caller's cwd, and BUN_CONFIG_VERBOSE_FETCH never
 * reaches a fetch. The shim removes the variable before bun starts; an
 * installed bin has no shell to do that, so it refuses instead.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkoutOnly, expectFailBlock, REPO, type Sandbox, sandbox } from "./helpers/blackbox";

setDefaultTimeout(120_000);

const BIN = join(REPO, "bin", "eris.ts");

/** A loopback Yaks endpoint that records each request's Authorization header. */
function actor(into: string[]) {
  return Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (into.push(req.headers.get("authorization") ?? ""), new Response("{}", { status: 503 })) });
}

describe.skipIf(checkoutOnly("the npm bin; a compiled binary has none"))("bin/eris.ts", () => {
  let sb: Sandbox;
  /** What an install leaves on PATH: a symlink to the package's file, in another directory. */
  let LINKED: string;

  beforeAll(() => {
    sb = sandbox("eris-bin-");
    LINKED = join(sb.dir, "linked-eris");
    symlinkSync(BIN, LINKED);
  });
  afterAll(() => sb.cleanup());

  it("reads nothing from the caller's cwd: no .env, no bunfig preload", async () => {
    /** When the bin's shebang drops `--no-env-file` or `--config=/dev/null`, a service directory's generated .env lands in eris's environment and its bunfig preload runs as eris code — observed at a yak report against loopback Actors, and at the preload's marker file. */
    const svc = join(sb.dir, "svc");
    mkdirSync(svc, { recursive: true });
    const seen = { env: [] as string[], dotenv: [] as string[] };
    const fromEnv = actor(seen.env);
    const fromDotenv = actor(seen.dotenv);
    const token = "sentinel-bearer-7f3a";
    const marker = join(sb.dir, "preload-ran");
    writeFileSync(join(svc, ".env"), `ERIS_YAKS_URL=http://127.0.0.1:${fromDotenv.port}\nERIS_YAKS_TOKEN=${token}\n`);
    writeFileSync(join(svc, "pwn.ts"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`);
    writeFileSync(join(svc, "bunfig.toml"), 'preload = ["./pwn.ts"]\n');
    const yak = (env: Record<string, string>) => sb.run(["yak", "issue", "--summary", "s", "--body", "b"], { program: BIN, cwd: svc, env });
    try {
      const fromCwd = await yak({});
      // PAIRED: the same variables from the real environment are honoured, so the silence above is not vacuous.
      const viaEnv = await yak({ ERIS_YAKS_URL: `http://127.0.0.1:${fromEnv.port}`, ERIS_YAKS_TOKEN: token });
      expect({ status: fromCwd.status, dotenv: seen.dotenv, preload: existsSync(marker) }).toEqual({ status: 0, dotenv: [], preload: false });
      expect({ status: viaEnv.status, env: seen.env }).toEqual({ status: 0, env: [`Bearer ${token}`] });
    } finally {
      fromEnv.stop(true);
      fromDotenv.stop(true);
    }
  });

  it("refuses BUN_CONFIG_VERBOSE_FETCH with its slug before any fetch, as the file and as an install's symlink", async () => {
    /** When the bin runs under a caller's BUN_CONFIG_VERBOSE_FETCH, bun prints every fetch's Authorization bearer and body to stderr (the shim exists to prevent exactly that); when the refusal's docs: line names the symlink's directory instead of the package, it names a file that is not there — observed at the loopback Actor's request log and at the block's local docs: line. */
    const seen: string[] = [];
    const server = actor(seen);
    const token = "sentinel-bearer-7f3a";
    const env = { ERIS_YAKS_URL: `http://127.0.0.1:${server.port}`, ERIS_YAKS_TOKEN: token };
    try {
      // PAIRED: without the variable the same command line fetches, so "no request" below is the refusal's doing.
      expect((await sb.run(["yak", "issue", "--summary", "s", "--body", "b"], { program: BIN, env })).status).toBe(0);
      expect(seen).toEqual([`Bearer ${token}`]);
      for (const program of [BIN, LINKED]) {
        const r = await sb.run(["yak", "issue", "--summary", "s", "--body", "b"], { program, env: { ...env, BUN_CONFIG_VERBOSE_FETCH: "curl" } });
        expectFailBlock(r, "eris-verbose-fetch-set");
        expect(r.stderr).toContain(`docs: ${REPO}/docs/ERRORS.md#eris-verbose-fetch-set\n`);
        expect(r.stderr).not.toContain(token);
      }
      expect(seen).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });

  it("runs the program: --version prints, an unknown command is the router's refusal", async () => {
    /** When the bin imports src/main.ts but never calls runProgram (main.ts runs itself only when it is the entry), every command exits 0 having printed nothing — observed at the stdout of --version and the exit status of an unknown command. */
    for (const program of [BIN, LINKED]) {
      const version = await sb.run(["--version"], { program });
      expect({ program, status: version.status, stderr: version.stderr }).toEqual({ program, status: 0, stderr: "" });
      expect(version.stdout).toMatch(/^eris \S+ \(sibylline-labs\/eris\)\n$/);
      const unknown = await sb.run(["frobnicate"], { program });
      expect({ program, status: unknown.status, stdout: unknown.stdout, stderr: unknown.stderr }).toEqual({
        program,
        status: 1,
        stdout: "",
        stderr: "ERROR Unknown command: frobnicate. Run 'eris --help'\n",
      });
    }
  });
});
