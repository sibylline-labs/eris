/**
 * `eris gate skip --mandate` and `ERIS_MANDATE` at the CLI verb seam against a loopback gateway
 * that spends one mandate use and stamps `gate-receipt@v3` atomically on `POST /v1/gates/receipts`.
 *
 * Every request crosses real HTTP. Tokens and handles are assembled at runtime so no literal trips
 * a secret scanner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalMandateScope, GATE_RECEIPT_SCHEMA_V3, sha256Hex } from "eris/gates-contract";
import { gateHandler } from "../plugins/gate/gate";
import { CliExit } from "../src/cli/ts-verb";

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, "..");
const ORG = "01JZ8K3M4N5P6Q7R8S9T0V1W2Z";
const OTHER_ORG = "01JZ8K3M4N5P6Q7R8S9T0V1W2Y";
const LOGIN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const HANDLE_A = ["mnd", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const HANDLE_UNKNOWN = ["mnd", ORG, "A".repeat(43)].join("_");
const HANDLE_OTHER_ORG = ["mnd", OTHER_ORG, "B".repeat(43)].join("_");
const ISSUE = "ABC-9";
const SESSION = "session:ses_mnd_a";
const OTHER_SESSION = "session:ses_mnd_b";
const SCOPE = `sr:us:mandate:gate:skip?gate=e2e&work_ref=linear:${ISSUE}`;
const NOW = new Date("2026-11-18T12:00:00Z");

interface MandateEntry {
  readonly id: string;
  readonly rootId: string;
  readonly org: string;
  readonly session: string;
  readonly scopes: readonly string[];
  maxUses: number;
  usesSpent: number;
  revoked: boolean;
}

interface StoredRow {
  comment_id: string;
  created_at: string;
  marker_version: "v2";
  payload: Record<string, unknown>;
  record_sha256: string;
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
let workdir: string;
let server: ReturnType<typeof Bun.serve>;
let store: Record<string, StoredRow[]>;
let mandates: Map<string, MandateEntry>;
let uses: Array<{ readonly session: string; readonly scope: string }>;
let seen: Seen[];
let clock: number;
let ignoreMandateHandle: boolean;
let omitRecordSha: boolean;
let mandateUnavailable: boolean;
let rateLimitRemaining: number;

const problem = (status: number, code: string) =>
  Response.json({ type: "about:blank", status, code }, { status, headers: { "content-type": "application/problem+json" } });
const at = () => new Date(Date.UTC(2026, 10, 18, 12, 0, clock++)).toISOString();

function handleReceiptPost(body: { comment_id: string; issue: string; receipt: Record<string, unknown>; prose: string; mandate_handle?: string }): Response {
  if (rateLimitRemaining > 0) {
    rateLimitRemaining--;
    return problem(429, "rate_limited");
  }
  const existing = (store[body.issue] ?? []).find((r) => r.comment_id === body.comment_id);
  if (existing !== undefined) {
    return Response.json(
      {
        comment_id: existing.comment_id,
        issue: body.issue,
        gate: String(body.receipt.gate),
        created_at: existing.created_at,
        ...(omitRecordSha ? {} : { record_sha256: existing.record_sha256 }),
        contract_version: "gates-contract/v1",
      },
      { status: 201 },
    );
  }
  let payload: Record<string, unknown> = body.receipt;
  if (body.mandate_handle !== undefined && !ignoreMandateHandle) {
    if (mandateUnavailable) return problem(503, "mandate_unavailable");
    const entry = mandates.get(body.mandate_handle);
    if (entry === undefined) {
      const handleOrg = body.mandate_handle.split("_")[1];
      if (handleOrg !== undefined && handleOrg !== ORG) return problem(401, "org_mismatch");
      return problem(404, "unknown_mandate");
    }
    if (entry.org !== ORG) return problem(401, "org_mismatch");
    if (entry.revoked) return problem(401, "revoked");
    const actor = String(body.receipt.actor ?? "");
    if (!actor.startsWith("session:")) return problem(422, "mandate_session_required");
    if (actor !== entry.session) return problem(403, "mandate_out_of_path");
    const scope = canonicalMandateScope(`sr:us:mandate:gate:skip?gate=${String(body.receipt.gate)}&work_ref=linear:${body.issue}`);
    if (scope === null) return problem(422, "mandate_act_unsupported");
    if (!entry.scopes.includes(scope)) return problem(403, "not_covered");
    if (entry.usesSpent >= entry.maxUses) return problem(403, "exhausted");
    entry.usesSpent++;
    uses.push({ session: actor, scope });
    payload = {
      ...body.receipt,
      schema: GATE_RECEIPT_SCHEMA_V3,
      mandate: {
        id: entry.id,
        use_id: `01JZ8K3M4N5P6Q7R8S9T0V1W${String(entry.usesSpent).padStart(2, "0")}`,
        root_id: entry.rootId,
        scope,
        chain_digest: "A".repeat(43),
        attestation: "aa.bb.cc",
      },
    };
  }
  const sha = sha256Hex(JSON.stringify(payload));
  const row: StoredRow = { comment_id: body.comment_id, created_at: at(), marker_version: "v2", payload, record_sha256: sha, prose: body.prose };
  (store[body.issue] ??= []).push(row);
  return Response.json(
    {
      comment_id: row.comment_id,
      issue: body.issue,
      gate: String(body.receipt.gate),
      created_at: row.created_at,
      ...(omitRecordSha ? {} : { record_sha256: sha }),
      contract_version: "gates-contract/v1",
    },
    { status: 201 },
  );
}

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "eris-gate-mandate-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const s: Seen = { method: req.method, path: url.pathname, query: url.searchParams, body: await req.text() };
      seen.push(s);
      if (s.method === "GET" && s.path === "/v1/gates/receipts") {
        const issue = s.query.get("issue") ?? "";
        const receipts = (store[issue] ?? []).map((r) => ({ comment_id: r.comment_id, created_at: r.created_at, marker_version: r.marker_version, payload: r.payload, source: "olympus", record_sha256: r.record_sha256 }));
        return Response.json({ issue, receipts, invalid: 0, contract_version: "gates-contract/v1" });
      }
      if (s.method === "POST" && s.path === "/v1/gates/receipts") {
        return handleReceiptPost(JSON.parse(s.body));
      }
      if (s.method === "GET" && s.path === "/v1/asks") return Response.json({ asks: [] });
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
  workdir = realpathSync(mkdtempSync(join(sandbox, "work-")));
  writeFileSync(join(workdir, "plan.md"), "# plan\n");
  store = {};
  mandates = new Map([
    [
      HANDLE_A,
      {
        id: "01JZ8K3M4N5P6Q7R8S9T0V1W3A",
        rootId: "01JZ8K3M4N5P6Q7R8S9T0V1W3R",
        org: ORG,
        session: SESSION,
        scopes: [SCOPE],
        maxUses: 1,
        usesSpent: 0,
        revoked: false,
      },
    ],
  ]);
  uses = [];
  seen = [];
  clock = 0;
  ignoreMandateHandle = false;
  omitRecordSha = false;
  mandateUnavailable = false;
  rateLimitRemaining = 0;
});

interface Run {
  rc: number;
  stdout: string;
  stderr: string;
}

async function run(args: string[], env: Record<string, string | undefined> = {}, withLogin = true): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const handler = gateHandler({}, { cwd: workdir, home, now: () => NOW, sleep: async () => undefined, jitter: () => 0 });
  const baseEnv: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: home,
    ...(withLogin ? { ERIS_YAKS_TOKEN: LOGIN, ERIS_YAKS_URL: `http://127.0.0.1:${server.port}` } : {}),
    ...env,
  };
  let rc: number;
  try {
    rc = await handler(args, {
      erisDir: REPO,
      env: baseEnv,
      stdout: { write: (s: string) => ((stdout += s), true) },
      stderr: { write: (s: string) => ((stderr += s), true) },
      format: "text",
    });
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    rc = e.code;
  }
  return { rc, stdout, stderr };
}

const skipArgs = (extra: string[], actor = SESSION, gate = "e2e") => [
  "skip",
  gate,
  "--issue",
  ISSUE,
  "--reason",
  "covered by the parent run on this issue",
  "--artifact",
  "plan.md",
  "--actor",
  actor,
  ...extra,
];

const everything = (runs: Run[]) =>
  [...runs.flatMap((r) => [r.stdout, r.stderr]), ...Object.values(store).flat().map((r) => `${r.prose}\n${JSON.stringify(r.payload)}`)].join("\n");

describe("eris gate skip --mandate", () => {
  // admits: integration: end-to-end skip -> POST -> v3 stamp -> GET -> check flow across gate, mandate, record, check, and loopback HTTP; verifies single spend and zero handle leakage.
  it("spends one use at the store, stores gate-receipt@v3, and check reads it as a granted skip without ever printing the handle", async () => {
    const r = await run(skipArgs(["--mandate", HANDLE_A]));
    expect(r.rc).toBe(0);
    const stored = store[ISSUE]!;
    expect(stored.length).toBe(1);
    expect(r.stdout).toBe(`${stored[0]!.comment_id}\n`);
    expect(r.stderr).toContain(`mandate stamped, record ${stored[0]!.record_sha256.slice(0, 12)}`);
    expect(stored[0]!.payload.schema).toBe(GATE_RECEIPT_SCHEMA_V3);
    expect(stored[0]!.payload.authorized).toBeUndefined();
    expect(stored[0]!.payload.mandate).toMatchObject({ id: "01JZ8K3M4N5P6Q7R8S9T0V1W3A", scope: SCOPE });
    expect(uses).toEqual([{ session: SESSION, scope: SCOPE }]);

    const c = await run(["check", "--issue", ISSUE, "--gates", "e2e"]);
    expect({ rc: c.rc, stdout: c.stdout }).toEqual({ rc: 0, stdout: "e2e\tskipped\tSKIPPED\n" });
    expect(everything([r, c])).not.toContain(HANDLE_A);
  });

  // admits: boundary-io: CLI verb exit code, slug rendering, and never-echoed handle invariant across real HTTP error responses for each gateway refusal code.
  it("refuses gateway mandate rejections with exit 3, exact slug, nothing stored, and never echoing the handle", async () => {
    mandates.get(HANDLE_A)!.maxUses = 2;
    const first = await run(skipArgs(["--mandate", HANDLE_A]));
    expect(first.rc).toBe(0);

    const outOfPath = await run(skipArgs(["--mandate", HANDLE_A], OTHER_SESSION));
    expect(outOfPath.rc).toBe(3);
    expect(outOfPath.stderr).toContain("slug: mandate-out-of-path");
    expect(outOfPath.stdout).toBe("");

    const notCovered = await run(skipArgs(["--mandate", HANDLE_A], SESSION, "sdk-check"));
    expect(notCovered.rc).toBe(3);
    expect(notCovered.stderr).toContain("slug: mandate-not-covered");

    const unknown = await run(skipArgs(["--mandate", HANDLE_UNKNOWN]));
    expect(unknown.rc).toBe(3);
    expect(unknown.stderr).toContain("slug: mandate-unknown-mandate");

    const wrongOrg = await run(skipArgs(["--mandate", HANDLE_OTHER_ORG]));
    expect(wrongOrg.rc).toBe(3);
    expect(wrongOrg.stderr).toContain("slug: mandate-org-mismatch");
    expect(wrongOrg.stderr).not.toContain("eris-login-required");

    mandates.get(HANDLE_A)!.usesSpent = 2;
    const exhausted = await run(skipArgs(["--mandate", HANDLE_A]));
    expect(exhausted.rc).toBe(3);
    expect(exhausted.stderr).toContain("slug: mandate-exhausted");

    mandates.get(HANDLE_A)!.revoked = true;
    const revoked = await run(skipArgs(["--mandate", HANDLE_A]));
    expect(revoked.rc).toBe(3);
    expect(revoked.stderr).toContain("slug: mandate-revoked");
    expect(revoked.stderr).not.toContain("eris-login-required");

    mandateUnavailable = true;
    const down = await run(skipArgs(["--mandate", HANDLE_A]));
    expect(down.rc).toBe(3);
    expect(down.stderr).toContain("slug: mandate-unavailable");

    expect(store[ISSUE]!.length).toBe(1);
    const dump = everything([first, outOfPath, notCovered, unknown, wrongOrg, exhausted, revoked, down]);
    expect(dump).not.toContain(HANDLE_A);
    expect(dump).not.toContain(HANDLE_UNKNOWN);
    expect(dump).not.toContain(HANDLE_OTHER_ORG);
  });

  // admits: integration: local validation ordering must fail before login/endpoint/network calls and never echo malformed values.
  it("refuses locally with zero HTTP requests (even with no login) on malformed handle, empty --mandate, non-session actor, or invalid scope", async () => {
    const badSecret = "mnd_not-a-handle-secret-value";
    const bad = await run(skipArgs(["--mandate", badSecret]), {}, false);
    expect(bad.rc).toBe(3);
    expect(bad.stderr).toContain("slug: mandate-handle-malformed");
    expect(bad.stderr).not.toContain("not-a-handle-secret-value");

    const empty = await run(skipArgs(["--mandate", ""]), {}, false);
    expect(empty.rc).toBe(1);

    const blank = await run(skipArgs(["--mandate", "   "]), {}, false);
    expect(blank.rc).toBe(3);
    expect(blank.stderr).toContain("slug: mandate-handle-malformed");

    const human = await run(skipArgs(["--mandate", HANDLE_A], "op@example.test"), {}, false);
    expect(human.rc).toBe(3);
    expect(human.stderr).toContain("slug: mandate-session-required");

    const badScope = await run(skipArgs(["--mandate", HANDLE_A], SESSION, "e2e&extra=1"), {}, false);
    expect(badScope.rc).toBe(3);
    expect(badScope.stderr).toContain("slug: mandate-act-unsupported");

    expect(seen).toEqual([]);
    expect(uses).toEqual([]);
    expect(everything([bad, empty, blank, human, badScope])).not.toContain(HANDLE_A);
  });

  // admits: algorithmic: four-way precedence matrix between --mandate, ERIS_MANDATE, and --authorized.
  it("reads ERIS_MANDATE when --authorized is absent, ignores it beside --authorized, treats blank env as unset, and keeps --authorized beside --mandate as context", async () => {
    mandates.get(HANDLE_A)!.maxUses = 3;
    const viaEnv = await run(skipArgs([]), { ERIS_MANDATE: HANDLE_A });
    expect(viaEnv.rc).toBe(0);
    expect(store[ISSUE]![0]!.payload.schema).toBe(GATE_RECEIPT_SCHEMA_V3);

    const humanOverridesEnv = await run(skipArgs(["--authorized", "alice asked: skip e2e on this slice"]), { ERIS_MANDATE: HANDLE_A });
    expect(humanOverridesEnv.rc).toBe(0);
    expect(store[ISSUE]![1]!.payload).toMatchObject({ schema: "gate-receipt@v2", authorized: "alice asked: skip e2e on this slice" });
    expect(store[ISSUE]![1]!.payload.mandate).toBeUndefined();
    expect(uses.length).toBe(1);

    const blankEnv = await run(skipArgs([]), { ERIS_MANDATE: "   " });
    expect(blankEnv.rc).toBe(2);
    expect(blankEnv.stderr).toContain("missing --authorized");

    // Beside --mandate, even a doctrine-shaped --authorized is context, not judged against --doctrine.
    const withContext = await run(skipArgs(["--mandate", HANDLE_A, "--authorized", "doctrine:ignored-as-context"]));
    expect(withContext.rc).toBe(0);
    expect(store[ISSUE]![2]!.payload).toMatchObject({ schema: GATE_RECEIPT_SCHEMA_V3, authorized: "doctrine:ignored-as-context" });
    expect(uses.length).toBe(2);
    expect(everything([viaEnv, humanOverridesEnv, blankEnv, withContext])).not.toContain(HANDLE_A);
  });

  // admits: boundary-io: post-write v2-vs-v3 sha256 verification against a legacy gateway response (same hash or omitted record_sha256) with and without prose --authorized.
  it("exits 3 mandate-not-stamped when the store keeps v2 unstamped or omits record_sha256, naming the prose grant accurately", async () => {
    ignoreMandateHandle = true;
    const noProse = await run(skipArgs(["--mandate", HANDLE_A]));
    expect(noProse.rc).toBe(3);
    expect(noProse.stderr).toContain("slug: mandate-not-stamped");
    expect(noProse.stderr).toContain("unauthorized-skip");
    const c1 = await run(["check", "--issue", ISSUE, "--gates", "e2e"]);
    expect(c1.rc).toBe(3);
    expect(c1.stdout).toContain("e2e\tunauthorized-skip\tSKIPPED");

    const withProse = await run(skipArgs(["--mandate", HANDLE_A, "--authorized", "alice asked: skip e2e on this slice"]));
    expect(withProse.rc).toBe(3);
    expect(withProse.stderr).toContain("slug: mandate-not-stamped");
    expect(withProse.stderr).toContain("judges it by its --authorized grant alone");
    expect(withProse.stderr).not.toContain("unauthorized-skip");
    const c2 = await run(["check", "--issue", ISSUE, "--gates", "e2e"]);
    expect({ rc: c2.rc, stdout: c2.stdout }).toEqual({ rc: 0, stdout: "e2e\tskipped\tSKIPPED\n" });

    ignoreMandateHandle = false;
    omitRecordSha = true;
    const noSha = await run(skipArgs(["--mandate", HANDLE_A]));
    expect(noSha.rc).toBe(3);
    expect(noSha.stderr).toContain("slug: mandate-not-stamped");
  });

  // admits: boundary-io: idempotent retry loop under HTTP 429 must resend the same comment_id so the gateway spends only one use.
  it("retries a 429 on POST /v1/gates/receipts with the same comment_id and spends one use", async () => {
    rateLimitRemaining = 1;
    const r = await run(skipArgs(["--mandate", HANDLE_A]));
    expect(r.rc).toBe(0);
    const posts = seen.filter((s) => s.method === "POST" && s.path === "/v1/gates/receipts");
    expect(posts.length).toBe(2);
    expect(JSON.parse(posts[0]!.body).comment_id).toBe(JSON.parse(posts[1]!.body).comment_id);
    expect(mandates.get(HANDLE_A)!.usesSpent).toBe(1);
  });
});
