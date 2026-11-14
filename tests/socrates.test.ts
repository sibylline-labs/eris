/**
 * `eris socrates submit` and the vendored submit contract v1.
 *
 * The contract half decodes tests/fixtures/socrates-contract-v1.json, the same
 * golden file the contract's source decodes, so the two copies cannot drift
 * without one suite failing. The verb half drives the handler against a
 * loopback `Bun.serve` standing in for the endpoint; every request crosses real
 * HTTP. The token is assembled at runtime so no literal trips a secret scanner.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SocratesProblem, SocratesSubmitReceipt, SocratesSubmitRequest, SocratesSubmitResponse } from "../plugins/socrates/socrates-contract.v1";
import { runSocrates } from "../plugins/socrates/submit";
import { REDACTION_CLASSES } from "../packages/outbound-scan/src/index";
import * as Verbs from "../plugins/socrates/socrates-contract.v1.verbs";
import { RUBRICS } from "../packages/socrates-core/src/index";
import type { ZodTypeAny } from "zod";
import { CliExit } from "../src/cli/ts-verb";
import { expectFailBlock, type Sandbox, sandbox } from "./helpers/blackbox";
import { answers, H1, ORG_POLICY, PASSING, policyResult } from "./helpers/socrates-fake";

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
  settings_team: { request: Verbs.SocratesSettingsTeamRequest, response: Verbs.SocratesSettingsTeamResponse },
  settings: { response: Verbs.SocratesSettingsResponse },
  settings_policy: { request: Verbs.SocratesSettingsPolicyRequest, response: Verbs.SocratesSettingsWriteResponse },
  settings_canon: { request: Verbs.SocratesSettingsCanonRequest, response: Verbs.SocratesSettingsWriteResponse },
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
    for (const [version, rubric] of Object.entries(RUBRICS)) {
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
/** A throwaway HOME holding a policy fetched just now, so a stamped submit needs no policy GET. */
let home: string;

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
  home = realpathSync(mkdtempSync(join(tmpdir(), "eris-socrates-home-")));
  mkdirSync(join(home, ".eris"));
  writeFileSync(join(home, ".eris", "socrates-policy.json"), JSON.stringify({ ...policyResult(H1, ORG_POLICY), fetched_at: new Date().toISOString() }));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const problem = (status: number, code: string, detail: string) =>
  Response.json({ type: `urn:hera:error:${code}`, title: code, status, detail, code }, { status, headers: { "content-type": "application/problem+json" } });

const CANDIDATE = ["--title", "Errors use problem+json", "--statement", "Every 4xx/5xx is RFC 7807.", "--source", "https://example.com/pr/14"];
/** A decision carries a stamp; these tests are about the exchange, not the answers. */
const STAMPED = [...CANDIDATE, ...answers()];

async function drive(args: string[], opts: { format?: "text" | "json"; env?: Record<string, string> } = {}) {
  let stdout = "";
  let stderr = "";
  const ctx = {
    erisDir: REPO,
    env: opts.env ?? { HOME: home, ERIS_YAKS_URL: `http://127.0.0.1:${server.port}`, ERIS_YAKS_TOKEN: TOKEN },
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
  // admits: a multi-line decision or practice statement filed as a review issue is marked Done and then refuses forever at resolve time; the statement string is runtime data no type or lint rule sees.
  it("refuses a multi-line decision or practice statement before sending anything", async () => {
    /** When submit lets a decision or practice statement with a line break through, a review issue is filed that resolve can never write; observed as rc 1, slug socrates-candidate-invalid and zero HTTP requests. */
    for (const kind of ["decision", "practice"]) {
      const r = await drive(["submit", "--title", "Errors use problem+json", "--source", "https://example.com/pr/14", "--kind", kind, "--statement", "Line 1\nLine 2", ...answers()]);
      expect({ kind, rc: r.rc, slug: r.slug }).toEqual({ kind, rc: 1, slug: "socrates-candidate-invalid" });
    }
    expect(requests).toEqual([]);
    expect((await drive(["submit", "--help"])).stdout).toContain("single line");
  });

  // admits: an ambiguity refusal that exits non-zero or drops its candidates.
  it("an ambiguous project name prints its candidates as a WARN and exits 0", async () => {
    /** When a 409 linear_ref_ambiguous on a project name reads as a failure block, the submitter gets exit 1 and no list to choose from; observed as rc, stdout and the WARN on stderr. */
    answer = () =>
      Response.json(
        { type: "urn:hera:error:linear_ref_ambiguous", title: "linear_ref_ambiguous", status: 409, detail: "More than one Linear object matches the reference", code: "linear_ref_ambiguous", kind: "project", candidates: [{ id: "proj_a", name: "Platform" }, { id: "proj_b", name: "Platform" }] },
        { status: 409, headers: { "content-type": "application/problem+json" } },
      );
    const r = await drive(["submit", ...STAMPED, "--project", "Platform"]);
    expect(r).toMatchObject({ rc: 0, stdout: "", slug: "socrates-ref-ambiguous" });
    expect(r.stderr).toContain("  proj_a  Platform\n  proj_b  Platform\n");
  });

  it("posts one schema-checked candidate with the login bearer and prints the receipt", async () => {
    /** When the body, path or bearer drifts, the endpoint refuses every submission. */
    expect(await drive(["submit", ...STAMPED, "--project", "platform"])).toMatchObject({ rc: 0, stdout: "submitted: cand_1\n", stderr: "" });
    expect(requests).toEqual([
      {
        path: "/v1/socrates/submit",
        auth: `Bearer ${TOKEN}`,
        body: {
          schema_version: "1.0.0",
          candidate: { kind: "decision", title: "Errors use problem+json", statement: "Every 4xx/5xx is RFC 7807.", source: "https://example.com/pr/14", project: "platform" },
          classification: { rubric_version: "rubric@v4", policy_hash: H1, answers: PASSING },
        },
      },
    ]);
  });

  it("sends now: true under --now", async () => {
    /** When the flag is dropped from the body, `submit --now` silently asks for nothing. Without the flag, the exact body above carries no `now`. */
    expect(await drive(["submit", ...STAMPED, "--now"])).toMatchObject({ rc: 0, stdout: "submitted: cand_1\n", stderr: "" });
    expect(requests.map((r) => (r.body as { now?: unknown }).now)).toEqual([true]);
  });

  // admits: boundary-io: a scope, section or evidence holding U+2028/U+2029 passes the contract, is filed, then renderDecision refuses it at resolve time; the string is runtime data no type or lint rule sees.
  it("sends scope, section, evidence and target when supplied, and refuses invalid values locally", async () => {
    /** When the entry-anatomy flags are dropped or not validated before sending, the server receives a bare candidate or rejects at the door. */
    expect(
      await drive([
        "submit",
        ...STAMPED,
        "--scope",
        "repo",
        "--section",
        "## Current",
        "--evidence",
        "decided in pull request",
        "--target",
        "lbd",
      ]),
    ).toMatchObject({ rc: 0, stdout: "submitted: cand_1\n", stderr: "" });
    expect((requests[0]?.body as { candidate: Record<string, unknown> }).candidate).toMatchObject({
      scope: "repo",
      section: "## Current",
      evidence: "decided in pull request",
      target: "lbd",
    });
    expect(await drive(["submit", ...STAMPED, "--target", "unknown_doc"])).toMatchObject({ rc: 1, slug: "socrates-candidate-invalid" });
    expect(await drive(["submit", ...STAMPED, "--scope", "repo\norg"])).toMatchObject({ rc: 1, slug: "socrates-candidate-invalid" });
    for (const flag of ["--scope", "--section", "--evidence"]) {
      for (const sep of ["\u2028", "\u2029"]) {
        expect(await drive(["submit", ...STAMPED, flag, `a${sep}b`])).toMatchObject({ rc: 1, slug: "socrates-candidate-invalid" });
      }
    }
  });

  it("prints a deduped receipt as a bare JSON record under --output json", async () => {
    /** When a dedup reads as a failure or the record grows a wrapper, a script branching on `deduped` breaks. */
    answer = () => Response.json({ candidate_id: "cand_1", deduped: true, contract_version: "1.0.0" });
    expect(await drive(["submit", ...STAMPED], { format: "json" })).toMatchObject({
      rc: 0,
      stdout: '{"candidate_id":"cand_1","deduped":true,"contract_version":"1.0.0","redactions":{"count":0,"classes":[]},"overrides":[]}\n',
      stderr: "",
    });
    expect((await drive(["submit", ...STAMPED])).stdout).toBe("already submitted: cand_1\n");
  });

  it("says a candidate the verbosity cap holds is held, and until when", async () => {
    /** When the hold is not printed, a submitter cannot tell a held candidate from a stalled one; when an unheld receipt changes, scripts reading it break. */
    const held = { held_until: "2026-11-12T00:00:00.000Z", held_reason: "verbosity_cap" };
    answer = () => Response.json({ candidate_id: "cand_1", deduped: false, contract_version: "1.0.0", ...held });
    expect(await drive(["submit", ...STAMPED])).toMatchObject({ rc: 0, stdout: "submitted: cand_1\n  held by the verbosity cap until Nov-12 00:00Z\n", stderr: "" });
    expect((await drive(["submit", ...STAMPED], { format: "json" })).stdout).toBe(
      '{"candidate_id":"cand_1","deduped":false,"contract_version":"1.0.0","held_until":"2026-11-12T00:00:00.000Z","held_reason":"verbosity_cap","redactions":{"count":0,"classes":[]},"overrides":[]}\n',
    );
    answer = () => Response.json({ candidate_id: "cand_1", deduped: false, contract_version: "1.0.0" });
    expect((await drive(["submit", ...STAMPED])).stdout).toBe("submitted: cand_1\n");
  });

  it("prints the subscribe link when the endpoint says the workspace is not entitled", async () => {
    /** When the 402 loses its link, an unentitled user has no way forward from the CLI. */
    answer = () =>
      Response.json(
        { type: "urn:hera:error:entitlement_lapsed", title: "Organization entitlement has lapsed", status: 402, detail: "not entitled to socrates", code: "entitlement_lapsed", _links: { subscribe: { href: SUBSCRIBE } } },
        { status: 402, headers: { "content-type": "application/problem+json" } },
      );
    const r = await drive(["submit", ...STAMPED], { format: "json" });
    expect(r).toMatchObject({ rc: 1, stdout: "", slug: "socrates-not-entitled" });
    expect(r.stderr).toContain(`fix: subscribe: ${SUBSCRIBE}\n`);
  });

  it("refuses an answer that is neither a receipt nor a problem+json error", async () => {
    /** When an untyped body passes, a proxy page or another service's JSON prints as a receipt. */
    for (const body of [new Response("<html>502</html>", { status: 502 }), Response.json({ ok: true }), Response.json({ ok: false, code: "x", status: 402 }, { status: 402 })]) {
      answer = () => body.clone();
      expect(await drive(["submit", ...STAMPED])).toMatchObject({ rc: 1, stdout: "", slug: "socrates-bad-response" });
    }
  });

  it("names a problem without a subscribe link as a refusal", async () => {
    /** When every problem reads as not-entitled, a revoked token sends the user to a billing page. */
    answer = () => Response.json({ type: "urn:hera:error:unauthorized", title: "Unauthorized", status: 401, detail: "Unauthorized", code: "unauthorized" }, { status: 401 });
    const r = await drive(["submit", ...STAMPED]);
    expect(r).toMatchObject({ rc: 1, slug: "socrates-refused" });
    expect(r.stderr).toContain("eris login");
  });

  it("prints the reason and the next step of each unenrolled refusal, and a fix line that defers to it", async () => {
    /** When a 409 prints only `Conflict`, a user with no enrolled project is told to check the candidate they sent. */
    const details = [
      'Linear is not installed for this org. An org admin installs it at https://dash.example/socrates, then add the "Socrates › Enrolled" label to a Linear project.',
      'No Linear project is enrolled in Socrates. Add the "Socrates › Enrolled" label to a Linear project, then run the command again.',
      'No Linear project is enrolled in Socrates. If Linear is not installed for this org, an org admin installs it at https://dash.example/socrates. Then add the "Socrates › Enrolled" label to a Linear project.',
    ];
    for (const detail of details) {
      answer = () => problem(409, "conflict", detail);
      const r = await drive(["submit", ...STAMPED]);
      expect(r).toMatchObject({ rc: 1, stdout: "", slug: "socrates-refused" });
      expect(r.stderr).toContain(`the endpoint refused the candidate: ${detail} (conflict, HTTP 409)`);
      expect(r.stderr).toContain("fix: follow the step named above, then run the command again");
      expect(r.stderr).not.toContain("check the candidate");
    }
  });

  it("prints the detail and code of every other problem refusal", async () => {
    /** When a 404 or 422 refusal loses its reason on the way to the terminal, the user is left with a status and no cause. */
    answer = () => problem(404, "not_found", 'Project "Agentic Harness" is not enrolled in Socrates; enrolled projects: Eris Yaks');
    expect((await drive(["submit", ...STAMPED, "--project", "Agentic Harness"])).stderr).toContain('refused the candidate: Project "Agentic Harness" is not enrolled in Socrates; enrolled projects: Eris Yaks (not_found, HTTP 404)');
    answer = () => problem(422, "unprocessable_entity", "Entry title must be at most 80 characters (got 90)");
    expect((await drive(["submit", ...STAMPED])).stderr).toContain("refused the candidate: Entry title must be at most 80 characters (got 90) (unprocessable_entity, HTTP 422)");
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
    const r = await drive(["submit", ...STAMPED], { env: { HOME: join(REPO, ".scratch", "no-such-home"), ERIS_YAKS_URL: `http://127.0.0.1:${server.port}` } });
    expect(r).toMatchObject({ rc: 1, slug: "yak-token-unresolved" });
    expect(requests).toEqual([]);
  });

  it("refuses an ERIS_YAKS_TOKEN with no URL rather than sending it to the default host", async () => {
    /** When an env bearer falls through to the built-in URL, a token set for one endpoint is posted to api.sibylline.group: observed at the slug and exit code, before any request. */
    const r = await drive(["submit", ...STAMPED], { env: { HOME: join(REPO, ".scratch", "no-such-home"), ERIS_YAKS_TOKEN: TOKEN } });
    expect(r).toMatchObject({ rc: 1, slug: "yak-url-unresolved" });
    expect(r.stderr).not.toContain(TOKEN);
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
      [...CANDIDATE, "--scope", GHP],
      [...CANDIDATE, "--section", GHP],
      [...CANDIDATE, "--evidence", GHP],
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
    const r = await drive(["submit", "--title", "t", "--statement", `ERIS_TOKEN=${sib}`, "--source", "https://example.com/pr/14", ...answers()], { format: "json" });
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
  const seen: { path: string; body: Record<string, unknown> | undefined }[] = [];
  const sib = ["sib", "01HZX3K5Q8W2N4R6T8V0Y2B4D6", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");

  beforeAll(() => {
    sb = sandbox("eris-socrates-");
    both = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const path = new URL(req.url).pathname;
        seen.push({ path, body: req.method === "GET" ? undefined : ((await req.json()) as Record<string, unknown>) });
        if (path === "/v1/yaks") return Response.json({ id: "yak_1", idempotency_key: "k", replay: false, contract_version: "2.0.0" });
        if (path === "/v1/socrates/policy") return Response.json(policyResult(H1, ORG_POLICY));
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
    const args = ["socrates", "submit", "--title", `about ${sib}`, "--statement", `the fixture ${sib} is not live`, "--source", "https://example.com/pr/14", "--allow-redaction", "sib-token", "--override-reason", "a test fixture, not a credential", ...answers()];
    const r = await sb.run(args, { env });
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: "submitted: cand_1\n" });
    expect(seen.map((s) => s.path)).toEqual(["/v1/socrates/policy", "/v1/yaks", "/v1/socrates/submit"]);
    const yak = seen[1]!.body!;
    expect(yak).toMatchObject({ verb: "issue", route: "vendor" });
    expect(JSON.stringify(yak)).not.toContain(sib.slice(4, 30));
    expect(String(yak.body)).toContain("sib-token in statement (1)");
    expect(String(yak.body)).toContain("sib-token in title (1)");
    expect((seen[2]!.body as { candidate: { statement: string } }).candidate.statement).toBe(`the fixture ${sib} is not live`);
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

describe("eris socrates submit entry-title preflight", () => {
  // admits: when submit lets an over-long, multi-line, or unbackticked dotted-token title past preflight, it fetches policy and sends a POST the endpoint refuses; runtime string bounds and call ordering require a seam test.
  it("refuses invalid entry titles locally before any HTTP call, states <= 80 and backticks in --help, and checks the post-redaction title", async () => {
    /** When submit only checks the 200-char wire schema, stamped and unfit submits send invalid titles over HTTP and --help misleads callers with `<= 200 chars`. Observed at the loopback request log and stderr. */
    requests.length = 0;
    const prdStmt = "Decisions: `ACME-K1`–`ACME-K2`\nConfirmed by: dana";
    const bad: [string, string[], RegExp][] = [
      ["stamped > 80 chars", ["submit", "--title", "x".repeat(81), "--statement", "s", "--source", "https://example.com/pr/14", ...answers()], /<= 80 characters/],
      ["unfit > 80 chars", ["submit", "--title", "x".repeat(85), "--statement", "s", "--source", "https://example.com/pr/14", "--unfit", "--hypothesis", "h"], /<= 80 characters/],
      ["prd > 66 chars", ["submit", "--kind", "prd", "--title", "z".repeat(67), "--statement", prdStmt, "--source", "https://docs.example.com/acme/billing"], /<= 66 characters/],
      ["unbackticked dotted token", ["submit", "--title", "Adopt request.signal in handlers", "--statement", "s", "--source", "https://example.com/pr/14", ...answers()], /backticks/],
      ["multi-line title", ["submit", "--title", "One\nTwo", "--statement", "s", "--source", "https://example.com/pr/14", ...answers()], /single-line/],
      ["trailing newline title", ["submit", "--title", "Trailing\n", "--statement", "s", "--source", "https://example.com/pr/14", ...answers()], /single-line/],
    ];
    for (const [label, args, fixRe] of bad) {
      const r = await drive(args);
      expect({ label, rc: r.rc, slug: r.slug, stdout: r.stdout }).toEqual({ label, rc: 1, slug: "socrates-candidate-invalid", stdout: "" });
      expect({ label, stderr: r.stderr }).toEqual({ label, stderr: expect.stringMatching(fixRe) });
    }
    expect(requests).toEqual([]);

    const help = await drive(["submit", "--help"]);
    expect(help.rc).toBe(0);
    expect(help.stdout).toContain("<= 80 chars");
    expect(help.stdout).toContain("backticks");
    expect(help.stdout).not.toMatch(/--title <text>\s+required, <= 200 chars/);

    // Boundary & redaction order: 80 chars, backticked dotted token, and a >80 raw title that redacts below 80 all pass.
    answer = () => Response.json({ candidate_id: "cand_1", deduped: false, contract_version: "1.0.0" });
    const sib = ["sib", "01HZX3K5Q8W2N4R6T8V0Y2B4D6", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
    expect(await drive(["submit", "--title", "x".repeat(80), "--statement", "s", "--source", "https://example.com/pr/14", ...answers()])).toMatchObject({ rc: 0 });
    expect(await drive(["submit", "--title", "Adopt `request.signal` in handlers", "--statement", "s", "--source", "https://example.com/pr/14", ...answers()])).toMatchObject({ rc: 0 });
    expect(await drive(["submit", "--title", `Token in title ${sib}`, "--statement", "s", "--source", "https://example.com/pr/14", ...answers()])).toMatchObject({ rc: 0 });
    expect(requests).toHaveLength(3);
  });

  // admits: boundary-io: eris socrates submit --kind prd must forward Url-valid ()<> --source over the real loopback HTTP seam and refuse invalid --source or bracketed PRD --title locally without blaming the prd statement; CLI validation and loopback HTTP wire behavior are invisible to tsc and ast-grep.
  it("accepts ()<> in --source for --kind prd and refuses invalid --source or bracketed --title without blaming the statement", async () => {
    requests.length = 0;
    answer = () => Response.json({ candidate_id: "cand_prd_1", deduped: false, contract_version: "1.0.0" });
    const prdStmt = "Decisions: `ACME-K1`–`ACME-K2`\nConfirmed by: dana";
    const wikiUrl = "https://en.wikipedia.org/wiki/Problem_details_(HTTP)?q=<a>";
    const ok = await drive(["submit", "--kind", "prd", "--title", "PRD — Problem Details", "--statement", prdStmt, "--source", wikiUrl]);
    expect(ok).toMatchObject({ rc: 0, stdout: "submitted: cand_prd_1\n", stderr: "" });
    expect(requests).toHaveLength(1);
    expect((requests[0]!.body as { candidate: { kind: string; source: string } }).candidate).toMatchObject({
      kind: "prd",
      source: wikiUrl,
    });

    const badSource = await drive(["submit", "--kind", "prd", "--title", "PRD — Problem Details", "--statement", prdStmt, "--source", "https://example.com/a b"]);
    expect({ rc: badSource.rc, slug: badSource.slug }).toEqual({ rc: 1, slug: "socrates-candidate-invalid" });
    expect(badSource.stderr).toContain("source: must be an absolute http(s) URL");
    expect(badSource.stderr).not.toContain("prd statement");

    const badTitle = await drive(["submit", "--kind", "prd", "--title", "PRD [draft]", "--statement", prdStmt, "--source", "https://docs.example.com/acme/billing"]);
    expect({ rc: badTitle.rc, slug: badTitle.slug }).toEqual({ rc: 1, slug: "socrates-candidate-invalid" });
    expect(badTitle.stderr).toContain("--title");
    expect(badTitle.stderr).not.toContain("prd statement");
    expect(requests).toHaveLength(1);
  });

  // admits: boundary-io: eris socrates submit --kind prd must refuse odd trailing-backslash --title, trailing-backslash --source, and C0/DEL --source locally with field-accurate errors and 0 HTTP requests while accepting even trailing-backslash PRD titles; CLI parsing, Zod validation, title check, and loopback HTTP interact only at runtime.
  it("refuses odd trailing-backslash PRD --title and backslash or C0/DEL --source locally with 0 HTTP requests", async () => {
    requests.length = 0;
    answer = () => Response.json({ candidate_id: "cand_prd_bs", deduped: false, contract_version: "1.0.0" });
    const prdStmt = "Decisions: `ACME-K1`–`ACME-K2`\nConfirmed by: dana";

    const evenOk = await drive(["submit", "--kind", "prd", "--title", "PRD — Foo\\\\", "--statement", prdStmt, "--source", "https://docs.example.com/acme/billing"]);
    expect(evenOk).toMatchObject({ rc: 0, stdout: "submitted: cand_prd_bs\n", stderr: "" });
    expect(requests).toHaveLength(1);

    for (const oddTitle of ["PRD — Foo\\", "PRD — Foo\\\\\\", "PRD — Foo\\ "]) {
      const badTitle = await drive(["submit", "--kind", "prd", "--title", oddTitle, "--statement", prdStmt, "--source", "https://docs.example.com/acme/billing"]);
      expect({ oddTitle, rc: badTitle.rc, slug: badTitle.slug }).toEqual({ oddTitle, rc: 1, slug: "socrates-candidate-invalid" });
      expect(badTitle.stderr).toContain("--title");
      expect(badTitle.stderr).not.toContain("prd statement");
    }

    for (const badUrl of ["https://example.com/foo\\", "https://example.com/\u0000nul", "https://example.com/\u0007bell", "https://example.com/\u007fdel"]) {
      const badSource = await drive(["submit", "--kind", "prd", "--title", "PRD — Foo", "--statement", prdStmt, "--source", badUrl]);
      expect({ badUrl, rc: badSource.rc, slug: badSource.slug }).toEqual({ badUrl, rc: 1, slug: "socrates-candidate-invalid" });
      expect(badSource.stderr).toContain("source: must be an absolute http(s) URL");
      expect(badSource.stderr).not.toContain("prd statement");
    }
    expect(requests).toHaveLength(1);
  });
});
