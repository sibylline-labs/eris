/**
 * The Homebrew formula rendered for a release (scripts/render-formula.ts over
 * packaging/homebrew/eris.rb.tmpl), from a fixture SHA256SUMS in the format the
 * release workflow publishes. Seams: `renderFormula`, and the script run as a
 * process the way the tap job runs it.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSums, renderFormula } from "../scripts/render-formula";
import { REPO } from "./helpers/blackbox";

const TEMPLATE = readFileSync(join(REPO, "packaging/homebrew/eris.rb.tmpl"), "utf8");
const MAC = "a1".repeat(32);
const LINUX = "b2".repeat(32);
const SUMS = `${LINUX}  eris-linux-x64\n${MAC}  eris-darwin-arm64\n`;

const render = (over: Partial<Parameters<typeof renderFormula>[0]> = {}) => renderFormula({ template: TEMPLATE, tag: "v0.2.0", repo: "sibylline-labs/eris", sums: SUMS, ...over });

/** The body of `on_<os> do … end` in the rendered formula. */
const block = (formula: string, os: "macos" | "linux") => new RegExp(`on_${os} do\\n([\\s\\S]*?)\\n  end\\n`).exec(formula)![1]!;

describe("the rendered formula", () => {
  it("pairs each platform's download url with that platform's own checksum", () => {
    /** When the checksums are swapped or taken in file order, every `brew install` fails its sha256 check on one platform — observed at the url and sha256 inside each platform's block, with different checksums in SHA256SUMS (listed in the opposite order to the blocks). */
    const f = render();
    expect(block(f, "macos")).toContain('url "https://github.com/sibylline-labs/eris/releases/download/v0.2.0/eris-darwin-arm64"');
    expect(block(f, "macos")).toContain(`sha256 "${MAC}"`);
    expect(block(f, "macos")).not.toContain(LINUX);
    expect(block(f, "linux")).toContain('url "https://github.com/sibylline-labs/eris/releases/download/v0.2.0/eris-linux-x64"');
    expect(block(f, "linux")).toContain(`sha256 "${LINUX}"`);
    expect(block(f, "linux")).not.toContain(MAC);
  });

  it("names the version without the v, the repository, and leaves no marker behind", () => {
    /** When the version keeps its v, `brew` reports v-prefixed versions and the formula's own test (`eris v#{version}`) never matches `eris --version`; when a marker survives, the tap carries a formula that cannot install — observed at the rendered text. */
    const f = render({ tag: "v0.3.0-rc.1", repo: "example-org/eris-fork" });
    expect(f).toContain('version "0.3.0-rc.1"');
    expect(f).toContain('homepage "https://github.com/example-org/eris-fork"');
    expect(f).toContain("/example-org/eris-fork/releases/download/v0.3.0-rc.1/eris-darwin-arm64");
    expect(f).not.toMatch(/@[A-Z0-9_]+@/);
    // The formula's own test is the same line `eris --version` prints.
    expect(f).toContain('assert_match "eris v#{version}", shell_output("#{bin}/eris --version")');
  });

  it("accepts a binary-mode marker and uppercase hex in SHA256SUMS", () => {
    /** When the parser only takes `<hex>  <name>`, a SHA256SUMS written with `sha256sum -b` stops the tap from updating — observed at the checksum read from each form. */
    const sums = parseSums(`${MAC.toUpperCase()} *eris-darwin-arm64\n${LINUX}  eris-linux-x64\r\n`);
    expect([...sums]).toEqual([["eris-darwin-arm64", MAC], ["eris-linux-x64", LINUX]]);
  });

  it.each([
    ["a tag without the v", { tag: "0.2.0" }, /--tag must look like/],
    ["a tag with a path in it", { tag: "v0.2.0/../x" }, /--tag must look like/],
    ["a repository that is not owner/name", { repo: "eris" }, /--repo must be owner\/name/],
    ["a SHA256SUMS without the linux binary", { sums: `${MAC}  eris-darwin-arm64\n` }, /no checksum for eris-linux-x64/],
    ["an empty SHA256SUMS", { sums: "" }, /no checksum for eris-darwin-arm64, eris-linux-x64/],
    ["conflicting lines for one binary", { sums: `${SUMS}${"c3".repeat(32)}  eris-linux-x64\n` }, /lists eris-linux-x64 twice/],
    ["a template with a marker nothing fills", { template: `${TEMPLATE}\n# @NOT_A_MARKER@\n` }, /markers this script does not fill: @NOT_A_MARKER@/],
  ])("refuses %s", (_name, over, message) => {
    /** When a bad tag, a missing checksum or a stray marker is rendered anyway, the tap is committed a formula that fails on every user's machine — observed as the thrown message, with nothing rendered. */
    expect(() => render(over)).toThrow(message);
  });
});

describe("scripts/render-formula.ts as the tap job runs it", () => {
  const scratch = () => {
    mkdirSync(join(REPO, ".scratch"), { recursive: true });
    return realpathSync(mkdtempSync(join(REPO, ".scratch", "formula-")));
  };
  const run = (args: string[]) => spawnSync("bun", ["scripts/render-formula.ts", ...args], { cwd: REPO, encoding: "utf8" });

  it("writes the formula to --out, and to stdout without it", () => {
    /** When the script ignores --out or the default template path, the tap job commits an empty or stale file — observed at the written file and at stdout. */
    const dir = scratch();
    try {
      const sums = join(dir, "SHA256SUMS");
      const out = join(dir, "eris.rb");
      writeFileSync(sums, SUMS);
      const written = run(["--tag", "v0.2.0", "--sums", sums, "--out", out]);
      expect({ status: written.status, stdout: written.stdout, stderr: written.stderr }).toEqual({ status: 0, stdout: "", stderr: "" });
      expect(readFileSync(out, "utf8")).toBe(render());
      const piped = run(["--tag", "v0.2.0", "--sums", sums]);
      expect({ status: piped.status, stdout: piped.stdout }).toEqual({ status: 0, stdout: render() });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 with an ERROR line, writing nothing, on a bad tag or a missing flag or file", () => {
    /** When a refusal exits 0 or writes a partial file, the tap job goes on to commit it — observed at the exit, stderr and the output path. */
    const dir = scratch();
    try {
      const sums = join(dir, "SHA256SUMS");
      const out = join(dir, "eris.rb");
      writeFileSync(sums, SUMS);
      for (const args of [["--tag", "latest", "--sums", sums, "--out", out], ["--sums", sums], ["--tag", "v0.2.0", "--sums", join(dir, "absent")], ["--tag", "v0.2.0", "--sums", sums, "--bogus"]]) {
        const r = run(args);
        expect({ args, status: r.status, stdout: r.stdout }).toEqual({ args, status: 1, stdout: "" });
        expect(r.stderr).toStartWith("ERROR ");
      }
      expect(() => readFileSync(out)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
