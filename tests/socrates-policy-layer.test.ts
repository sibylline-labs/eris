/**
 * `eris socrates classify` and `submit` under a rubric policy: the org policy
 * cached at `~/.eris/socrates-policy.json`, merged with the stricter-only layer
 * a repo's `eris.yaml` sets under `socrates.policy`.
 *
 * Drives the group handler in-process with a temp HOME and a temp repo (a
 * `.git` entry bounds the `eris.yaml` walk). `fetch` is the `SocratesDeps`
 * seam: it records every request and answers the policy GET and the submit
 * POST, so a test observes what left the machine, in what order.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultPolicy, RUBRIC_V1, RUBRIC_V2 } from "../packages/socrates-core/src/index";
import { runSocrates } from "../plugins/socrates/submit";
import { CliExit } from "../src/cli/ts-verb";

const REPO = resolve(import.meta.dir, "..");
const TOKEN = ["sib", "01HZX3K5Q8W2N4R6T8V0Y2B4D6", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const ENDPOINT = "https://socrates.example";
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);

const CANDIDATE = ["--title", "Errors use problem+json", "--statement", "Every 4xx/5xx is RFC 7807.", "--source", "https://example.com/pr/14"];

/** Every gate passes and the consequence scores 3, the rubric's threshold. */
const PASSING: Record<string, string> = {
  already_recorded: "new",
  end_condition: "none",
  owning_layer: "no-other-owner",
  practice: "what-the-system-is",
  reversibility: "more-than-a-setting",
  premise_basis: "observed",
  consequence: "a-service-contract",
};
const answers = (over: Record<string, string> = {}) => Object.entries({ ...PASSING, ...over }).flatMap(([q, v]) => ["--answer", `${q}=${v}`]);

const policyResult = (hash: string, policy: object, rubric_version = "rubric@v2") => ({ rubric_version, policy_hash: hash, policy, contract_version: "1.0.0" });
const ORG_V2 = { ...defaultPolicy(RUBRIC_V2), threshold: 5 };

let home: string;
let cwd: string;
let calls: { method: string; path: string; body: unknown }[];
let serverPolicy: object;
let receipt: object;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "eris-socrates-home-")));
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "eris-socrates-repo-")));
  mkdirSync(join(cwd, ".git"));
  mkdirSync(join(home, ".eris"));
  calls = [];
  serverPolicy = policyResult(H1, ORG_V2);
  receipt = { candidate_id: "cand_1", deduped: false, contract_version: "1.0.0" };
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const cacheFile = () => join(home, ".eris", "socrates-policy.json");
/** Fetched just now: a stamp refetches a policy over an hour old, which these tests do not mean to exercise. */
const writeCache = (result: object) => writeFileSync(cacheFile(), JSON.stringify({ ...result, fetched_at: new Date().toISOString() }));
const erisYaml = (text: string) => writeFileSync(join(cwd, "eris.yaml"), text);

async function drive(args: string[], opts: { format?: "text" | "json" } = {}) {
  let stdout = "";
  let stderr = "";
  const ctx = {
    erisDir: REPO,
    env: { HOME: home, ERIS_YAKS_URL: ENDPOINT, ERIS_YAKS_TOKEN: TOKEN },
    format: opts.format ?? "text",
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: (s: string) => ((stderr += s), true) },
  };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({ method: init?.method ?? "GET", path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return Response.json(path === "/v1/socrates/policy" ? serverPolicy : receipt);
  }) as unknown as typeof globalThis.fetch;
  let rc: number;
  try {
    rc = await runSocrates(args, ctx, { fetch, home, cwd });
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    rc = e.code;
  }
  const slug = stderr.split("\n").find((l) => l.startsWith("slug: "))?.slice("slug: ".length);
  return { rc, stdout, stderr, slug };
}

describe("eris socrates classify under the repo layer and the cached org policy", () => {
  // admits: a repo's raised threshold that classify ignores scores a candidate the repo meant to hold back as load-bearing; observed at the verdict, with no fetch. No type sees the file's value.
  it("scores under a raised repo threshold, and names the layer it applied", async () => {
    erisYaml("service: x\nsocrates:\n  policy:\n    threshold: 99\n");
    const r = await drive(["classify", ...CANDIDATE, ...answers()], { format: "json" });
    expect(r).toMatchObject({ rc: 0, stderr: "" });
    expect(JSON.parse(r.stdout)).toMatchObject({ verdict: "not-load-bearing", score: 3, threshold: 99, policy_hash: null, repo_policy: { threshold: 99 } });
    expect((await drive(["classify", ...CANDIDATE, ...answers()])).stdout).toBe("not-load-bearing: score 3 of 99 (rubric@v2)\n  policy: rubric defaults + repo layer\n");
    expect(calls).toEqual([]);
  });

  // admits: a loosening layer (a gate off, a key the layer cannot carry, YAML's `on`) that parses is applied or silently dropped; observed at the slug naming the file. The file is YAML, so only the parse holds it.
  it("refuses a layer that turns a gate off or carries any other key, naming the file", async () => {
    for (const body of ["gates:\n      end_condition:\n        enabled: false\n", "gates:\n      end_condition:\n        enabled: on\n", "verbosity: spine\n", "auto_resolve: true\n", "threshold: -1\n"]) {
      erisYaml(`socrates:\n  policy:\n    ${body}`);
      const r = await drive(["classify", ...CANDIDATE, ...answers()]);
      expect({ body, rc: r.rc, slug: r.slug, stdout: r.stdout }).toEqual({ body, rc: 1, slug: "socrates-repo-policy-invalid", stdout: "" });
      expect(r.stderr).toContain(join(cwd, "eris.yaml"));
    }
    erisYaml("socrates:\n  mode: strict\n");
    expect(await drive(["classify", ...CANDIDATE, ...answers()])).toMatchObject({ rc: 1, slug: "socrates-repo-policy-invalid" });
  });

  // admits: an eris.yaml that does not parse dropping its repo layer, so a repo's raised threshold is silently ignored; observed at the slug naming the file.
  it("refuses an eris.yaml that is not YAML instead of scoring without its layer", async () => {
    erisYaml("socrates:\n  policy:\n    threshold: 99\n  [unclosed\n");
    const r = await drive(["classify", ...CANDIDATE, ...answers()]);
    expect({ rc: r.rc, slug: r.slug, stdout: r.stdout }).toEqual({ rc: 1, slug: "socrates-repo-policy-invalid", stdout: "" });
    expect(r.stderr).toContain(join(cwd, "eris.yaml"));
    expect(calls).toEqual([]);
  });

  // admits: a threshold below the cached org's is clamped or applied, so a repo loosens the org policy; observed at the slug. Only the runtime org value can decide it.
  it("refuses a repo threshold below the cached org's", async () => {
    writeCache(policyResult(H1, ORG_V2));
    erisYaml("socrates:\n  policy:\n    threshold: 4\n");
    const r = await drive(["classify", ...CANDIDATE, ...answers()]);
    expect(r).toMatchObject({ rc: 1, stdout: "", slug: "socrates-repo-policy-looser" });
    expect(r.stderr).toContain("threshold 4 is below the org's 5");
  });

  // admits: an org policy cached for another rubric is applied to this one (or this one's is ignored), so the local verdict disagrees with the server's; observed at the verdict and the policy_hash it names.
  it("uses the cached org policy only when its rubric is the one scoring, and never overrides a gate it turns off", async () => {
    writeCache(policyResult(H1, { ...defaultPolicy(RUBRIC_V1), threshold: 50 }, "rubric@v1"));
    expect(JSON.parse((await drive(["classify", ...CANDIDATE, ...answers()], { format: "json" })).stdout)).toMatchObject({ verdict: "load-bearing", threshold: 3, policy_hash: null, repo_policy: null });

    const off = { ...ORG_V2, gates: { ...ORG_V2.gates, end_condition: { enabled: false, weight: 0 } } };
    writeCache(policyResult(H1, off));
    const r = await drive(["classify", ...CANDIDATE, ...answers({ end_condition: "has-end-condition" })], { format: "json" });
    expect(JSON.parse(r.stdout)).toMatchObject({ verdict: "not-load-bearing", score: 3, threshold: 5, policy_hash: H1, repo_policy: null });
    expect((await drive(["classify", ...CANDIDATE, ...answers({ end_condition: "has-end-condition" })])).stdout).toContain(`  policy: org ${H1.slice(0, 12)}\n`);
    expect(await drive(["classify", ...CANDIDATE, ...answers({ end_condition: "has-end-condition" }), "--override", "end_condition=x"])).toMatchObject({ rc: 1, slug: "socrates-override-invalid" });
    expect(calls).toEqual([]);
  });
});

describe("eris socrates submit --answer", () => {
  // admits: a stamped submit sent without a cached policy carries no hash the server can compare, or a corrupt cache crashes the verb; observed at the requests in order and the body sent.
  it("fetches the org policy first when the cache is absent or corrupt, then sends the stamp", async () => {
    erisYaml("socrates:\n  policy:\n    threshold: 9\n");
    receipt = { candidate_id: "cand_1", deduped: false, contract_version: "1.0.0", classification: { verdict: "pass", rubric_version: "rubric@v2", policy_hash: H1, reclassified: false } };
    for (const cache of [undefined, "{not json", JSON.stringify({ rubric_version: "rubric@v2" })]) {
      calls = [];
      rmSync(cacheFile(), { force: true });
      if (cache !== undefined) writeFileSync(cacheFile(), cache);
      const r = await drive(["submit", ...CANDIDATE, ...answers()]);
      expect({ cache, ...r }).toMatchObject({ cache, rc: 0, stderr: "", stdout: `submitted: cand_1\n  verdict: pass (rubric@v2, policy ${H1.slice(0, 12)})\n` });
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/socrates/policy", "POST /v1/socrates/submit"]);
      expect(calls[0]!.body).toBeUndefined();
      expect((calls[1]!.body as { classification: unknown }).classification).toEqual({ rubric_version: "rubric@v2", policy_hash: H1, answers: PASSING, repo_policy: { threshold: 9 } });
      expect(JSON.parse(readFileSync(cacheFile(), "utf8"))).toMatchObject({ rubric_version: "rubric@v2", policy_hash: H1, policy: ORG_V2 });
    }
    calls = [];
    expect((await drive(["submit", ...CANDIDATE, ...answers()])).rc).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/socrates/submit"]);
  });

  // admits: a reclassified receipt reads as the verdict eris scored, or the stale cache is kept so every later submit is reclassified too; observed at the WARN and at the GET that follows the POST.
  it("warns on a reclassified receipt and refreshes the cache", async () => {
    writeCache(policyResult(H1, ORG_V2));
    serverPolicy = policyResult(H2, { ...ORG_V2, threshold: 7 });
    receipt = { candidate_id: "cand_1", deduped: false, contract_version: "1.0.0", classification: { verdict: "fail", rubric_version: "rubric@v2", policy_hash: H2, reclassified: true, stamped_policy_hash: H1 } };
    const r = await drive(["submit", ...CANDIDATE, ...answers()], { format: "json" });
    expect(r.rc).toBe(0);
    expect(r.stderr).toContain(`reclassified under ${H2.slice(0, 12)} (was ${H1.slice(0, 12)}): fail`);
    expect(r.stderr).toContain("socrates-reclassified");
    expect(JSON.parse(r.stdout)).toMatchObject({ candidate_id: "cand_1", classification: { verdict: "fail", reclassified: true, stamped_policy_hash: H1 } });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/socrates/submit", "GET /v1/socrates/policy"]);
    expect((calls[0]!.body as { classification: { policy_hash: string } }).classification.policy_hash).toBe(H1);
    expect(JSON.parse(readFileSync(cacheFile(), "utf8"))).toMatchObject({ policy_hash: H2 });
  });

  // admits: rubric answers on a candidate the server never scores reach the wire, or a looser repo layer is sent for the server to find; observed at the slug with no request made.
  it("sends nothing for answers on a prd or conflict, or under a looser repo layer", async () => {
    const prd = ["--kind", "prd", "--title", "PRD — Acme Billing", "--source", "https://docs.example.com/acme/document/billing", "--statement", "Decisions: `ACME-K1`–`ACME-K57`\nConfirmed by: dana"];
    expect(await drive(["submit", ...prd, ...answers()])).toMatchObject({ rc: 1, slug: "socrates-answers-invalid" });
    expect(await drive(["submit", ...prd, "--override", "end_condition=a"])).toMatchObject({ rc: 1, slug: "socrates-override-invalid" });
    expect(await drive(["submit", ...CANDIDATE, "--override", "end_condition=a"])).toMatchObject({ rc: 1, slug: "socrates-flag-required" });
    writeCache(policyResult(H1, ORG_V2));
    erisYaml("socrates:\n  policy:\n    threshold: 4\n");
    expect(await drive(["submit", ...CANDIDATE, ...answers()])).toMatchObject({ rc: 1, slug: "socrates-repo-policy-looser" });
    expect(calls).toEqual([]);
    expect(existsSync(cacheFile())).toBe(true);
  });
});
