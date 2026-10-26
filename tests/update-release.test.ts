/**
 * The release `eris update` (RELEASE_UPDATE, src/cli/commands/update/opt-in.ts):
 * the in-place self-update a distribution that publishes binaries composes in
 * place of core's verb, composed here the same way and driven through `main` (the seam every
 * command line crosses) with the handler's host injected (what is running, where,
 * on which platform) and GitHub replaced by the loopback fixture in
 * tests/helpers/release-fixture.ts: two real listeners, so the asset download's
 * redirect to a second origin is real. The binary under update is a small shell
 * script that answers `--version` like eris does, so replacement, the smoke run
 * and the restore are the real filesystem and a real child process. The same
 * verb on a binary `build()` compiled is tests/update-binary.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGINS } from "../plugins";
import { composeCli } from "../src/cli/compose";
import { RELEASE_UPDATE } from "../src/cli/commands/update/opt-in";
import { allowedRedirect, compareVersions, createUpdateHandler, defaultHost, parseApiBase, type UpdateHost } from "../src/cli/commands/update/release";
import { REGISTRY } from "../src/cli/registry";
import { HANDLERS, main } from "../src/main";
import { nodeRunner } from "../src/runtime/process";
import { releaseFixture, type ReleaseFixture, sha256Hex } from "./helpers/release-fixture";
import { expectFailBlock, REPO, type Run } from "./helpers/blackbox";

const isRoot = process.getuid?.() === 0;
const TOKEN = ["ghp", "_", "a".repeat(36)].join("");

/** A stand-in eris: answers `--output json --version` as the real one does, and says in `log` whether `<path>.old` existed when it was asked and which tokens it was handed. */
const fakeEris = (version: string, log?: string): string =>
  `#!/bin/sh\n${log !== undefined ? `if [ -e "$0.old" ]; then old=old-kept; else old=old-missing; fi\necho "$old token-\${GH_TOKEN:-unset}-\${GITHUB_TOKEN:-unset}" >> '${log}'\n` : ""}` +
  `printf '%s\\n' '{"version":"${version}","release_repo":"example-org/eris-fork","build_id":null,"extra":null}'\n`;

interface Out {
  rc: number;
  stdout: string;
  stderr: string;
}

interface World {
  dir: string;
  bin: string;
  target: string;
  smokeLog: string;
  fx: ReleaseFixture;
  host: UpdateHost;
  /** Run `eris <argv>` with the update handler on `host`. */
  run(argv: string[], opts?: { env?: Record<string, string | undefined>; host?: Partial<UpdateHost> }): Promise<Out>;
  /** What is left in the bin dir. */
  left(): string[];
  /** The tag the target reports when run. */
  reports(): string;
}

let w: World;

beforeEach(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  const dir = realpathSync(mkdtempSync(join(REPO, ".scratch", "update-")));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const target = join(bin, "eris");
  writeFileSync(target, fakeEris("v0.0.1"));
  chmodSync(target, 0o755);
  const fx = releaseFixture("example-org/eris-fork");
  const host: UpdateHost = {
    compiled: true,
    execPath: target,
    platform: "linux",
    arch: "x64",
    version: "v0.0.1",
    releaseRepo: "example-org/eris-fork",
    runner: nodeRunner,
    apiTimeoutMs: 5_000,
    downloadTimeoutMs: 5_000,
  };
  w = {
    dir,
    bin,
    target,
    smokeLog: join(dir, "smoke.log"),
    fx,
    host,
    async run(argv, opts = {}) {
      const h = { ...host, ...opts.host };
      const cli = composeCli({ ...REGISTRY, update: RELEASE_UPDATE.row }, { ...HANDLERS, update: async () => createUpdateHandler(h) }, PLUGINS);
      let stdout = "";
      let stderr = "";
      const env: Record<string, string | undefined> = { _ERIS_SHIM_DIR: REPO, PATH: process.env.PATH, HOME: process.env.HOME, ERIS_UPDATE_API: fx.api, ...opts.env };
      const rc = await main(argv, env, { cli, stdout: { write: (s: string) => ((stdout += s), true) }, stderr: { write: (s: string) => ((stderr += s), true) } });
      return { rc, stdout, stderr };
    },
    left: () => readdirSync(bin).sort(),
    reports: () => (JSON.parse(Bun.spawnSync([target, "--output", "json", "--version"]).stdout.toString()) as { version: string }).version,
  };
});

afterEach(() => {
  w.fx.stop();
  chmodSync(w.bin, 0o755);
  rmSync(w.dir, { recursive: true, force: true });
});

/** A release for the fake host (linux-x64) whose binary reports `tag`. */
function publish(tag: string, extra: { prerelease?: boolean; sums?: "auto" | string | null; binary?: string } = {}) {
  return w.fx.publish({ tag, prerelease: extra.prerelease, sums: extra.sums, assets: { "eris-linux-x64": extra.binary ?? fakeEris(tag, w.smokeLog), "eris-darwin-arm64": "not this platform" } });
}

const asRun = (o: Out): Run => ({ status: o.rc, stdout: o.stdout, stderr: o.stderr, stdoutBytes: Buffer.from(o.stdout), stderrBytes: Buffer.from(o.stderr) });
const requests = () => w.fx.hits.filter((h) => !h.path.startsWith("/browser/"));

describe("eris update replaces the running binary", () => {
  it("downloads, verifies, replaces in place, smokes the new binary and removes .old", async () => {
    /** When the replacement skips the checksum, lands in another directory, leaves .old behind or never runs the new binary, a user keeps a broken or half-written eris — observed at the bin directory, the binary's own report and what it saw while it ran. */
    publish("v0.0.2");
    let during: string[] = [];
    w.fx.midDownload = () => {
      const now = readdirSync(w.bin).sort();
      if (now.length > 1) during = now;
    };
    const before = statSync(w.target).mode & 0o777;
    const r = await w.run(["update"], { env: { TMPDIR: join(w.dir, "does-not-exist") } });
    expect({ rc: r.rc, stdout: r.stdout }).toEqual({ rc: 0, stdout: "" });
    expect(r.stderr).toContain("INFO ✓ updated eris v0.0.1 -> v0.0.2");
    // What the new binary saw when update ran it, before this test runs it again.
    const smoked = readFileSync(w.smokeLog, "utf8");
    expect(w.reports()).toBe("v0.0.2");
    expect(w.left()).toEqual(["eris"]);
    expect(statSync(w.target).mode & 0o777).toBe(before);
    // The download streamed into a temp file beside the target (not under TMPDIR), and the previous binary was kept until the new one answered.
    expect(during).toEqual([expect.stringMatching(/^\.eris-update-/), "eris"]);
    expect(smoked).toBe("old-kept token-unset-unset\n");
  });

  it("fetches assets through their API url with octet-stream, never browser_download_url", async () => {
    /** When the download uses browser_download_url, a private repository answers 404 to the token and update fails exactly where it is needed — observed at the requests the fixture received, which lists that url and 404s it as a private repository does. */
    publish("v0.0.2");
    const r = await w.run(["update"]);
    expect(r.rc).toBe(0);
    const paths = requests().map((h) => `${h.server} ${h.path}`);
    expect(paths).toEqual([
      "api /repos/example-org/eris-fork/releases/latest",
      expect.stringMatching(/^api \/repos\/example-org\/eris-fork\/releases\/assets\/\d+$/),
      expect.stringMatching(/^cdn \/blob\/\d+$/),
      expect.stringMatching(/^api \/repos\/example-org\/eris-fork\/releases\/assets\/\d+$/),
      expect.stringMatching(/^cdn \/blob\/\d+$/),
    ]);
    for (const h of requests().filter((h) => h.path.includes("/assets/"))) expect(h.accept).toBe("application/octet-stream");
    expect(w.fx.browserHits()).toBe(0);
  });

  it("replaces the file a symlink points to and leaves the symlink", async () => {
    /** When update renames over the link instead of its target, the link becomes a regular file and the real install is never updated — observed at the link and at the file it names. */
    publish("v0.0.2");
    const link = join(w.dir, "link-eris");
    symlinkSync(w.target, link);
    const r = await w.run(["update"], { host: { execPath: link } });
    expect(r.rc).toBe(0);
    expect(statSync(link).isFile() && readFileSync(link, "utf8") === readFileSync(w.target, "utf8")).toBe(true);
    expect(readdirSync(w.dir).includes("link-eris")).toBe(true);
    expect(Bun.spawnSync([link, "--output", "json", "--version"]).stdout.toString()).toContain("v0.0.2");
    expect(w.reports()).toBe("v0.0.2");
  });

  it("accepts a binary-mode marker in SHA256SUMS", async () => {
    /** When the SHA256SUMS parser rejects `<hash> *<name>`, which `sha256sum -b` writes, every release published that way refuses to install — observed at the exit and the binary's report. */
    const binary = fakeEris("v0.0.2", w.smokeLog);
    publish("v0.0.2", { sums: `${sha256Hex(binary)} *eris-linux-x64\n`, binary });
    const r = await w.run(["update"]);
    expect(r.rc).toBe(0);
    expect(w.reports()).toBe("v0.0.2");
  });

  it("prints one JSON record under --output json, and nothing else on stdout", async () => {
    /** When the machine rendering drops a field or mixes progress into stdout, a script gating on `updated` or parsing the record breaks — observed at stdout. */
    publish("v0.0.2");
    const r = await w.run(["--output", "json", "update"]);
    expect(r.rc).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ current: "v0.0.1", latest: "v0.0.2", update_available: true, updated: true });
    expect(r.stdout.split("\n").filter(Boolean)).toHaveLength(1);
    expect(r.stderr).toContain("INFO ✓ updated");
  });

  it("does nothing, and downloads nothing, when this is already the latest release", async () => {
    /** When update reinstalls the version it already is, every run downloads and rewrites the binary — observed at the requests, the bin directory and the record. Paired with the replacement above. */
    publish("v0.0.1");
    const r = await w.run(["--output", "json", "update"]);
    expect(r.rc).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ current: "v0.0.1", latest: "v0.0.1", update_available: false, updated: false });
    expect(r.stderr).toContain("INFO ✓ eris v0.0.1 is up to date");
    expect(requests().map((h) => h.path)).toEqual(["/repos/example-org/eris-fork/releases/latest"]);
    expect(readFileSync(w.target, "utf8")).toBe(fakeEris("v0.0.1"));
  });
});

describe("eris update --check", () => {
  const cases: [string, { current?: string; latest: string }, number, string, boolean][] = [
    ["an update is available", { latest: "v0.0.2" }, 10, "update available: v0.0.1 -> v0.0.2\n", true],
    ["this is the latest", { latest: "v0.0.1" }, 0, "up to date: v0.0.1\n", false],
    ["this build is newer than the latest release", { current: "v0.1.0", latest: "v0.0.2" }, 0, "up to date: v0.1.0\n", false],
    ["this build is untagged", { current: "dev", latest: "v0.0.2" }, 10, "update available: dev -> v0.0.2\n", true],
    ["the latest has a two-digit patch", { current: "v0.0.9", latest: "v0.0.10" }, 10, "update available: v0.0.9 -> v0.0.10\n", true],
  ];
  it.each(cases)("exits with the answer when %s, and replaces nothing", async (_name, { current = "v0.0.1", latest }, rc, text, available) => {
    /** When --check exits 0 for an available update (or 10 for none), a script gating on it never updates or always does; when it downloads, "check" changes the machine — observed at the exit, both renderings and the requests. */
    publish(latest);
    const host = { version: current };
    const t = await w.run(["update", "--check"], { host });
    expect({ rc: t.rc, stdout: t.stdout, stderr: t.stderr }).toEqual({ rc, stdout: text, stderr: "" });
    const j = await w.run(["--output", "json", "update", "--check"], { host });
    expect(j.rc).toBe(rc);
    expect(JSON.parse(j.stdout)).toEqual({ current, latest, update_available: available, updated: false });
    expect(requests().every((h) => h.path.endsWith("/releases/latest"))).toBe(true);
    expect(readFileSync(w.target, "utf8")).toBe(fakeEris("v0.0.1"));
  });

  it("exits 1, not 10, when the check cannot be answered", async () => {
    /** When a failed check shares the available-update exit code, a script updating on 10 treats an outage as news — observed at the exit and the block. */
    const r = await w.run(["update", "--check"]);
    expect(r.rc).toBe(1);
    expectFailBlock(asRun(r), "update-needs-token");
  });
});

describe("eris update --to", () => {
  it("installs an older release, a downgrade the plain command never makes", async () => {
    /** When --to refuses a downgrade, a bad release cannot be backed out; when a plain `update` makes one, a build ahead of the latest release is pulled back — observed at the binary's report after each. */
    publish("v0.0.1");
    publish("v0.0.2");
    w.fx.latest = "v0.0.2";
    const host = { version: "v0.0.2" };
    writeFileSync(w.target, fakeEris("v0.0.2"));
    const plain = await w.run(["--output", "json", "update"], { host });
    expect(JSON.parse(plain.stdout)).toMatchObject({ update_available: false, updated: false });
    expect(w.reports()).toBe("v0.0.2");
    const back = await w.run(["--output", "json", "update", "--to", "v0.0.1"], { host });
    expect(back.rc).toBe(0);
    expect(JSON.parse(back.stdout)).toEqual({ current: "v0.0.2", latest: "v0.0.1", update_available: false, updated: true });
    expect(w.reports()).toBe("v0.0.1");
    expect(requests().map((h) => h.path)).toContain("/repos/example-org/eris-fork/releases/tags/v0.0.1");
  });

  it("installs a prerelease only when named, and never takes one as the latest", async () => {
    /** When `update` follows a prerelease, every user is moved onto a release candidate; when --to cannot name one, a candidate cannot be tried — observed at the binary's report. */
    publish("v0.0.2");
    publish("v0.0.3-rc.1", { prerelease: true });
    w.fx.latest = "v0.0.3-rc.1"; // a host that wrongly answers `latest` with a prerelease
    const refused = await w.run(["update"]);
    expect(refused.rc).toBe(1);
    expectFailBlock(asRun(refused), "update-release-not-found");
    expect(w.reports()).toBe("v0.0.1");
    const named = await w.run(["update", "--to", "v0.0.3-rc.1"]);
    expect(named.rc).toBe(0);
    expect(w.reports()).toBe("v0.0.3-rc.1");
  });

  it.each([["an empty-looking tag", "v1;touch x"], ["a path", "../v1"], ["a flag", "-x"]])("refuses %s before any request", async (_name, to) => {
    /** When --to is put into the API path unchecked, a crafted tag reaches another endpoint — observed at the exit, the message and the requests. */
    const r = await w.run(["update", `--to=${to}`]);
    expect({ rc: r.rc, stdout: r.stdout }).toEqual({ rc: 1, stdout: "" });
    expect(r.stderr).toContain("ERROR --to takes a release tag such as v0.2.1");
    expect(w.fx.hits).toEqual([]);
  });
});

describe("the token", () => {
  it("goes to the API host, and is dropped when the download redirects to another host", async () => {
    /** When the bearer follows the asset redirect to the storage host, it leaks to a third party and the signed URL rejects it — observed at the Authorization each server received. Paired: the API saw it. */
    publish("v0.0.2");
    const r = await w.run(["update"], { env: { GH_TOKEN: TOKEN } });
    expect(r.rc).toBe(0);
    const api = requests().filter((h) => h.server === "api");
    const cdn = requests().filter((h) => h.server === "cdn");
    expect(api.length).toBe(3);
    expect(api.map((h) => h.authorization)).toEqual(Array(3).fill(`Bearer ${TOKEN}`));
    expect(cdn.length).toBe(2);
    expect(cdn.map((h) => h.authorization)).toEqual([null, null]);
    expect(r.stderr).not.toContain(TOKEN);
    // The binary being installed is run to check it, and is not handed the token.
    expect(readFileSync(w.smokeLog, "utf8")).toBe("old-kept token-unset-unset\n");
  });

  it("is never sent to an asset url on another host", async () => {
    /** When the token is attached to whatever url the release lists, a release served from a mirror (or a tampered listing) receives it — observed at the Authorization the cdn received for a listing that points at it directly. */
    publish("v0.0.2");
    w.fx.assetUrlsOnCdn = true;
    const r = await w.run(["update"], { env: { GH_TOKEN: TOKEN } });
    expect(r.rc).toBe(0);
    expect(requests().filter((h) => h.server === "cdn").map((h) => h.authorization)).toEqual([null, null]);
    expect(requests().filter((h) => h.server === "api").map((h) => h.authorization)).toEqual([`Bearer ${TOKEN}`]);
  });

  it("is GH_TOKEN, else GITHUB_TOKEN, else nothing", async () => {
    /** When the lookup order is wrong, a CI job's GITHUB_TOKEN overrides the operator's GH_TOKEN, and an unset token sends an empty Bearer — observed at the Authorization the API received. */
    publish("v0.0.1");
    const seen = async (env: Record<string, string | undefined>) => {
      w.fx.hits.length = 0;
      await w.run(["update", "--check"], { env });
      return w.fx.hits.map((h) => h.authorization);
    };
    expect(await seen({ GH_TOKEN: "one", GITHUB_TOKEN: "two" })).toEqual(["Bearer one"]);
    expect(await seen({ GITHUB_TOKEN: "two" })).toEqual(["Bearer two"]);
    expect(await seen({ GH_TOKEN: "", GITHUB_TOKEN: "" })).toEqual([null]);
    expect(await seen({})).toEqual([null]);
  });

  it("is trimmed, and a token holding a line break or space is refused without being shown", async () => {
    /** When a token with a stray line break reaches the Authorization header, fetch throws an error that quotes the whole value and the failure block prints the secret to stderr and any log it lands in — observed at stderr and at the requests, for a token with a trailing CR LF (trimmed, and used) and one with a line break inside (refused). */
    publish("v0.0.1");
    const padded = await w.run(["update", "--check"], { env: { GH_TOKEN: `  ${TOKEN}\r\n` } });
    expect(padded.rc).toBe(0);
    expect(w.fx.hits.map((h) => h.authorization)).toEqual([`Bearer ${TOKEN}`]);
    w.fx.hits.length = 0;
    for (const bad of [`${TOKEN}\nX-Injected: 1`, `${TOKEN} extra`]) {
      const r = await w.run(["update", "--check"], { env: { GH_TOKEN: bad } });
      expectFailBlock(asRun(r), "update-token-invalid");
      expect(r.stderr).toContain("GH_TOKEN");
      expect(r.stderr).not.toContain(TOKEN);
      expect(r.stderr).not.toContain("X-Injected");
    }
    expect(w.fx.hits).toEqual([]);
    // A blank GH_TOKEN falls through to GITHUB_TOKEN rather than being sent empty.
    const blank = await w.run(["update", "--check"], { env: { GH_TOKEN: " \n", GITHUB_TOKEN: TOKEN } });
    expect(blank.rc).toBe(0);
    expect(w.fx.hits.map((h) => h.authorization)).toEqual([`Bearer ${TOKEN}`]);
  });

  it("goes only to api.github.com or a loopback API: an ERIS_UPDATE_API on any other host gets none", async () => {
    /** When the bearer follows ERIS_UPDATE_API to whatever host it names, a stray or planted variable hands the user's GitHub token to that host — observed at the headers eris hands fetch for a non-loopback https base, forwarded to the fixture. Paired: api.github.com, through the same forwarding, gets it. */
    // No assets: their loopback http urls are refused under an https base, and --check needs none.
    w.fx.publish({ tag: "v0.0.1", assets: {}, sums: null });
    const real = globalThis.fetch;
    const sent: [string, string | null][] = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      sent.push([url.origin, new Headers(init?.headers).get("authorization")]);
      return real(new URL(`${url.pathname}${url.search}`, w.fx.api), init);
    }) as typeof fetch;
    try {
      for (const api of ["https://ghe.example.com", "https://api.github.com.example.com", "https://api.github.com"]) {
        const r = await w.run(["update", "--check"], { env: { ERIS_UPDATE_API: api, GH_TOKEN: TOKEN } });
        expect({ api, rc: r.rc, stderr: r.stderr }).toEqual({ api, rc: 0, stderr: "" });
      }
    } finally {
      globalThis.fetch = real;
    }
    expect(sent).toEqual([
      ["https://ghe.example.com", null],
      ["https://api.github.com.example.com", null],
      ["https://api.github.com", `Bearer ${TOKEN}`],
    ]);
  });

  it("reaches a private repository: 404 without it, the release with it", async () => {
    /** When update cannot authenticate, a private distribution's binary never updates — observed at the exit with and without the token against a fixture that 404s as GitHub does. */
    publish("v0.0.2");
    w.fx.requireToken = TOKEN;
    const without = await w.run(["update"]);
    expect(without.rc).toBe(1);
    expectFailBlock(asRun(without), "update-needs-token");
    const withToken = await w.run(["update"], { env: { GH_TOKEN: TOKEN } });
    expect(withToken.rc).toBe(0);
    expect(w.reports()).toBe("v0.0.2");
  });
});

describe("eris update refuses, naming the fix", () => {
  /** Every refusal: a slugged block, nothing on stdout, and the binary untouched with nothing left beside it. */
  const untouched = () => {
    expect(readFileSync(w.target, "utf8")).toBe(fakeEris("v0.0.1"));
    expect(w.left()).toEqual(["eris"]);
  };

  describe("before any request", () => {
    it("on a source checkout, naming git", async () => {
      /** When update runs from a checkout it replaces bun's own binary or the wrong file — observed at the block and at the fixture, which saw no request. */
      const r = await w.run(["update"], { host: { compiled: false } });
      expectFailBlock(asRun(r), "update-not-compiled");
      expect(r.stderr).toMatch(/^fix: .*git .*pull/m);
      expect(w.fx.hits).toEqual([]);
      untouched();
    });

    it.each([
      ["win32", "x64"],
      ["darwin", "x64"],
      ["linux", "arm64"],
    ])("on an unsupported platform (%s-%s)", async (platform, arch) => {
      /** When update looks up an asset for a platform no release carries, the user gets a 'missing asset' for a build that can never exist — observed at the block naming the supported platforms, with no request made. */
      const r = await w.run(["update"], { host: { platform, arch } });
      expectFailBlock(asRun(r), "update-unsupported-platform");
      expect(r.stderr).toContain(`${platform}-${arch}`);
      expect(r.stderr).toContain("darwin-arm64");
      expect(r.stderr).toContain("linux-x64");
      expect(w.fx.hits).toEqual([]);
      untouched();
    });

    it.skipIf(isRoot)("when the directory cannot be written, before downloading anything", async () => {
      /** When the write permission is found only after the download, a user on a read-only install waits for 60 MB and then fails — observed at the block and at the fixture, which saw no request. */
      chmodSync(w.bin, 0o555);
      const r = await w.run(["update"]);
      expectFailBlock(asRun(r), "update-target-unwritable");
      expect(r.stderr).toContain(w.bin);
      expect(w.fx.hits).toEqual([]);
      chmodSync(w.bin, 0o755);
      untouched();
    });

    it.each([
      ["a scheme that is not http(s)", "ftp://127.0.0.1:21"],
      ["plain http to a host that is not loopback", "http://api.example.com"],
      ["credentials in the url", "https://user:secret@api.example.com"],
      ["something that is not a url", "not a url"],
    ])("when ERIS_UPDATE_API is %s", async (_name, api) => {
      /** When the override accepts any url, a stray variable sends the bearer in clear text to a host nobody chose — observed at the block and at the fixture, which saw no request. */
      publish("v0.0.2");
      const r = await w.run(["update"], { env: { ERIS_UPDATE_API: api, GH_TOKEN: TOKEN } });
      expectFailBlock(asRun(r), "update-api-invalid");
      expect(r.stderr).not.toContain(TOKEN);
      expect(r.stderr).not.toContain("secret");
      expect(w.fx.hits).toEqual([]);
    });
  });

  describe("on what the API answers", () => {
    const reset = "1893456000"; // 2030-01-01T00:00:00Z
    const status = (code: number, headers: Record<string, string> = {}) => () => new Response("{}", { status: code, headers });
    const cases: [string, () => Response, string, (string | RegExp)[]][] = [
      ["a 403 with the rate limit spent", status(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }), "update-rate-limited", [/^fix: .*GH_TOKEN/m, "2030-01-01T00:00:00Z"]],
      ["a 429", status(429, { "retry-after": "60" }), "update-rate-limited", [/^fix: .*GH_TOKEN/m]],
      ["a 403 that is not the rate limit", status(403), "update-api-error", ["403"]],
      ["a 404 with no token", status(404), "update-needs-token", [/^fix: .*private/m, /^fix: .*GH_TOKEN/m]],
      ["a 500", status(500), "update-api-error", ["500"]],
      ["a body that is not a release", () => new Response("<html>", { status: 200 }), "update-api-error", []],
      ["a release without a tag", () => Response.json({ assets: [] }), "update-api-error", []],
    ];
    it.each(cases)("%s", async (_name, respond, slug, wants) => {
      /** When a status is read as success, a rate limit looks like 'no update', a private repository like a missing release, or an HTML error page like a release — observed at the block's slug and fix for each distinct answer. */
      w.fx.override = (req, server) => (server === "api" ? respond() : undefined);
      const r = await w.run(["update"]);
      expectFailBlock(asRun(r), slug);
      for (const want of wants) typeof want === "string" ? expect(r.stderr).toContain(want) : expect(r.stderr).toMatch(want);
      untouched();
    });

    it("a 401 with a token names the token as rejected", async () => {
      /** When a rejected token is reported as a missing release, the user chases the tag instead of the token — observed at the block, which must not echo the token. */
      w.fx.override = (_req, server) => (server === "api" ? new Response("{}", { status: 401 }) : undefined);
      const r = await w.run(["update"], { env: { GH_TOKEN: TOKEN } });
      expectFailBlock(asRun(r), "update-api-error");
      expect(r.stderr).toMatch(/^fix: .*GH_TOKEN/m);
      expect(r.stderr).not.toContain(TOKEN);
    });

    it("a 404 with a token is a release that is not there, not a missing token", async () => {
      /** When a 404 always asks for a token, a user who has one is sent in a circle — observed at the slug. Paired with the no-token row above. */
      const r = await w.run(["update"], { env: { GH_TOKEN: TOKEN } });
      expectFailBlock(asRun(r), "update-release-not-found");
      expect(r.stderr).toContain("example-org/eris-fork");
      expect(r.stderr).not.toContain(TOKEN);
    });

    it("a draft release is not installable even when named", async () => {
      /** When a draft's assets are fetched, an unpublished build reaches users — observed at the block for `--to` a draft, and at the binary. */
      w.fx.publish({ tag: "v0.0.9", draft: true, assets: { "eris-linux-x64": fakeEris("v0.0.9") } });
      const r = await w.run(["update", "--to", "v0.0.9"]);
      expectFailBlock(asRun(r), "update-release-not-found");
      untouched();
    });
  });

  describe("on the network", () => {
    it("when nothing answers", async () => {
      /** When a refused connection escapes as a stack trace, offline users see a crash instead of what to check — observed at the block. */
      w.fx.stop();
      const r = await w.run(["update"]);
      expectFailBlock(asRun(r), "update-unreachable");
      expect(r.stderr).toContain(w.fx.api.replace("http://", ""));
      untouched();
    });

    it("when the API stops answering", async () => {
      /** When there is no deadline, a stalled connection hangs update forever — observed at the block, after the host's deadline. */
      w.fx.override = (_req, server) => (server === "api" ? new Promise<Response>(() => {}) : undefined);
      const t0 = Date.now();
      const r = await w.run(["update"], { host: { apiTimeoutMs: 150 } });
      expectFailBlock(asRun(r), "update-unreachable");
      expect(r.stderr).toMatch(/did not respond/);
      expect(Date.now() - t0).toBeLessThan(4_000);
      untouched();
    });

    it("when the download stalls, with the partial file removed", async () => {
      /** When the deadline covers only the headers, a download that goes quiet mid-body hangs update and leaves a partial file beside the binary — observed at the block and the directory. */
      const rel = publish("v0.0.2");
      const binary = `/blob/${rel.ids.get("eris-linux-x64")}`;
      w.fx.override = (req, server) =>
        server === "cdn" && new URL(req.url).pathname === binary ? new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); } })) : undefined;
      const r = await w.run(["update"], { host: { downloadTimeoutMs: 150 } });
      expectFailBlock(asRun(r), "update-unreachable");
      untouched();
    });

    it("when a redirect never ends, or leaves for a scheme that is not http(s)", async () => {
      /** When redirects are followed without a limit or a scheme check, a loop hangs update and a redirect to file: or ftp: reads from somewhere nobody chose — observed at the block for each. */
      publish("v0.0.2");
      w.fx.override = (req, server) => (server === "cdn" ? new Response(null, { status: 302, headers: { location: req.url } }) : undefined);
      const loop = await w.run(["update"]);
      expectFailBlock(asRun(loop), "update-api-error");
      w.fx.override = (_req, server) => (server === "cdn" ? new Response(null, { status: 302, headers: { location: "ftp://example.com/eris" } }) : undefined);
      const scheme = await w.run(["update"]);
      expectFailBlock(asRun(scheme), "update-api-error");
      untouched();
    });
  });

  describe("on what the release holds", () => {
    it("when it has no binary for this platform", async () => {
      /** When the asset is picked by position or prefix, a linux-x64 host installs the darwin binary — observed at the block, which names the asset it looked for and the release. */
      w.fx.publish({ tag: "v0.0.2", assets: { "eris-darwin-arm64": "mac" } });
      const r = await w.run(["update"]);
      expectFailBlock(asRun(r), "update-asset-missing");
      expect(r.stderr).toContain("eris-linux-x64");
      expect(r.stderr).toContain("v0.0.2");
      untouched();
    });

    it.each([
      ["no SHA256SUMS", null],
      ["a SHA256SUMS without this platform's line", `${sha256Hex("x")}  eris-darwin-arm64\n`],
      ["an empty SHA256SUMS", ""],
    ])("when it has %s, with nothing downloaded", async (_name, sums) => {
      /** When a release without a checksum is installed anyway, the integrity check fails open — observed at the block and at the requests, which must not include the binary. */
      publish("v0.0.2", { sums });
      const r = await w.run(["update"]);
      expectFailBlock(asRun(r), "update-asset-missing");
      expect(r.stderr).toContain("SHA256SUMS");
      expect(requests().filter((h) => h.server === "cdn").length).toBeLessThanOrEqual(1); // SHA256SUMS at most, never the binary
      untouched();
    });

    it("when the binary does not match its checksum, replacing nothing", async () => {
      /** When the checksum is compared to the wrong thing or not enforced, a corrupted or substituted binary replaces the user's — observed at the block, the untouched binary and the bin directory (the partial download removed). */
      publish("v0.0.2", { sums: `${sha256Hex("something else")}  eris-linux-x64\n` });
      const r = await w.run(["update"]);
      expectFailBlock(asRun(r), "update-checksum-mismatch");
      expect(r.stderr).toContain(sha256Hex("something else"));
      untouched();
    });
  });

  describe("after the replacement", () => {
    it.each([
      ["exits non-zero", "#!/bin/sh\necho 'exec format' >&2\nexit 3\n"],
      ["reports another version", fakeEris("v9.9.9")],
      ["prints something that is not a version record", "#!/bin/sh\necho hello\n"],
    ])("restores the previous binary when the new one %s", async (_name, binary) => {
      /** When a binary that cannot run is left in place, the user is locked out of eris with no way to run `eris update` again — observed at the block, the restored file and the bin directory (.old gone). */
      publish("v0.0.2", { binary });
      const r = await w.run(["update"]);
      expectFailBlock(asRun(r), "update-smoke-failed");
      expect(r.stderr).toContain("restored");
      untouched();
      expect(w.reports()).toBe("v0.0.1");
    });
  });
});

describe("the pure parts", () => {
  it.each([
    ["v0.0.1", "v0.0.2", -1],
    ["v0.0.2", "v0.0.10", -1],
    ["v1.0.0", "v0.9.9", 1],
    ["v0.2.0", "v0.2.0", 0],
    ["v0.3.0-rc.1", "v0.3.0", -1],
    ["v0.3.0-rc.2", "v0.3.0-rc.10", -1],
    ["v0.3.0-alpha", "v0.3.0-rc.1", -1],
    ["v0.3.0-1", "v0.3.0-alpha", -1],
    ["0.2.0", "v0.2.0", 0],
  ])("compareVersions(%s, %s) is %p", (a, b, expected) => {
    /** When versions compare as strings, v0.0.10 sorts below v0.0.2 and a prerelease sorts above its release, so `update` offers a downgrade or skips a release — observed at the ordering semver defines. */
    expect(Math.sign(compareVersions(a, b)!)).toBe(expected);
    expect(Math.sign(compareVersions(b, a)!)).toBe(-expected || 0);
  });

  it.each([["dev", "v0.0.1"], ["v0.0", "v0.0.1"], ["latest", "v1.0.0"]])("compareVersions(%s, %s) is unknown", (a, b) => {
    /** When an untagged build is ordered like a release, `--check` answers 'up to date' for a binary that has no version at all — observed as null, which callers treat as 'different'. */
    expect(compareVersions(a, b)).toBeNull();
  });

  it.each([
    [undefined, "https://api.github.com/"],
    ["", "https://api.github.com/"],
    ["https://ghe.example.com/api/v3/", "https://ghe.example.com/api/v3"],
    ["http://127.0.0.1:8080", "http://127.0.0.1:8080/"],
    ["http://localhost:8080", "http://localhost:8080/"],
    ["http://[::1]:8080", "http://[::1]:8080/"],
  ])("parseApiBase(%p) is %p", (raw, expected) => {
    /** When the default or an enterprise host is mis-parsed, update talks to the wrong API or drops its path prefix — observed at the base url. */
    expect(parseApiBase(raw)?.href).toBe(expected);
  });

  it.each(["http://api.example.com", "http://0.0.0.0:80", "ftp://x", "https://u:p@x.example.com", "https://x.example.com/?a=1", "nope"])("parseApiBase(%p) is refused", (raw) => {
    /** When a cleartext or credentialed base is accepted, the bearer travels in the open or in a url a log prints — observed as null. */
    expect(parseApiBase(raw)).toBeNull();
  });

  it("allowedRedirect keeps https on https, and allows http only for a loopback API", () => {
    /** When a redirect may downgrade, the download travels in the clear after an https API — observed at the decision for each pairing. */
    const github = new URL("https://api.github.com/");
    const loopback = new URL("http://127.0.0.1:9/");
    expect(allowedRedirect(github, new URL("https://release-assets.githubusercontent.com/x"))).toBe(true);
    expect(allowedRedirect(github, new URL("http://release-assets.githubusercontent.com/x"))).toBe(false);
    expect(allowedRedirect(github, new URL("ftp://example.com/x"))).toBe(false);
    expect(allowedRedirect(loopback, new URL("http://127.0.0.1:10/x"))).toBe(true);
    expect(allowedRedirect(loopback, new URL("file:///etc/passwd"))).toBe(false);
  });

  it("the default host is this process", () => {
    /** When the default host drifts from the build's identity, a released binary compares itself with the wrong version or repository — observed at the fields. */
    const h = defaultHost();
    expect(h).toMatchObject({ compiled: false, version: "dev", releaseRepo: "sibylline-labs/eris", platform: process.platform, arch: process.arch, execPath: process.execPath });
    expect(existsSync(h.execPath)).toBe(true);
  });
});
