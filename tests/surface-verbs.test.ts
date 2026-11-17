/**
 * `eris surface lock | unlock | digest` at the verb seam: the surface handler driven with argv, a
 * loopback `Bun.serve` standing in for the gateway (an in-memory receipt store), a sandbox HOME holding
 * the login, and a registry file outside any git repo so the receipt's artifact is a plain file. Every
 * request crosses real HTTP. The bearer is assembled at runtime so no literal trips a secret scanner.
 * Parity with the private verbs is the same rows, exit codes and stdout the private fixtures assert.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256Hex } from "eris/gates-contract";
import { type GateDeps } from "../plugins/gate/gate";
import { lockState } from "../plugins/gate/ledger";
import { surfaceHandler } from "../plugins/gate/surface-verb";
import { CliExit } from "../src/cli/ts-verb";

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, "..");
const ORG = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const LOGIN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const LEDGER = "ABC-9";
const HUMAN = "Dan asked: pull the plug";
const REGISTRY = `surfaces:
  auth:
    paths: ["src/auth/**"]
    one_way_unlock: { merge: [adversarial-review] }
    ledger: ${LEDGER}
  billing:
    paths: ["src/billing/**"]
`;

interface StoredRow {
  comment_id: string;
  created_at: string;
  marker_version: "v2";
  payload: unknown;
}

let sandbox: string;
let home: string;
let work: string;
let server: ReturnType<typeof Bun.serve>;
let store: Record<string, StoredRow[]>;
let posts: { comment_id: string; issue: string; receipt: Record<string, unknown> }[];
let clock: number;

const at = () => new Date(Date.UTC(2026, 10, 17, 10, 0, clock++)).toISOString();

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "surface-verbs-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/v1/gates/receipts") {
        const issue = url.searchParams.get("issue") ?? "";
        const receipts = (store[issue] ?? []).map((r) => ({ ...r, source: "olympus", record_sha256: null, author: { kind: "app", name: null } }));
        return Response.json({ issue, receipts, invalid: 0, contract_version: "gates-contract/v1" });
      }
      if (req.method === "POST" && url.pathname === "/v1/gates/receipts") {
        const body = JSON.parse(await req.text()) as { comment_id: string; issue: string; receipt: { gate: string } };
        posts.push(body);
        const row = { comment_id: body.comment_id, created_at: at(), marker_version: "v2" as const, payload: body.receipt };
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
  work = realpathSync(mkdtempSync(join(sandbox, "work-")));
  mkdirSync(join(work, ".claude"));
  writeFileSync(join(work, ".claude", "surfaces.yml"), REGISTRY);
  store = {};
  posts = [];
  clock = 0;
});

interface Ran {
  code: number;
  out: string;
  err: string;
}

async function surface(args: string[], deps: GateDeps = {}): Promise<Ran> {
  let out = "";
  let err = "";
  const ctx = {
    erisDir: REPO,
    env: { HOME: home, PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: sandbox },
    stdout: { write: (s: string) => ((out += s), true) },
    stderr: { write: (s: string) => ((err += s), true) },
    format: "text" as const,
  };
  const all: GateDeps = { home, cwd: work, now: () => new Date("2026-11-17T09:00:00.000Z"), sleep: async () => {}, jitter: () => 0, ...deps };
  try {
    return { code: await surfaceHandler({}, all)(args, ctx), out, err };
  } catch (e) {
    if (e instanceof CliExit) return { code: e.code, out, err };
    throw e;
  }
}

const lock = (extra: string[] = ["--authorized", HUMAN]) => surface(["lock", "auth", "--reason", "incident in flight", ...extra]);

describe("surface lock and unlock", () => {
  // admits: the human-write rule at the CLI edge: the same call succeeds only with a human grant, and a refused call sends nothing (observed at exit code, slug and the store's POST count).
  it("refuses a lock without a human grant, locks on one, and a second lock records nothing", async () => {
    const none = await lock([]);
    expect(none.code).toBe(3);
    expect(none.err).toContain("surface-lock-unauthorized");
    const doctrine = await lock(["--authorized", "doctrine:auto"]);
    expect(doctrine.code).toBe(3);
    expect(doctrine.err).toContain("not a human grant");
    expect(posts).toHaveLength(0);

    const locked = await lock();
    expect(locked.code).toBe(0);
    expect(locked.out).toBe(`${posts[0]!.comment_id}\n`);
    expect(locked.err).toContain("locked auth (ledger ABC-9)");
    expect(posts[0]).toMatchObject({ issue: LEDGER, receipt: { gate: "surface-lock", verdict: "PASS", authorized: HUMAN } });
    const again = await lock();
    expect({ code: again.code, out: again.out, posts: posts.length }).toEqual({ code: 0, out: "-\n", posts: 1 });
  });

  // admits: unlocking restores the open state, and lifting needs the same human grant as locking.
  it("lifts a lock only on a human grant, and a lift of an open surface records nothing", async () => {
    await lock();
    const bad = await surface(["unlock", "auth", "--authorized", "doctrine:auto"]);
    expect(bad.code).toBe(3);
    const lifted = await surface(["unlock", "auth", "--authorized", HUMAN, "--reason", "fixed"]);
    expect(lifted.code).toBe(0);
    expect(lifted.err).toContain("unlocked auth");
    expect(posts[1]).toMatchObject({ receipt: { gate: "surface-lock", verdict: "AMENDED" } });
    const open = await surface(["unlock", "auth", "--authorized", HUMAN]);
    expect({ out: open.out, posts: posts.length }).toEqual({ out: "-\n", posts: 2 });
  });

  // admits: a surface the registry lacks, or one with no ledger, has nothing to lock; each refuses at the edge before any write, and a missing flag is exit 1 as in the private verb.
  it("refuses an unknown surface, a surface with no ledger and a missing --reason", async () => {
    const unknown = await surface(["lock", "nope", "--reason", "x y z", "--authorized", HUMAN]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("nope: not a surface");
    const ledgerless = await surface(["lock", "billing", "--reason", "x y z", "--authorized", HUMAN]);
    expect(ledgerless.code).toBe(2);
    expect(ledgerless.err).toContain("billing: has no ledger");
    const noReason = await surface(["lock", "auth", "--authorized", HUMAN]);
    expect({ code: noReason.code, err: noReason.err.includes("missing --reason") }).toEqual({ code: 1, err: true });
    expect(posts).toHaveLength(0);
  });

  // admits: a lock this verb writes must read locked to the reader `eris gate ci`'s unlock leg uses (`lockState`), and a lift must read open: the write and read halves live in different files.
  it("writes a lock that lockState reads locked, and a lift it reads open", async () => {
    const rows = () => (store[LEDGER] ?? []).map((r) => ({ commentId: r.comment_id, createdAt: r.created_at, version: r.marker_version, payload: r.payload })) as never;
    await lock();
    expect(lockState(LEDGER, rows()).locked).toBe(true);
    await surface(["unlock", "auth", "--authorized", HUMAN, "--reason", "fixed"]);
    expect(lockState(LEDGER, rows()).locked).toBe(false);
  });
});

describe("surface digest", () => {
  // admits: the digest rolls up receipts by action inside the window; paired with an empty window, a locked surface and a receipt outside the window, observed as the exact stdout rows.
  it("prints one row per surface and a roll-up line", async () => {
    const empty = await surface(["digest"]);
    expect(empty.out).toBe("auth\tABC-9\t0\t0\t0\topen\nbilling\t-\t0\t0\t0\t-\n@digest\tunlocked one-way since Nov-16: none; locked: none\n");

    const spend = (gate: string, createdAt: string) =>
      (store[LEDGER] ??= []).push({
        comment_id: `s-${gate}-${createdAt}`,
        created_at: createdAt,
        marker_version: "v2",
        payload: { schema: "gate-receipt@v2", gate, issue: LEDGER, verdict: "PASS", artifact: { _tag: "file", path: "/x", sha256: sha256Hex("x") }, actor: "a", evidence: [], recorded_at: createdAt },
      });
    spend("unlocked-merge", "2026-11-17T08:00:00.000Z");
    spend("unlocked-merge", "2026-11-01T08:00:00.000Z");
    await lock();
    const week = await surface(["digest", "--since", "7d"]);
    expect(week.out).toContain("auth\tABC-9\t1\t0\t0\tlocked\n");
    expect(week.out).toBe("auth\tABC-9\t1\t0\t0\tlocked\nbilling\t-\t0\t0\t0\t-\n@digest\tunlocked one-way since Nov-10: 1 (merge 1) on auth; locked: auth\n");
  });

  // admits: a malformed window is a usage error before any read, and an invalid registry is a precondition failure (exit 3), as in the private verb.
  it("refuses a bad --since and an invalid registry", async () => {
    const bad = await surface(["digest", "--since", "soon"]);
    expect({ code: bad.code, err: bad.err.includes("not <n>h or <n>d") }).toEqual({ code: 1, err: true });
    writeFileSync(join(work, ".claude", "surfaces.yml"), "surfaces: {}\nglobs: [x]\n");
    const invalid = await surface(["digest"]);
    expect(invalid.code).toBe(3);
    expect(invalid.err).toContain("gate-surfaces-invalid");
  });
});
