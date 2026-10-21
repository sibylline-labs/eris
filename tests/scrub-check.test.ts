/**
 * scripts/scrub-check.ts — the gate that keeps private references out of this
 * public tree. Seam: `scan(path, text, opts)`, the per-file verdict the CLI and
 * CI print and exit on.
 *
 * Every private-looking input below is assembled at runtime, so this file holds
 * no literal the gate itself would flag.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { denylistRule, scan } from "../scripts/scrub-check";

const SCRIPT = resolve(import.meta.dir, "..", "scripts", "scrub-check.ts");

const rules = (path: string, text: string) => scan(path, text).map((h) => h.rule);
const ORG = "sibyl" + "line";
/** A full commit SHA this repo does not hold, and one it does (an action pin, say). */
const FOREIGN_SHA = ("1a2b" + "3c4d").repeat(5);
const KNOWN_SHA = ("9e8f" + "7a6b").repeat(5);

describe("scan", () => {
  it.each([
    ["the private org", "docs/a.md", `github.com/${ORG}-advisory/eris`, "private-org"],
    ["the private org in a commit message", "", `Merge pull request #9 from ${ORG}-advisory/eris`, "private-org"],
    ["the bare org name outside the contact and licence files", "docs/a.md", `built by ${ORG}`, "private-org"],
    ["the public org run into a slug outside a commit message", "docs/a.md", `branch x-${ORG}-labsyak-contract`, "private-org"],
    ["the contact domain outside the contact files", "docs/a.md", `mail security@${ORG}.group`, "private-org"],
    ["a personal email", "README.md", `ask ${"dan" + "@"}corp.io`, "email"],
    ["a tracker label", "src/a.ts", `// fixed in ${"QR" + "X"}-1100`, "tracker-label"],
    ["a decision-register label", "src/a.ts", `// per ${"D" + "42"}`, "register-label"],
    ["a lettered finding label", "src/a.ts", `// (fixed, ${"F" + "7q"})`, "register-label"],
    ["a review-claim label", "src/a.ts", `// (${"Claim" + " 64"}, deliberate)`, "register-label"],
    ["a private plan section", "src/a.ts", `// see ${"plan " + "§5"}`, "private-plan"],
    ["a lettered document section", "src/a.ts", `// the server re-derives (${"§0" + "b.1"})`, "private-section"],
    ["a named document section", "src/a.ts", `// the ${"CLAUDE.md § " + "Gotchas"} lesson`, "private-section"],
    ["a bare commit SHA as provenance", "rules/a.yml", `# fixed in ${"c0ff" + "ee1"}`, "private-sha"],
    ["a full commit SHA this repo cannot resolve", "tests/a.md", `recorded at \`${FOREIGN_SHA}\``, "private-sha"],
    ["a bucket path", "docs/a.md", `${"gs" + "://"}bucket/x`, "bucket-path"],
    ["an internal host", "docs/a.md", `https://api.${"workers" + ".dev"}`, "internal-host"],
    ["a GitHub token literal", "tests/a.ts", `"${"ghp" + "_" + "a".repeat(36)}"`, "token-shaped"],
    ["a Google API key literal", "tests/a.ts", `"${"AI" + "za" + "B".repeat(35)}"`, "token-shaped"],
    ["an sk- secret key literal", "tests/a.ts", `"${"sk" + "-ant-" + "a".repeat(30)}"`, "token-shaped"],
    ["a JWT segment literal", "tests/a.ts", `"${"ey" + "JhbGciOiJIUzI1NiJ9"}."`, "token-shaped"],
    ["an AWS secret assignment", "tests/a.ts", `${"aws_secret" + "_access_key"}=${"A".repeat(40)}`, "token-shaped"],
  ])("flags %s", (_name, path, text, rule) => {
    /** When the gate stops recognising a private reference, CI goes green on a tree that leaks it — observed at scan(). */
    expect(rules(path, text)).toContain(rule);
  });

  it.each([
    ["the public org", "docs/a.md", `https://github.com/${ORG}-labs/eris/blob/main/docs/ERRORS.md`],
    ["the public package scope", "package.json", `"@${ORG}-labs/yak-contract"`],
    ["a merge message whose branch slug runs the public org into a word", "", `Merge pull request #4 from ${ORG}-labs/dan/x-export-${ORG}-labsyak-contract`],
    ["the security address in SECURITY.md", "SECURITY.md", `Email security@${ORG}.group.`],
    ["the support address in CONTRIBUTING.md", "CONTRIBUTING.md", `Write to support@${ORG}.group.`],
    ["the copyright holder in NOTICE", "NOTICE", `Copyright 2026 ${"Sibyl" + "line"} Labs`],
    ["an example-domain email and a git remote", "tests/a.ts", "ada@example.com git@github.com:acme/widgets.git"],
    ["a package-manager pin", "package.json", '"packageManager": "bun@1.3.13"'],
    ["output-contract sections and a cut field", "src/a.ts", "// docs/OUTPUT-CONTRACT.md §4 and §3.1; cut -d' ' -f1"],
    ["a sha256 digest", "tests/a.ts", "a".repeat(32) + "0".repeat(32)],
    ["hyphenated standard names and the placeholder tracker label", "docs/a.md", "UTF-8, SHA-256, RFC-6761 and ABC-123"],
  ])("passes %s", (_name, path, text) => {
    /** When the gate flags public text, CI goes red on a clean tree and the allowlist gets widened blindly — observed at scan(). */
    expect(scan(path, text)).toEqual([]);
  });

  it("passes a full SHA this repo resolves (its own commit, or a workflow's action pin)", () => {
    /** When a known SHA is flagged, every pinned `uses:` line turns CI red — observed at scan() with the known set. */
    const line = `      - uses: actions/checkout@${KNOWN_SHA} # v4.4.0`;
    expect(scan(".github/workflows/ci.yml", line, { known: new Set([KNOWN_SHA]) })).toEqual([]);
    expect(scan(".github/workflows/ci.yml", line).map((h) => h.rule)).toEqual(["private-sha"]);
  });
});

describe("the tree scan", () => {
  it("skips untracked symlinks, to a directory or to a file outside the tree", () => {
    /** When the tree scan reads through a symlink, a checkout holding a directory link crashes the gate (EISDIR) and a file link drags outside content into the verdict — observed at the CLI's exit and output. */
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "scrub-tree-")));
    try {
      const repo = join(dir, "repo");
      const outside = join(dir, "outside");
      mkdirSync(join(repo, "sub"), { recursive: true });
      mkdirSync(outside);
      writeFileSync(join(repo, "README.md"), "a clean file\n");
      writeFileSync(join(outside, "leak.txt"), `${"gs" + "://"}bucket/x\n`);
      const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo });
      git("init", "-q");
      git("add", "README.md");
      git("commit", "-q", "-m", "init");
      symlinkSync(join(repo, "sub"), join(repo, "dir-link"));
      symlinkSync(join(outside, "leak.txt"), join(repo, "file-link"));
      const r = Bun.spawnSync(["bun", SCRIPT], { cwd: repo });
      expect({ rc: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }).toEqual({ rc: 0, stdout: "", stderr: "scrub-check: clean\n" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("denylistRule", () => {
  const deny = denylistRule(["# a comment", "", "acme", "  zork  "])!;
  const denied = (text: string) => scan("src/a.ts", text, { extra: [deny], extraOnly: true }).length;

  it("flags a term as a whole word in any case, inside identifiers split by `_` or `-`", () => {
    /** When a maintainer's private term slips past their denylist, the leak ships green — observed at scan() with the rule. */
    expect([denied("calls the Acme worker"), denied("ACME_TOKEN=x"), denied("zork-api"), denied(`see ${"ZORK" + "-12"}`)]).toEqual([1, 1, 1, 1]);
  });

  it("does not flag a term inside a longer word, and ignores comment and blank lines", () => {
    /** When a short term matches inside ordinary words, the denylist run is too noisy to keep clean — observed at scan() with the rule. */
    expect([denied("acmeish zorkle"), denied("a comment")]).toEqual([0, 0]);
    expect(denylistRule(["# only comments", ""])).toBeUndefined();
  });
});
