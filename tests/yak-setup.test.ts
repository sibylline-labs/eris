/**
 * plugins/yak/yak-setup.ts — mints this machine's Yaks bearer into ~/.eris/yaks.json.
 * The file is credential material, so the contract is about where the token
 * goes and where it never goes.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const SCRIPT = join(REPO, "plugins/yak/yak-setup.ts");
let home: string;

beforeEach(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  home = realpathSync(mkdtempSync(join(REPO, ".scratch", "yak-setup-")));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function setup(args: string[], env: Record<string, string> = {}): { rc: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["bun", "--no-env-file", SCRIPT, ...args], { cwd: home, env: { PATH: process.env.PATH ?? "", HOME: home, ...env } });
  return { rc: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

const dest = () => join(home, ".eris", "yaks.json");

describe("plugins/yak/yak-setup.ts", () => {
  it("writes {url, token} at mode 0600, and never prints the token", () => {
    /** When the file is group/world-readable the reader refuses it; when the token reaches stdout it lands in a terminal log. */
    const r = setup(["--url", "http://127.0.0.1:9"]);
    expect({ rc: r.rc, stderr: r.stderr }).toEqual({ rc: 0, stderr: "" });
    const cfg = JSON.parse(readFileSync(dest(), "utf8")) as { url: string; token: string };
    expect(cfg.url).toBe("http://127.0.0.1:9");
    expect(cfg.token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(dest()).mode & 0o777).toBe(0o600);
    expect(r.stdout).toStartWith(`wrote ${dest()} (-rw-------)\n`);
    expect(r.stdout).not.toContain(cfg.token);
    const slug = `yak-${hostname().split(".")[0]!.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/-+$/, "")}`;
    expect(r.stdout).toContain(`"<token from ${dest()}>": "${slug}"`);
    expect(r.stdout).toContain("the operator of http://127.0.0.1:9");
  });

  it("takes the url from ERIS_YAKS_URL when --url is absent, and --url wins over it", () => {
    /** When the env fallback is ignored, a machine configured the documented way cannot mint a bearer; when it beats --url, an explicit flag is silently overridden. */
    expect(setup([], { ERIS_YAKS_URL: "https://env.example" }).rc).toBe(0);
    expect(JSON.parse(readFileSync(dest(), "utf8")).url).toBe("https://env.example");
    expect(setup(["--force", "--url", "https://flag.example"], { ERIS_YAKS_URL: "https://env.example" }).rc).toBe(0);
    expect(JSON.parse(readFileSync(dest(), "utf8")).url).toBe("https://flag.example");
  });

  it("refuses with no --url and no ERIS_YAKS_URL, writing nothing", () => {
    /** When a missing URL falls back to a built-in host, the bearer is minted for a server the user never chose and every yak goes there. */
    expect(setup([])).toEqual({
      rc: 1,
      stdout: "",
      stderr: "no Yaks URL: pass --url <url> or set ERIS_YAKS_URL (usage: plugins/yak/yak-setup.ts [--slug <slug>] [--url <url>] [--force])\n",
    });
    expect(() => statSync(dest())).toThrow();
  });

  it("refuses to overwrite without --force; --force mints a new bearer", () => {
    /** When a rerun silently rewrites the file, the old bearer stays live in the worker map with nobody holding it. */
    mkdirSync(join(home, ".eris"));
    writeFileSync(dest(), '{"url":"u","token":"old"}\n');
    const refused = setup(["--url", "http://127.0.0.1:9"]);
    expect({ rc: refused.rc, stdout: refused.stdout }).toEqual({ rc: 1, stdout: "" });
    expect(refused.stderr).toStartWith(`refusing to overwrite ${dest()} (pass --force if that is what you want)\n`);
    expect(readFileSync(dest(), "utf8")).toBe('{"url":"u","token":"old"}\n');
    expect(setup(["--force", "--slug", "yak-ci.box_1", "--url", "http://127.0.0.1:9"]).rc).toBe(0);
    expect(JSON.parse(readFileSync(dest(), "utf8")).token).not.toBe("old");
  });

  it("refuses a slug outside the registry grammar, an unknown flag and a missing value, writing nothing", () => {
    /** When a bad slug is accepted, the bearer maps to a source the registry rejects and every yak 401s. */
    expect(setup(["--slug", "Bad Slug", "--url", "http://127.0.0.1:9"])).toEqual({ rc: 1, stdout: "", stderr: "slug 'Bad Slug' fails the registry grammar ^[a-z0-9][a-z0-9._-]*$\n" });
    expect(setup(["--nope"])).toEqual({
      rc: 1,
      stdout: "",
      stderr: "Unknown flag '--nope' (usage: plugins/yak/yak-setup.ts [--slug <slug>] [--url <url>] [--force])\n",
    });
    expect(setup(["--url"])).toEqual({
      rc: 1,
      stdout: "",
      stderr: "--url requires a value — no value follows it (usage: plugins/yak/yak-setup.ts [--slug <slug>] [--url <url>] [--force])\n",
    });
    expect(() => statSync(dest())).toThrow();
  });

  it("--help prints the usage and writes nothing", () => {
    /** When help falls through, asking how the script works mints a credential. */
    const r = setup(["--help"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toContain("Usage: plugins/yak/yak-setup.ts [--slug <slug>] [--url <url>] [--force]");
    expect(() => statSync(dest())).toThrow();
  });
});
