/**
 * Distribution seams and parity behaviours on `gatePlugin(defaults)` and `eris/sdk`:
 * `resolveActor`, `burdenSurfaces`, `pulled(ctx, { cwd, home })`, function-form `ladderFile`,
 * `receiptLink` (`{link}` template slot, stderr note, store sha mismatch), `subcommands` dispatch
 * & built-in collision guard, `--asks` output on receipt listing failure, detached-worktree
 * `ls-remote` push fallback (and fail-closed on unreachable origin), oversized `final-gates.diff`
 * `diff-rebuild:` recording & re-derivation, and the lazy SDK programmatic helpers.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RUNGS, sha256Hex } from "eris/gates-contract";
import { locateArtifact } from "../plugins/gate/artifact";
import { liveGit, type Git } from "../plugins/gate/git";
import {
  CliExit,
  type GateDefaults,
  type GateDeps,
  gateHandler,
  gateHumanSignoff,
  gatePlugin,
  gateRows,
  judgeGateMonotone,
  listGateReceipts,
  readGateLadder,
  recordGateReceipt,
  renderGateProse,
  surfaceHandler,
} from "eris/sdk";

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, "..");
const ORG = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const LOGIN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const ISSUE = "ABC-42";
const LEDGER = "ABC-90";
const HUMAN_BEFORE = RUNGS[0];

interface StoredRow {
  comment_id: string;
  created_at: string;
  marker_version: "v2";
  payload: Record<string, unknown>;
  prose: string;
}

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  body: string;
}

let sandbox: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let store: Record<string, StoredRow[]>;
let seen: Seen[];
let clock: number;
let asks: unknown[];
let override: Record<string, (s: Seen) => Response | undefined>;

const problem = (status: number, code: string) => Response.json({ status, code }, { status, headers: { "content-type": "application/problem+json" } });
const at = () => new Date(Date.UTC(2026, 10, 17, 10, 0, clock++)).toISOString();

function git(dir: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeCtx(env: Record<string, string | undefined> = {}) {
  let out = "";
  let err = "";
  const ctx = {
    erisDir: REPO,
    env: { PATH: process.env.PATH, HOME: home, GIT_CEILING_DIRECTORIES: sandbox, ...env },
    stdout: { write: (s: string) => ((out += s), true) },
    stderr: { write: (s: string) => ((err += s), true) },
    isTty: false,
    format: "text" as const,
  };
  return { ctx, out: () => out, err: () => err };
}

async function runGate(args: string[], defaults: GateDefaults = {}, deps: GateDeps = {}, env: Record<string, string | undefined> = {}) {
  const { ctx, out, err } = makeCtx(env);
  try {
    const code = await gateHandler(defaults, { home, sleep: async () => {}, jitter: () => 0, expectDelaysMs: [0], ...deps })(args, ctx);
    return { code, out: out(), err: err() };
  } catch (e) {
    if (e instanceof CliExit) return { code: e.code, out: out(), err: err() };
    throw e;
  }
}

async function runSurface(args: string[], defaults: GateDefaults = {}, deps: GateDeps = {}, env: Record<string, string | undefined> = {}) {
  const { ctx, out, err } = makeCtx(env);
  try {
    const code = await surfaceHandler(defaults, { home, sleep: async () => {}, jitter: () => 0, ...deps })(args, ctx);
    return { code, out: out(), err: err() };
  } catch (e) {
    if (e instanceof CliExit) return { code: e.code, out: out(), err: err() };
    throw e;
  }
}

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "gate-seams-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const s: Seen = { method: req.method, path: url.pathname, query: url.searchParams, body: await req.text() };
      seen.push(s);
      const custom = override[`${s.method} ${s.path}`]?.(s);
      if (custom !== undefined) return custom;
      if (s.method === "GET" && s.path === "/v1/gates/receipts") {
        const issue = s.query.get("issue") ?? "";
        const receipts = (store[issue] ?? []).map((r) => ({ comment_id: r.comment_id, created_at: r.created_at, marker_version: r.marker_version, payload: r.payload, source: "marker", record_sha256: null, author: { kind: "app", name: null } }));
        return Response.json({ issue, receipts, invalid: 0, contract_version: "gates-contract/v1" });
      }
      if (s.method === "POST" && s.path === "/v1/gates/receipts") {
        const body = JSON.parse(s.body) as { comment_id: string; issue: string; receipt: Record<string, unknown>; prose: string };
        const row: StoredRow = { comment_id: body.comment_id, created_at: at(), marker_version: "v2", payload: body.receipt, prose: body.prose };
        (store[body.issue] ??= []).push(row);
        return Response.json(
          { comment_id: body.comment_id, issue: body.issue, gate: body.receipt.gate, created_at: row.created_at, record_sha256: sha256Hex(JSON.stringify(body.receipt)), contract_version: "gates-contract/v1" },
          { status: 201 },
        );
      }
      if (s.method === "GET" && s.path.startsWith("/v1/gates/artifacts/")) return problem(404, "artifact_not_found");
      if (s.method === "GET" && s.path === "/v1/asks") return Response.json({ asks });
      return problem(404, "not_found");
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
  seen = [];
  clock = 0;
  asks = [];
  override = {};
});

describe("GateDefaults seams", () => {
  // admits: integration: resolveActor, pulled({cwd,home}), ladderFile(ctx), and burdenSurfaces must each reach the verb engines end-to-end across record, skip, check, and surface lock/unlock; static types alone cannot verify runtime wiring.
  it("routes resolveActor, pulled({cwd, home}), ladderFile(ctx), and burdenSurfaces through record, skip, check, and surface", async () => {
    const work = realpathSync(mkdtempSync(join(sandbox, "seams-")));
    const note = join(work, "plan.md");
    writeFileSync(note, "# plan\n");
    const ladder = join(work, "ladder.yaml");
    writeFileSync(ladder, `classes:\n  U1: ${HUMAN_BEFORE}\n`);
    const rubric = join(work, "rubric.yaml");
    writeFileSync(rubric, "surfaces:\n  auth: [test-run]\n");
    mkdirSync(join(work, ".claude"), { recursive: true });
    writeFileSync(join(work, ".claude", "surfaces.yml"), `surfaces:\n  auth:\n    paths: ["src/auth/**"]\n    ledger: ${LEDGER}\n`);

    const pulledReqs: Array<{ cwd?: string; home?: string }> = [];
    const actorCalls: string[] = [];
    const defaults: GateDefaults = {
      pulled: async (_ctx, req) => {
        pulledReqs.push({ cwd: req?.cwd, home: req?.home });
        return { ok: true, value: null };
      },
      ladderFile: () => ladder,
      resolveActor: async (req) => {
        actorCalls.push(req.flag ?? "(auto)");
        return { actor: req.flag ?? "session:house-42", actorInfo: { kind: "session", runtime: "opencode", name: "house-loop" } };
      },
      burdenSurfaces: async () => ({ changed: ["src/auth/a.ts"], surfaces: ["auth"], known: ["auth"] }),
    };

    const rec = await runGate(["record", "final-gates", "--issue", ISSUE, "--verdict", "PASS", "--artifact", note, "--impact", "U1"], defaults, { cwd: work });
    expect(rec.code).toBe(0);
    expect(store[ISSUE]![0]!.payload.actor).toBe("session:house-42");
    expect(store[ISSUE]![0]!.payload.actor_info).toEqual({ kind: "session", runtime: "opencode", name: "house-loop" });
    expect(pulledReqs[0]).toEqual({ cwd: work, home });

    const sk = await runGate(["skip", "revert-path", "--issue", ISSUE, "--reason", "not needed in sandbox", "--authorized", "Ada asked: skip it", "--artifact", note], defaults, { cwd: work });
    expect(sk.code).toBe(0);
    expect(store[ISSUE]![1]!.payload.actor).toBe("session:house-42");

    // Function-form ladderFile puts U1 at the human-before rung and burdenSurfaces reports crossing `auth` requiring `test-run`.
    const chk = await runGate(["check", "--issue", ISSUE, "--gates", "final-gates", "--burden", rubric, "--base", "main"], defaults, { cwd: work });
    expect(chk.code).toBe(3);
    expect(chk.out).toContain("burden\tunmet\ttest-run\n");
    expect(chk.out).toContain(`@door\t${HUMAN_BEFORE}\tU1:auth\n`);

    // Surface lock and unlock use resolveActor too.
    const lock = await runSurface(["lock", "auth", "--reason", "incident", "--authorized", "Ada asked: freeze"], defaults, { cwd: work });
    expect(lock.code).toBe(0);
    expect(store[LEDGER]![0]!.payload.actor).toBe("session:house-42");
    expect(actorCalls).toEqual(["(auto)", "(auto)", "(auto)"]);
  });

  // admits: boundary-io: receiptLink must inject `{link}` into rendered prose, append stderr note, report store sha256 mismatch, and leave prose clean with no blank line when unset; observed across HTTP POST payload and stderr.
  it("renders {link} with receiptLink, warns on store sha mismatch, and omits {link} cleanly when unset", async () => {
    const work = realpathSync(mkdtempSync(join(sandbox, "link-")));
    const note = join(work, "plan.md");
    writeFileSync(note, "# plan\n");

    // Unset: no link line and no extra blank line before closing `+++`.
    const plain = await runGate(["record", "plan-review", "--issue", ISSUE, "--verdict", "PASS", "--artifact", note], {}, { cwd: work });
    expect(plain.code).toBe(0);
    expect(store[ISSUE]![0]!.prose).not.toContain("View:");
    expect(store[ISSUE]![0]!.prose).not.toContain("\n\n\n+++");

    // Set: link line rendered before closing `+++` and note printed on stderr.
    const mismatches: Array<{ url: string; storeSha: string | undefined }> = [];
    const linkDefaults: GateDefaults = {
      receiptLink: () => ({
        url: (sha) => `https://viewer.example.com/receipt/${sha}`,
        line: (sha, url) => `- View: [receipt \`${sha.slice(0, 12)}\`](${url})`,
        note: (url) => `, View ${url}`,
        onMismatch: (url, storeSha) => mismatches.push({ url, storeSha }),
      }),
    };
    const linked = await runGate(["record", "premise-gate", "--issue", ISSUE, "--verdict", "PASS", "--artifact", note], linkDefaults, { cwd: work });
    expect(linked.code).toBe(0);
    const sha = sha256Hex(JSON.stringify(store[ISSUE]![1]!.payload));
    expect(store[ISSUE]![1]!.prose).toContain(`- View: [receipt \`${sha.slice(0, 12)}\`](https://viewer.example.com/receipt/${sha})\n\n+++`);
    expect(linked.err).toContain(`, View https://viewer.example.com/receipt/${sha}`);
    expect(mismatches).toEqual([]);

    // Mismatch: store returns a different record_sha256 -> onMismatch fires.
    override["POST /v1/gates/receipts"] = (s) => {
      const body = JSON.parse(s.body) as { comment_id: string; issue: string; receipt: Record<string, unknown>; prose: string };
      (store[body.issue] ??= []).push({ comment_id: body.comment_id, created_at: at(), marker_version: "v2", payload: body.receipt, prose: body.prose });
      return Response.json({ comment_id: body.comment_id, issue: body.issue, gate: body.receipt.gate, created_at: at(), record_sha256: "f".repeat(64), contract_version: "gates-contract/v1" }, { status: 201 });
    };
    const mis = await runGate(["record", "sdk-check", "--issue", ISSUE, "--verdict", "PASS", "--artifact", note], linkDefaults, { cwd: work });
    expect(mis.code).toBe(0);
    expect(mismatches.length).toBe(1);
    expect(mismatches[0]!.storeSha).toBe("f".repeat(64));
  });

  // admits: integration: distribution subcommands must register in gateRows, appear in gate --help, dispatch cleanly, and refuse any collision with built-in verbs (record, skip, check, ci).
  it("dispatches distribution subcommands, shows them in help, and refuses built-in collisions", async () => {
    const received: string[][] = [];
    const defaults: GateDefaults = {
      gateSummary: "Gate receipts (custom)",
      subcommands: {
        custom: {
          row: { summary: "Custom gate subcommand", flags: [{ name: "--flag", takesValue: true }], usage: "--flag <v>" },
          usageLine: "custom --flag <v>\n                          Custom gate subcommand",
          run: async (args, ctx) => {
            received.push(args);
            ctx.stdout.write(`ran:${args.join(",")}\n`);
            return 0;
          },
        },
      },
    };
    const p = gatePlugin(defaults);
    expect(String(p.rows.gate.summary)).toBe("Gate receipts (custom)");
    expect((p.rows as Record<string, unknown>)["gate custom"]).toBeDefined();

    const help = await runGate(["--help"], defaults);
    expect(help.code).toBe(0);
    expect(help.out).toContain("custom --flag <v>");

    const ran = await runGate(["custom", "--flag", "ok"], defaults);
    expect(ran).toEqual({ code: 0, out: "ran:--flag,ok\n", err: "" });
    expect(received).toEqual([["--flag", "ok"]]);

    for (const builtin of ["record", "skip", "check", "ci"]) {
      expect(() =>
        gateRows({
          subcommands: {
            [builtin]: { row: { summary: "bad", flags: [], usage: "" }, run: async () => 0 },
          },
        }),
      ).toThrow(/built in/);
    }
  });

  // admits: boundary-io: `--asks` callers rely on the `{"asks":...}` line even when receipt listing fails (e.g. gate-receipt-unseen or 503); verified over loopback HTTP.
  it("emits @asks and the JSON asks line when --asks is set even if receipt listing fails", async () => {
    asks = [{ id: "ask-1", question: "Ship?", door: "one-way", blocking: true, state: "open", binds: { issue: ISSUE }, schema: "ask@1" }];
    override["GET /v1/gates/receipts"] = () => problem(503, "store_down");
    const r = await runGate(["check", "--issue", ISSUE, "--gates", "plan-review", "--asks"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("@asks\topen\t1\n");
    expect(r.out).toContain(`"asks":{"issue":"${ISSUE}","state":"open","open":[{"id":"ask-1","question":"Ship?","door":"one-way","binds":{"issue":"${ISSUE}"}}]}`);
    expect(r.err).toContain("slug: gate-store-unreachable");
  });

  // admits: boundary-io: detached worktrees lacking local refs/remotes/origin/* must fall back to read-only `git ls-remote origin`, and an unreachable origin must fail closed as gate-artifact-uncommitted.
  it("uses git ls-remote origin fallback in a detached checkout and fails closed when origin is unreachable", async () => {
    const bare = join(sandbox, "lsremote-origin.git");
    git(sandbox, ["init", "--bare", bare]);
    const mainClone = join(sandbox, "lsremote-main");
    git(sandbox, ["clone", bare, mainClone]);
    writeFileSync(join(mainClone, "plan.md"), "# plan\n");
    git(mainClone, ["add", "plan.md"]);
    git(mainClone, ["commit", "-m", "add plan"]);
    git(mainClone, ["push", "origin", "HEAD:refs/heads/main"]);
    const head = git(mainClone, ["rev-parse", "HEAD"]);

    // Detached clone with NO refs/remotes/origin/* locally, hosted origin URL, and real git ls-remote routed to `bare`.
    const detached = join(sandbox, "lsremote-detached");
    git(sandbox, ["init", detached]);
    git(detached, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]);
    git(detached, ["fetch", "--no-tags", bare, head]);
    git(detached, ["checkout", "--detach", "FETCH_HEAD"]);

    const env = { PATH: process.env.PATH, HOME: home, GIT_CEILING_DIRECTORIES: sandbox };
    const live = liveGit(env);
    const withRemote = (target: string): Git => ({
      env,
      run: (argv, opts) => live.run(argv.includes("ls-remote") ? argv.map((a) => (a === "origin" ? target : a)) : argv, opts),
    });

    const sha = sha256Hex("# plan\n");
    const located = await locateArtifact(withRemote(bare), detached, "plan.md", sha);
    expect(located).toEqual({ _tag: "git", repo: "acme/widgets", ref: head, commit: head, path: "plan.md", sha256: sha });

    // Unreachable remote -> ls-remote fails -> fails closed (gate-artifact-uncommitted).
    await expect(locateArtifact(withRemote(join(sandbox, "does-not-exist.git")), detached, "plan.md", sha)).rejects.toThrow(/not pushed to origin/);
  });

  // admits: boundary-io: an oversized final-gates.diff with final-gates.base beside it must record diff-rebuild: evidence and re-derive matching bytes in `check` after the diff file is removed.
  it("records diff-rebuild: evidence for oversized final-gates.diff and re-derives it on check once deleted", async () => {
    const repo = join(sandbox, "rebuild-repo");
    mkdirSync(repo, { recursive: true });
    git(repo, ["init"]);
    git(repo, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]);
    writeFileSync(join(repo, "big.txt"), "seed\n");
    git(repo, ["add", "big.txt"]);
    git(repo, ["commit", "-m", "base"]);
    const baseSha = git(repo, ["rev-parse", "HEAD"]);

    // Incompressible >50 KiB diff so gzip+base64 exceeds COPY_MAX_BYTES (48 KiB).
    const chunks: string[] = [];
    for (let i = 0; i < 2400; i++) chunks.push(`${sha256Hex(`line-${i}`)} ${i}`);
    writeFileSync(join(repo, "big.txt"), `${chunks.join("\n")}\n`);
    git(repo, ["add", "big.txt"]);
    git(repo, ["commit", "-m", "big change"]);
    const headSha = git(repo, ["rev-parse", "HEAD"]);

    const scratch = join(sandbox, "diff-dir");
    mkdirSync(scratch, { recursive: true });
    const diffPath = join(scratch, "final-gates.diff");
    const basePath = join(scratch, "final-gates.base");
    const diffRes = spawnSync("git", ["diff", "--no-ext-diff", "--no-color", baseSha, headSha], { cwd: repo });
    writeFileSync(diffPath, diffRes.stdout);
    writeFileSync(basePath, `${baseSha}\n`);

    const rec = await runGate(["record", "final-gates", "--issue", ISSUE, "--verdict", "PASS", "--artifact", diffPath, "--impact", "U0"], {}, { cwd: repo });
    expect(rec.code).toBe(0);
    expect(rec.err).toContain("check re-derives it from the recorded base and head");
    const ev = store[ISSUE]![0]!.payload.evidence as Array<{ kind: string; content?: string }>;
    expect(ev.some((e) => e.kind === "text" && e.content === `diff-rebuild: repo=acme/widgets base=${baseSha} head=${headSha}`)).toBe(true);

    // Delete the diff file; check re-derives it from git and passes.
    unlinkSync(diffPath);
    const chk = await runGate(["check", "--issue", ISSUE, "--gates", "final-gates"], {}, { cwd: repo });
    expect(chk.code).toBe(0);
    expect(chk.out).toContain("final-gates\tpass\tPASS\n");
  });

  // admits: integration: lazy SDK helpers (recordGateReceipt, listGateReceipts, gateHumanSignoff, judgeGateMonotone, readGateLadder, renderGateProse) must compose end-to-end with GateDefaults without duplicating engine logic.
  it("exposes lazy programmatic gate helpers on eris/sdk", async () => {
    const work = realpathSync(mkdtempSync(join(sandbox, "sdk-helpers-")));
    const note = join(work, "artifact.md");
    writeFileSync(note, "# ok\n");
    const ladder = join(work, "ladder.yaml");
    writeFileSync(ladder, `classes:\n  U2: ${HUMAN_BEFORE}\n`);

    const { ctx } = makeCtx();
    const defaults: GateDefaults = {
      resolveActor: async () => ({ actor: "session:sdk-1" }),
      receiptLink: () => ({
        url: (sha) => `https://viewer.example.com/${sha}`,
        line: (_sha, url) => `- Link: ${url}`,
      }),
    };
    const rec = await recordGateReceipt(
      ctx,
      defaults,
      { gate: "surface-widen", issue: ISSUE, verdict: "PASS", artifact: note, authorized: "Ada asked: widen", evidence: [{ kind: "text", content: "ok" }] },
      { home, cwd: work, sleep: async () => {}, jitter: () => 0 },
    );
    expect(rec.receipt.actor).toBe("session:sdk-1");
    expect(rec.linkUrl).toBe(`https://viewer.example.com/${sha256Hex(JSON.stringify(rec.receipt))}`);

    const listed = await listGateReceipts(ctx, defaults, ISSUE, { home, cwd: work, sleep: async () => {}, jitter: () => 0 });
    expect(listed.receipts.length).toBe(1);

    const signoff = await gateHumanSignoff(ctx, defaults, ISSUE, "surface-widen", { home, cwd: work, sleep: async () => {}, jitter: () => 0 });
    expect(signoff.why).toBeNull();
    expect(new TextDecoder().decode(signoff.bytes)).toBe("# ok\n");

    const loadedLadder = await readGateLadder(ladder);
    expect(loadedLadder?.classes.U2).toBe(HUMAN_BEFORE);
    expect(await readGateLadder(join(work, "missing.yaml"))).toBeNull();

    const prose = await renderGateProse(rec.receipt, [], "- Link: https://viewer.example.com/x");
    expect(prose).toContain("- Link: https://viewer.example.com/x\n\n+++");

    // judgeGateMonotone on a clean git repo with no widening passes.
    const repo = join(sandbox, "mono-repo");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    git(repo, ["init"]);
    writeFileSync(join(repo, ".claude", "surfaces.yml"), "surfaces:\n  auth:\n    paths: ['src/auth/**']\n");
    git(repo, ["add", ".claude/surfaces.yml"]);
    git(repo, ["commit", "-m", "base"]);
    const baseSha = git(repo, ["rev-parse", "HEAD"]);
    const monoOut: string[] = [];
    const monoErr: string[] = [];
    await judgeGateMonotone(ctx, defaults, { base: baseSha, registry: ".claude/surfaces.yml", out: (l) => monoOut.push(l), err: (l) => monoErr.push(l) }, { home, cwd: repo });
    expect(monoOut).toEqual([]);
    expect(monoErr.join("\n")).toContain("0 tighter, 0 wider");
  });
});
