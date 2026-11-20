/**
 * `eris gate check --unlock merge|deploy|effect` and `--announce`: hard rules (`foreign-deploy`,
 * `data-destroying-effect`, `hard-rule:` override on `door-signoff`), deterministic v5 UUID
 * idempotency (`commentIdFor`), mid-flight surface lock re-read before recording `unlocked-<action>`,
 * full 40-hex `--head-sha` enforcement, and CLI flag exclusivity.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256Hex } from "eris/gates-contract";
import { CliExit, type GateDefaults, type GateDeps, gateHandler } from "eris/sdk";
import { commentIdFor } from "../plugins/gate/ledger";

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, "..");
const ORG = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const LOGIN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const ISSUE = "ABC-50";
const LEDGER = "ABC-99";
const DOCTRINE_UNLOCK_ON = `active: auto

## auto
Auto unlock.
\`\`\`yaml
policy:
  signoff:
    unlock: on
\`\`\`
`;

interface StoredRow {
  comment_id: string;
  created_at: string;
  marker_version: "v2";
  payload: Record<string, unknown>;
}

let sandbox: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let store: Record<string, StoredRow[]>;
let clock: number;
let onReceiptRead: ((issue: string) => void) | undefined;

const at = () => new Date(Date.UTC(2026, 10, 17, 10, 0, clock++)).toISOString();

function git(dir: string, args: string[]): string {
  const r = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${r.stderr}`);
  return r.stdout.trim();
}

async function runGate(args: string[], defaults: GateDefaults = {}, deps: GateDeps = {}) {
  let out = "";
  let err = "";
  const ctx = {
    erisDir: REPO,
    env: { PATH: process.env.PATH, HOME: home, GIT_CEILING_DIRECTORIES: sandbox },
    stdout: { write: (s: string) => ((out += s), true) },
    stderr: { write: (s: string) => ((err += s), true) },
    isTty: false,
    format: "text" as const,
  };
  try {
    const code = await gateHandler(defaults, { home, now: () => new Date("2026-11-17T12:00:00.000Z"), sleep: async () => {}, jitter: () => 0, ...deps })(args, ctx);
    return { code, out, err };
  } catch (e) {
    if (e instanceof CliExit) return { code: e.code, out, err };
    throw e;
  }
}

function seedReceipt(issue: string, gate: string, artifact: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const payload = {
    schema: "gate-receipt@v2",
    gate,
    issue,
    verdict: "PASS",
    artifact,
    actor: "ada@example.com",
    evidence: [],
    recorded_at: at(),
    ...extra,
  };
  (store[issue] ??= []).push({ comment_id: `seed-${clock}`, created_at: at(), marker_version: "v2", payload });
}

function makeRepoWithSurface(name: string) {
  const repo = join(sandbox, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]);
  mkdirSync(join(repo, ".claude"), { recursive: true });
  mkdirSync(join(repo, "src", "auth"), { recursive: true });
  writeFileSync(
    join(repo, ".claude", "surfaces.yml"),
    `surfaces:\n  auth:\n    paths: ["src/auth/**"]\n    ledger: ${LEDGER}\n    change_budget: 2\n    one_way_unlock:\n      merge: [posture-check]\n      deploy: [posture-check]\n      effect: [posture-check]\n`,
  );
  writeFileSync(join(repo, "src", "auth", "login.ts"), "export const v = 1;\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);

  // Feature change crossing `auth` surface.
  git(repo, ["checkout", "-b", "feat"]);
  writeFileSync(join(repo, "src", "auth", "login.ts"), "export const v = 2;\n");
  git(repo, ["add", "src/auth/login.ts"]);
  git(repo, ["commit", "-m", "touch auth"]);
  git(repo, ["update-ref", "refs/remotes/origin/feat", "HEAD"]);
  const headSha = git(repo, ["rev-parse", "HEAD"]);

  const doctrineFile = join(sandbox, `${name}-doctrine.md`);
  writeFileSync(doctrineFile, DOCTRINE_UNLOCK_ON);
  const regSha = sha256Hex(readFileSync(join(repo, ".claude", "surfaces.yml")));
  const loginSha = sha256Hex(readFileSync(join(repo, "src", "auth", "login.ts")));

  return {
    repo,
    baseSha,
    headSha,
    doctrineFile,
    regArtifact: { _tag: "git", repo: "acme/widgets", ref: "feat", commit: headSha, path: ".claude/surfaces.yml", sha256: regSha },
    loginArtifact: { _tag: "git", repo: "acme/widgets", ref: "feat", commit: headSha, path: "src/auth/login.ts", sha256: loginSha },
  };
}

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "gate-unlock-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/v1/gates/receipts") {
        const issue = url.searchParams.get("issue") ?? "";
        onReceiptRead?.(issue);
        const receipts = (store[issue] ?? []).map((r) => ({ comment_id: r.comment_id, created_at: r.created_at, marker_version: r.marker_version, payload: r.payload, source: "marker", record_sha256: null, author: { kind: "app", name: null } }));
        return Response.json({ issue, receipts, invalid: 0, contract_version: "gates-contract/v1" });
      }
      if (req.method === "POST" && url.pathname === "/v1/gates/receipts") {
        const body = JSON.parse(await req.text()) as { comment_id: string; issue: string; receipt: Record<string, unknown> };
        const existing = (store[body.issue] ?? []).find((r) => r.comment_id === body.comment_id);
        if (existing !== undefined) {
          return Response.json({ status: 409, code: "comment_conflict" }, { status: 409, headers: { "content-type": "application/problem+json" } });
        }
        const row: StoredRow = { comment_id: body.comment_id, created_at: at(), marker_version: "v2", payload: body.receipt };
        (store[body.issue] ??= []).push(row);
        return Response.json(
          { comment_id: body.comment_id, issue: body.issue, gate: body.receipt.gate, created_at: row.created_at, record_sha256: sha256Hex(JSON.stringify(body.receipt)), contract_version: "gates-contract/v1" },
          { status: 201 },
        );
      }
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
  clock = 0;
  onReceiptRead = undefined;
});

describe("gate check --unlock", () => {
  // admits: boundary-io: CLI flag validation must reject exclusive flags, invalid actions, missing --target on deploy, missing --effect-kind on effect, and non-40-hex --head-sha with --announce before any gateway call.
  it("refuses invalid --unlock flag combinations before reaching the gateway", async () => {
    const f = makeRepoWithSurface("flags");
    const excl = await runGate(["check", "--issue", ISSUE, "--unlock", "merge", "--gates", "plan-review"], {}, { cwd: f.repo });
    expect(excl.code).toBe(1);
    expect(excl.err).toContain("exclusive");

    const badAction = await runGate(["check", "--issue", ISSUE, "--unlock", "ship"], {}, { cwd: f.repo });
    expect(badAction.code).toBe(1);
    expect(badAction.err).toContain("not merge, deploy or effect");

    const noTarget = await runGate(["check", "--issue", ISSUE, "--unlock", "deploy"], {}, { cwd: f.repo });
    expect(noTarget.code).toBe(1);
    expect(noTarget.err).toContain("--target");

    const noKind = await runGate(["check", "--issue", ISSUE, "--unlock", "effect"], {}, { cwd: f.repo });
    expect(noKind.code).toBe(1);
    expect(noKind.err).toContain("--effect-kind");

    const shortSha = await runGate(["check", "--issue", ISSUE, "--unlock", "merge", "--base", f.baseSha, "--head-sha", f.headSha.slice(0, 12), "--announce", "--doctrine", f.doctrineFile], {}, { cwd: f.repo });
    expect(shortSha.code).toBe(3);
    expect(shortSha.err).toContain("slug: gate-unlock-unresolved");
  });

  // admits: integration: hard rules (foreign-deploy and data-destroying-effect) must never auto-unlock even when every bar gate, baseline, and budget passes, and must yield only to a human door-signoff carrying both `door:` and `hard-rule:`.
  it("enforces foreign-deploy and data-destroying-effect hard rules and allows explicit human hard-rule override", async () => {
    const f = makeRepoWithSurface("hard");
    seedReceipt(LEDGER, "audit-surfaces", f.regArtifact);
    seedReceipt(ISSUE, "posture-check", f.loginArtifact);

    // Same-owner deploy unlocks with --announce.
    const sameDeploy = await runGate(
      ["check", "--issue", ISSUE, "--unlock", "deploy", "--base", f.baseSha, "--target", "acme/widgets", "--announce", "--doctrine", f.doctrineFile],
      {},
      { cwd: f.repo },
    );
    expect(sameDeploy.code).toBe(0);
    expect(sameDeploy.out).toContain("@announce\trecorded\tauth\n");
    expect(sameDeploy.out).toContain("@unlock\tunlocked\tdeploy\n");

    // Foreign deploy never unlocks -> @unlock never deploy.
    const foreign = await runGate(
      ["check", "--issue", ISSUE, "--unlock", "deploy", "--base", f.baseSha, "--target", "other/service", "--announce", "--doctrine", f.doctrineFile],
      {},
      { cwd: f.repo },
    );
    expect(foreign.code).toBe(3);
    expect(foreign.out).toContain("@unlock\tnever\tdeploy\n");
    expect(foreign.err).toContain("slug: gate-unlock-human");
    expect(foreign.err).toContain("foreign-deploy");

    // Destructive effect never unlocks -> @unlock never effect.
    const destructive = await runGate(
      ["check", "--issue", ISSUE, "--unlock", "effect", "--base", f.baseSha, "--effect-kind", "table-drop", "--announce", "--doctrine", f.doctrineFile],
      {},
      { cwd: f.repo },
    );
    expect(destructive.code).toBe(3);
    expect(destructive.out).toContain("@unlock\tnever\teffect\n");
    expect(destructive.err).toContain("data-destroying-effect");

    // A human door-signoff WITHOUT `hard-rule: data-destroying-effect` is rejected.
    seedReceipt(ISSUE, "door-signoff", f.loginArtifact, {
      authorized: "Ada asked: run drop",
      evidence: [{ kind: "text", content: "door: effect", sha256: sha256Hex("door: effect") }],
    });
    const noOverride = await runGate(
      ["check", "--issue", ISSUE, "--unlock", "effect", "--base", f.baseSha, "--effect-kind", "table-drop", "--doctrine", f.doctrineFile],
      {},
      { cwd: f.repo },
    );
    expect(noOverride.code).toBe(3);
    expect(noOverride.err).toContain("hard-rule: data-destroying-effect");

    // With `hard-rule: data-destroying-effect`, the human sign-off overrides the hard rule aloud.
    const evText = "door: effect\nhard-rule: data-destroying-effect";
    seedReceipt(ISSUE, "door-signoff", f.loginArtifact, {
      authorized: "Ada asked: run drop",
      evidence: [{ kind: "text", content: evText, sha256: sha256Hex(evText) }],
    });
    const overridden = await runGate(
      ["check", "--issue", ISSUE, "--unlock", "effect", "--base", f.baseSha, "--effect-kind", "table-drop", "--doctrine", f.doctrineFile],
      {},
      { cwd: f.repo },
    );
    expect(overridden.code).toBe(0);
    expect(overridden.out).toContain("@hard-rule\toverridden\tdata-destroying-effect\n");
    expect(overridden.out).toContain("@unlock\thuman-signed\teffect\n");
    expect(overridden.err).toContain("WARN door-signoff overrides hard rule data-destroying-effect");
  });

  // admits: state-machine: `--announce` must be idempotent across retries (same deterministic v5 UUID, single budget spend) and must abort without writing if a surface is locked between decision read and announce write.
  it("announces idempotently with v5 UUID and aborts without writing if locked mid-flight", async () => {
    const f = makeRepoWithSurface("announce");
    seedReceipt(LEDGER, "audit-surfaces", f.regArtifact);
    seedReceipt(ISSUE, "posture-check", f.loginArtifact);
    const baselineAt = store[LEDGER]![0]!.created_at;

    // First --announce records once on LEDGER (deterministic v5 UUID) and once on ISSUE.
    const first = await runGate(
      ["check", "--issue", ISSUE, "--unlock", "merge", "--base", f.baseSha, "--announce", "--doctrine", f.doctrineFile],
      { resolveActor: async () => ({ actor: "session:announcer" }) },
      { cwd: f.repo },
    );
    expect(first.code).toBe(0);
    expect(first.out).toContain("@announce\trecorded\tauth\n");
    expect(first.out).toContain(`@announce\trecorded\t${ISSUE}\n`);
    expect(first.out).toContain("@unlock\tunlocked\tmerge\n");
    const ledgerAnn = store[LEDGER]!.filter((r) => r.payload.gate === "unlocked-merge");
    expect(ledgerAnn.length).toBe(1);
    expect(ledgerAnn[0]!.comment_id).toBe(commentIdFor(`${LEDGER}|merge|${f.headSha}|${baselineAt}`));
    expect(ledgerAnn[0]!.payload.actor).toBe("session:announcer");

    // Second --announce at the same head prints `already` and spends no additional budget.
    const second = await runGate(
      ["check", "--issue", ISSUE, "--unlock", "merge", "--base", f.baseSha, "--announce", "--doctrine", f.doctrineFile],
      {},
      { cwd: f.repo },
    );
    expect(second.code).toBe(0);
    expect(second.out).toContain("@announce\talready\tauth\n");
    expect(store[LEDGER]!.filter((r) => r.payload.gate === "unlocked-merge").length).toBe(1);

    // Mid-flight lock test on a fresh repo/store: surface is open during unlock decision, then locked before announceUnlocked's pre-write re-read.
    store = {};
    clock = 0;
    seedReceipt(LEDGER, "audit-surfaces", f.regArtifact);
    seedReceipt(ISSUE, "posture-check", f.loginArtifact);
    let ledgerReads = 0;
    onReceiptRead = (issue) => {
      if (issue === LEDGER) {
        ledgerReads++;
        // First read is checkUnlock's open check; second read is announceUnlocked's pre-write lock check.
        if (ledgerReads === 2) {
          seedReceipt(LEDGER, "surface-lock", f.regArtifact, {
            authorized: "Ada asked: emergency stop",
            evidence: [{ kind: "text", content: "locked auth: emergency stop", sha256: sha256Hex("locked auth: emergency stop") }],
          });
        }
      }
    };
    const racing = await runGate(
      ["check", "--issue", ISSUE, "--unlock", "merge", "--base", f.baseSha, "--announce", "--doctrine", f.doctrineFile],
      {},
      { cwd: f.repo },
    );
    expect(racing.code).toBe(3);
    expect(racing.err).toContain("locked while the announcement was being recorded; nothing was recorded");
    expect(store[LEDGER]!.filter((r) => r.payload.gate === "unlocked-merge").length).toBe(0);
  });
});
