/**
 * The `eris` shim and the router behind it, driven as a caller runs them.
 *
 * What the shim owes every command: bun reads nothing from the caller's cwd
 * (no `.env`, no `bunfig.toml` preload), BUN_CONFIG_VERBOSE_FETCH is gone
 * before bun starts, a missing bun is its own refusal, and an unknown command
 * is the router's. A compiled binary's side of the same rows is pinned in
 * tests/compiled-binary.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { accessSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { renderFailureBlock } from "../ts/lib/eris-fail";
import { checkoutOnly } from "./helpers/blackbox";

setDefaultTimeout(120_000);

const REPO = resolve(import.meta.dir, "..");
const ERIS = join(REPO, "eris");

let tmp: string;

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "eris-shim-")));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Top-level entries a copied checkout does not need: dependencies, VCS state, worktrees and bulk. */
const CHECKOUT_COPY_SKIP = new Set([
  "node_modules", ".git", ".claude", "data", "thoughts", "research", "tests", "docs", ".idea", ".ok", ".ruff_cache", ".scratch",
]);

/** A copy of this checkout whose node_modules is present and empty: the install a pull
 *  leaves behind when it adds a dependency. Present on purpose — with no node_modules
 *  anywhere up the tree bun auto-installs at runtime instead of failing to resolve, so
 *  only a stale one fails the same way on every host. package.json stays for the same
 *  reason. */
function checkoutWithStaleDeps(name: string): string {
  const dir = join(tmp, name);
  cpSync(REPO, dir, {
    recursive: true,
    filter: (src) => !(resolve(src, "..") === REPO && CHECKOUT_COPY_SKIP.has(src.slice(REPO.length + 1))),
  });
  mkdirSync(join(dir, "node_modules"));
  return dir;
}

describe.skipIf(checkoutOnly("the eris shim; a binary has none"))("shim → router", () => {
  it("reads nothing from the caller's cwd and keeps a fetch's bearer off stderr under BUN_CONFIG_VERBOSE_FETCH", async () => {
    /** When the shim lets bun read the cwd, a service dir's generated .env lands in eris's environment and its bunfig preload runs as eris code; when BUN_CONFIG_VERBOSE_FETCH survives, every fetch prints its Authorization header — observed at a yak report against loopback Actors. */
    const svc = join(tmp, "svc");
    mkdirSync(svc, { recursive: true });
    const seen = { env: [] as string[], dotenv: [] as string[] };
    const actor = (into: string[]) =>
      Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (into.push(req.headers.get("authorization") ?? ""), new Response("{}", { status: 503 })) });
    const fromEnv = actor(seen.env);
    const fromDotenv = actor(seen.dotenv);
    const token = "sentinel-bearer-7f3a";
    writeFileSync(join(svc, ".env"), `ERIS_YAKS_URL=http://127.0.0.1:${fromDotenv.port}\nERIS_YAKS_TOKEN=${token}\n`);
    writeFileSync(join(svc, "pwn.ts"), `require("node:fs").writeFileSync(${JSON.stringify(join(tmp, "preload-ran"))}, "x");\n`);
    writeFileSync(join(svc, "bunfig.toml"), 'preload = ["./pwn.ts"]\n');
    const yak = async (env: Record<string, string>) => {
      const p = Bun.spawn([ERIS, "yak", "issue", "--summary", "s", "--body", "b"], { cwd: svc, env: { PATH: process.env.PATH ?? "", HOME: tmp, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stderr, status] = await Promise.all([new Response(p.stderr).text(), p.exited]);
      return { status, stderr };
    };
    try {
      const fromCwd = await yak({});
      // PAIRED: the same variables from the real environment are honoured, so the silence above is not vacuous.
      const r = await yak({ BUN_CONFIG_VERBOSE_FETCH: "curl", ERIS_YAKS_URL: `http://127.0.0.1:${fromEnv.port}`, ERIS_YAKS_TOKEN: token });
      expect({ status: fromCwd.status, dotenv: seen.dotenv, preload: existsSync(join(tmp, "preload-ran")) }).toEqual({ status: 0, dotenv: [], preload: false });
      expect({ status: r.status, env: seen.env }).toEqual({ status: 0, env: [`Bearer ${token}`] });
      expect(r.stderr).not.toContain(token);
      expect(r.stderr.toLowerCase()).not.toContain("authorization");
    } finally {
      fromEnv.stop(true);
      fromDotenv.stop(true);
    }
  });

  it("an unknown command is the router's refusal: exit 1, one ERROR line, nothing on stdout, under every shell the shim is run with", () => {
    /** When an unknown command exits 0, `eris confgi sync prod` passes a CI gate having done nothing. */
    for (const launcher of [[ERIS], ["sh", ERIS], ["bash", ERIS]]) {
      const r = spawnSync(launcher[0]!, [...launcher.slice(1), "frob\u001bnicate"], { cwd: tmp, env: { PATH: process.env.PATH ?? "", HOME: tmp }, encoding: "utf8" });
      expect({ launcher, status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({
        launcher,
        status: 1,
        stdout: "",
        stderr: "ERROR Unknown command: frobnicate. Run 'eris --help'\n",
      });
    }
  });

  it("without bun: the eris-bun-missing failure block, rendered by the shim itself", () => {
    /** When the shim cannot report a missing bun, the operator sees `bun: not found` with no slug and no fix. */
    const noBun = (process.env.PATH ?? "").split(delimiter).filter((d) => {
      try {
        accessSync(join(d, "bun"), constants.X_OK);
        return false;
      } catch {
        return true;
      }
    });
    const want = renderFailureBlock(
      {
        slug: "eris-bun-missing",
        what: "bun is not on PATH — eris routes every command through bun (src/main.ts)",
        fix: `install bun (https://bun.sh), then run ./install.sh --checkout in ${REPO}`,
      },
      REPO,
    );
    for (const launcher of [[ERIS], ["/bin/sh", ERIS]]) {
      const r = spawnSync(launcher[0]!, [...launcher.slice(1), "--help"], { cwd: tmp, env: { PATH: noBun.join(delimiter), HOME: tmp }, encoding: "utf8" });
      expect({ launcher, status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ launcher, status: 1, stdout: "", stderr: want });
    }
  });

  it("a checkout that cannot resolve its dependencies names bun install, never a raw resolution crash", () => {
    // When `eris config list` ran against a node_modules a pull left stale, it printed
    // `ERROR ResolveMessage: Cannot find package 'yaml' from …/parse.ts` with no slug and
    // no fix; this goes red — observed at the shim, the one place the operator sees it.
    // `eris yak` is this build's verb whose handler loads a package (zod); it names the
    // fix in a block and still exits 0, because reporting a broken harness must not stop
    // the caller (plugins/yak/handlers.ts). The core's own block for any other verb,
    // `eris-deps-not-installed`, is classified in tests/ts-verb-deps.test.ts.
    const dir = checkoutWithStaleDeps("stale-deps");
    const r = spawnSync(join(dir, "eris"), ["yak", "issue", "--summary", "s", "--body", "b"], { cwd: tmp, env: { PATH: process.env.PATH ?? "", HOME: tmp }, encoding: "utf8" });
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: "" });
    expect(r.stderr).not.toContain("ResolveMessage");
    expect(r.stderr.match(/^ERROR /gm)).toHaveLength(1);
    expect(r.stderr).toContain("slug: yak-deps-not-installed\n");
    expect(r.stderr).toContain(`fix: from ${dir}, run: bun install\n`);
    expect(r.stderr).toContain(`docs: ${dir}/docs/ERRORS.md#yak-deps-not-installed\n`);
  });
});
