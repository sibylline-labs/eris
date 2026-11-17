/**
 * The gates client's `/v1/linear` routes and the yak lookup (docs/dev/GATES-CLIENT.md), and the
 * bounded 429 retry every verb shares (`retryRateLimited`).
 *
 * The seam is the client function over a loopback `Bun.serve` standing in for the gateway: every
 * request crosses real HTTP, and the server records what it was sent. The request keys and reply
 * shapes are the gateway's `linear-contract/v1` (`ClaimBody`, `ReleaseBody`, `CommentBody`,
 * `TransitionBody`). The bearer is assembled at runtime so no literal trips a secret scanner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  claimIssue,
  commentIssue,
  type GatesEndpoint,
  gatesEndpoint,
  getIssue,
  releaseIssue,
  resolveYakIssue,
  retryRateLimited,
  transitionIssue,
} from "eris/gates-contract";

const TOKEN = ["sib", "01HZX3K5Q8W2N4R6T8V0Y2B4D6", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const V1 = "linear-contract/v1";
const SHA = "a".repeat(6) + "0".repeat(6);

interface Seen {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

type Route = (req: Seen) => Response;

let server: ReturnType<typeof Bun.serve>;
let routes: Record<string, Route>;
let seen: Seen[];

const problem = (status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  Response.json({ type: "about:blank", status, code, ...extra }, { status, headers: { "content-type": "application/problem+json", ...headers } });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      seen.push({ method: req.method, path: url.pathname, headers: req.headers, body: text === "" ? undefined : JSON.parse(text) });
      const route = routes[`${req.method} ${url.pathname}`];
      return route ? route(seen[seen.length - 1]!) : problem(404, "not_found");
    },
  });
});

afterAll(() => server.stop(true));

beforeEach(() => {
  routes = {};
  seen = [];
});

const endpoint = (): GatesEndpoint => {
  const ep = gatesEndpoint(`http://127.0.0.1:${server.port}`, TOKEN);
  if (!ep.ok) throw new Error(ep.failure.what);
  return ep.value;
};

const CLAIM = { issue: "ABC-7", loop: "one-shot", runtime: "claude", session_id: null, pr_url: null, claimed_at: "2026-11-17T12:00:00Z", expires_at: "2026-11-17T16:00:00Z", agent_session_id: null };
const ISSUE = { id: "i1", identifier: "ABC-7", title: "t", url: "u", state: { id: "s1", name: "Todo", type: "unstarted" }, team: { id: "t1", key: "ABC" }, parent: { id: "p1", identifier: "ABC-1", state: { id: "s0", name: "Backlog", type: "backlog" } } };

describe("the /v1/linear routes", () => {
  it("sends each route's body keys exactly, on the bearer, and decodes each reply", async () => {
    /** When a request carries a key the gateway's body schema does not name (or misses one), the route answers 400 and no loop can claim, release, comment or move an issue: observed on the bodies the loopback gateway records. */
    routes["POST /v1/linear/issues/ABC-7/claim"] = () => Response.json({ claim: CLAIM, delegate_status: "pending", bundle_sha: SHA, contract_version: V1 }, { status: 201 });
    routes["POST /v1/linear/issues/ABC-7/release"] = () => Response.json({ released: false, reason: "superseded", contract_version: V1 });
    routes["POST /v1/linear/issues/ABC-7/comments"] = () => Response.json({ comment: { id: "c1", createdAt: "2026-11-17T12:00:00Z", body: "hi" }, contract_version: V1 });
    routes["POST /v1/linear/issues/ABC-7/transition"] = () => Response.json({ issue: ISSUE, contract_version: V1 });
    routes["GET /v1/linear/issues/ABC-7"] = () => Response.json({ issue: { ...ISSUE, labels: { nodes: [], pageInfo: { hasNextPage: false } } }, contract_version: V1 });
    const ep = endpoint();

    const reserved = await claimIssue(ep, "ABC-7", { claimId: "claim-0001", loop: "one-shot", runtime: "claude" });
    const bound = await claimIssue(ep, "ABC-7", { claimId: "claim-0001", loop: "one-shot", runtime: "claude", sessionId: "job00001" });
    const released = await releaseIssue(ep, "ABC-7", { claimId: "claim-0001", outcome: "handed_back", body: "done" });
    const blank = await releaseIssue(ep, "ABC-7", { claimId: "claim-0001", outcome: "aborted" });
    const comment = await commentIssue(ep, "ABC-7", "hi");
    const moved = await transitionIssue(ep, "ABC-7", { type: "started", name: "In Progress" });
    const read = await getIssue(ep, "ABC-7");

    expect(seen.map((s) => [s.method, s.path, s.body])).toEqual([
      ["POST", "/v1/linear/issues/ABC-7/claim", { claim_id: "claim-0001", loop: "one-shot", runtime: "claude" }],
      ["POST", "/v1/linear/issues/ABC-7/claim", { claim_id: "claim-0001", loop: "one-shot", runtime: "claude", session_id: "job00001" }],
      ["POST", "/v1/linear/issues/ABC-7/release", { claim_id: "claim-0001", outcome: "handed_back", body: "done" }],
      ["POST", "/v1/linear/issues/ABC-7/release", { claim_id: "claim-0001", outcome: "aborted" }],
      ["POST", "/v1/linear/issues/ABC-7/comments", { body: "hi" }],
      ["POST", "/v1/linear/issues/ABC-7/transition", { state_type: "started", state: "In Progress" }],
      ["GET", "/v1/linear/issues/ABC-7", undefined],
    ]);
    expect(seen.every((s) => s.headers.get("authorization") === `Bearer ${TOKEN}`)).toBe(true);
    expect(reserved).toEqual({ ok: true, value: { claim: CLAIM, delegateStatus: "pending", bundleSha: SHA } });
    expect(bound.ok).toBe(true);
    expect(released).toEqual({ ok: true, value: { released: false, reason: "superseded" } });
    expect(blank.ok).toBe(true);
    expect(comment).toEqual({ ok: true, value: { id: "c1" } });
    expect(moved).toEqual({ ok: true, value: { identifier: "ABC-7", state: { name: "Todo", type: "unstarted" }, parent: { identifier: "ABC-1", state: { name: "Backlog", type: "backlog" } } } });
    expect(read).toEqual(moved);
  });

  it("maps the gateway's refusals to their slugs: another holder, an unknown issue or state, a rate limit, a reply off the contract", async () => {
    /** When a refusal reaches the verb as a generic mismatch, an operator cannot tell another loop's claim from a typo or a contract skew, and the hand-back retry never sees the 429: observed on each failure's slug, its holder text and its retryAfterMs. */
    const holder = { loop: "fixer", runtime: "claude", session_id: "job00002", claimed_at: "2026-11-17T11:00:00Z", expires_at: "2026-11-17T15:00:00Z" };
    routes["POST /v1/linear/issues/ABC-7/claim"] = () => problem(409, "issue_already_claimed", { fields: { holder } });
    routes["GET /v1/linear/issues/ABC-8"] = () => problem(404, "issue_not_found");
    routes["POST /v1/linear/issues/ABC-7/transition"] = () => problem(404, "state_not_found");
    routes["POST /v1/linear/issues/ABC-7/comments"] = () => problem(429, "rate_limited", {}, { "retry-after": "7" });
    routes["GET /v1/linear/issues/ABC-7"] = () => Response.json({ issue: ISSUE });
    const ep = endpoint();

    const claimed = await claimIssue(ep, "ABC-7", { claimId: "claim-0001", loop: "one-shot", runtime: "claude" });
    expect(claimed.ok ? null : claimed.failure.slug).toBe("linear-issue-claimed");
    expect(claimed.ok ? "" : claimed.failure.what).toContain("loop fixer");
    expect(claimed.ok ? "" : claimed.failure.what).toContain("session job00002");
    expect(claimed.ok ? "" : claimed.failure.what).toContain("2026-11-17T15:00:00Z");

    const missing = await getIssue(ep, "ABC-8");
    expect(missing.ok ? null : missing.failure.slug).toBe("linear-issue-not-found");
    const state = await transitionIssue(ep, "ABC-7", { type: "started", name: "In Progress" });
    expect(state.ok ? null : state.failure.slug).toBe("linear-state-not-found");
    const limited = await commentIssue(ep, "ABC-7", "hi");
    expect(limited.ok ? null : [limited.failure.slug, limited.failure.retryAfterMs]).toEqual(["linear-rate-limited", 7000]);
    const unversioned = await getIssue(ep, "ABC-7");
    expect(unversioned.ok ? null : unversioned.failure.slug).toBe("gate-contract-mismatch");
  });
});

describe("resolveYakIssue", () => {
  it("reads a ULID on /v1 and a UUID on /v0: the observation's cluster, then its current issue", async () => {
    /** When the lookup reads the wrong version's routes or skips the cluster hop, a yak id launches nothing or the wrong issue: observed on the paths asked and the key returned. */
    const ulid = "01HZX3K5Q8W2N4R6T8V0Y2B4D7";
    const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";
    routes[`GET /v1/yaks/observations/${ulid}`] = () => Response.json({ cluster_id: "c-1" });
    routes["GET /v1/yaks/clusters/c-1"] = () => Response.json({ current_issue_identifier: "ABC-9" });
    routes[`GET /v0/yaks/observations/${uuid}`] = () => Response.json({ cluster_id: "c-2" });
    routes["GET /v0/yaks/clusters/c-2"] = () => Response.json({ current_issue_identifier: null });
    const ep = endpoint();

    expect(await resolveYakIssue(ep, ulid)).toEqual({ ok: true, value: "ABC-9" });
    const pending = await resolveYakIssue(ep, uuid);
    expect(pending.ok ? null : pending.failure.slug).toBe("yak-unresolved");
    expect(seen.map((s) => s.path)).toEqual([`/v1/yaks/observations/${ulid}`, "/v1/yaks/clusters/c-1", `/v0/yaks/observations/${uuid}`, "/v0/yaks/clusters/c-2"]);
  });

  it("never follows a redirect, so the bearer cannot be carried to another host", async () => {
    /** When the lookup follows a 3xx, the login bearer is sent on to whatever host the redirect names: observed on the requests the loopback sees (no follow-up) and the failure. */
    const ulid = "01HZX3K5Q8W2N4R6T8V0Y2B4D7";
    routes[`GET /v1/yaks/observations/${ulid}`] = () => new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${server.port}/elsewhere` } });
    routes["GET /elsewhere"] = () => Response.json({ cluster_id: "c-1" });
    const r = await resolveYakIssue(endpoint(), ulid);
    expect(r.ok).toBe(false);
    expect(seen.map((s) => s.path)).toEqual([`/v1/yaks/observations/${ulid}`]);
  });
});

describe("retryRateLimited", () => {
  it("retries only a rate-limited failure, waits the reply's Retry-After, and stops at the bound", async () => {
    /** When a 429 is not retried (or anything else is), a hand-back shed by the gateway's rate limit is lost, or a refused write is repeated: observed on the attempt count, the waits and the outcome. */
    const limited = { ok: false as const, failure: { slug: "linear-rate-limited", what: "w", fix: "f", docs: "d", exit: 3 as const, retryAfterMs: 4000 } };
    const waits: number[] = [];
    let calls = 0;
    const opts = { delaysMs: [1000, 2000], maxWaitMs: 60_000, sleep: async (ms: number) => void waits.push(ms), jitter: () => 0 };

    const gaveUp = await retryRateLimited(async () => (calls++, limited), opts);
    expect(gaveUp).toEqual(limited);
    expect(calls).toBe(3);
    expect(waits).toEqual([4000, 4000]);

    calls = 0;
    const refused = { ok: false as const, failure: { slug: "gate-contract-mismatch", what: "w", fix: "f", docs: "d", exit: 3 as const } };
    expect(await retryRateLimited(async () => (calls++, refused), opts)).toEqual(refused);
    expect(calls).toBe(1);

    calls = 0;
    expect(await retryRateLimited(async () => (calls++ === 0 ? limited : { ok: true as const, value: 5 }), opts)).toEqual({ ok: true, value: 5 });
    expect(calls).toBe(2);
  });
});
