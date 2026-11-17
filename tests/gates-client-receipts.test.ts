/**
 * The gates client's receipt, asset, artifact and asks routes (docs/dev/GATES-CLIENT.md), and the
 * receipt contract's decode.
 *
 * The seam is the client function over a loopback `Bun.serve` standing in for the gateway: every
 * request crosses real HTTP, and the server records what it was sent. The bearer is assembled at
 * runtime so no literal trips a secret scanner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  appendReceipt,
  artifactCopy,
  assetDigest,
  decodePayload,
  type GatesEndpoint,
  gatesEndpoint,
  listAsks,
  listReceipts,
  reviewReportDigest,
  sha256Hex,
  uploadAsset,
} from "eris/gates-contract";

const TOKEN = ["sib", "01HZX3K5Q8W2N4R6T8V0Y2B4D6", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const ASSET_HOST = ["uploads", "linear", "app"].join(".");

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: Uint8Array;
}

type Route = (req: Seen) => Response;

let server: ReturnType<typeof Bun.serve>;
let routes: Record<string, Route>;
let seen: Seen[];

const problem = (status: number, code: string, headers: Record<string, string> = {}) =>
  Response.json({ type: "about:blank", status, code }, { status, headers: { "content-type": "application/problem+json", ...headers } });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const s: Seen = { method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) };
      seen.push(s);
      const route = routes[`${req.method} ${url.pathname}`];
      return route ? route(s) : problem(404, "not_found");
    },
  });
});

afterAll(() => server.stop(true));

beforeEach(() => {
  routes = {};
  seen = [];
});

const endpoint = (opts: { policySha?: string; onStale?: (live: string | null) => void } = {}): GatesEndpoint => {
  const ep = gatesEndpoint(`http://127.0.0.1:${server.port}`, TOKEN, opts);
  if (!ep.ok) throw new Error(ep.failure.what);
  return ep.value;
};

const receiptV2 = (over: Record<string, unknown> = {}) => ({
  schema: "gate-receipt@v2",
  gate: "plan-review",
  issue: "ABC-1",
  verdict: "PASS",
  artifact: { _tag: "file", path: "/plan.md", sha256: sha256Hex("plan") },
  actor: "someone@example.com",
  evidence: [{ kind: "text", content: "ok", sha256: sha256Hex("ok") }],
  recorded_at: "2026-11-17T10:00:00.000Z",
  ...over,
});

const listing = (rows: unknown[], extra: Record<string, unknown> = {}) => ({ issue: "ABC-1", receipts: rows, invalid: 0, contract_version: "gates-contract/v1", ...extra });

describe("listReceipts", () => {
  // admits: boundary-io: the live listing rows carry an `author` key this contract does not name; a strict decode would refuse every listing and fail every check closed, observed at the decoded value.
  it("decodes a listing whose rows carry keys the contract does not name, and sends the pulled bundle sha", async () => {
    routes["GET /v1/gates/receipts"] = () =>
      Response.json(listing([{ comment_id: "c-1", created_at: "2026-11-17T10:00:00.000Z", marker_version: "v2", payload: receiptV2(), source: "olympus", record_sha256: null, author: { kind: "app", name: null } }], { next: null }));
    const policySha = sha256Hex("bundle").slice(0, 12);
    const r = await listReceipts(endpoint({ policySha }), "ABC-1");
    expect(r).toEqual({ ok: true, value: { receipts: [{ id: "c-1", createdAt: "2026-11-17T10:00:00.000Z", version: "v2", payload: receiptV2() }], invalid: 0 } });
    expect(seen[0]!.query.get("issue")).toBe("ABC-1");
    expect(seen[0]!.headers.get("x-eris-policy-sha")).toBe(policySha);
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  // admits: boundary-io: a soft-stale reply must reach the verb's WARN exactly once per command, however many receipt calls it makes; observed through the onStale callback.
  it("tells the caller once when the gateway marks this machine's policy stale", async () => {
    const live = sha256Hex("live").slice(0, 12);
    routes["GET /v1/gates/receipts"] = () => Response.json(listing([]), { headers: { "x-gates-policy-stale": "soft", "x-gates-policy-sha": live } });
    const told: (string | null)[] = [];
    const ep = endpoint({ onStale: (s) => told.push(s) });
    await listReceipts(ep, "ABC-1");
    await listReceipts(ep, "ABC-1");
    expect(told).toEqual([live]);
  });

  // admits: boundary-io: each gateway answer maps to one slug a loop branches on; a wrong map turns a retryable outage into a contract bug (or the reverse), observed at the returned failure.
  it.each([
    [401, "unauthorized", "eris-login-required"],
    [403, "forbidden", "gate-store-forbidden"],
    [404, "issue_not_found", "linear-issue-not-found"],
    [409, "linear_disconnected", "gate-store-unreachable"],
    [500, "boom", "gate-store-unreachable"],
    [422, "bad", "gate-contract-mismatch"],
  ])("maps HTTP %d %s to %s", async (status, code, slug) => {
    routes["GET /v1/gates/receipts"] = () => problem(status, code);
    const r = await listReceipts(endpoint(), "ABC-1");
    expect(r.ok ? null : r.failure.slug).toBe(slug);
  });

  // admits: boundary-io: a 429's Retry-After is what the verb's bounded retry waits on; dropping it makes a loop hammer the gateway, observed at the failure's retryAfterMs.
  it("returns a rate-limited failure carrying the Retry-After window", async () => {
    routes["GET /v1/gates/receipts"] = () => problem(429, "rate_limited", { "retry-after": "7" });
    const r = await listReceipts(endpoint(), "ABC-1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.slug).toBe("linear-rate-limited");
      expect(r.failure.retryAfterMs).toBe(7000);
    }
  });
});

describe("appendReceipt", () => {
  // admits: boundary-io: the caller keys the comment id so a retried write is deduped by the gateway; a client that minted its own id would double-write, observed in the posted body.
  it("posts the caller's comment id with the receipt and prose, and returns the stored record", async () => {
    const recordSha = sha256Hex("record");
    routes["POST /v1/gates/receipts"] = () =>
      Response.json({ comment_id: "c-9", issue: "ABC-1", gate: "plan-review", created_at: "2026-11-17T10:00:01.000Z", record_sha256: recordSha, contract_version: "gates-contract/v1" }, { status: 201 });
    const r = await appendReceipt(endpoint(), { commentId: "key-1", issue: "ABC-1", receipt: receiptV2(), prose: "+++ Gate receipt" });
    expect(r).toEqual({ ok: true, value: { id: "c-9", createdAt: "2026-11-17T10:00:01.000Z", recordSha256: recordSha } });
    expect(JSON.parse(new TextDecoder().decode(seen[0]!.body))).toEqual({ comment_id: "key-1", issue: "ABC-1", receipt: receiptV2(), prose: "+++ Gate receipt" });
  });

  // admits: boundary-io: a hard-stale org refuses the write with 409 doctrine_out_of_date; reading it as a contract bug hides the 'pull first' fix, observed at the slug.
  it("maps a hard-stale refusal to doctrine-out-of-date", async () => {
    routes["POST /v1/gates/receipts"] = () => problem(409, "doctrine_out_of_date");
    const r = await appendReceipt(endpoint(), { commentId: "k", issue: "ABC-1", receipt: receiptV2(), prose: "p" });
    expect(r.ok ? null : r.failure.slug).toBe("doctrine-out-of-date");
  });
});

describe("assets and artifacts", () => {
  // admits: boundary-io: an upload is raw bytes named by x-filename, and an asset URL off the storage host would put an attacker's link in the receipt; observed at the request and the returned failure.
  it("uploads raw bytes and refuses an asset URL off the asset host", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    routes["POST /v1/gates/assets"] = () => Response.json({ assetUrl: `https://${ASSET_HOST}/a/b.png`, sha256: sha256Hex(bytes), bytes: 4, contract_version: "gates-contract/v1.1" });
    const ok = await uploadAsset(endpoint(), { name: "b.png", contentType: "image/png", bytes });
    expect(ok).toEqual({ ok: true, value: { assetUrl: `https://${ASSET_HOST}/a/b.png`, sha256: sha256Hex(bytes), bytes: 4 } });
    expect(seen[0]!.headers.get("x-filename")).toBe("b.png");
    expect(seen[0]!.headers.get("content-type")).toBe("image/png");
    expect([...seen[0]!.body]).toEqual([...bytes]);
    routes["POST /v1/gates/assets"] = () => Response.json({ assetUrl: "https://evil.example.com/b.png", sha256: sha256Hex(bytes), bytes: 4, contract_version: "gates-contract/v1.1" });
    const off = await uploadAsset(endpoint(), { name: "b.png", contentType: "image/png", bytes });
    expect(off.ok ? null : off.failure.slug).toBe("gate-contract-mismatch");
  });

  // admits: boundary-io: a deleted asset is a verdict (the evidence is gone), not an outage; mapping 404 asset_not_found to a failure would turn bad-digest into exit-3-unreachable, observed at the value.
  it("reads an asset's digest, and a missing asset as Gone", async () => {
    const url = `https://${ASSET_HOST}/a/b.png`;
    routes["GET /v1/gates/assets/digest"] = (s) =>
      s.query.get("url") === url ? Response.json({ sha256: sha256Hex("x"), bytes: 1, contentType: "image/png", contract_version: "gates-contract/v1.1" }) : problem(404, "asset_not_found");
    expect(await assetDigest(endpoint(), url)).toEqual({ ok: true, value: { _tag: "Digest", sha256: sha256Hex("x"), bytes: 1, contentType: "image/png" } });
    const gone = await assetDigest(endpoint(), `${url}x`);
    expect(gone.ok && gone.value._tag).toBe("Gone");
  });

  // admits: boundary-io: the stored copy answers drift checks once the file is gone; a 404 must read NotStored and a copy for another sha must be refused, observed at the value.
  it("reads a stored artifact copy, NotStored on 404, and refuses a copy of other bytes", async () => {
    const sha = sha256Hex("artifact");
    const other = sha256Hex("other");
    routes[`GET /v1/gates/artifacts/${sha}`] = () => Response.json({ sha256: sha, encoding: "gzip+base64", content: "H4sI", bytes: 8, contract_version: "gates-contract/v1.2" });
    routes[`GET /v1/gates/artifacts/${other}`] = () => Response.json({ sha256: sha, encoding: "gzip+base64", content: "H4sI", bytes: 8, contract_version: "gates-contract/v1.2" });
    expect(await artifactCopy(endpoint(), sha)).toEqual({ ok: true, value: { _tag: "Stored", copy: { sha256: sha, encoding: "gzip+base64", content: "H4sI", bytes: 8 } } });
    const mismatched = await artifactCopy(endpoint(), other);
    expect(mismatched.ok ? null : mismatched.failure.slug).toBe("gate-contract-mismatch");
    routes[`GET /v1/gates/artifacts/${sha}`] = () => problem(404, "artifact_not_found");
    const none = await artifactCopy(endpoint(), sha);
    expect(none.ok && none.value._tag).toBe("NotStored");
    seen = [];
    const notHex = await artifactCopy(endpoint(), "not-a-sha");
    expect(notHex.ok && notHex.value._tag).toBe("NotStored");
    expect(seen).toEqual([]);
  });
});

describe("listAsks", () => {
  const ask = (id: string, over: Record<string, unknown> = {}) => ({
    schema: "ask@1",
    id,
    question: "Ship it?",
    options: [],
    free_text: true,
    recommend: null,
    blocking: true,
    binds: { issue: "ABC-1" },
    asker: [],
    context_links: [],
    state: "open",
    created_at: "2026-11-17T10:00:00.000Z",
    door: "one-way",
    answer: null,
    ...over,
  });

  // admits: boundary-io: the @asks row reads the open blocking set by its filters; a query that drops one would let an unrelated ask hold the terminal gate, observed at the request's query.
  it("sends the filters and decodes the rows", async () => {
    routes["GET /v1/asks"] = () => Response.json({ asks: [ask("ask_1")], next: null });
    const r = await listAsks(endpoint(), { issue: "ABC-1", state: "open", blocking: true, limit: 100 });
    expect(r.ok && r.value.map((a) => a.id)).toEqual(["ask_1"]);
    expect(Object.fromEntries(seen[0]!.query)).toEqual({ issue: "ABC-1", state: "open", blocking: "true", limit: "100" });
  });

  // admits: boundary-io: an unreadable asks API must never read as no asks; each answer maps to an asks-* slug, observed at the failure.
  it.each([
    [401, "eris-login-required"],
    [403, "asks-store-forbidden"],
    [503, "asks-store-unreachable"],
    [400, "asks-contract-mismatch"],
    [429, "asks-rate-limited"],
  ])("maps HTTP %d to %s", async (status, slug) => {
    routes["GET /v1/asks"] = () => problem(status, "x");
    const r = await listAsks(endpoint(), { issue: "ABC-1" });
    expect(r.ok ? null : r.failure.slug).toBe(slug);
  });
});

describe("decodePayload", () => {
  const report = {
    target: { repo: "o/r", pr: 1, head_sha: "a".repeat(40), diff_sha256: "b".repeat(64) },
    surface: "auth",
    effort: "high",
    reviewer: { actor: "session:x", model: "m", fresh_context: true, skill: { name: "review", harness_sha: "c".repeat(40), sha256: "d".repeat(64) }, vocabulary: { path: "v.md", sha256: "e".repeat(64) } },
    author: { actor: "session:y" },
    classes_checked: ["authz"],
    findings: [],
  } as const;
  const stamp = {
    id: "01HZX3K5Q8W2N4R6T8V0Y2B4D6",
    use_id: "01HZX3K5Q8W2N4R6T8V0Y2B4D7",
    root_id: "01HZX3K5Q8W2N4R6T8V0Y2B4D8",
    scope: "sr:us:mandate:gate:skip?gate=e2e&issue=ABC-1",
    chain_digest: "A".repeat(43),
    attestation: "aa.bb.cc",
  };

  // admits: boundary-io: every receipt version another build stores must decode here, or check reads it as an undecodable marker and the gate as missing; observed at the decoded receipt.
  it.each([
    ["a v2 git artifact with a carried copy", "v2", receiptV2({ artifact: { _tag: "git", repo: "o/r", ref: "main", commit: "f".repeat(40), path: "p.md", sha256: sha256Hex("p"), copy: { encoding: "gzip+base64", content: "H4sI", bytes: 1 } } }), "gate-receipt@v2"],
    ["a v3 mandate-stamped SKIPPED", "v2", receiptV2({ schema: "gate-receipt@v3", verdict: "SKIPPED", reason: "not needed here at all", mandate: stamp }), "gate-receipt@v3"],
    ["a v2 with review-report evidence", "v2", receiptV2({ evidence: [{ kind: "review-report", report, sha256: reviewReportDigest(report) }] }), "gate-receipt@v2"],
    ["a v2 with a key the contract does not name", "v2", receiptV2({ future_field: 1 }), "gate-receipt@v2"],
    ["a v1 normalised to v2", "v1", { schema: "gate-receipt@v1", gate: "g", issue: "ABC-1", verdict: "PASS", artifact: { path: "p", sha256: "x" }, actor: "a", evidence: ["e"], recorded_at: "t" }, "gate-receipt@v2"],
  ] as const)("decodes %s", (_, version, payload, schema) => {
    const d = decodePayload(version, payload);
    expect(d.kind === "receipt" ? d.receipt.schema : d.kind).toBe(schema);
  });

  // admits: boundary-io: a review report that declares its own verdict, or a v3 with a malformed stamp, must not decode as a receipt (it would be judged), observed at the decode result.
  it.each([
    ["a review report carrying a verdict", receiptV2({ evidence: [{ kind: "review-report", report: { ...report, verdict: "PASS" }, sha256: "x" }] })],
    ["a v3 whose mandate scope is not canonical", receiptV2({ schema: "gate-receipt@v3", verdict: "SKIPPED", mandate: { ...stamp, scope: "sr:us:mandate:gate:skip?issue=ABC-1&gate=e2e" } })],
  ])("refuses %s", (_, payload) => {
    expect(decodePayload("v2", payload).kind).toBe("invalid");
  });
});
