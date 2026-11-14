/**
 * scripts/scrub-check.ts — the gate that keeps private references out of this
 * public tree. Seam: `scan(path, text, opts)`, the per-file verdict the CLI and
 * CI print and exit on.
 *
 * Every private-looking input below is assembled at runtime, so this file holds
 * no literal the gate itself would flag.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { denylistRule, prMetadata, scan } from "../scripts/scrub-check";

const SCRIPT = resolve(import.meta.dir, "..", "scripts", "scrub-check.ts");

/** The runner's own event variables would turn a plain CLI run into a pull-request run; each spawn pins them. */
const PINNED = { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: "" };

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
    ["another host on the contact domain outside the contact files", "src/a.ts", `https://dash.${ORG}.group`, "private-org"],
    ["a host that only ends in the public endpoint's name", "src/a.ts", `https://evilapi.${ORG}.group`, "private-org"],
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
    ["the hosted install steps and support address in the eris-yaks skill", "skills/eris-yaks/SKILL.md", `https://yak.${ORG}.group/install.md · support@${ORG}.group`],
    ["the public Yaks endpoint, eris's default URL, in source", "plugins/yak/yak-identity.ts", `"https://api.${ORG}.group"`],
    ["the copyright holder in NOTICE", "NOTICE", `Copyright 2026 ${"Sibyl" + "line"} Labs`],
    ["an example-domain email and a git remote", "tests/a.ts", "ada@example.com git@github.com:acme/widgets.git"],
    ["a package-manager pin", "package.json", '"packageManager": "bun@1.4.4"'],
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
      const r = Bun.spawnSync(["bun", SCRIPT], { cwd: repo, env: { ...process.env, ...PINNED } });
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

/** Each run spawns bun, and on a contended host three of them in one test pass bun's 5s default. */
setDefaultTimeout(60_000);

/** One clean repo for every run: the scan only reads it, so a call writes only its own event.json and deny.txt. */
let fixture: { dir: string; repo: string; head: string };
beforeAll(() => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "scrub-pr-")));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "a clean file\n");
  const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo });
  git("init", "-q");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  fixture = { dir, repo, head: git("rev-parse", "HEAD").stdout.toString().trim() };
});
afterAll(() => rmSync(fixture.dir, { recursive: true, force: true }));

const run = (payload: unknown, opts: { args?: string[]; env?: Record<string, string>; raw?: string; noFile?: boolean; commitSha?: boolean; denylist?: string } = {}) => {
  const { dir, repo, head } = fixture;
  const file = join(dir, "event.json");
  writeFileSync(file, opts.raw ?? JSON.stringify(typeof payload === "function" ? (payload as (sha: string) => unknown)(head) : payload));
  const deny = join(dir, "deny.txt");
  writeFileSync(deny, opts.denylist ?? "");
  const args = opts.args ?? (opts.noFile ? [] : ["--pr-event", file]);
  const r = Bun.spawnSync(["bun", SCRIPT, ...args.map((a) => a.replace("$FILE", file).replace("$DENY", deny))], { cwd: repo, env: Object.fromEntries(Object.entries({ ...process.env, ...PINNED, ...opts.env }).filter(([, v]) => v !== "__unset__")) as Record<string, string> });
  return { rc: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), file };
};

describe("the pull request scan", () => {
  const event = (over: { ref?: string; title?: string; body?: string | null }) => ({
    pull_request: { number: 7, title: "fix(x): a clean title", body: "A clean body.", head: { ref: "fix/a-clean-slug", repo: { full_name: "sibyl" + "line-labs/eris" } }, ...over, ...(over.ref ? { head: { ref: over.ref, repo: { full_name: "sibyl" + "line-labs/eris" } } } : {}) },
  });
  it("fails a pull request whose branch slug, title or body carries a private reference", () => {
    /** When the pull request's own text is not scanned, a tracker key in the branch slug lands in main's merge subject and the history gate goes red after merge — observed at the CLI's exit and output. */
    const key = "QR" + "X-1100";
    const out = [
      run(event({ ref: `dan/${key.toLowerCase()}-fix` })),
      run(event({ title: `fix(x): a thing (${key})` })),
      run(event({ body: `Fixes ${key}\nsee https://linear` + `.app/${ORG}/issue/${key}` })),
    ];
    expect(out.map((o) => o.rc)).toEqual([1, 1, 1]);
    expect(out[0]!.stdout).toContain("pull request merge subject");
    expect(out[1]!.stdout).toContain("pull request title");
    expect(out[2]!.stdout).toContain("pull request body");
  });

  it("passes a clean pull request, and refuses a payload with no pull request", () => {
    /** When a clean pull request fails the gate, or a payload it cannot read passes it, CI blocks good merges or waves leaks through — observed at the CLI's exit. */
    expect([run(event({})).rc, run(event({ body: null })).rc, run({ push: {} }).rc]).toEqual([0, 0, 2]);
  });
});

describe("the pull request scan, fail-closed and false-positive guards", () => {
  const base = { number: 7, title: "fix(x): clean", body: "clean", head: { ref: "fix/a-clean-slug", repo: { full_name: "sibyl" + "line-labs/eris" } } };
  const withHead = (head: unknown) => ({ pull_request: { ...base, head } });

  it("does not flag a commit SHA the repository itself holds in the title or body", () => {
    /** When the pull request scan runs without the known SHAs, a PR that cites this repo's own commit fails with a false [private-sha] and blocks a clean merge — observed at the CLI's exit. */
    const rc = run((sha: string) => ({ pull_request: { ...base, title: `revert ${sha}`, body: `see ${sha}` } })).rc;
    expect(rc).toBe(0);
  });

  it("flags a SHA the repository does not hold", () => {
    /** When known SHAs are passed too liberally, a foreign SHA in a PR body lands in public history — observed at the CLI's exit. */
    const r = run({ pull_request: { ...base, body: `see ${FOREIGN_SHA}` } });
    expect([r.rc, r.stdout]).toEqual([1, expect.stringContaining("pull request body")]);
  });

  it("exits 2 on a pull_request run whose GITHUB_EVENT_PATH is unset or empty", () => {
    /** When the env default fails open, the CI mechanism (no --pr-event flag) waves every pull request through unscanned — observed at the CLI's exit. */
    const r = (path: string) => run({}, { noFile: true, env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: path } }).rc;
    expect([r(""), r("__unset__"), r("/nonexistent/event.json")]).toEqual([2, 2, 2]);
  });

  it("reads the payload from GITHUB_EVENT_PATH on a pull_request run", () => {
    /** When the env default is not read, the one mechanism ci.yml uses scans nothing — observed at the CLI's output. */
    const dirty = { pull_request: { ...base, title: "fix(x): " + "QR" + "X-1100" } };
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "scrub-env-")));
    try {
      const f = join(dir, "e.json");
      writeFileSync(f, JSON.stringify(dirty));
      const r = run(dirty, { noFile: true, env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: f } });
      expect([r.rc, r.stdout]).toEqual([1, expect.stringContaining("pull request title")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 2, not a stack trace, on a malformed or unreadable payload", () => {
    /** When a bad payload throws, CI sees exit 1 and a stack trace instead of "cannot scan what was asked" — observed at the CLI's exit. */
    const bad = run({}, { raw: "{bad json" });
    const dir = run({}, { args: ["--pr-event", "."] });
    const typed = run({ pull_request: { head: { ref: "fix/x", repo: { full_name: "o/r" } }, title: 123 } });
    expect([bad.rc, bad.stderr.includes("at "), typed.rc, typed.stderr.includes("at ")]).toEqual([2, false, 2, false]);
    expect(dir.rc).toBe(2);
  });

  it("takes the owner from head.user.login when the head repo is deleted", () => {
    /** When a null head repo yields an empty owner, a private org login in the merge subject escapes the scan — observed at the CLI's exit. */
    const r = run(withHead({ ref: "fix/clean", repo: null, user: { login: ORG + "-advisory" } }));
    expect([r.rc, r.stdout]).toEqual([1, expect.stringContaining("pull request merge subject")]);
  });

  it.each(["dan/qrx-1100/cleanup", "dan/qrx-1100_fix", "dan/qrx-1100"])("flags a tracker key leading a segment of the head ref: %s", (ref) => {
    /** When the lookahead stops at `-`, a key followed by `/` or `_` slips into the merge subject — observed at the CLI's exit. */
    expect(run(withHead({ ref, repo: { full_name: "o/r" } })).rc).toBe(1);
  });

  it.each(["fix/utf-8-bom", "fix/rfc-6761", "fix/sha-256_sum"])("allows a standard prefix in the head ref: %s", (ref) => {
    /** When the branch rule ignores the standard-prefix allowlist, ordinary slugs fail the gate — observed at the CLI's exit. */
    expect(run(withHead({ ref, repo: { full_name: "o/r" } })).rc).toBe(0);
  });

  it("applies --denylist to the pull request's own text", () => {
    /** When the denylist is not passed to the pull request scan, a maintainer's private term in a title ships green — observed at the CLI's exit. */
    const r = run({ pull_request: { ...base, title: "mention zorkword here" } }, { args: ["--pr-event", "$FILE", "--denylist", "$DENY"], denylist: "zorkword\n" });
    expect([r.rc, r.stdout]).toEqual([1, expect.stringContaining("pull request title")]);
  });
});

describe("prMetadata", () => {
  it("builds the merge subject GitHub defaults to from the head owner and ref", () => {
    /** When the subject drops the head ref, the branch slug escapes the scan that exists to read it — observed at prMetadata(). */
    const parts = prMetadata({ pull_request: { number: 7, title: "t", body: "b", head: { ref: "fix/x", repo: { full_name: "o/r" } } } });
    expect([parts?.[0]?.where, parts?.[0]?.text]).toEqual(["pull request merge subject", "Merge pull request #7 from o/fix/x"]);
  });

  it("takes the owner from the head label when the head repo and user are both gone", () => {
    /** When the label fallback is ignored, a deleted fork's owner is dropped and the merge subject reads "from /ref" — observed at prMetadata(). */
    const parts = prMetadata({ pull_request: { number: 7, head: { ref: "fix/x", repo: null, user: null, label: "o:fix/x" } } });
    expect(parts?.[0]?.text).toBe("Merge pull request #7 from o/fix/x");
  });

  it.each([
    ["an empty head ref", { head: { ref: "", repo: { full_name: "o/r" } } }],
    ["a whitespace head ref", { head: { ref: "  ", repo: { full_name: "o/r" } } }],
    ["a non-string head ref", { head: { ref: 5, repo: { full_name: "o/r" } } }],
    ["an array head ref", { head: { ref: ["fix/x"], repo: { full_name: "o/r" } } }],
    ["no owner anywhere", { head: { ref: "fix/x", repo: null, user: null } }],
    ["a non-string full_name", { head: { ref: "fix/x", repo: { full_name: 5 }, user: { login: "o" } } }],
    ["an array full_name", { head: { ref: "fix/x", repo: { full_name: ["o/r"] } } }],
    ["a full_name with no slash", { head: { ref: "fix/x", repo: { full_name: "or" }, user: { login: "o" } } }],
    ["a whitespace full_name owner", { head: { ref: "fix/x", repo: { full_name: " /r" } } }],
    ["a non-string login", { head: { ref: "fix/x", repo: null, user: { login: 5 } } }],
    ["a whitespace login", { head: { ref: "fix/x", repo: null, user: { login: " " } } }],
    ["a non-string label", { head: { ref: "fix/x", repo: null, user: null, label: 5 } }],
    ["a colon-less label", { head: { ref: "fix/x", repo: null, user: null, label: "o" } }],
    ["a whitespace label owner", { head: { ref: "fix/x", repo: null, user: null, label: " :fix/x" } }],
    ["an array repo", { head: { ref: "fix/x", repo: [], user: { login: "o" } } }],
    ["a non-string title", { head: { ref: "fix/x", repo: { full_name: "o/r" } }, title: 123 }],
    ["a non-string body", { head: { ref: "fix/x", repo: { full_name: "o/r" } }, body: {} }],
  ])("refuses a payload with %s", (_name, pull_request) => {
    /** When a corrupted payload is scanned anyway, it throws (rc 1, a stack trace) or passes clean (rc 0) instead of exiting 2 — observed at prMetadata(). */
    expect(prMetadata({ pull_request: { number: 7, ...pull_request } })).toBeUndefined();
  });
});
