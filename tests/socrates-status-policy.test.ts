/**
 * `eris socrates status` and `eris socrates policy`.
 *
 * Drives the group handler in-process with a temp HOME and a fake endpoint (tests/helpers/
 * socrates-fake.ts): every request is recorded, so a test observes what left the machine, and
 * the policy cache is a file the test reads back.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { GHP, H1, H2, ORG_POLICY, policyResult, socratesFake, type SocratesFake } from "./helpers/socrates-fake";

const problem = (status: number, code: string, detail: string, extra: Record<string, unknown> = {}) =>
  Response.json({ type: `urn:hera:error:${code}`, title: code, status, detail, code, ...extra }, { status, headers: { "content-type": "application/problem+json" } });

const STATUS = {
  rubric_version: "rubric@v3",
  policy_hash: H1,
  pending_candidates: 3,
  open_epics: [
    { epic: "epic_412", project: "Platform", url: "https://linear.example/epic/412", open_children: 4 },
    { epic: "epic_419", project: "Billing", url: "https://linear.example/epic/419", open_children: 0 },
  ],
  contract_version: "1.0.0",
};
const CANDIDATE_STATUS = { candidate_id: "cand_1", state: "needs_input", issue_url: "https://linear.example/issue/abc" };

let fake: SocratesFake;
beforeEach(() => {
  fake = socratesFake();
  fake.answer.status = () => Response.json(STATUS);
});
afterEach(() => fake.cleanup());

const requests = () => fake.calls.map((c) => `${c.method} ${c.path}${c.search === "" ? "" : `?${c.search}`}`);

describe("eris socrates status", () => {
  // admits: the verb is not routed, or sends a body on a GET, or the counts and Epics drop out of the output; observed at the request the endpoint received and at stdout.
  it("asks for the status and prints the pending count and the open review Epics", async () => {
    const r = await fake.drive(["status"]);
    expect(r).toMatchObject({ rc: 0, stderr: "" });
    expect(r.stdout).toBe("pending candidates: 3\nopen review Epics: 2\n  epic_412  Platform  4 open  https://linear.example/epic/412\n  epic_419  Billing  0 open  https://linear.example/epic/419\n");
    expect(requests()).toEqual(["GET /v1/socrates/status"]);
    expect(fake.calls[0]!.body).toBeUndefined();
  });

  // admits: the candidate id is not sent as the contract's `candidate_id` query, or its state is not printed; observed at the query the endpoint received and at stdout.
  it("asks about one candidate and prints its state and issue", async () => {
    fake.answer.status = () => Response.json({ ...STATUS, candidate: CANDIDATE_STATUS });
    const r = await fake.drive(["status", "--candidate", "cand_1"]);
    expect(r).toMatchObject({ rc: 0, stderr: "" });
    expect(r.stdout).toContain("candidate cand_1: needs_input\n  issue: https://linear.example/issue/abc\n");
    expect(r.stdout).toContain("pending candidates: 3\n");
    expect(requests()).toEqual(["GET /v1/socrates/status?candidate_id=cand_1"]);
  });

  // admits: a held candidate reads as plain `pending`, so its submitter cannot tell a hold from a stall; also an old client schema (no held fields) failing to decode the new answer.
  it("says a candidate the verbosity cap holds is held, and until when", async () => {
    const held = { ...CANDIDATE_STATUS, state: "pending", held_until: "2026-11-12T00:00:00.000Z", held_reason: "verbosity_cap" };
    fake.answer.status = () => Response.json({ ...STATUS, candidate: held });
    const r = await fake.drive(["status", "--candidate", "cand_1"]);
    expect(r).toMatchObject({ rc: 0, stderr: "" });
    expect(r.stdout).toContain("candidate cand_1: pending\n  issue: https://linear.example/issue/abc\n  held by the verbosity cap until Nov-12 00:00Z\n");
    const json = await fake.drive(["status", "--candidate", "cand_1"], { format: "json" });
    expect(JSON.parse(json.stdout).candidate).toMatchObject({ held_until: "2026-11-12T00:00:00.000Z", held_reason: "verbosity_cap" });

    fake.answer.status = () => Response.json({ ...STATUS, candidate: CANDIDATE_STATUS });
    expect((await fake.drive(["status", "--candidate", "cand_1"])).stdout).not.toContain("held");
  });

  // admits: the json form reshapes the decoded record, or text drops it; a script reading `candidate.state` breaks. Observed at stdout, byte for byte, against what the endpoint answered.
  it("prints the decoded record under --output json", async () => {
    fake.answer.status = () => Response.json({ ...STATUS, candidate: CANDIDATE_STATUS });
    const r = await fake.drive(["status", "--candidate", "cand_1"], { format: "json" });
    expect(r).toMatchObject({ rc: 0, stderr: "" });
    expect(JSON.parse(r.stdout)).toEqual({ ...STATUS, candidate: CANDIDATE_STATUS });
    expect(r.stdout.endsWith("\n")).toBe(true);
    expect(r.stdout.trimEnd().includes("\n")).toBe(false);
  });

  // admits: text the server sent reaches the terminal with its control characters, so a project name can drive the terminal; observed at stdout, which keeps the name and loses the escape.
  it("strips terminal control characters from what the server sent", async () => {
    fake.answer.status = () => Response.json({ ...STATUS, open_epics: [{ ...STATUS.open_epics[0]!, project: "Plat\u001b[31mform" }] });
    const r = await fake.drive(["status"]);
    expect(r.stdout).toContain("Plat[31mform");
    expect(r.stdout).not.toContain("\u001b");
  });

  // admits: an answer that is not about the candidate asked for (an older server ignoring the query) prints the org's status as if it were the candidate's; observed at the slug, with nothing on stdout.
  it("fails when the answer holds no state for the candidate asked about, or another candidate's", async () => {
    for (const reply of [STATUS, { ...STATUS, candidate: { ...CANDIDATE_STATUS, candidate_id: "cand_2" } }]) {
      fake.answer.status = () => Response.json(reply);
      const r = await fake.drive(["status", "--candidate", "cand_1"]);
      expect(r).toMatchObject({ rc: 1, stdout: "", slug: "socrates-bad-response" });
    }
    fake.answer.status = () => Response.json({ ...STATUS, candidate: CANDIDATE_STATUS });
    expect(await fake.drive(["status", "--candidate", "cand_1"])).toMatchObject({ rc: 0 });
  });

  // admits: a 404 reads as a generic bad response, or a 402 loses its subscribe link; observed at the slug and the fix line.
  it("names an unknown candidate, a route the server lacks, and an unentitled workspace", async () => {
    fake.answer.status = () => problem(404, "not_found", "No candidate of this org has that id");
    const unknown = await fake.drive(["status", "--candidate", "cand_9"]);
    expect(unknown).toMatchObject({ rc: 1, stdout: "", slug: "socrates-refused" });
    expect(unknown.stderr).toContain("fix: check the candidate id");
    fake.answer.status = () => Response.json({ error: "not found" }, { status: 404 });
    const missing = await fake.drive(["status"]);
    expect(missing).toMatchObject({ rc: 1, slug: "socrates-bad-response" });
    expect(missing.stderr).toContain("fix: this endpoint does not serve /v1/socrates/status");
    fake.answer.status = () => problem(402, "entitlement_lapsed", "not entitled to socrates", { _links: { subscribe: { href: "https://example.com/subscribe" } } });
    const lapsed = await fake.drive(["status"]);
    expect(lapsed).toMatchObject({ rc: 1, slug: "socrates-not-entitled" });
    expect(lapsed.stderr).toContain("fix: subscribe: https://example.com/subscribe\n");
  });

  // admits: a blank id, or one holding a secret, reaches the wire in the query; observed at the slug, with no request.
  it("sends nothing for a blank candidate id or one holding a secret", async () => {
    expect(await fake.drive(["status", "--candidate", " "])).toMatchObject({ rc: 1, slug: "socrates-flag-required" });
    const leak = await fake.drive(["status", "--candidate", GHP]);
    expect(leak).toMatchObject({ rc: 1, slug: "socrates-secret-detected" });
    expect(leak.stderr).not.toContain(GHP);
    expect(fake.calls).toEqual([]);
    expect(await fake.drive(["status"])).toMatchObject({ rc: 0 });
    expect(fake.calls).toHaveLength(1);
  });
});

describe("eris socrates policy", () => {
  const ORG_HASHED = policyResult(H1, ORG_POLICY);

  // admits: the verb prints without refreshing the cache, so the next stamp carries a stale hash; or prints something other than the served policy. Observed at the cache file and at stdout.
  it("fetches the policy, refreshes the cache and prints the hash, rubric, threshold and enabled gates", async () => {
    const r = await fake.drive(["policy"]);
    expect(r).toMatchObject({ rc: 0, stderr: "" });
    const gates = Object.keys(ORG_POLICY.gates).join(", ");
    expect(r.stdout).toBe(`org policy: ${H1.slice(0, 12)} (rubric@v3)\nthreshold: 5\nenabled gates: ${gates}\nrepo layer: none\n`);
    expect(requests()).toEqual(["GET /v1/socrates/policy"]);
    expect(JSON.parse(readFileSync(fake.cachePath(), "utf8"))).toMatchObject({ policy_hash: H1, rubric_version: "rubric@v3", policy: ORG_POLICY });
  });

  // admits: a gate the org turned off is listed as enabled; observed at stdout.
  it("lists only the gates that are on", async () => {
    fake.answer.policy = () => Response.json(policyResult(H1, { ...ORG_POLICY, gates: { ...ORG_POLICY.gates, end_condition: { enabled: false, weight: 0 } } }));
    const line = (await fake.drive(["policy"])).stdout.split("\n").find((l) => l.startsWith("enabled gates: "))!;
    expect(line).toContain("owning_layer");
    expect(line).not.toContain("end_condition");
  });

  // admits: a policy that moved on the server refreshes the cache silently, so a person cannot see that a stamp they built earlier is stale; observed at the changed line, which is absent when the hash did not move.
  it("shows the previous hash beside the new one when the refresh changed it", async () => {
    fake.writeCache(policyResult(H2, ORG_POLICY));
    const moved = await fake.drive(["policy"]);
    expect(moved.stdout).toContain(`org policy: ${H1.slice(0, 12)} (rubric@v3)\nchanged: ${H2.slice(0, 12)} -> ${H1.slice(0, 12)}\n`);
    expect(JSON.parse(readFileSync(fake.cachePath(), "utf8"))).toMatchObject({ policy_hash: H1 });
    const same = await fake.drive(["policy"]);
    expect(same).toMatchObject({ rc: 0 });
    expect(same.stdout).toContain(`org policy: ${H1.slice(0, 12)}`);
    expect(same.stdout).not.toContain("changed:");
  });

  // admits: the repo layer is dropped from the printout, or merged without the stricter-only check; observed at the effective threshold and the layer line, and at the slug for a looser layer.
  it("merges the repo layer and names its file", async () => {
    fake.erisYaml("service: x\nsocrates:\n  policy:\n    threshold: 9\n    gates:\n      end_condition:\n        enabled: true\n");
    const r = await fake.drive(["policy"]);
    expect(r).toMatchObject({ rc: 0, stderr: "" });
    expect(r.stdout).toContain("threshold: 9 (org 5)\n");
    expect(r.stdout).toContain(`repo layer: ${fake.cwd}/eris.yaml (threshold 9, gates end_condition)\n`);
    fake.erisYaml("socrates:\n  policy:\n    threshold: 4\n");
    expect(await fake.drive(["policy"])).toMatchObject({ rc: 1, stdout: "", slug: "socrates-repo-policy-looser" });
  });

  // admits: a rubric this build does not score is shown as the rubric's defaults, which is not what the server serves; observed at stdout.
  it("shows the served policy, and says the repo layer was not applied, for a rubric this build does not score", async () => {
    fake.answer.policy = () => Response.json(policyResult(H1, { ...ORG_POLICY, threshold: 7 }, "rubric@v99"));
    fake.erisYaml("socrates:\n  policy:\n    threshold: 9\n");
    const r = await fake.drive(["policy"]);
    expect(r.stdout).toContain("org policy: " + H1.slice(0, 12) + " (rubric@v99)\nthreshold: 7\n");
    expect(r.stdout).toContain(`repo layer: ${fake.cwd}/eris.yaml (not applied: rubric@v99 is not a rubric this build scores)\n`);
  });

  // admits: --cached reaches the network, or prints a policy the cache does not hold; observed at the requests (none) with no login at all, and at stdout.
  it("prints the cache under --cached without a request or a login", async () => {
    fake.writeCache(ORG_HASHED, 3 * 60 * 60 * 1000);
    const r = await fake.drive(["policy", "--cached"], { env: { HOME: fake.home } });
    expect(r).toMatchObject({ rc: 0, stderr: "" });
    expect(r.stdout).toContain(`org policy: ${H1.slice(0, 12)} (rubric@v3)\n`);
    expect(r.stdout).not.toContain("changed:");
    expect(fake.calls).toEqual([]);
  });

  // admits: --cached with nothing cached prints defaults or fetches; observed at the slug, with no request and nothing on stdout, for an absent and a corrupt cache.
  it("fails under --cached when no policy is cached", async () => {
    const absent = await fake.drive(["policy", "--cached"]);
    expect(absent).toMatchObject({ rc: 1, stdout: "", slug: "socrates-policy-not-cached" });
    expect(absent.stderr).toContain("fix: run 'eris socrates policy'");
    writeFileSync(fake.cachePath(), "{not json");
    expect(await fake.drive(["policy", "--cached"])).toMatchObject({ rc: 1, stdout: "", slug: "socrates-policy-not-cached" });
    expect(fake.calls).toEqual([]);
    expect(existsSync(fake.cachePath())).toBe(true);
    rmSync(fake.cachePath());
    expect(await fake.drive(["policy"])).toMatchObject({ rc: 0 });
    expect(await fake.drive(["policy", "--cached"])).toMatchObject({ rc: 0 });
  });

  // admits: the json form leaves out a layer or the change, so a script cannot tell which policy a stamp will carry; observed at stdout.
  it("prints the effective policy as one record under --output json", async () => {
    fake.writeCache(policyResult(H2, ORG_POLICY));
    fake.erisYaml("socrates:\n  policy:\n    threshold: 9\n");
    const r = await fake.drive(["policy"], { format: "json" });
    expect(r).toMatchObject({ rc: 0, stderr: "" });
    const record = JSON.parse(r.stdout);
    expect(record).toMatchObject({
      rubric_version: "rubric@v3",
      policy_hash: H1,
      cached: false,
      changed: { from: H2, to: H1 },
      org_policy: ORG_POLICY,
      policy: { threshold: 9 },
      repo_policy: { threshold: 9 },
      repo_policy_path: `${fake.cwd}/eris.yaml`,
      contract_version: "1.0.0",
    });
    const cached = JSON.parse((await fake.drive(["policy", "--cached"], { format: "json" })).stdout);
    expect(cached).toMatchObject({ policy_hash: H1, cached: true, repo_policy: { threshold: 9 } });
    expect(cached.changed).toBeUndefined();
  });

  // admits: the policy route's refusals print as a receipt, or a 402 loses its link; observed at the slug and the fix line.
  it("prints an endpoint refusal as a failure block", async () => {
    fake.answer.policy = () => problem(402, "entitlement_lapsed", "not entitled to socrates", { _links: { subscribe: { href: "https://example.com/subscribe" } } });
    const r = await fake.drive(["policy"]);
    expect(r).toMatchObject({ rc: 1, stdout: "", slug: "socrates-not-entitled" });
    expect(existsSync(fake.cachePath())).toBe(false);
  });
});

describe("eris socrates, the command list", () => {
  // admits: the group help or the unknown-verb fix omits the new verbs, so a person is never told they exist; observed at stdout and at the fix line.
  it("names status and policy in the help and in the unknown-verb fix", async () => {
    const help = await fake.drive([]);
    expect(help.stdout).toContain("  status    ");
    expect(help.stdout).toContain("  policy    ");
    const unknown = await fake.drive(["bogus"]);
    expect(unknown).toMatchObject({ rc: 1, slug: "socrates-unknown-verb" });
    expect(unknown.stderr).toContain("use: classify, consult, discover, evidence, policy, resolve, settings, status, submit");
  });
});
