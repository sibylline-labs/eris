/**
 * Merge door and review dispatch parity for `plugins/gate/unlock.ts`, `burden.ts`, `floor.ts`,
 * `check.ts`, and `ladder.ts`: the review bar on a registered (tier-1) surface applies only to a
 * one-way merge. A clean two-way merge reads `not-needed`; a one-way merge missing
 * `adversarial-review` prints the `@dispatch` row that launches it; a governance diff, a locked
 * surface, or `signoff.two-way: human` keeps it human-signed whatever the door.
 *
 * Driven over a loopback `Bun.serve` gateway and real git repos under `.scratch/`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { gatesEndpoint, readDoctrine, RUNGS, sha256Hex } from "eris/gates-contract";
import { owedBy, targetChanges } from "../plugins/gate/burden";
import { GateFailure } from "../plugins/gate/failure";
import { gateHandler, type GateDeps } from "../plugins/gate/gate";
import { liveGit, memoReads } from "../plugins/gate/git";
import { DEFAULT_RUNGS, doorRung } from "../plugins/gate/ladder";
import { checkUnlock, oneWayDoorLine, reviewDispatch } from "../plugins/gate/unlock";
import { CliExit } from "../src/cli/ts-verb";

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, "..");
const ORG = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const LOGIN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const NOW = new Date("2026-11-20T12:00:00.000Z");
const REVIEW_DOC = "# review\nclean\n";
const ISSUE = "ABC-1";
const LEDGER = "ABC-9";
const ASSET_HOST = ["uploads", "linear", "app"].join(".");
const [HUMAN_BEFORE, HUMAN_AFTER, AUTO] = [RUNGS[0], RUNGS[1], RUNGS[2]];

interface StoredRow {
  comment_id: string;
  created_at: string;
  marker_version: "v2";
  payload: unknown;
}

let sandbox: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let store: Record<string, StoredRow[]>;
let copies: Record<string, unknown>;
let assets: Record<string, { sha256: string; bytes: number; contentType: string }>;
let clock: number;

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "gate-unlock-door-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/v1/gates/receipts") {
        const issue = url.searchParams.get("issue") ?? "";
        return Response.json({ issue, receipts: store[issue] ?? [], invalid: 0, contract_version: "gates-contract/v1" });
      }
      if (req.method === "GET" && url.pathname.startsWith("/v1/gates/artifacts/")) {
        const copy = copies[url.pathname.slice("/v1/gates/artifacts/".length)];
        return copy === undefined
          ? Response.json({ status: 404, code: "artifact_not_found" }, { status: 404, headers: { "content-type": "application/problem+json" } })
          : Response.json({ ...(copy as object), contract_version: "gates-contract/v1.2" });
      }
      if (req.method === "GET" && url.pathname === "/v1/gates/assets/digest") {
        const assetUrl = url.searchParams.get("url") ?? "";
        const asset = assets[assetUrl];
        return asset === undefined
          ? Response.json({ status: 404, code: "asset_not_found" }, { status: 404, headers: { "content-type": "application/problem+json" } })
          : Response.json({ ...asset, contract_version: "gates-contract/v1.1" });
      }
      if (req.method === "GET" && url.pathname === "/v1/asks") return Response.json({ asks: [] });
      return Response.json({ status: 404, code: "not_found" }, { status: 404, headers: { "content-type": "application/problem+json" } });
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(sandbox, "home-")));
  mkdirSync(join(home, ".eris"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".eris", "yaks.json"), JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token: LOGIN }), { mode: 0o600 });
  store = {};
  copies = {};
  assets = {};
  clock = 0;
});

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd, env: { PATH: process.env.PATH, HOME: home } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function write(dir: string, rel: string, body: string): void {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

function tmp(files: Record<string, string> = {}): string {
  const dir = realpathSync(mkdtempSync(join(sandbox, "tmp-")));
  for (const [rel, body] of Object.entries(files)) write(dir, rel, body);
  return dir;
}

const REGISTRY = (extra = "") => `surfaces:
  auth:
    paths:
      - src/auth/**
    one_way_unlock:
      merge: [adversarial-review]
    ledger: ${LEDGER}
    change_budget: 2
${extra}`;

function shop(registry = REGISTRY(), change: (d: string) => void = (d) => write(d, "src/auth/login.ts", "export const a = 2;\n")) {
  const d = realpathSync(mkdtempSync(join(sandbox, "repo-")));
  write(d, ".claude/surfaces.yml", registry);
  write(d, "src/auth/login.ts", "export const a = 1;\n");
  write(d, "src/other.ts", "x\n");
  git(d, "init", "-q", "-b", "main");
  git(d, "remote", "add", "origin", "git@github.com:acme/shop.git");
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "base");
  git(d, "checkout", "-q", "-b", "feat");
  change(d);
  write(d, "review.md", REVIEW_DOC);
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "change");
  return { d, head: git(d, "rev-parse", "HEAD"), base: git(d, "rev-parse", "main") };
}

const POSTURE = (signoff = "{ one-way: human, two-way: self }") =>
  `active: bau\n\n## bau\nDefault\n- Default.\n\`\`\`yaml\npolicy:\n  signoff: ${signoff}\n\`\`\`\n`;

const LOCKIN = () =>
  `active: lock\n\n## lock\nLock\n- Ceiling.\n\`\`\`yaml\npolicy:\n  signoff: { one-way: human, two-way: human }\n  ceilings:\n    all: ${HUMAN_BEFORE}\n\`\`\`\n`;

const at = () => new Date(Date.UTC(2026, 10, 20, 8, 0, clock++)).toISOString();
const put = (issue: string, payload: Record<string, unknown>) => {
  (store[issue] ??= []).push({ comment_id: `c-${clock}`, created_at: at(), marker_version: "v2", payload });
};

const line = (content: string) => ({ kind: "text" as const, content, sha256: sha256Hex(content) });
const gzipCopy = (text: string) => {
  const bytes = Buffer.from(text);
  return { encoding: "gzip+base64" as const, content: gzipSync(bytes).toString("base64"), bytes: bytes.byteLength };
};

const bound = (gate: string, commit: string, issue = ISSUE, over: Record<string, unknown> = {}) => ({
  schema: "gate-receipt@v2",
  gate,
  issue,
  verdict: "PASS",
  artifact: { _tag: "git", repo: "acme/shop", ref: "feat", commit, path: "review.md", sha256: sha256Hex(REVIEW_DOC) },
  actor: "op@example.com",
  evidence: [],
  recorded_at: "2026-11-20T08:00:00.000Z",
  ...over,
});

function fileReceipt(gate: string, issue = ISSUE, over: Record<string, unknown> = {}) {
  const path = join(tmp({ [`${gate}.md`]: "# a\n" }), `${gate}.md`);
  return {
    schema: "gate-receipt@v2",
    gate,
    issue,
    verdict: "PASS",
    artifact: { _tag: "file", path, sha256: sha256Hex("# a\n") },
    actor: "op@example.com",
    evidence: [],
    recorded_at: "2026-11-20T08:00:00.000Z",
    ...over,
  };
}

const defineFuture = (commit: string, evidence: string[], extra: Record<string, unknown> = {}) =>
  bound("define-future", commit, ISSUE, { evidence: evidence.map(line), user_impact: "U1", ...extra });

const scoped = (u: "U0" | "U1" | "U2" | "U3") => fileReceipt("understand-scope", ISSUE, { user_impact: u });

const deltaReceipt = (edges: { add?: unknown[]; remove?: unknown[]; change?: unknown[] }, extra: Record<string, unknown> = {}) => {
  const text = JSON.stringify({ kind: "eris.graph-target", nodes: { add: [], remove: [], change: [] }, edges: { add: [], remove: [], change: [], ...edges } });
  const artifact = { _tag: "file" as const, path: join(tmp(), "gone", "target.delta.json"), sha256: sha256Hex(text), copy: gzipCopy(text) };
  return {
    schema: "gate-receipt@v2",
    gate: "define-future",
    issue: ISSUE,
    verdict: "PASS",
    artifact,
    actor: "op@example.com",
    evidence: [line("re-sign of the granted delta")],
    user_impact: "U1",
    authorized: "Pat asked: grant it",
    recorded_at: "2026-11-20T08:00:00.000Z",
    ...extra,
  };
};

const UNLOCKED = (head: string) => ({
  doctrineText: POSTURE("{ one-way: human, two-way: self, unlock: on }"),
  issue: [bound("adversarial-review", head), bound("posture-check", head)],
  ledger: [
    fileReceipt("audit-surfaces", LEDGER),
    fileReceipt("unlocked-merge", LEDGER, { evidence: [line(["unlocked one-way: merge", "surface: auth", `issue: ${ISSUE} head: ${head}`].join("\n"))] }),
  ],
});

async function unlock(
  cwd: string,
  opts: {
    issue?: Record<string, unknown>[];
    ledger?: Record<string, unknown>[];
    doctrineText?: string;
    base?: string;
    headSha?: string;
  } = {},
): Promise<{ rc: number; stdout: string; stderr: string }> {
  store = {};
  for (const r of opts.issue ?? []) put(ISSUE, r);
  for (const r of opts.ledger ?? []) put(LEDGER, r);
  const ep = gatesEndpoint(`http://127.0.0.1:${server.port}`, LOGIN);
  if (!ep.ok) throw new Error(ep.failure.what);
  const g = memoReads(liveGit({ HOME: home, PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: sandbox, ERIS_CLONES_FILE: join(home, "none.json") }));
  const headSha = opts.headSha ?? git(cwd, "rev-parse", "HEAD");
  const base = opts.base ?? "main";
  const doctrineText = opts.doctrineText ?? POSTURE();
  let stdout = "";
  let stderr = "";
  try {
    await checkUnlock({
      ep: ep.value,
      issue: ISSUE,
      action: "merge",
      base,
      headSha,
      registry: ".claude/surfaces.yml",
      cwd,
      g,
      doctrine: { file: "doctrine.md", read: readDoctrine(doctrineText) },
      now: NOW,
      readRetry: { delaysMs: [], maxWaitMs: 0, sleep: async () => {}, jitter: () => 0 },
      out: (l) => void (stdout += `${l}\n`),
      warn: (l) => void (stderr += `${l}\n`),
    });
    return { rc: 0, stdout, stderr };
  } catch (e) {
    if (e instanceof GateFailure) return { rc: e.failure.exit, stdout, stderr: `${stderr}${e.failure.what}\n${e.failure.fix}\n` };
    throw e;
  }
}

async function runGate(args: string[], cwd = sandbox): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const ctx = {
    erisDir: REPO,
    env: { HOME: home, PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: sandbox, ERIS_CLONES_FILE: join(home, "none.json") },
    stdout: { write: (s: string) => ((out += s), true) },
    stderr: { write: (s: string) => ((err += s), true) },
    format: "text" as const,
  };
  const deps: GateDeps = { home, cwd, now: () => NOW, sleep: async () => {}, jitter: () => 0, expectDelaysMs: [0, 0] };
  try {
    return { code: await gateHandler({}, deps)(args, ctx), out, err };
  } catch (e) {
    if (e instanceof CliExit) return { code: e.code, out, err };
    throw e;
  }
}

describe("checkUnlock merge: the door decides the bar", () => {
  // admits: integration: a two-way change crossing a tier-1 path demanded sign-off or a review before the merge door check existed.
  it("a two-way define-future door crossing a tier-1 path needs nothing", async () => {
    const { d, head } = shop();
    const r = await unlock(d, { issue: [defineFuture(head, ["door: two-way (+1 -0 ~0)"])] });
    expect({ rc: r.rc, stdout: r.stdout }).toEqual({
      rc: 0,
      stdout: `@door\ttwo-way\tdefine-future, rung ${AUTO} (U1:auth)\n@surface\tauth\t1\n@lock\topen\tauth\n@unlock\tnot-needed\tmerge\n`,
    });
  });

  // admits: integration: an empty target (no door line) is two-way; the unladdered rung fallback reads U0/U1 as auto (two-way).
  it("an empty target, or no define-future on a U1 change, is two-way", async () => {
    const { d, head } = shop();
    const empty = await unlock(d, { issue: [defineFuture(head, ["governance sites: none"])] });
    expect({ rc: empty.rc, last: empty.stdout.split("\n").at(-2) }).toEqual({ rc: 0, last: "@unlock\tnot-needed\tmerge" });
    const rung = await unlock(d, { issue: [scoped("U1")] });
    expect({ rc: rung.rc, door: rung.stdout.split("\n")[0] }).toEqual({ rc: 0, door: `@door\ttwo-way\trung ${AUTO} (U1:auth)` });
  });

  // admits: boundary-io: fail closed when unclassified, ceilinged to human-before, define-future fails, or counts contradict two-way.
  it("reads one-way when unclassified, ceilinged to human-before, the define-future does not pass, or its counts contradict two-way", async () => {
    const { d, head } = shop();
    const none = await unlock(d, {});
    expect({ rc: none.rc, door: none.stdout.split("\n")[0] }).toEqual({ rc: 3, door: "@door\tone-way\tunclassified" });
    const floored = await unlock(d, { issue: [scoped("U0")], doctrineText: LOCKIN() });
    expect({ rc: floored.rc, door: floored.stdout.split("\n")[0] }).toEqual({ rc: 3, door: `@door\tone-way\trung ${HUMAN_BEFORE} (U0:auth)` });
    const blocking = await unlock(d, { issue: [defineFuture(head, ["door: two-way (+1 -0 ~0)"], { verdict: "BLOCKING" })] });
    expect({ rc: blocking.rc, door: blocking.stdout.split("\n")[0] }).toEqual({ rc: 3, door: "@door\tone-way\tdefine-future blocking" });
    const mislabelled = await unlock(d, { issue: [defineFuture(head, ["door: two-way (+1 -1 ~0)"])] });
    expect({ rc: mislabelled.rc, door: mislabelled.stdout.split("\n")[0] }).toEqual({ rc: 3, door: "@door\tone-way\tdefine-future" });
  });

  // admits: integration: a one-way tier-1 merge missing adversarial-review must print the neon dispatch row before @unlock human.
  it("a one-way door missing adversarial-review prints the neon dispatch", async () => {
    const { d, head } = shop();
    const r = await unlock(d, { issue: [defineFuture(head, ["door: one-way (+0 -1 ~0)"], { authorized: "Pat asked: drop it" }), bound("posture-check", head)] });
    expect(r.rc).toBe(3);
    expect(r.stdout).toStartWith("@door\tone-way\tdefine-future\n");
    expect(r.stdout).toContain("adversarial-review\tmissing\t-\n");
    expect(r.stdout).toContain(`@dispatch\tadversarial-review\teris loop launch adversarial-review ${ISSUE} --cwd ${d} --runtime opencode --pool neon --unclaimed\n`);
  });

  // admits: integration: a one-way door with a passing bar unlocks without human sign-off and prints no @dispatch row.
  it("a one-way door with a passing review unlocks without a human, and dispatches nothing", async () => {
    const { d, head } = shop();
    const green = UNLOCKED(head);
    const r = await unlock(d, { ...green, issue: [...green.issue, defineFuture(head, ["door: one-way (+0 -1 ~0)"], { authorized: "Pat asked: drop it" })] });
    expect({ rc: r.rc, last: r.stdout.split("\n").at(-2) }).toEqual({ rc: 0, last: "@unlock\tunlocked\tmerge" });
    expect(r.stdout).not.toContain("@dispatch");
  });

  // admits: integration: a two-way door must never waive a governance diff (registry, vocabulary, or review skill edit).
  it("a governance diff stays human on a two-way door", async () => {
    const { d, head } = shop(REGISTRY(), (dir) => {
      write(dir, "src/auth/login.ts", "export const a = 2;\n");
      write(dir, ".claude/surfaces.yml", REGISTRY('  billing:\n    paths: ["src/billing/**"]\n'));
    });
    const r = await unlock(d, { issue: [defineFuture(head, ["door: two-way (+1 -0 ~0)"])] });
    expect(r.rc).toBe(3);
    expect(r.stdout).toContain("@governance\t.claude/surfaces.yml\n");
    expect(r.stdout).toContain(`@door\ttwo-way\tdefine-future, rung ${AUTO} (U1:auth)\n`);
    expect(r.stdout).toEndWith("@unlock\thuman\tmerge\n");
    expect(r.stderr).toContain("always human-signed");
  });

  // admits: integration: a two-way merge must read each crossed surface's lock before returning not-needed.
  it("a two-way merge on a locked surface reads human", async () => {
    const { d, head } = shop();
    const lock = fileReceipt("surface-lock", LEDGER, { evidence: [line("locked auth: incident in flight")], authorized: "Pat asked: freeze auth" });
    const r = await unlock(d, { issue: [defineFuture(head, ["door: two-way (+1 -0 ~0)"])], ledger: [lock] });
    expect(r.rc).toBe(3);
    expect(r.stdout).toContain("@lock\tlocked\tauth\n");
    expect(r.stdout).toEndWith("@unlock\thuman\tmerge\n");
    expect(r.stderr).toContain("incident in flight");
    expect(r.stderr).toContain("'eris surface unlock auth' lifts it");
  });

  // admits: boundary-io: a passing define-future over a removing/changing target.delta.json with no door line must read one-way.
  it("a passing define-future whose delta removes or changes anything is one-way, whatever its evidence says", async () => {
    const { d } = shop();
    const delta = (change: unknown[]) => JSON.stringify({ kind: "eris.graph-target", nodes: { add: [], remove: [], change: [] }, edges: { add: [], remove: [], change } });
    const over = (text: string) => {
      const path = join(tmp({ "target.delta.json": text }), "target.delta.json");
      return {
        schema: "gate-receipt@v2",
        gate: "define-future",
        issue: ISSUE,
        verdict: "PASS",
        artifact: { _tag: "file", path, sha256: sha256Hex(text) },
        actor: "op@example.com",
        evidence: [line("re-sign of the granted delta")],
        user_impact: "U1",
        recorded_at: "2026-11-20T08:00:00.000Z",
      };
    };
    const changed = await unlock(d, { issue: [over(delta([{ from: "a", to: "b" }]))] });
    expect({ rc: changed.rc, door: changed.stdout.split("\n")[0] }).toEqual({ rc: 3, door: "@door\tone-way\tdefine-future delta (-0 ~1)" });
    const added = await unlock(d, { issue: [over(delta([]))] });
    expect({ rc: added.rc, door: added.stdout.split("\n")[0] }).toEqual({ rc: 0, door: `@door\ttwo-way\tdefine-future, rung ${AUTO} (U1:auth)` });
  });

  // admits: algorithmic: multi-counter door lines and Unicode minus U+2212 have regex branches no type checker inspects.
  it("reads every count on a door line, however many counters it carries, including Unicode minus U+2212", () => {
    expect(oneWayDoorLine("door: two-way (edges +3 -1 ~0, nodes +0 -0 ~0)")).toBe(true);
    expect(oneWayDoorLine("door: two-way (edges +3 -0 ~0, nodes +1 -0 ~2)")).toBe(true);
    expect(oneWayDoorLine("door: two-way (edges +3 -0 ~0, nodes +1 -0 ~0)")).toBe(false);
    expect(oneWayDoorLine("door: two-way (+1 \u22121 ~0)")).toBe(true);
    expect(oneWayDoorLine("door: two-way (+1 \u22120 ~0)")).toBe(false);
  });

  // admits: integration: an unauthorized, stale, or tampered SKIPPED define-future must stay one-way instead of falling through to the class rung.
  it("an invalid SKIPPED define-future is one-way; only a valid skip defers to the class", async () => {
    const { d, head } = shop();
    const r = await unlock(d, { issue: [defineFuture(head, ["door: one-way (+0 -1 ~0)"], { verdict: "BLOCKING" }), defineFuture(head, [], { verdict: "SKIPPED" })] });
    expect({ rc: r.rc, door: r.stdout.split("\n")[0] }).toEqual({ rc: 3, door: "@door\tone-way\tdefine-future unauthorized-skip" });
  });

  // admits: integration: a passing empty-target define-future must not short-circuit unclassified issues, human-before ceilings, or signoff.two-way: human.
  it("the class decides with the define-future: unclassified, a human-before ceiling, or signoff.two-way: human never reads not-needed", async () => {
    const { d, head } = shop();
    const floored = await unlock(d, { issue: [defineFuture(head, ["empty target delta: none"], { user_impact: "U0" })], doctrineText: LOCKIN() });
    expect({ rc: floored.rc, door: floored.stdout.split("\n")[0] }).toEqual({ rc: 3, door: `@door\tone-way\trung ${HUMAN_BEFORE} (U0:auth)` });
    const unclassified = await unlock(d, { issue: [defineFuture(head, ["empty target delta: none"], { user_impact: undefined })] });
    expect({ rc: unclassified.rc, door: unclassified.stdout.split("\n")[0] }).toEqual({ rc: 3, door: "@door\tone-way\tunclassified" });
    const held = await unlock(d, { issue: [defineFuture(head, ["door: two-way (+1 -0 ~0)"])], doctrineText: POSTURE("{ one-way: human, two-way: human }") });
    expect({ rc: held.rc, door: held.stdout.split("\n")[0], last: held.stdout.split("\n").at(-2) }).toEqual({
      rc: 3,
      door: `@door\ttwo-way\tdefine-future, rung ${AUTO} (U1:auth)`,
      last: "@unlock\thuman\tmerge",
    });
    expect(held.stderr).toContain("signoff.two-way: human");
  });

  // admits: integration: a head-bound BLOCKING review must not re-dispatch (verdict shopping), and human sign-off suppresses @dispatch.
  it("dispatches the review only when none is bound to the head, and never beside a human sign-off", async () => {
    const { d, head } = shop();
    const oneWay = defineFuture(head, ["door: one-way (+0 -1 ~0)"], { authorized: "Pat asked: drop it" });
    const atHead = await unlock(d, { issue: [oneWay, bound("posture-check", head), bound("adversarial-review", head, ISSUE, { verdict: "BLOCKING" })] });
    expect(atHead.rc).toBe(3);
    expect(atHead.stdout).toContain("adversarial-review\tblocking\tBLOCKING\n");
    expect(atHead.stdout).not.toContain("@dispatch");
    const older = await unlock(d, { issue: [oneWay, bound("adversarial-review", git(d, "rev-parse", "main"), ISSUE, { verdict: "BLOCKING" })] });
    expect(older.stdout).toContain("@dispatch\tadversarial-review\t");
    const signed = await unlock(d, { issue: [oneWay, bound("door-signoff", head, ISSUE, { evidence: [line("door: merge")], authorized: "Pat asked: merge it" })] });
    expect({ rc: signed.rc, last: signed.stdout.split("\n").at(-2) }).toEqual({ rc: 0, last: "@unlock\thuman-signed\tmerge" });
    expect(signed.stdout).not.toContain("@dispatch");
  });

  // admits: boundary-io: a linked worktree must resolve its main clone via --git-common-dir and shell-quote paths with spaces.
  it("the dispatch names the main clone, shell-quoted, even from a linked worktree", async () => {
    const { d, head } = shop();
    const wt = join(tmp(), "my wt");
    git(d, "worktree", "add", "-q", "-b", "feat2", wt, "feat");
    const r = await unlock(wt, { issue: [defineFuture(head, ["door: one-way (+0 -1 ~0)"], { authorized: "Pat asked: drop it" })] });
    expect(r.stdout).toContain(`--cwd ${d} --runtime`);
    expect(reviewDispatch(ISSUE, "/a b/c")).toBe(`eris loop launch adversarial-review ${ISSUE} --cwd /a\\ b/c --runtime opencode --pool neon --unclaimed`);
  });

  // admits: integration: a follow-up run's later empty-target note must not hide an earlier one-way define-future on the same issue.
  it("a one-way door named by an earlier define-future holds after a later empty-target note", async () => {
    const { d, head } = shop();
    const r = await unlock(d, { issue: [defineFuture(head, ["door: one-way (edges +0 -0 ~1)"], { authorized: "Pat asked: grant it" }), defineFuture(head, ["empty target delta: none"])] });
    expect({ rc: r.rc, door: r.stdout.split("\n")[0] }).toEqual({ rc: 3, door: "@door\tone-way\tdefine-future history" });
  });

  // admits: integration: historical define-future delta bytes (carried or stored copy), log door lines, and unverifiable bytes must hold one-way after a later empty-target note.
  it("an earlier define-future's verified delta bytes or log door line hold one-way after a later empty-target note, and unverifiable bytes fail closed", async () => {
    const { d, head } = shop();
    const note = defineFuture(head, ["empty target delta: 0 governance sites"]);
    const bytes = await unlock(d, { issue: [deltaReceipt({ change: [{ from: "a", to: "b" }] }), note] });
    expect({ rc: bytes.rc, door: bytes.stdout.split("\n")[0] }).toEqual({ rc: 3, door: "@door\tone-way\tdefine-future history (-0 ~1)" });

    // Stored copy via GET /v1/gates/artifacts/<sha256> (no inline copy on the receipt, live file gone).
    const storedText = JSON.stringify({ kind: "eris.graph-target", version: 1, nodes: { remove: ["srn:service:old"] } });
    const storedSha = sha256Hex(storedText);
    copies[storedSha] = { sha256: storedSha, ...gzipCopy(storedText) };
    const storedRec = {
      schema: "gate-receipt@v2",
      gate: "define-future",
      issue: ISSUE,
      verdict: "PASS",
      artifact: { _tag: "file", path: join(tmp(), "gone", "stored.delta.json"), sha256: storedSha },
      actor: "op@example.com",
      evidence: [],
      user_impact: "U1",
      recorded_at: "2026-11-20T08:00:00.000Z",
    };
    const fromStore = await unlock(d, { issue: [storedRec, note] });
    expect({ rc: fromStore.rc, door: fromStore.stdout.split("\n")[0] }).toEqual({ rc: 3, door: "@door\tone-way\tdefine-future history (-1 ~0)" });

    const logged = defineFuture(head, [], {
      evidence: [{ kind: "log" as const, content: "door: one-way (+0 -1 ~0)", sha256: sha256Hex("door: one-way (+0 -1 ~0)") }],
      authorized: "Pat asked: drop it",
    });
    const log = await unlock(d, { issue: [logged, note] });
    expect({ rc: log.rc, door: log.stdout.split("\n")[0] }).toEqual({ rc: 3, door: "@door\tone-way\tdefine-future history" });

    const gone = {
      schema: "gate-receipt@v2",
      gate: "define-future",
      issue: ISSUE,
      verdict: "BLOCKING",
      artifact: { _tag: "file", path: join(tmp(), "gone", "target.delta.json"), sha256: sha256Hex("lost") },
      actor: "op@example.com",
      evidence: [],
      user_impact: "U1",
      recorded_at: "2026-11-20T08:00:00.000Z",
    };
    const unverified = await unlock(d, { issue: [gone, note] });
    expect({ rc: unverified.rc, door: unverified.stdout.split("\n")[0] }).toEqual({ rc: 3, door: "@door\tone-way\tdefine-future history unverified" });

    const additive = await unlock(d, { issue: [deltaReceipt({ add: [{ from: "a", to: "b" }] }), note] });
    expect({ rc: additive.rc, door: additive.stdout.split("\n")[0] }).toEqual({ rc: 0, door: `@door\ttwo-way\tdefine-future, rung ${AUTO} (U1:auth)` });
  });

  // admits: integration: a passing review whose artifact names no commit must read stale-head without re-dispatching on an unchanged head.
  it("a passing review whose artifact names no commit is not re-dispatched", async () => {
    const { d, head } = shop();
    const oneWay = defineFuture(head, ["door: one-way (+0 -1 ~0)"], { authorized: "Pat asked: drop it" });
    const r = await unlock(d, { issue: [oneWay, bound("posture-check", head), fileReceipt("adversarial-review", ISSUE, { verdict: "PASS" })] });
    expect(r.rc).toBe(3);
    expect(r.stdout).toContain("adversarial-review\tstale-head\tPASS\n");
    expect(r.stdout).not.toContain("@dispatch");
    expect(r.stderr).toContain("names no commit");
  });

  // admits: integration: sparse valid eris.graph-target deltas omitting empty fields must decode accurately and malformed graph-target JSON must fail closed on both latest and history.
  it("reads sparse valid eris.graph-target deltas accurately and fails closed on malformed graph-target JSON (latest and history)", async () => {
    const { d, head } = shop();
    const note = defineFuture(head, ["empty target delta: 0 governance sites"]);
    const rawDelta = (doc: Record<string, unknown>, withFile = false) => {
      const text = JSON.stringify(doc);
      const artifact = withFile
        ? { _tag: "file" as const, path: join(tmp({ "target.delta.json": text }), "target.delta.json"), sha256: sha256Hex(text) }
        : { _tag: "file" as const, path: join(tmp(), "gone", "target.delta.json"), sha256: sha256Hex(text), copy: gzipCopy(text) };
      return {
        schema: "gate-receipt@v2",
        gate: "define-future",
        issue: ISSUE,
        verdict: "PASS",
        artifact,
        actor: "op@example.com",
        evidence: [line("re-sign of the granted delta")],
        user_impact: "U1",
        authorized: "Pat asked: grant it",
        recorded_at: "2026-11-20T08:00:00.000Z",
      };
    };

    const sparseChange = { kind: "eris.graph-target", version: 1, baseline: { file: "baseline.json" }, edges: { change: [{ id: "calls:a->b", set: { via: "rpc" } }] } };
    const sparseRemove = { kind: "eris.graph-target", version: 1, baseline: { file: "baseline.json" }, nodes: { remove: ["srn:service:legacy"] } };
    const sparseAdd = { kind: "eris.graph-target", version: 1, baseline: { file: "baseline.json" }, edges: { add: [{ id: "calls:a->b", type: "calls", from: "a", to: "b" }] } };

    const latestChange = await unlock(d, { issue: [rawDelta(sparseChange, true)] });
    expect({ rc: latestChange.rc, door: latestChange.stdout.split("\n")[0] }).toEqual({ rc: 3, door: "@door\tone-way\tdefine-future delta (-0 ~1)" });
    const latestRemove = await unlock(d, { issue: [rawDelta(sparseRemove, true)] });
    expect({ rc: latestRemove.rc, door: latestRemove.stdout.split("\n")[0] }).toEqual({ rc: 3, door: "@door\tone-way\tdefine-future delta (-1 ~0)" });
    const latestAdd = await unlock(d, { issue: [rawDelta(sparseAdd, true)] });
    expect({ rc: latestAdd.rc, door: latestAdd.stdout.split("\n")[0] }).toEqual({ rc: 0, door: `@door\ttwo-way\tdefine-future, rung ${AUTO} (U1:auth)` });

    const histChange = await unlock(d, { issue: [rawDelta(sparseChange), note] });
    expect({ rc: histChange.rc, door: histChange.stdout.split("\n")[0] }).toEqual({ rc: 3, door: "@door\tone-way\tdefine-future history (-0 ~1)" });
    const histRemove = await unlock(d, { issue: [rawDelta(sparseRemove), note] });
    expect({ rc: histRemove.rc, door: histRemove.stdout.split("\n")[0] }).toEqual({ rc: 3, door: "@door\tone-way\tdefine-future history (-1 ~0)" });
    const histAdd = await unlock(d, { issue: [rawDelta(sparseAdd), note] });
    expect({ rc: histAdd.rc, door: histAdd.stdout.split("\n")[0] }).toEqual({ rc: 0, door: `@door\ttwo-way\tdefine-future, rung ${AUTO} (U1:auth)` });

    for (const bad of [
      { kind: "eris.graph-target", version: 1, nodes: "bad" },
      { kind: "eris.graph-target", version: 1, edges: { removes: ["srn:service:legacy"] } },
      { kind: "eris.graph-target", version: 1, node: { remove: ["srn:service:legacy"] } },
      { kind: "eris.graph-target", version: 2, edges: { add: [] } },
    ]) {
      const latestBad = await unlock(d, { issue: [rawDelta(bad, true)] });
      expect({ rc: latestBad.rc, door: latestBad.stdout.split("\n")[0] }).toEqual({ rc: 3, door: "@door\tone-way\tdefine-future delta invalid" });
      const histBad = await unlock(d, { issue: [rawDelta(bad), note] });
      expect({ rc: histBad.rc, door: histBad.stdout.split("\n")[0] }).toEqual({ rc: 3, door: "@door\tone-way\tdefine-future history invalid" });
    }
  });

  // admits: integration: non-human grants (doctrine:, repo:, blank) must not lower guarded U2 under human-before ceilings, while a human grant can.
  it("non-human authorized grants cannot lower guarded U2 under human-before ceilings; a human grant can", async () => {
    const { d } = shop();
    const u2Floor = `active: strict\n\n## strict\nStrict U2\n- U2 stays held.\n\`\`\`yaml\npolicy:\n  signoff: { one-way: human, two-way: self }\n  ceilings:\n    U2: ${HUMAN_BEFORE}\n\`\`\`\n`;
    const control = await unlock(d, { issue: [scoped("U2")], doctrineText: u2Floor });
    expect({ rc: control.rc, door: control.stdout.split("\n")[0] }).toEqual({ rc: 3, door: `@door\tone-way\trung ${HUMAN_BEFORE} (U2:auth)` });
    for (const authorized of ["doctrine:strict-u2", "repo:no-eris-yaml", "   "]) {
      const lowered = fileReceipt("plan-review", ISSUE, { user_impact: "U0", authorized });
      const r = await unlock(d, { issue: [scoped("U2"), lowered], doctrineText: u2Floor });
      expect({ rc: r.rc, door: r.stdout.split("\n")[0] }).toEqual({ rc: 3, door: `@door\tone-way\trung ${HUMAN_BEFORE} (U2:auth)` });
    }
    const human = fileReceipt("plan-review", ISSUE, { user_impact: "U0", authorized: "Pat asked: U0, internal only" });
    const ok = await unlock(d, { issue: [scoped("U2"), human], doctrineText: u2Floor });
    expect({ rc: ok.rc, door: ok.stdout.split("\n")[0], last: ok.stdout.split("\n").at(-2) }).toEqual({
      rc: 0,
      door: `@door\ttwo-way\trung ${AUTO} (U0:auth)`,
      last: "@unlock\tnot-needed\tmerge",
    });
  });
});

describe("burden, ladder defaults, and blank SKIPPED grants", () => {
  // admits: boundary-io: sparse valid eris.graph-target deltas omitting nodes/remove/change previously returned null and owed no screenshot; file bytes are runtime I/O.
  it("owes screenshot for a sparse non-empty delta and owes nothing for an empty sparse delta", async () => {
    const sparseAdd = `${JSON.stringify({
      kind: "eris.graph-target",
      version: 1,
      baseline: { file: "baseline.json" },
      edges: { add: [{ id: "calls:srn:service:a->srn:service:b", type: "calls", from: "srn:service:a", to: "srn:service:b" }] },
    })}\n`;
    const sparseEmpty = `${JSON.stringify({ kind: "eris.graph-target", version: 1, baseline: { file: "baseline.json" } })}\n`;
    expect(targetChanges(Buffer.from(sparseAdd))).toEqual({ kind: "delta", add: 1, remove: 0, change: 0 });
    expect(owedBy("define-future", Buffer.from(sparseAdd))).toEqual(["screenshot"]);
    expect(owedBy("define-future", Buffer.from(sparseEmpty))).toEqual([]);

    const shotUrl = `https://${ASSET_HOST}/diff.png`;
    assets[shotUrl] = { sha256: sha256Hex("png"), bytes: 3, contentType: "image/png" };
    const shot = { kind: "screenshot", name: "diff.png", content_type: "image/png", bytes: 3, sha256: sha256Hex("png"), asset_url: shotUrl };

    const addPath = join(tmp({ "target.delta.json": sparseAdd }), "target.delta.json");
    put(ISSUE, {
      schema: "gate-receipt@v2",
      gate: "define-future",
      issue: ISSUE,
      verdict: "PASS",
      artifact: { _tag: "file", path: addPath, sha256: sha256Hex(sparseAdd) },
      actor: "op@example.com",
      evidence: [],
      recorded_at: "2026-11-20T08:00:00.000Z",
    });
    const bare = await runGate(["check", "--issue", ISSUE, "--gates", "define-future"]);
    expect({ code: bare.code, out: bare.out }).toEqual({ code: 3, out: "define-future\tpass\tPASS\nburden\tunmet\tscreenshot\n" });

    store = {};
    put(ISSUE, {
      schema: "gate-receipt@v2",
      gate: "define-future",
      issue: ISSUE,
      verdict: "PASS",
      artifact: { _tag: "file", path: addPath, sha256: sha256Hex(sparseAdd) },
      actor: "op@example.com",
      evidence: [shot],
      recorded_at: "2026-11-20T08:00:00.000Z",
    });
    const met = await runGate(["check", "--issue", ISSUE, "--gates", "define-future"]);
    expect({ code: met.code, out: met.out }).toEqual({ code: 0, out: "define-future\tpass\tPASS\nburden\tpass\tscreenshot\n" });

    store = {};
    const emptyPath = join(tmp({ "target.delta.json": sparseEmpty }), "target.delta.json");
    put(ISSUE, {
      schema: "gate-receipt@v2",
      gate: "define-future",
      issue: ISSUE,
      verdict: "PASS",
      artifact: { _tag: "file", path: emptyPath, sha256: sha256Hex(sparseEmpty) },
      actor: "op@example.com",
      evidence: [],
      recorded_at: "2026-11-20T08:00:00.000Z",
    });
    const empty = await runGate(["check", "--issue", ISSUE, "--gates", "define-future"]);
    expect({ code: empty.code, out: empty.out }).toEqual({ code: 0, out: "define-future\tpass\tPASS\n" });
  });

  // admits: algorithmic: unladdered U0/U1 default to auto while U2/U3 stay human-after, and explicit ladder entries still win by specificity.
  it("doorRung defaults unladdered U0/U1 to auto and U2/U3 to human-after while explicit ladder entries win", () => {
    const at = (classes: Record<string, (typeof RUNGS)[number]> | null, u: "U0" | "U1" | "U2" | "U3", crossings: string[] = []) =>
      doorRung({ ladder: classes === null ? null : { classes }, policy: undefined, posture: undefined, u, crossings, bleedReducing: false });
    expect(DEFAULT_RUNGS).toEqual({ U0: AUTO, U1: AUTO, U2: HUMAN_AFTER, U3: HUMAN_AFTER });
    expect(at(null, "U0")).toEqual({ rung: AUTO, door: "U0", stated: AUTO });
    expect(at(null, "U1")).toEqual({ rung: AUTO, door: "U1", stated: AUTO });
    expect(at(null, "U2")).toEqual({ rung: HUMAN_AFTER, door: "U2", stated: HUMAN_AFTER });
    expect(at(null, "U3")).toEqual({ rung: HUMAN_AFTER, door: "U3", stated: HUMAN_AFTER });
    expect(at({ all: AUTO, U2: HUMAN_AFTER, "U2:auth": HUMAN_BEFORE }, "U2", ["auth"]).rung).toBe(HUMAN_BEFORE);
    expect(at({ all: AUTO, U2: HUMAN_AFTER }, "U2", ["auth"]).rung).toBe(HUMAN_AFTER);
  });

  // admits: boundary-io: a SKIPPED receipt stored with a blank authorized grant must read unauthorized-skip under isHumanGrant.
  it("reads a SKIPPED receipt with a whitespace-only authorized grant as unauthorized-skip", async () => {
    put(ISSUE, fileReceipt("sdk-check", ISSUE, { verdict: "SKIPPED", authorized: "   ", reason: "not needed here" }));
    const r = await runGate(["check", "--issue", ISSUE, "--gates", "sdk-check"]);
    expect({ code: r.code, out: r.out }).toEqual({ code: 3, out: "sdk-check\tunauthorized-skip\tSKIPPED\n" });
  });
});
