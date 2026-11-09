/**
 * `eris socrates submit --fragment <path>#L<x>-L<y>` and `eris socrates evidence <id>`.
 *
 * Drives the group handler in-process against a real `git` repo made in a sandbox, with a fake
 * endpoint on the `SocratesDeps.fetch` seam that records every request, so a test observes what
 * left the machine, in what order, and what the provenance names.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { repoOfRemote } from "../plugins/socrates/fragment";
import { runSocrates } from "../plugins/socrates/submit";
import { CliExit } from "../src/cli/ts-verb";
import { type Sandbox, sandbox } from "./helpers/blackbox";
import { answers, CANDIDATE, ENDPOINT, GHP, H1, ORG_V2, policyResult, TOKEN } from "./helpers/socrates-fake";

const REPO = resolve(import.meta.dir, "..");
const HYPOTHESIS = "I think this is a retry-budget invariant the rubric has no question for.";
const RETRY = ["export function retry() {", "  for (let i = 0; i < 3; i++) {", "    attempt(i);", "  }", "}", ""].join("\n");

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let sb: Sandbox;
let repo: string;
let calls: Call[];
let answer: { submit: () => Response; evidence: (body: { content: string }) => Response; fragment: (id: string) => Response };
let sha: string;
let nextFragment: number;

function git(...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd: repo, env: sb.env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function commitFile(name: string, text: string | Uint8Array): void {
  const path = join(repo, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  git("add", "--", name);
  git("commit", "-q", "-m", `add ${name}`);
  sha = git("rev-parse", "HEAD");
}

beforeEach(() => {
  sb = sandbox("eris-socrates-evidence-");
  repo = join(sb.dir, "repo");
  mkdirSync(repo);
  sb.env.GIT_CONFIG_GLOBAL = join(sb.dir, "gitconfig");
  writeFileSync(sb.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = t\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
  git("init", "-q");
  git("remote", "add", "origin", "https://user:pw@example.com/acme/app.git");
  commitFile("src/retry.ts", RETRY);
  calls = [];
  nextFragment = 1;
  answer = {
    submit: () => Response.json({ candidate_id: "cand_1", deduped: false, contract_version: "1.0.0", unfit: { state: "needs_input" } }),
    evidence: () => Response.json({ fragment_id: `frag_${nextFragment++}`, candidate_id: "cand_1", expires_at: "2026-12-05T00:00:00.000Z", contract_version: "1.0.0" }),
    fragment: (id) =>
      Response.json({ fragment_id: id, candidate_id: "cand_1", kind: "code", provenance: `acme/app@${sha}:src/retry.ts#L2-L4`, content: "  for (;;) {\n\tattempt();\u001b[2J\n  }", created_at: "2026-11-05T00:00:00.000Z", expires_at: "2026-12-05T00:00:00.000Z", contract_version: "1.0.0" }),
  };
});

async function drive(args: string[], opts: { format?: "text" | "json"; cwd?: string } = {}) {
  let stdout = "";
  let stderr = "";
  const ctx = {
    erisDir: REPO,
    env: { ...sb.env, HOME: sb.home, ERIS_YAKS_URL: ENDPOINT, ERIS_YAKS_TOKEN: TOKEN },
    format: opts.format ?? "text",
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: (s: string) => ((stderr += s), true) },
  };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body });
    if (url.pathname === "/v1/socrates/policy") return Response.json(policyResult(H1, ORG_V2));
    if (url.pathname === "/v1/socrates/evidence") return answer.evidence(body as { content: string });
    if (url.pathname.startsWith("/v1/socrates/evidence/")) return answer.fragment(decodeURIComponent(url.pathname.slice("/v1/socrates/evidence/".length)));
    return answer.submit();
  }) as unknown as typeof globalThis.fetch;
  let rc: number;
  try {
    rc = await runSocrates(args, ctx, { fetch, home: sb.home, cwd: opts.cwd ?? repo });
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    rc = e.code;
  }
  const slug = stderr.split("\n").find((l) => l.startsWith("slug: "))?.slice("slug: ".length);
  return { rc, stdout, stderr, slug };
}

const UNFIT = ["--unfit", "--hypothesis", HYPOTHESIS];
const submitBody = () => calls.find((c) => c.path === "/v1/socrates/submit")!.body as { candidate: Record<string, string>; unfit?: { evidence: { kind: string; provenance: string; content: string }[] } };

describe("eris socrates submit --fragment", () => {
  // admits: a fragment holding a secret is sent (inline with the stamp, or as its own object) because the fragment text skips the local scan; observed as no request at all and the refusal slug.
  it("a fragment holding a secret never leaves the machine, inline or linked", async () => {
    commitFile("src/config.ts", `export const token = "${GHP}";\n`);
    for (const stamp of [UNFIT, answers()]) {
      calls = [];
      const r = await drive(["submit", ...CANDIDATE, ...stamp, "--fragment", "src/config.ts#L1"]);
      expect(r).toMatchObject({ rc: 1, stdout: "", slug: "socrates-secret-detected" });
      expect(r.stderr).toContain("evidence.0");
      expect(r.stderr).not.toContain(GHP);
      expect(calls).toEqual([]);
    }
  });

  // admits: our redaction classes skip a fragment, so a token the other fields would have scrubbed reaches the endpoint; observed at the fragment body the endpoint received and the WARN.
  it("redacts a fragment the way it redacts the other fields", async () => {
    commitFile("deploy.sh", `ERIS_TOKEN=${TOKEN}\n`);
    const r = await drive(["submit", ...CANDIDATE, ...answers(), "--fragment", "deploy.sh#L1"]);
    expect(r.rc).toBe(0);
    expect(r.stderr).toContain("socrates-redacted");
    const posted = calls.find((c) => c.path === "/v1/socrates/evidence")!.body as { content: string };
    expect(posted.content).toBe("ERIS_TOKEN=«redacted:sib-token»");
  });

  // admits: the unfit path drops the fragment, slices the wrong lines, names a provenance that is not the commit the text came from, or posts it separately where the filing cannot list it; observed at the exact body sent and the requests made.
  it("with --unfit, sends the line range inline under <repo>@<sha>:<path>#L<x>-L<y> and posts nothing else", async () => {
    const r = await drive(["submit", ...CANDIDATE, ...UNFIT, "--fragment", "src/retry.ts#L2-L4", "--fragment", "src/retry.ts#L5"]);
    expect(r).toMatchObject({ rc: 0, stderr: "", stdout: "submitted: cand_1\n  filed for an answer: needs-input\n" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/socrates/policy", "POST /v1/socrates/submit"]);
    expect(submitBody().unfit!.evidence).toEqual([
      { kind: "code", provenance: `acme/app@${sha}:src/retry.ts#L2-L4`, content: "  for (let i = 0; i < 3; i++) {\n    attempt(i);\n  }" },
      { kind: "code", provenance: `acme/app@${sha}:src/retry.ts#L5`, content: "}" },
    ]);
    // Only provenance goes to what is filed on the review issue; the candidate's own fields carry no fragment text.
    expect(JSON.stringify(submitBody().candidate)).not.toContain("attempt");
  });

  // admits: --fragment and --evidence-file together exceed the five entries the contract allows and one is dropped silently; observed as a refusal with no request.
  it("refuses more than five fragments in all, before any request", async () => {
    const six = Array.from({ length: 6 }, (_, i) => ["--fragment", `src/retry.ts#L${i % 5 + 1}`]).flat();
    expect(await drive(["submit", ...CANDIDATE, ...UNFIT, ...six])).toMatchObject({ rc: 1, stdout: "", slug: "socrates-evidence-invalid" });
    const file = join(sb.dir, "evidence.json");
    writeFileSync(file, JSON.stringify(Array.from({ length: 4 }, (_, i) => ({ kind: "doc", provenance: `https://example.com/d#${i}`, content: `doc ${i}` }))));
    const r = await drive(["submit", ...CANDIDATE, ...UNFIT, "--evidence-file", file, "--fragment", "src/retry.ts#L1", "--fragment", "src/retry.ts#L2"]);
    expect(r).toMatchObject({ rc: 1, stdout: "", slug: "socrates-unfit-invalid" });
    expect(calls).toEqual([]);
  });

  // admits: a linked fragment is never posted, is posted before the candidate exists, lacks the candidate id, or its id is not printed for 'eris socrates evidence'; observed at the request order, each body, stdout and the JSON record.
  it("without --unfit, posts each fragment linked to the receipt's candidate and prints its id", async () => {
    commitFile("docs/notes.md", "# Retry\n\nThree attempts, then give up.\n");
    const r = await drive(["submit", ...CANDIDATE, ...answers(), "--fragment", "src/retry.ts#L1-L2", "--fragment", "docs/notes.md#L3"]);
    expect(r.rc).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/socrates/policy", "POST /v1/socrates/submit", "POST /v1/socrates/evidence", "POST /v1/socrates/evidence"]);
    expect(calls[2]!.body).toEqual({ schema_version: "1.0.0", candidate_id: "cand_1", kind: "code", provenance: `acme/app@${sha}:src/retry.ts#L1-L2`, content: "export function retry() {\n  for (let i = 0; i < 3; i++) {" });
    expect(calls[3]!.body).toMatchObject({ kind: "doc", provenance: `acme/app@${sha}:docs/notes.md#L3`, content: "Three attempts, then give up." });
    expect(JSON.stringify(submitBody())).not.toContain("attempts");
    expect(r.stdout).toContain(`  evidence: frag_1 acme/app@${sha}:src/retry.ts#L1-L2\n  evidence: frag_2 acme/app@${sha}:docs/notes.md#L3\n`);

    calls = [];
    const j = await drive(["submit", ...CANDIDATE, ...answers(), "--fragment", "src/retry.ts#L1"], { format: "json" });
    expect(JSON.parse(j.stdout).evidence).toEqual([{ fragment_id: "frag_3", provenance: `acme/app@${sha}:src/retry.ts#L1`, expires_at: "2026-12-05T00:00:00.000Z" }]);
  });

  // admits: a refused fragment after the receipt reads as a plain failure, so the caller does not know the candidate was already submitted (or prints success); observed at the ERROR line, the exit code and an empty stdout.
  it("names the submitted candidate when the endpoint refuses a linked fragment", async () => {
    answer.evidence = () => Response.json({ type: "urn:hera:error:forbidden", title: "Forbidden", status: 403, detail: "Evidence is off for this org", code: "socrates_evidence_disabled", _links: { settings: { href: "https://dash.example/socrates" } } }, { status: 403 });
    const r = await drive(["submit", ...CANDIDATE, ...answers(), "--fragment", "src/retry.ts#L1"]);
    expect(r).toMatchObject({ rc: 1, stdout: "", slug: "socrates-refused" });
    expect(r.stderr).toContain("for candidate cand_1, which was submitted");
    expect(r.stderr).toContain("open https://dash.example/socrates");
  });

  // admits: a reference the reader cannot stand behind is sent anyway: untracked, changed since the commit (the provenance would lie), past the end, binary, or not a range; observed as the slug and no request.
  it.each([
    ["an untracked file", () => writeFileSync(join(repo, "new.ts"), "x\n"), "new.ts#L1", "not tracked"],
    ["a file changed since HEAD", () => writeFileSync(join(repo, "src/retry.ts"), "changed\n"), "src/retry.ts#L1", "not in"],
    ["a range past the end", () => undefined, "src/retry.ts#L4-L9", "past its end"],
    ["a binary file", () => commitFile("bin.dat", new Uint8Array([1, 0, 2, 10])), "bin.dat#L1", "binary"],
    ["no line range", () => undefined, "src/retry.ts", "not <path>#L<x>"],
    ["a range that ends before it starts", () => undefined, "src/retry.ts#L3-L2", "ends (L2) before it starts (L3)"],
    ["a path with whitespace", () => undefined, "src/a b.ts#L1", "whitespace"],
  ])("refuses %s with nothing sent", async (_name, arrange, ref, says) => {
    arrange();
    const r = await drive(["submit", ...CANDIDATE, ...UNFIT, "--fragment", ref]);
    expect(r).toMatchObject({ rc: 1, stdout: "", slug: "socrates-evidence-invalid" });
    expect(r.stderr).toContain(says);
    expect(calls).toEqual([]);
  });

  // admits: a path given from a subdirectory is sent under a cwd-relative path, so the provenance names a file the commit does not hold at that path; observed at the provenance sent.
  it("names the repo-relative path when run from a subdirectory", async () => {
    const r = await drive(["submit", ...CANDIDATE, ...UNFIT, "--fragment", "retry.ts#L1"], { cwd: join(repo, "src") });
    expect(r.rc).toBe(0);
    expect(submitBody().unfit!.evidence[0]!.provenance).toBe(`acme/app@${sha}:src/retry.ts#L1`);
  });

  // admits: from a subdirectory the dirty check reads the repo-relative path against the cwd, matches nothing and passes, so working-tree edits are dropped silently under a provenance that claims the file; observed as the refusal and no request.
  it("refuses a file changed since HEAD when run from a subdirectory too", async () => {
    writeFileSync(join(repo, "src/retry.ts"), "DIRTY WORKTREE TEXT\n");
    const r = await drive(["submit", ...CANDIDATE, ...UNFIT, "--fragment", "retry.ts#L1"], { cwd: join(repo, "src") });
    expect(r).toMatchObject({ rc: 1, stdout: "", slug: "socrates-evidence-invalid" });
    expect(r.stderr).toContain("not in");
    expect(calls).toEqual([]);
  });

  // admits: the provenance carries the remote's credentials or host junk, or a remote with no owner/name path breaks the link; observed at the parsed repo.
  it.each([
    ["https://user:pw@example.com/acme/app.git", "acme/app"],
    ["git@github.com:acme/app.git", "acme/app"],
    ["ssh://git@github.com:22/acme/app", "acme/app"],
    ["https://gitlab.example/group/sub/app.git/", "sub/app"],
    ["/srv/git/app.git", "git/app"],
    ["app", null],
  ])("reads %s as %p", (url, repoName) => {
    expect(repoOfRemote(url)).toBe(repoName);
  });
});

describe("eris socrates evidence", () => {
  // admits: the verb is not routed, reads the wrong path, or prints the server's control characters to the terminal; observed at the request, stdout and the JSON record.
  it("prints one fragment, with its content's control characters removed", async () => {
    const r = await drive(["evidence", "frag_01M6"]);
    expect(r).toMatchObject({ rc: 0, stderr: "" });
    expect(calls).toEqual([{ method: "GET", path: "/v1/socrates/evidence/frag_01M6", body: undefined }]);
    expect(r.stdout).toBe(`fragment: frag_01M6\nkind: code\nprovenance: acme/app@${sha}:src/retry.ts#L2-L4\nexpires: 2026-12-05T00:00:00.000Z\ncandidate: cand_1\n\n  for (;;) {\n\tattempt();[2J\n  }\n`);
    const j = await drive(["evidence", "frag_01M6"], { format: "json" });
    expect(JSON.parse(j.stdout)).toMatchObject({ fragment_id: "frag_01M6", content: "  for (;;) {\n\tattempt();\u001b[2J\n  }" });
  });

  // admits: an id with a slash or dot-dot reaches another route, a blank id is sent, or a reply for another fragment is printed as the one asked for; observed at the encoded path, the slugs and the request count.
  it("encodes the id into one path segment, refuses a blank one, and refuses a reply for another fragment", async () => {
    await drive(["evidence", "../status"]);
    expect(calls[0]!.path).toBe("/v1/socrates/evidence/..%2Fstatus");
    calls = [];
    // A bare dot segment survives percent-encoding, and fetch resolves it to another route.
    for (const dots of [".", ".."]) expect(await drive(["evidence", dots])).toMatchObject({ rc: 1, stdout: "", slug: "socrates-flag-required" });
    expect(await drive(["evidence", ""])).toMatchObject({ rc: 1, slug: "socrates-flag-required" });
    expect(await drive(["evidence"])).toMatchObject({ rc: 1, slug: "socrates-flag-required" });
    expect(calls).toEqual([]);
    answer.fragment = () => Response.json({ fragment_id: "frag_other", kind: "code", provenance: "a/b@0123456:x.ts#L1", content: "x", created_at: "2026-11-05T00:00:00.000Z", expires_at: "2026-12-05T00:00:00.000Z", contract_version: "1.0.0" });
    expect(await drive(["evidence", "frag_1"])).toMatchObject({ rc: 1, stdout: "", slug: "socrates-bad-response" });
  });

  // admits: a gone fragment reads as a generic failure with no hint that fragments are deleted on resolve or after 30 days; observed at the fix line.
  it("explains a 404", async () => {
    answer.fragment = () => Response.json({ type: "urn:hera:error:not_found", title: "Not Found", status: 404, detail: "Not found", code: "not_found" }, { status: 404 });
    const r = await drive(["evidence", "frag_gone"]);
    expect(r).toMatchObject({ rc: 1, stdout: "", slug: "socrates-refused" });
    expect(r.stderr).toContain("deleted when its candidate resolves");
  });
});
