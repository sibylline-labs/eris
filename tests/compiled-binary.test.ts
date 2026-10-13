/**
 * What a compiled eris (scripts/build.ts) must do that the checkout gets from
 * its shim or its tree. Runs only in the binary oracle,
 * `ERIS_BIN=<binary> bun test ./tests`; the checkout's side of each row is
 * pinned in tests/cli-shim.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { binaryOnly, expectFailBlock, installRoot, type Sandbox, sandbox } from "./helpers/blackbox";

/** A yak report. With no Yaks credentials in the sandbox it runs to its "not configured" outcome. */
const YAK = ["yak", "issue", "--summary", "s", "--body", "b"];

/** A refusal block the global pre-pass writes: `completion` has no JSON rendering. */
const REFUSED = ["--output", "json", "completion", "bash"];

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox("eris-bin-");
});
afterEach(() => sb.cleanup());

describe.skipIf(binaryOnly("a compiled binary's own startup and refusals"))("a compiled eris binary", () => {
  it("reads nothing from the caller's cwd: no .env, no bunfig.toml preload", async () => {
    /** When the build leaves bun's executable autoloads on, a service dir's generated .env lands in eris's environment and its bunfig preload runs as eris code. */
    const svc = join(sb.dir, "service-dir");
    mkdirSync(svc);
    const planted = join(sb.dir, "planted-cache");
    writeFileSync(join(svc, ".env"), `ERIS_CACHE_DIR=${planted}\n`);
    writeFileSync(join(svc, "bunfig.toml"), 'preload = ["./pwn.ts"]\n');
    writeFileSync(join(svc, "pwn.ts"), 'import { writeFileSync } from "node:fs";\nwriteFileSync("pwned.marker", "ran");\n');

    const r = await sb.run(["--help"], { cwd: svc });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: eris");
    expect(existsSync(join(svc, "pwned.marker"))).toBe(false);
    expect(existsSync(planted)).toBe(false);

    // Positive control: the same variable from the real environment IS honoured, so the absence above is not vacuous.
    const honoured = await sb.run(["--help"], { cwd: svc, env: { ERIS_CACHE_DIR: planted } });
    expect(honoured.status).toBe(0);
    expect(existsSync(planted)).toBe(true);
  });

  it("runs a verb that loads a package with no bun on PATH and no node_modules above the cwd", async () => {
    /** When a verb spawns bun or resolves a package at runtime, a host that installs only the binary fails: `eris yak` loads zod, and with it unresolvable it reports yak-deps-not-installed instead of its outcome. */
    sb.hideReal("bun");
    const r = await sb.run(["--output", "json", ...YAK]);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    const record = JSON.parse(r.stdout) as { verb: string; delivered: boolean; error?: { slug: string } };
    expect({ verb: record.verb, delivered: record.delivered }).toEqual({ verb: "issue", delivered: false });
    expect(record.error?.slug).not.toBe("yak-deps-not-installed");
  });

  it("turns off BUN_CONFIG_VERBOSE_FETCH, so a fetch's bearer never reaches stderr", async () => {
    /** When the binary leaves a caller's BUN_CONFIG_VERBOSE_FETCH in force (a binary has no shim to unset it before bun starts), every fetch prints its Authorization header to stderr — observed at the stderr of a yak report against a loopback Actor. */
    const token = "sentinel-bearer-7f3a";
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        seen.push(req.headers.get("authorization") ?? "");
        return new Response("{}", { status: 503 });
      },
    });
    try {
      const r = await sb.run(YAK, {
        env: { BUN_CONFIG_VERBOSE_FETCH: "curl", ERIS_YAKS_URL: `http://127.0.0.1:${server.port}`, ERIS_YAKS_TOKEN: token },
      });
      // PAIRED: the fetch really ran, carrying the bearer the stderr must not show.
      expect(seen).toEqual([`Bearer ${token}`]);
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain(token);
      expect(r.stderr.toLowerCase()).not.toContain("authorization");
    } finally {
      server.stop(true);
    }
  });

  it("ignores a stray _ERIS_SHIM_DIR: its install root is its own asset home", async () => {
    /** When a binary honours the shim's private variable, a stray value in the caller's environment points its docs at a directory that is not its asset home, so a failure block's local docs: line names a file that does not exist — observed at that line. */
    const stray = join(sb.dir, "nonexistent");
    const r = await sb.run(REFUSED, { env: { _ERIS_SHIM_DIR: stray } });
    expectFailBlock(r, "output-json-unsupported");
    expect(r.stderr).toContain(`docs: ${installRoot()}/docs/OUTPUT-CONTRACT.md#3-machine-surfaces\n`);
    expect(existsSync(join(installRoot(), "docs/OUTPUT-CONTRACT.md"))).toBe(true);
    expect(r.stderr).not.toContain(stray);
  });

  /** Two ways to make the cache base unwritable. A read-only parent is the EACCES an operator hits; root bypasses file modes, so a file where the directory should be is the same failure for it. */
  const isRoot = process.getuid?.() === 0;
  const unwritable = [
    ["a read-only parent directory", (dir: string) => {
      const ro = join(dir, "read-only");
      mkdirSync(ro);
      chmodSync(ro, 0o555);
      return join(ro, "cache");
    }, true],
    ["a file where the cache directory should be", (dir: string) => {
      writeFileSync(join(dir, "not-a-dir"), "");
      return join(dir, "not-a-dir", "cache");
    }, false],
  ] as const;

  describe.each(unwritable)("with an unwritable cache dir (%s)", (_name, make, byMode) => {
    let cache: string;
    beforeEach(() => {
      cache = make(sb.dir);
    });
    afterEach(() => {
      // Let cleanup remove what the case made.
      const ro = join(sb.dir, "read-only");
      if (existsSync(ro)) chmodSync(ro, 0o755);
    });

    it.skipIf(isRoot && byMode)("still answers --help, --version and completion, which read no asset", async () => {
      /** When the asset home is written before anything else, an unwritable cache dir bricks every command, `--help`, `--version` and the `eris completion` in a shell profile included, with a bare EACCES and no slug — observed at the exit, stdout and stderr. */
      for (const argv of [["--help"], ["-h"], ["--version"], ["--output", "json", "--version"], ["yak", "issue", "--help"], ["completion", "bash"]]) {
        const r = await sb.run(argv, { env: { ERIS_CACHE_DIR: cache } });
        expect({ argv, status: r.status, stderr: r.stderr }).toEqual({ argv, status: 0, stderr: "" });
        expect(r.stdout.length).toBeGreaterThan(0);
      }
      expect(existsSync(cache)).toBe(false);
    });

    it.skipIf(isRoot && byMode)("refuses a verb that reads an asset with eris-cache-unwritable, naming the knobs", async () => {
      /** When materialization fails with the OS error escaping, the operator gets `ERROR EACCES…` with no slug and no fix — observed at the failure block: slug, fix lines naming ERIS_CACHE_DIR and XDG_CACHE_HOME, two docs lines. */
      const r = await sb.run(YAK, { env: { ERIS_CACHE_DIR: cache } });
      expectFailBlock(r, "eris-cache-unwritable");
      expect(r.stderr).toContain(`ERROR eris cannot write its asset cache under ${cache}`);
      expect(r.stderr).toMatch(/^fix: .*ERIS_CACHE_DIR/m);
      expect(r.stderr).toMatch(/^fix: .*XDG_CACHE_HOME/m);
      // No asset home exists to hold the docs, so the local line is the repo-relative path; the GitHub line is the readable one.
      expect(r.stderr).toContain("\ndocs: docs/ERRORS.md#eris-cache-unwritable\n");
      expect(r.stderr).toContain("\ndocs: https://github.com/sibylline-labs/eris/blob/main/docs/ERRORS.md#eris-cache-unwritable\n");
      expect(existsSync(cache)).toBe(false);
    });

    it.skipIf(isRoot && byMode)("a refusal printed on a help path names no unwritten docs file", async () => {
      /** When the help path adopts the unwritten home, any other block's local docs: line names a file under a directory that was never written — observed at the json refusal's first docs line. */
      const r = await sb.run([...REFUSED, "--help"], { env: { ERIS_CACHE_DIR: cache } });
      expectFailBlock(r, "output-json-unsupported");
      expect(r.stderr).toContain("\ndocs: docs/OUTPUT-CONTRACT.md#3-machine-surfaces\n");
      expect(r.stderr).not.toContain(cache);
    });
  });
});
