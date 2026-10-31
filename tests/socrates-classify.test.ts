/**
 * `eris socrates classify`: local rubric scoring with typed HAL override links.
 *
 * Drives the group handler in-process. `fetch` is a stub that records every
 * call, so a test observes that classify never leaves the machine. The
 * endpoint url comes from ERIS_YAKS_URL so the link's href is fixed.
 */

import { describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { runSocrates } from "../plugins/socrates/submit";
import { CliExit } from "../src/cli/ts-verb";

const REPO = resolve(import.meta.dir, "..");
const ENDPOINT = "https://socrates.example";
const fetches: string[] = [];

const CANDIDATE = ["--title", "Errors use problem+json", "--statement", "Every 4xx/5xx is RFC 7807.", "--source", "https://example.com/pr/14"];

/** Every gate passes and the consequence scores at the threshold. */
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

async function drive(args: string[], opts: { format?: "text" | "json" } = {}) {
  let stdout = "";
  let stderr = "";
  const ctx = {
    erisDir: REPO,
    env: { HOME: join(REPO, ".scratch", "no-such-home"), ERIS_YAKS_URL: ENDPOINT },
    format: opts.format ?? "text",
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: (s: string) => ((stderr += s), true) },
  };
  const deps = {
    fetch: (async (input: string | URL | Request) => {
      fetches.push(String(input));
      throw new Error("classify must not call the network");
    }) as unknown as typeof fetch,
  };
  let rc: number;
  try {
    rc = await runSocrates(["classify", ...args], ctx, deps);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    rc = e.code;
  }
  const slug = stderr.split("\n").find((l) => l.startsWith("slug: "))?.slice("slug: ".length);
  return { rc, stdout, stderr, slug };
}

const json = async (args: string[]) => {
  const r = await drive(args, { format: "json" });
  expect({ rc: r.rc, stderr: r.stderr }).toEqual({ rc: 0, stderr: "" });
  return JSON.parse(r.stdout) as Record<string, unknown>;
};

describe("eris socrates classify", () => {
  it("scores the answers locally and prints the same verdict every time", async () => {
    /** When the verdict depends on anything but the answers and the statement, two agents classifying one candidate disagree. Observed at stdout, byte for byte, with no fetch made. */
    const first = await drive([...CANDIDATE, ...answers()], { format: "json" });
    const second = await drive([...CANDIDATE, ...answers()], { format: "json" });
    expect(first.rc).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(JSON.parse(first.stdout)).toEqual({
      verdict: "load-bearing",
      rubric_version: "rubric@v2",
      score: 3,
      threshold: 3,
      breakdown: { consequence: 3 },
      overrides: [],
      meta: { _links: {} },
    });
    expect((await drive([...CANDIDATE, ...answers()])).stdout).toBe("load-bearing: score 3 of 3 (rubric@v2)\n");
    expect(fetches).toEqual([]);
  });

  it("says which gate rejected the candidate and why, with a typed override link for that gate", async () => {
    /** When a rejection omits the gate, the reason or the link, the agent cannot tell what failed or how to override it. */
    const r = await json([...CANDIDATE, ...answers({ end_condition: "has-end-condition" })]);
    expect(r).toMatchObject({ verdict: "rejected", rubric_version: "rubric@v2", gate: "end_condition", answer: "has-end-condition" });
    expect(r.reason).toContain("end condition");
    expect(r.meta).toEqual({
      _links: { override: [{ href: `${ENDPOINT}/v1/socrates/classify`, method: "POST", gate: "end_condition", title: "eris socrates classify … --override end_condition=<one-line reason>" }] },
    });
    const text = await drive([...CANDIDATE, ...answers({ end_condition: "has-end-condition" })]);
    expect(text.stdout).toContain("rejected: end_condition (rubric@v2)\n");
    expect(text.stdout).toContain("--override end_condition=<one-line reason>");
  });

  it("names the wording feature when the statement fires a gate the answer passed", async () => {
    /** When a feature-fired rejection reads as the agent's answer, the agent changes a correct answer instead of the statement. */
    const r = await json(["--title", "t", "--statement", "We pin v2 for now.", "--source", "https://example.com/pr/14", ...answers()]);
    expect(r).toMatchObject({ verdict: "rejected", gate: "end_condition", answer: "none", feature: "end_condition_wording" });
    expect(r.reason).toContain("temporary, until, for now or right now");
  });

  it("bypasses only the gate an override names", async () => {
    /** When an override bypasses more than its gate, one reason waves a candidate past every check. */
    const two = answers({ end_condition: "has-end-condition", owning_layer: "owned-elsewhere" });
    const one = await json([...CANDIDATE, ...two, "--override", "end_condition=the end condition is the PRD's, not this decision's"]);
    expect(one).toMatchObject({ verdict: "rejected", gate: "owning_layer", overrides: [{ gate: "end_condition", reason: "the end condition is the PRD's, not this decision's" }] });
    expect((one.meta as { _links: { override: { gate: string }[] } })._links.override.map((l) => l.gate)).toEqual(["owning_layer"]);
    const both = await json([...CANDIDATE, ...two, "--override", "end_condition=a", "--override", "owning_layer=b"]);
    expect(both).toMatchObject({ verdict: "load-bearing", overrides: [{ gate: "end_condition", reason: "a" }, { gate: "owning_layer", reason: "b" }], meta: { _links: {} } });
  });

  it("refuses an override with no reason, a blank or multi-line one, or a gate it cannot bypass", async () => {
    /** When an override is accepted without a one-line reason, or on a gate that did not reject, the sub-issue's flag carries no why or a bypass nothing asked for. */
    const fired = answers({ end_condition: "has-end-condition" });
    for (const o of ["end_condition", "end_condition=", "end_condition=   ", "end_condition=line one\nline two", `end_condition=${"x".repeat(201)}`]) {
      expect({ o, ...(await drive([...CANDIDATE, ...fired, "--override", o])) }).toMatchObject({ o, rc: 1, stdout: "", slug: "socrates-override-invalid" });
    }
    expect(await drive([...CANDIDATE, ...fired, "--override", "no_such_gate=x"])).toMatchObject({ rc: 1, slug: "socrates-override-invalid" });
    expect(await drive([...CANDIDATE, ...answers({ practice: "how-people-work" }), "--override", "practice=x"])).toMatchObject({ rc: 1, slug: "socrates-override-invalid" });
    expect(await drive([...CANDIDATE, ...fired, "--override", "owning_layer=it does not fail"])).toMatchObject({ rc: 1, slug: "socrates-override-invalid" });
    expect(await drive([...CANDIDATE, ...fired, "--override", "end_condition=a", "--override", "end_condition=b"])).toMatchObject({ rc: 1, slug: "socrates-override-invalid" });
  });

  it("routes a practice and an inferred premise without offering an override", async () => {
    /** When a reroute offers an override, an agent forces a practice into review as a load-bearing decision. */
    expect(await json([...CANDIDATE, ...answers({ practice: "how-people-work" })])).toMatchObject({ verdict: "practice", gate: "practice", route: "practices-doc", meta: { _links: {} } });
    expect(await json([...CANDIDATE, ...answers({ premise_basis: "inferred" })])).toMatchObject({ verdict: "rerouted", gate: "premise_basis", route: "key-assumption", meta: { _links: {} } });
  });

  it("takes the same classify request as JSON", async () => {
    /** When --request and the flags score differently, an agent's verdict depends on which spelling it used. */
    const request = {
      candidate: { kind: "decision", title: "Errors use problem+json", statement: "Every 4xx/5xx is RFC 7807.", source: "https://example.com/pr/14" },
      answers: { ...PASSING, end_condition: "has-end-condition", owning_layer: "owned-elsewhere" },
      overrides: [{ gate: "end_condition", reason: "a" }],
    };
    const viaJson = await drive(["--request", JSON.stringify(request)], { format: "json" });
    const viaFlags = await drive([...CANDIDATE, ...answers(request.answers), "--override", "end_condition=a"], { format: "json" });
    expect(viaJson.rc).toBe(0);
    expect(viaJson.stdout).toBe(viaFlags.stdout);
    expect(await drive(["--request", JSON.stringify({ ...request, rubric_version: "rubric@v9" })])).toMatchObject({ rc: 1, slug: "socrates-candidate-invalid" });
    expect(await drive(["--request", "{not json"])).toMatchObject({ rc: 1, slug: "socrates-candidate-invalid" });
    expect(await drive(["--request", JSON.stringify(request), "--title", "t"])).toMatchObject({ rc: 1, slug: "socrates-flag-required" });
  });

  it("refuses missing, unknown or out-of-enum answers, naming each question's answers", async () => {
    /** When an incomplete answer set scores, a gate the agent skipped silently passes. */
    const missing = await drive([...CANDIDATE, "--answer", "end_condition=none"]);
    expect(missing).toMatchObject({ rc: 1, stdout: "", slug: "socrates-answers-invalid" });
    expect(missing.stderr).toContain("consequence");
    expect(missing.stderr).toContain("a-service-contract");
    expect(await drive([...CANDIDATE, ...answers({ consequence: "huge" })])).toMatchObject({ rc: 1, slug: "socrates-answers-invalid" });
    expect(await drive([...CANDIDATE, ...answers(), "--answer", "vibes=good"])).toMatchObject({ rc: 1, slug: "socrates-answers-invalid" });
    expect(await drive([...CANDIDATE, ...answers(), "--answer", "consequence=a-future-plan"])).toMatchObject({ rc: 1, slug: "socrates-answers-invalid" });
    expect(await drive([...CANDIDATE, ...answers(), "--answer", "consequence"])).toMatchObject({ rc: 1, slug: "socrates-answers-invalid" });
    expect(await drive(["--statement", "s", ...answers()])).toMatchObject({ rc: 1, slug: "socrates-flag-required" });
    expect(fetches).toEqual([]);
  });

  it("gives a prd or conflict candidate its kind as the verdict, never a rubric score", async () => {
    /** When a PRD is scored as a decision, the owning-layer gate rejects it (the PRD owns it) and the one entry a PRD should file as never is. */
    const prd = ["--kind", "prd", "--title", "PRD — Acme Billing", "--source", "https://docs.example.com/acme/document/billing", "--statement", "Decisions: `ACME-K1`–`ACME-K57`\nConfirmed by: dana"];
    expect(await json(prd)).toEqual({
      verdict: "prd",
      rubric_version: "rubric@v2",
      route: "review-issue",
      reason: "files as one review issue: PRD authored: PRD — Acme Billing",
      overrides: [],
      meta: { _links: {} },
    });
    const conflict = ["--kind", "conflict", "--title", "Two sources disagree", "--source", "https://example.com/pr/14", "--statement", "S.\n\nAuthoritative sites:\n- `ACME-K11` in [Doc](https://docs.example.com/a)\n- [Code](https://code.example.com/b)"];
    expect((await drive(conflict)).stdout).toBe("conflict: one review issue (rubric@v2) -> review-issue\n  why: files as one review issue: Two sources disagree\n");
    expect(await drive([...conflict.slice(0, -1), "S. with no sites"])).toMatchObject({ rc: 1, stdout: "", slug: "socrates-candidate-invalid" });
    expect(await drive([...prd, ...answers()])).toMatchObject({ rc: 1, slug: "socrates-answers-invalid" });
    expect(await drive([...prd, "--override", "end_condition=a"])).toMatchObject({ rc: 1, slug: "socrates-override-invalid" });
    expect(fetches).toEqual([]);
  });
});
