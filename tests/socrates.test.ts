/**
 * `eris socrates submit` and the vendored submit contract v1.
 *
 * The contract half decodes tests/fixtures/socrates-contract-v1.json, the same
 * golden file the contract's source decodes, so the two copies cannot drift
 * without one suite failing. The verb half drives the handler against a
 * loopback `Bun.serve` standing in for the endpoint; every request crosses real
 * HTTP. The token is assembled at runtime so no literal trips a secret scanner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SocratesProblem, SocratesSubmitReceipt, SocratesSubmitRequest, SocratesSubmitResponse } from "../plugins/socrates/socrates-contract.v1";
import { runSocrates } from "../plugins/socrates/submit";
import { REDACTION_CLASSES } from "../packages/outbound-scan/src/index";
import * as Verbs from "../plugins/socrates/socrates-contract.v1.verbs";
import { RUBRIC_V1, RUBRIC_V2 } from "../packages/socrates-core/src/index";
import type { ZodTypeAny } from "zod";
import { CliExit } from "../src/cli/ts-verb";
import { expectFailBlock, type Sandbox, sandbox } from "./helpers/blackbox";

const REPO = resolve(import.meta.dir, "..");
const TOKEN = ["sib", "01HZX3K5Q8W2N4R6T8V0Y2B4D6", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const GHP = ["ghp", "Zq8Lr2Vm5Nx7Pk1Ws4Ty6Hb9Jd3Gf0Ca8Ee2"].join("_");
const SUBSCRIBE = "https://example.com/billing/subscribe?product=socrates";

const fixtures = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "socrates-contract-v1.json"), "utf8")) as {
  request: { accept: unknown[]; reject: unknown[] };
  response: { receipt: unknown[]; problem: unknown[]; reject: unknown[] };
  messages: Record<string, Partial<Record<"request" | "response", { accept: unknown[]; reject: unknown[] }>>>;
};

describe("the submit contract v1, against the shared golden file", () => {
  it("accepts every accepted request and refuses every rejected one", () => {
    /** When this copy loosens or tightens a field the source contract does not, the client sends what the endpoint refuses, or refuses what it takes. */
    for (const raw of fixtures.request.accept) expect(SocratesSubmitRequest.safeParse(raw).success).toBe(true);
    for (const raw of fixtures.request.reject) expect({ raw, ok: SocratesSubmitRequest.safeParse(raw).success }).toEqual({ raw, ok: false });
  });

  it("decodes a response only as a receipt or a problem+json error", () => {
    /** When anything else decodes, untyped JSON reaches the output as if it were a receipt. */
    for (const raw of fixtures.response.receipt) expect(SocratesSubmitReceipt.safeParse(raw).success).toBe(true);
    for (const raw of fixtures.response.problem) expect(SocratesProblem.safeParse(raw).success).toBe(true);
    for (const raw of fixtures.response.reject) expect({ raw, ok: SocratesSubmitResponse.safeParse(raw).success }).toEqual({ raw, ok: false });
  });
});

/** Every route beyond submit: its request (where it takes one) and its response union. */
const MESSAGES: Record<string, { request?: ZodTypeAny; response: ZodTypeAny }> = {
  classify: { request: Verbs.SocratesClassifyRequest, response: Verbs.SocratesClassifyResponse },
  policy: { response: Verbs.SocratesPolicyResponse },
  evidence_create: { request: Verbs.SocratesEvidenceCreateRequest, response: Verbs.SocratesEvidenceCreateResponse },
  evidence_get: { request: Verbs.SocratesEvidenceGetRequest, response: Verbs.SocratesEvidenceGetResponse },
  consult: { request: Verbs.SocratesConsultRequest, response: Verbs.SocratesConsultResponse },
  resolve: { request: Verbs.SocratesResolveRequest, response: Verbs.SocratesResolveResponse },
  status: { request: Verbs.SocratesStatusRequest, response: Verbs.SocratesStatusResponse },
};

describe("the contract v1 routes beyond submit, against the shared golden file", () => {
  it("covers exactly the routes the fixture file holds", () => {
    /** When a route is added on one side only, its messages go undecoded here. */
    expect(Object.keys(fixtures.messages).sort()).toEqual(Object.keys(MESSAGES).sort());
  });

  for (const [name, schemas] of Object.entries(MESSAGES)) {
    it(`${name}: accepts what the source accepts and refuses what it refuses`, () => {
      /** When this copy drifts from the source, the client sends what the endpoint refuses, or reads an untyped body as a result. */
      for (const side of ["request", "response"] as const) {
        const schema = schemas[side];
        const set = fixtures.messages[name]?.[side];
        expect(set === undefined).toBe(schema === undefined);
        if (!schema || !set) continue;
        for (const raw of set.accept) expect({ raw, ok: schema.safeParse(raw).success }).toEqual({ raw, ok: true });
        for (const raw of set.reject) expect({ raw, ok: schema.safeParse(raw).success }).toEqual({ raw, ok: false });
      }
    });
  }

  it("classify: every answer of every published rubric decodes", () => {
    /** Published rubrics are frozen, so an answer spelling the wire refuses can never be sent. */
    const candidate = { kind: "decision", title: "t", statement: "s", source: "https://example.com" };
    for (const [version, rubric] of [["rubric@v1", RUBRIC_V1], ["rubric@v2", RUBRIC_V2]] as const) {
      for (const [gate, question] of Object.entries(rubric.questions)) {
        for (const answer of question.answers) {
          const raw = { schema_version: "1.0.0", rubric_version: version, candidate, answers: { [gate]: answer } };
          expect({ version, gate, answer, ok: Verbs.SocratesClassifyRequest.safeParse(raw).success }).toEqual({ version, gate, answer, ok: true });
        }
      }
    }
  });
});

let server: ReturnType<typeof Bun.serve>;
let answer: () => Response;
const requests: { path: string; auth: string | null; body: unknown }[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      requests.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), body: await req.json() });
      return answer();
    },
  });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  requests.length = 0;
  answer = () => Response.json({ candidate_id: "cand_1", deduped: false, contract_version: "1.0.0" });
});

const CANDIDATE = ["--title", "Errors use problem+json", "--statement", "Every 4xx/5xx is RFC 7807.", "--source", "https://example.com/pr/14"];

async function drive(args: string[], opts: { format?: "text" | "json"; env?: Record<string, string> } = {}) {
  let stdout = "";
  let stderr = "";
  const ctx = {
    erisDir: REPO,
    env: opts.env ?? { HOME: join(REPO, ".scratch", "no-such-home"), ERIS_YAKS_URL: `http://127.0.0.1:${server.port}`, ERIS_YAKS_TOKEN: TOKEN },
    format: opts.format ?? "text",
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: (s: string) => ((stderr += s), true) },
  };
  let rc: number;
  try {
    rc = await runSocrates(args, ctx);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    rc = e.code;
  }
  const slug = stderr.split("\n").find((l) => l.startsWith("slug: "))?.slice("slug: ".length);
  return { rc, stdout, stderr, slug };
}

describe("eris socrates submit", () => {
  it("posts one schema-checked candidate with the login bearer and prints the receipt", async () => {
    /** When the body, path or bearer drifts, the endpoint refuses every submission. */
    expect(await drive(["submit", ...CANDIDATE, "--project", "platform"])).toMatchObject({ rc: 0, stdout: "submitted: cand_1\n", stderr: "" });
    expect(requests).toEqual([
      {
        path: "/v1/socrates/submit",
        auth: `Bearer ${TOKEN}`,
        body: { schema_version: "1.0.0", candidate: { kind: "decision", title: "Errors use problem+json", statement: "Every 4xx/5xx is RFC 7807.", source: "https://example.com/pr/14", project: "platform" } },
      },
    ]);
  });

  it("sends now: true under --now", async () => {
    /** When the flag is dropped from the body, `submit --now` silently asks for nothing. Without the flag, the exact body above carries no `now`. */
    expect(await drive(["submit", ...CANDIDATE, "--now"])).toMatchObject({ rc: 0, stdout: "submitted: cand_1\n", stderr: "" });
    expect(requests.map((r) => (r.body as { now?: unknown }).now)).toEqual([true]);
  });

  it("prints a deduped receipt as a bare JSON record under --output json", async () => {
    /** When a dedup reads as a failure or the record grows a wrapper, a script branching on `deduped` breaks. */
    answer = () => Response.json({ candidate_id: "cand_1", deduped: true, contract_version: "1.0.0" });
    expect(await drive(["submit", ...CANDIDATE], { format: "json" })).toMatchObject({
      rc: 0,
      stdout: '{"candidate_id":"cand_1","deduped":true,"contract_version":"1.0.0","redactions":{"count":0,"classes":[]},"overrides":[]}\n',
      stderr: "",
    });
    expect((await drive(["submit", ...CANDIDATE])).stdout).toBe("already submitted: cand_1\n");
  });

  it("prints the subscribe link when the endpoint says the workspace is not entitled", async () => {
    /** When the 402 loses its link, an unentitled user has no way forward from the CLI. */
    answer = () =>
      Response.json(
        { type: "urn:hera:error:entitlement_lapsed", title: "Organization entitlement has lapsed", status: 402, detail: "not entitled to socrates", code: "entitlement_lapsed", _links: { subscribe: { href: SUBSCRIBE } } },
        { status: 402, headers: { "content-type": "application/problem+json" } },
      );
    const r = await drive(["submit", ...CANDIDATE], { format: "json" });
    expect(r).toMatchObject({ rc: 1, stdout: "", slug: "socrates-not-entitled" });
    expect(r.stderr).toContain(`fix: subscribe: ${SUBSCRIBE}\n`);
  });

  it("refuses an answer that is neither a receipt nor a problem+json error", async () => {
    /** When an untyped body passes, a proxy page or another service's JSON prints as a receipt. */
    for (const body of [new Response("<html>502</html>", { status: 502 }), Response.json({ ok: true }), Response.json({ ok: false, code: "x", status: 402 }, { status: 402 })]) {
      answer = () => body.clone();
      expect(await drive(["submit", ...CANDIDATE])).toMatchObject({ rc: 1, stdout: "", slug: "socrates-bad-response" });
    }
  });

  it("names a problem without a subscribe link as a refusal", async () => {
    /** When every problem reads as not-entitled, a revoked token sends the user to a billing page. */
    answer = () => Response.json({ type: "urn:hera:error:unauthorized", title: "Unauthorized", status: 401, detail: "Unauthorized", code: "unauthorized" }, { status: 401 });
    const r = await drive(["submit", ...CANDIDATE]);
    expect(r).toMatchObject({ rc: 1, slug: "socrates-refused" });
    expect(r.stderr).toContain("eris login");
  });

  it("sends nothing when the candidate fails the contract or a required flag is missing", async () => {
    /** When a malformed candidate leaves the machine, the endpoint is the first to validate it. */
    expect(await drive(["submit", "--title", "t", "--statement", "s", "--source", "repo@abc:path#L1"])).toMatchObject({ rc: 1, slug: "socrates-candidate-invalid" });
    expect(await drive(["submit", ...CANDIDATE, "--kind", "opinion"])).toMatchObject({ rc: 1, slug: "socrates-candidate-invalid" });
    expect(await drive(["submit", ...CANDIDATE, "--kind", "conflict"])).toMatchObject({ rc: 1, slug: "socrates-candidate-invalid" });
    expect(await drive(["submit", "--title", "t"])).toMatchObject({ rc: 1, slug: "socrates-flag-required" });
    expect(requests).toEqual([]);
  });

  it("asks for eris login when no token resolves", async () => {
    /** When a missing token reaches the wire, the endpoint's 401 hides the local fix. */
    const r = await drive(["submit", ...CANDIDATE], { env: { HOME: join(REPO, ".scratch", "no-such-home"), ERIS_YAKS_URL: `http://127.0.0.1:${server.port}` } });
    expect(r).toMatchObject({ rc: 1, slug: "yak-token-unresolved" });
    expect(requests).toEqual([]);
  });

  it("never sends a gitleaks-shaped secret, from any field, with or without an override", async () => {
    /** When the scan misses a field or an override reaches past it, a live credential leaves the machine; observed at the loopback endpoint, which receives nothing, and at the block, which never prints the secret. */
    const allowAll = REDACTION_CLASSES.flatMap((c) => ["--allow-redaction", c]);
    const shapes = [
      ["--title", GHP, "--statement", "s", "--source", "https://example.com/pr/14"],
      ["--title", "t", "--statement", `we pasted ${GHP} here`, "--source", "https://example.com/pr/14"],
      ["--title", "t", "--statement", "s", "--source", `https://example.com/pr/14?t=${GHP}`],
      [...CANDIDATE, "--project", GHP],
    ];
    for (const shape of shapes) {
      for (const extra of [[], ["--allow-redaction", "github-token", "--override-reason", "x"], [...allowAll, "--override-reason", "x"]]) {
        const r = await drive(["submit", ...shape, ...extra]);
        expect({ shape, extra, rc: r.rc, slug: r.slug, stdout: r.stdout }).toEqual({ shape, extra, rc: 1, slug: "socrates-secret-detected", stdout: "" });
        expect(r.stderr).not.toContain(GHP);
      }
    }
    const reason = await drive(["submit", ...CANDIDATE, "--allow-redaction", "assignment", "--override-reason", GHP]);
    expect(reason).toMatchObject({ rc: 1, slug: "socrates-secret-detected" });
    expect(requests).toEqual([]);
  });

  it("sends our redaction classes as markers, and says so on stderr", async () => {
    /** When a redaction class is skipped on the socrates path, a token the yak path would scrub reaches the endpoint; when the WARN is missing, the caller cannot tell their text changed. Observed at the body the endpoint received. */
    const sib = ["sib", "01HZX3K5Q8W2N4R6T8V0Y2B4D6", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
    const r = await drive(["submit", "--title", "t", "--statement", `ERIS_TOKEN=${sib}`, "--source", "https://example.com/pr/14"], { format: "json" });
    expect(r.rc).toBe(0);
    expect(r.stderr).toContain("socrates-redacted");
    expect(JSON.parse(r.stdout)).toMatchObject({ redactions: { count: 1, classes: ["sib-token"] }, overrides: [] });
    expect(requests).toHaveLength(1);
    expect((requests[0]!.body as { candidate: { statement: string } }).candidate.statement).toBe("ERIS_TOKEN=«redacted:sib-token»");
  });

  it("types the override: a known class, and a reason with it", async () => {
    /** When an unknown class is accepted, a typo silently overrides nothing; when the reason is optional, the vendor yak carries no why. Observed at the slug, with nothing sent. */
    expect(await drive(["submit", ...CANDIDATE, "--allow-redaction", "everything", "--override-reason", "x"])).toMatchObject({ rc: 1, slug: "socrates-override-invalid" });
    expect(await drive(["submit", ...CANDIDATE, "--allow-redaction", "jwt"])).toMatchObject({ rc: 1, slug: "socrates-flag-required" });
    expect(await drive(["submit", ...CANDIDATE, "--override-reason", "x"])).toMatchObject({ rc: 1, slug: "socrates-flag-required" });
    expect(requests).toEqual([]);
  });
});

describe("eris socrates submit --allow-redaction, through the eris entrypoint", () => {
  let sb: Sandbox;
  let both: ReturnType<typeof Bun.serve>;
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  const sib = ["sib", "01HZX3K5Q8W2N4R6T8V0Y2B4D6", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");

  beforeAll(() => {
    sb = sandbox("eris-socrates-");
    both = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const path = new URL(req.url).pathname;
        seen.push({ path, body: (await req.json()) as Record<string, unknown> });
        if (path === "/v1/yaks") return Response.json({ id: "yak_1", idempotency_key: "k", replay: false, contract_version: "2.0.0" });
        return Response.json({ candidate_id: "cand_1", deduped: false, contract_version: "1.0.0" });
      },
    });
  });
  afterAll(() => {
    both.stop(true);
    sb.cleanup();
  });

  it("files exactly one vendor yak naming the class, never the text, then sends the text as written", async () => {
    /** When an override files no yak (or one per field, or into the caller's own workspace), the vendor never learns its pattern over-matched; when the yak carries the text, the override leaks what it let through to a second tracker. Observed at one loopback server standing in for both endpoints, across the child `eris yak` process. */
    const env = { ERIS_YAKS_URL: `http://127.0.0.1:${both.port}`, ERIS_YAKS_TOKEN: TOKEN };
    const args = ["socrates", "submit", "--title", `about ${sib}`, "--statement", `the fixture ${sib} is not live`, "--source", "https://example.com/pr/14", "--allow-redaction", "sib-token", "--override-reason", "a test fixture, not a credential"];
    const r = await sb.run(args, { env });
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: "submitted: cand_1\n" });
    expect(seen.map((s) => s.path)).toEqual(["/v1/yaks", "/v1/socrates/submit"]);
    const yak = seen[0]!.body;
    expect(yak).toMatchObject({ verb: "issue", route: "vendor" });
    expect(JSON.stringify(yak)).not.toContain(sib.slice(4, 30));
    expect(String(yak.body)).toContain("sib-token in statement (1)");
    expect(String(yak.body)).toContain("sib-token in title (1)");
    expect((seen[1]!.body as { candidate: { statement: string } }).candidate.statement).toBe(`the fixture ${sib} is not live`);
  });

  it("sends nothing, and files no yak, when a secret sits beside the override", async () => {
    /** When the override path runs before the secret scan, the yak goes out and so might the secret; observed at the loopback server, which receives nothing. */
    seen.length = 0;
    const env = { ERIS_YAKS_URL: `http://127.0.0.1:${both.port}`, ERIS_YAKS_TOKEN: TOKEN };
    const r = await sb.run(["socrates", "submit", "--title", "t", "--statement", `ERIS_TOKEN=${sib} and ${GHP}`, "--source", "https://example.com/pr/14", "--allow-redaction", "sib-token", "--override-reason", "x"], { env });
    expectFailBlock(r, "socrates-secret-detected");
    expect(seen).toEqual([]);
  });
});
