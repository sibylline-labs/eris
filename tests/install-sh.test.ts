import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modeOf, REPO, type Sandbox, sandbox } from "./helpers/blackbox";

/**
 * install.sh: by default it downloads the release binary for this
 * OS/arch from the public GitHub releases with `curl`, checks it against the
 * release's SHA256SUMS and installs it; `--checkout` keeps the dev wrapper
 * around the live checkout.
 *
 * `curl` is the network boundary and is a PATH fake that serves a staged
 * release by the URL's last path segment, failing like `curl -f` on a missing
 * asset; everything else is the real script, the real `sh`, and the
 * host's own hash tool. The platform is pinned by a PATH `uname`, so these rows
 * run on a Linux or a macOS host alike: the Linux CI legs exercise the
 * `sha256sum` branch and the macOS release leg the `shasum` one.
 */
const INSTALL = join(REPO, "install.sh");
const SYSTEMS = {
  darwin: { s: "Darwin", m: "arm64", target: "darwin-arm64", other: "linux-x64" },
  linux: { s: "Linux", m: "x86_64", target: "linux-x64", other: "darwin-arm64" },
};
const HOST = process.platform === "darwin" ? SYSTEMS.darwin : SYSTEMS.linux;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const binary = (target: string) => `#!/bin/sh\necho "fake eris ${target}"\n`;

let sb: Sandbox;
let binDir: string;
const installed = () => join(binDir, "eris");
const leftovers = () => (existsSync(binDir) ? readdirSync(binDir).filter((e) => e !== "eris") : []);
/** The URL of every `curl` call, in order. */
const urls = () => sb.argv("curl").trim().split("\n").filter(Boolean).map((l) => l.split(" ").at(-1)!);
const RELEASES = "https://github.com/sibylline-labs/eris/releases";

function pinSystem(s: string, m: string): void {
  sb.fake("uname", `case "$1" in -s) echo ${s} ;; -m) echo ${m} ;; *) echo ${s} ;; esac`);
}

/** A release's assets: both binaries, and `SHA256SUMS` in sha256sum's text format. */
function stage(sums: (hash: (target: string) => string) => string[] = (h) => [`${h(HOST.target)}  eris-${HOST.target}`, `${h(HOST.other)}  eris-${HOST.other}`]): void {
  const dir = join(sb.dir, "release");
  mkdirSync(dir);
  for (const t of [HOST.target, HOST.other]) writeFileSync(join(dir, `eris-${t}`), binary(t));
  writeFileSync(join(dir, "SHA256SUMS"), `${sums((t) => sha256(binary(t))).join("\n")}\n`);
  sb.env.FAKE_RELEASE = dir;
}

beforeEach(() => {
  sb = sandbox("eris-install-");
  binDir = join(sb.home, ".local", "bin");
  pinSystem(HOST.s, HOST.m);
  // curl -fsSL -o <file> <url>
  sb.fake(
    "curl",
    `out=; while [ $# -gt 1 ]; do case $1 in -o) out=$2; shift ;; esac; shift; done
[ -f "$FAKE_RELEASE/\${1##*/}" ] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }
cp "$FAKE_RELEASE/\${1##*/}" "$out"`,
  );
  // An Intel Mac has no such oid. Pinned, because an Apple Silicon host answers 1 and would turn the refusal rows below into installs.
  sb.fake("sysctl", 'echo "sysctl: unknown oid \'hw.optional.arm64\'" >&2; exit 1');
});
afterEach(() => sb.cleanup());

const install = (args: string[] = [], env: Record<string, string | undefined> = {}) => sb.run(args, { program: INSTALL, env });

describe("install.sh downloads the release binary", () => {
  it.each([
    ["the latest release", undefined],
    ["a pinned ERIS_VERSION", "v0.1.0-rc.1"],
  ])("installs the verified binary for this platform from %s", async (_name, version) => {
    /** When the wrong asset, repo or tag is requested, or the binary lands unverified, non-executable or beside a stray temp dir, the user installs the wrong eris or none — observed at the bin dir and the `curl` URLs. */
    stage();
    const r = await install([], { ERIS_VERSION: version });
    expect(r.status, r.stderr).toBe(0);

    expect(readFileSync(installed(), "utf8")).toBe(binary(HOST.target));
    expect(modeOf(installed())).toBe("755");
    expect(leftovers()).toEqual([]);

    // Unpinned, GitHub's latest-release redirect, which skips pre-releases; pinned, that tag's assets.
    const base = version === undefined ? `${RELEASES}/latest/download` : `${RELEASES}/download/${version}`;
    expect(urls().sort()).toEqual([`${base}/SHA256SUMS`, `${base}/eris-${HOST.target}`].sort());
  });

  it.each([
    ["a different hash for this platform", (h: (t: string) => string) => [`${sha256("tampered")}  eris-${HOST.target}`, `${h(HOST.other)}  eris-${HOST.other}`]],
    ["no line for this platform", (h: (t: string) => string) => [`${h(HOST.other)}  eris-${HOST.other}`]],
    ["an empty SHA256SUMS", () => []],
  ])("installs nothing when SHA256SUMS has %s", async (_name, sums) => {
    /** When the checksum check fails open, a binary that does not match its release's SHA256SUMS is installed and run — observed at the bin dir. Paired with the row above, which stages the same release honestly. */
    stage(sums);
    const r = await install();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/checksum/i);
    expect(existsSync(installed())).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("installs nothing, and without ERIS_VERSION says no stable release was found", async () => {
    /** When a failed latest-release download gives no reason, a first-time installer on a repo whose only release is a pre-release never learns that ERIS_VERSION or --checkout is the way in — observed at the exit, stderr and the bin dir. */
    sb.fake("curl", 'echo "curl: (22) The requested URL returned error: 404" >&2; exit 22');
    const r = await install();
    expect(r.status).toBe(1);
    for (const want of ["no stable release found", "pre-releases are skipped", "ERIS_VERSION=<tag>", "--checkout", RELEASES]) expect(r.stderr).toContain(want);
    expect(existsSync(installed())).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("installs nothing, and with ERIS_VERSION names the release it could not get", async () => {
    /** When a pinned release fails with the message for the latest one, the user is told no stable release exists although they asked for a named tag — observed at the exit and stderr. Paired with the row above. */
    sb.fake("curl", 'echo "curl: (22) The requested URL returned error: 404" >&2; exit 22');
    const r = await install([], { ERIS_VERSION: "v9.9.9" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("(v9.9.9)");
    expect(r.stderr).toContain(RELEASES);
    expect(r.stderr).not.toContain("no stable release");
    expect(existsSync(installed())).toBe(false);
  });

  it.each([
    ["Linux", "aarch64"],
    ["Darwin", "x86_64"],
    ["FreeBSD", "amd64"],
  ])("refuses %s %s, naming the supported targets and --checkout, before it downloads", async (s, m) => {
    /** When an unsupported machine falls through to a download, it fetches an asset that does not exist, or installs a binary that cannot run — observed at the exit, the message and the `curl` call count. */
    stage();
    pinSystem(s, m);
    const r = await install();
    expect(r.status).toBe(1);
    for (const want of ["darwin-arm64", "linux-x64", "--checkout"]) expect(r.stderr).toContain(want);
    expect(sb.calls("curl")).toBe(0);
    expect(existsSync(installed())).toBe(false);
  });

  it("installs the arm64 binary on an x86_64 shell under Rosetta", async () => {
    /** When uname's x86_64 alone picks the asset, an Apple Silicon Mac whose shell runs under Rosetta is refused a binary it can run — observed at the `curl` asset URL and the installed file. */
    stage();
    pinSystem("Darwin", "x86_64");
    sb.fake("sysctl", "echo 1");
    const r = await install();
    expect(r.status, r.stderr).toBe(0);
    expect(urls()).toContain(`${RELEASES}/latest/download/eris-darwin-arm64`);
    expect(readFileSync(installed(), "utf8")).toBe(binary("darwin-arm64"));
  });

  it.each([
    ["a --checkout wrapper", '#!/bin/sh\nexec "/home/dev/eris/eris" "$@"\n', true],
    ["a previous release binary that happens to contain exec \"", `\x7fELF${"\0".repeat(4096)}\nexec "x"\n`, false],
    ["nothing", undefined, false],
  ])("says it replaces the wrapper only when the file there is %s", async (_name, existing, notice) => {
    /** When the notice is missing, a dev whose \`eris\` ran their live checkout finds it silently swapped for a release binary; when it fires on a previous release binary, every upgrade prints a false claim — observed at stderr, with the file replaced either way. */
    stage();
    if (existing !== undefined) {
      mkdirSync(binDir, { recursive: true });
      writeFileSync(installed(), existing);
    }
    const r = await install();
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(installed(), "utf8")).toBe(binary(HOST.target));
    const lines = r.stderr.split("\n").filter((l) => l.includes("--checkout wrapper"));
    expect(lines.length).toBe(notice ? 1 : 0);
    if (notice) expect(lines[0]).toContain(installed());
  });

  it("an unknown argument is a usage error that downloads and installs nothing", async () => {
    /** When a mistyped `--chekout` is ignored, the default path downloads a binary over a dev's checkout wrapper — observed at the exit, the usage line and the `curl` call count. */
    stage();
    const r = await install(["--chekout"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: ./install.sh [--checkout]");
    expect(sb.calls("curl")).toBe(0);
    expect(existsSync(installed())).toBe(false);
  });
});

describe("install.sh --checkout", () => {
  it("installs the checkout's dependencies and a wrapper that runs the checkout's own eris", async () => {
    /** When `bun install` runs in the caller's cwd, or the wrapper does not exec this checkout, `eris` runs stale or foreign code — observed at the fake bun's argv and cwd, and by running the wrapper. */
    const cwdFile = join(sb.dir, "bun-cwd");
    sb.fake("bun", `pwd -P > ${JSON.stringify(cwdFile)}`);
    const r = await install(["--checkout"]);
    expect(r.status, r.stderr).toBe(0);
    expect(sb.argv("bun").trim()).toBe("install --frozen-lockfile");
    expect(readFileSync(cwdFile, "utf8").trim()).toBe(REPO);
    expect(sb.calls("curl")).toBe(0);

    // The real bun, not the fake: the wrapper execs the checkout's shim.
    const w = await sb.run(["--help"], { program: installed(), env: { PATH: process.env.PATH } });
    expect(w.status, w.stderr).toBe(0);
    expect(w.stdout).toContain("Usage: eris <command>");
  });
});
