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
import { CliExit } from "../src/cli/ts-verb";

const REPO = resolve(import.meta.dir, "..");
const TOKEN = ["sib", "01HZX3K5Q8W2N4R6T8V0Y2B4D6", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const SUBSCRIBE = "https://example.com/billing/subscribe?product=socrates";

const fixtures = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "socrates-contract-v1.json"), "utf8")) as {
  request: { accept: unknown[]; reject: unknown[] };
  response: { receipt: unknown[]; problem: unknown[]; reject: unknown[] };
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

  it("prints a deduped receipt as a bare JSON record under --output json", async () => {
    /** When a dedup reads as a failure or the record grows a wrapper, a script branching on `deduped` breaks. */
    answer = () => Response.json({ candidate_id: "cand_1", deduped: true, contract_version: "1.0.0" });
    expect(await drive(["submit", ...CANDIDATE], { format: "json" })).toMatchObject({ rc: 0, stdout: '{"candidate_id":"cand_1","deduped":true,"contract_version":"1.0.0"}\n', stderr: "" });
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
    expect(await drive(["submit", "--title", "t"])).toMatchObject({ rc: 1, slug: "socrates-flag-required" });
    expect(requests).toEqual([]);
  });

  it("asks for eris login when no token resolves", async () => {
    /** When a missing token reaches the wire, the endpoint's 401 hides the local fix. */
    const r = await drive(["submit", ...CANDIDATE], { env: { HOME: join(REPO, ".scratch", "no-such-home"), ERIS_YAKS_URL: `http://127.0.0.1:${server.port}` } });
    expect(r).toMatchObject({ rc: 1, slug: "yak-token-unresolved" });
    expect(requests).toEqual([]);
  });
});
