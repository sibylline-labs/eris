/**
 * `eris doctrine set`, over the gates client (docs/dev/GATES-CLIENT.md).
 *
 * The seam is the doctrine handler with a loopback `Bun.serve` standing in for the gateway's
 * `/v1/gates/doctrine-comments` (GET open issues, POST comment) and `/v1/gates/receipts` routes, and a
 * sandbox directory holding the doctrine file the verb edits. Every request crosses real HTTP and the
 * server keeps what it was sent, so the tests read the comment the gateway would have written, not the
 * client's idea of it. The request and reply shapes are those the gateway's own tests assert
 * (apps/gates test/doctrine-comments.test.ts); the live route is probed separately.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { type GatesOrgBundle, policyHash, readDoctrine, renderBundle, sha256Hex } from "eris/gates-contract";
import { doctrineHandler } from "../plugins/doctrine/doctrine";
import { setActiveDoctrineText, snapshotPosture } from "../plugins/doctrine/set";
import { CliExit } from "../src/cli/ts-verb";

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, "..");
const ORG = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const LOGIN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");

const BUNDLE: GatesOrgBundle = {
  active: "business-as-usual",
  postures: {
    "rapid-prototype": { name: "Rapid prototype", bullets: ["Ship small experiments quickly."], policy: { profile_default: "spine", gates: { "premise-gate": "off" } } },
    "business-as-usual": { name: "Business as usual", bullets: ["The default.", "The established process."], policy: { profile_default: "deep" } },
  },
  profiles: { spine: ["understand-scope", "premise-gate", "plan-review", "final-gates"], deep: { require: ["understand-scope", "premise-gate", "sdk-check", "plan-review", "final-gates"] } },
  loops: { "one-shot": "# One shot\n\nRun the issue to a ready PR.\n" },
} as GatesOrgBundle;
const DOCTRINE_TEXT = renderBundle(BUNDLE)["doctrine.md"]!;
const READ = readDoctrine(DOCTRINE_TEXT);
const HASH_BAU = policyHash(READ.postures.find((p) => p.slug === "business-as-usual")!)!;
const HASH_RAPID = policyHash(READ.postures.find((p) => p.slug === "rapid-prototype")!)!;

interface Posted {
  readonly body: { issue: string; comment_id: string; replace_comment_id?: string; body: string; from_snapshot: { sha256: string; content: string; bytes: number }; to_snapshot: { sha256: string; content: string; bytes: number } };
  readonly auth: string | null;
}

let sandbox: string;
let home: string;
let file: string;
let server: ReturnType<typeof Bun.serve>;
let hits: string[];
let posted: Posted[];
let queries: string[];
let openIssues: string[];
let receiptHash: Record<string, string>;
let listStatus: number;
let seq: number;

const problem = (status: number, code: string) => Response.json({ type: "about:blank", status, code }, { status, headers: { "content-type": "application/problem+json" } });

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "doctrine-set-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      hits.push(`${req.method} ${url.pathname}`);
      if (req.method === "GET" && url.pathname === "/v1/gates/doctrine-comments") {
        queries.push(url.search);
        if (listStatus !== 200) return problem(listStatus, "refused");
        return Response.json({ issues: openIssues, contract_version: "gates-contract/v1" });
      }
      if (req.method === "GET" && url.pathname === "/v1/gates/receipts") {
        const issue = url.searchParams.get("issue")!;
        const hash = receiptHash[issue];
        const receipts =
          hash === undefined
            ? []
            : [
                {
                  comment_id: `r-${issue}`,
                  created_at: "2026-11-17T08:00:00.000Z",
                  marker_version: "v2",
                  payload: {
                    schema: "gate-receipt@v2",
                    gate: "plan-review",
                    issue,
                    verdict: "PASS",
                    artifact: { _tag: "file", path: "/x/plan.md", sha256: "a".repeat(64) },
                    doctrine: { path: "/x/doctrine.md", sha256: "b".repeat(64), posture: hash === HASH_BAU ? "business-as-usual" : "rapid-prototype", policy_hash: hash },
                    actor: "op@example.com",
                    evidence: [],
                    recorded_at: "2026-11-17T08:00:00.000Z",
                  },
                },
              ];
        return Response.json({ issue, receipts, invalid: 0, contract_version: "gates-contract/v1" });
      }
      if (req.method === "POST" && url.pathname === "/v1/gates/doctrine-comments") {
        const body = (await req.json()) as Posted["body"];
        posted.push({ body, auth: req.headers.get("authorization") });
        const id = body.replace_comment_id ?? `lin-${++seq}`;
        return Response.json({ id, issue: body.issue, body: body.body, createdAt: "2026-11-17T12:00:00.000Z", coalesced: body.replace_comment_id !== undefined, contract_version: "gates-contract/v1" });
      }
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
  file = join(home, "doctrine.md");
  writeFileSync(file, DOCTRINE_TEXT);
  hits = [];
  posted = [];
  queries = [];
  openIssues = ["ABC-1", "ABC-2", "ABC-3"];
  receiptHash = { "ABC-1": HASH_BAU, "ABC-2": HASH_RAPID };
  listStatus = 200;
  seq = 0;
});

async function doctrine(args: string[], opts: { now?: string; env?: Record<string, string> } = {}) {
  let stdout = "";
  let stderr = "";
  let rc: number;
  try {
    rc = await doctrineHandler({}, () => "", { home, cwd: sandbox, now: () => new Date(opts.now ?? "2026-11-17T12:00:00.000Z") })(args, {
      erisDir: REPO,
      env: { PATH: process.env.PATH, HOME: home, ...opts.env },
      format: "text",
      stdout: { write: (s: string) => ((stdout += s), true) },
      stderr: { write: (s: string) => ((stderr += s), true) },
    });
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    rc = e.code;
  }
  return { rc, stdout, stderr };
}

const slugOf = (stderr: string) => /^slug: (\S+)$/m.exec(stderr)?.[1];
const set = (posture: string, over: string[] = [], reason = "ship faster") => ["set", posture, "--reason", reason, "--file", file, "--actor", "op@example.com", ...over];
const unzip = (b64: string) => gunzipSync(Buffer.from(b64, "base64")).toString("utf8");

describe("eris doctrine set", () => {
  it("switches active, and has the gateway comment only the issue whose latest receipt is on another policy", async () => {
    /** When set comments an issue already on the target policy, or one with no receipt, or never switches the file, the tracker is spammed or the change is invisible: observed on the POSTs, the file and the history line. */
    const r = await doctrine(set("rapid-prototype"));
    expect(r.rc).toBe(0);
    expect(r.stdout).toBe("ABC-1\tcommented\tlin-1\n");
    expect(r.stderr).toContain("active doctrine: rapid-prototype (1 issue(s) updated)");
    expect(posted).toHaveLength(1);
    const p = posted[0]!;
    expect(p.auth).toBe(`Bearer ${LOGIN}`);
    expect(p.body.issue).toBe("ABC-1");
    expect(p.body.replace_comment_id).toBeUndefined();
    expect(p.body.comment_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.body.body.split("\n")[0]).toMatch(/^Doctrine changed: Business as usual \(business-as-usual@[0-9a-f]{12}\) \(snapshot `[0-9a-f]{12}`\) → Rapid prototype \(rapid-prototype@[0-9a-f]{12}\) \(snapshot `[0-9a-f]{12}`\) · by op@example.com · reason: ship faster$/);
    expect(p.body.body.split("\n").slice(1).every((l) => l.startsWith("- "))).toBe(true);
    // The snapshots are the postures' own sections, and the digest names the bytes.
    const bau = READ.postures.find((x) => x.slug === "business-as-usual")!;
    expect(unzip(p.body.from_snapshot.content)).toBe(bau.section);
    expect(p.body.from_snapshot.sha256).toBe(sha256Hex(bau.section));
    expect(readFileSync(file, "utf8")).toBe(setActiveDoctrineText(DOCTRINE_TEXT, "rapid-prototype"));
    const history = readFileSync(join(home, "doctrine-history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(history).toEqual([{ at: "2026-11-17T12:00:00.000Z", actor: "op@example.com", reason: "ship faster", from: "business-as-usual", to: "rapid-prototype", from_hash: HASH_BAU, to_hash: HASH_RAPID }]);
  });

  it("coalesces a second flip within ten minutes into the first comment, and says when it reverted", async () => {
    /** When a quick flip and flip-back posts a second comment, the issue thread fills with noise; when the coalesce loses the base posture it reports the wrong from: observed on replace_comment_id and the body. */
    delete receiptHash["ABC-2"];
    expect((await doctrine(set("rapid-prototype"))).rc).toBe(0);
    const r = await doctrine(set("business-as-usual", [], "back"), { now: "2026-11-17T12:05:00.000Z" });
    expect(r.rc).toBe(0);
    expect(r.stdout).toBe("ABC-1\tcoalesced\tlin-1\n");
    const second = posted[1]!.body;
    expect(second.replace_comment_id).toBe("lin-1");
    expect(second.comment_id).toBe("lin-1");
    expect(second.body).toContain("→ Rapid prototype");
    expect(second.body).toContain("reason: ship faster; back");
    expect(second.body.split("\n").slice(1)).toEqual(["- No effective change."]);
  });

  it("starts a new comment once the window has passed", async () => {
    /** When the window never closes, a change a day later rewrites yesterday's comment instead of announcing itself: observed on replace_comment_id. */
    delete receiptHash["ABC-2"];
    expect((await doctrine(set("rapid-prototype"))).rc).toBe(0);
    receiptHash["ABC-1"] = HASH_RAPID;
    const r = await doctrine(set("business-as-usual"), { now: "2026-11-17T12:11:00.000Z" });
    expect(r.rc).toBe(0);
    expect(posted[1]!.body.replace_comment_id).toBeUndefined();
    expect(r.stdout).toBe("ABC-1\tcommented\tlin-2\n");
  });

  it("--issues narrows the gateway's candidates", async () => {
    /** When --issues is ignored the gateway lists every open issue and a scoped flip comments on unrelated work: observed on the query string the gateway received. */
    await doctrine(set("rapid-prototype", ["--issues", "ABC-1, ABC-2"]));
    expect(queries).toEqual(["?candidates=ABC-1%2CABC-2"]);
  });

  it("refuses a blank reason, an unknown posture and a pulled tree before any request, the file untouched", async () => {
    /** When set switches first and validates later, a refused command still rewrites the doctrine or edits the org's pulled copy: observed on the slug, the request log and the file bytes. */
    const blank = await doctrine(["set", "rapid-prototype", "--reason", "  ", "--file", file]);
    expect([blank.rc, slugOf(blank.stderr)]).toEqual([2, "doctrine-usage"]);
    const unknown = await doctrine(set("nope"));
    expect([unknown.rc, slugOf(unknown.stderr)]).toEqual([3, "doctrine-posture-unknown"]);
    const missing = await doctrine(["set", "rapid-prototype", "--file", file]);
    expect([missing.rc, slugOf(missing.stderr)]).toEqual([2, "doctrine-usage"]);
    const store = join(home, ".eris", "doctrine", ORG);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "doctrine.md"), DOCTRINE_TEXT);
    const managed = await doctrine(["set", "rapid-prototype", "--reason", "x", "--file", join(store, "doctrine.md")]);
    expect([managed.rc, slugOf(managed.stderr)]).toEqual([3, "doctrine-org-managed"]);
    expect(hits).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(DOCTRINE_TEXT);
  });

  it("a gateway that refuses the open-issues read leaves the doctrine file as it was", async () => {
    /** When set writes the file before it knows the gateway will take the change, a 403 leaves a switched doctrine with no comments: observed on the slug and the file bytes. */
    listStatus = 403;
    const r = await doctrine(set("rapid-prototype"));
    expect([r.rc, slugOf(r.stderr)]).toEqual([3, "gate-store-forbidden"]);
    expect(posted).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(DOCTRINE_TEXT);
  });

  it("names the session as the actor when no --actor is given", async () => {
    /** When the default actor is dropped the comment says 'unknown' and the change cannot be traced to a session: observed on the posted header. */
    const r = await doctrine(["set", "rapid-prototype", "--reason", "x", "--file", file], { env: { CLAUDE_CODE_SESSION_ID: "abc123" } });
    expect(r.rc).toBe(0);
    expect(posted[0]!.body.body).toContain("· by session:abc123 ·");
  });
});

describe("snapshotPosture", () => {
  it("never sends a section holding a credential-shaped string: its heading and name stand in", () => {
    /** When the snapshot is the raw section, a credential pasted into a posture bullet is uploaded to the gateway and stored: observed on the snapshot's decoded content. */
    const token = ["ghp", "_", "a1B2c3D4".repeat(5)].join("");
    const p = { slug: "x", name: "X", section: `## x\nX\n- see ${token}\n` } as Parameters<typeof snapshotPosture>[0];
    const snap = snapshotPosture(p);
    expect(unzip(snap.content)).toBe("## x\nX\n");
    expect(snap.sha256).toBe(sha256Hex("## x\nX\n"));
  });
});
