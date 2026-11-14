/**
 * `eris socrates submit --unfit`, and the stamp every decision or practice submit carries.
 *
 * Drives the group handler in-process with a temp HOME and a fake endpoint (tests/helpers/
 * socrates-fake.ts), so a test observes what left the machine and in what order. One run goes
 * through the eris entrypoint against a real loopback listener, for the stdin the in-process runs
 * replace.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { answers, CANDIDATE, fixOf, GHP, H1, H2, ORG_POLICY, PASSING, policyResult, socratesFake, type SocratesFake, TOKEN } from "./helpers/socrates-fake";
import { type Sandbox, sandbox } from "./helpers/blackbox";

const RECEIPT_UNFIT = { candidate_id: "cand_1", deduped: false, contract_version: "1.0.0", unfit: { state: "needs_input" } };
const HYPOTHESIS = "I think this is a retry-budget invariant the rubric has no question for.";
const UNFIT = ["--unfit", "--hypothesis", HYPOTHESIS];

const ev = (n: number, extra: Record<string, unknown> = {}) => ({ kind: "code", provenance: `https://github.com/example/repo/blob/0123456/src/retry.ts#L${n + 1}`, content: `retry loop ${n}`, ...extra });
const evidence = (count: number) => Array.from({ length: count }, (_, i) => ev(i));

let fake: SocratesFake;
beforeEach(() => {
  fake = socratesFake();
  fake.answer.submit = () => Response.json(RECEIPT_UNFIT);
});
afterEach(() => fake.cleanup());

const posts = () => fake.calls.filter((c) => c.method === "POST");
const sent = () => posts()[0]!.body as { schema_version: string; candidate: unknown; unfit?: unknown; classification?: unknown };

describe("eris socrates submit --unfit", () => {
  // admits: the unfit body carries the wrong stamp, drops a field or sends a classification beside it; the server then files the candidate unstamped or refuses the body. Observed at the requests in order and the exact body sent; no type sees the runtime hash.
  it("fetches the policy when none is cached, then sends the hypothesis under the rubric and policy hash, and prints the filing line", async () => {
    const r = await fake.drive(["submit", ...CANDIDATE, ...UNFIT]);
    expect(r).toMatchObject({ rc: 0, stderr: "", stdout: "submitted: cand_1\n  filed for an answer: needs-input\n" });
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/socrates/policy", "POST /v1/socrates/submit"]);
    expect(sent()).toEqual({
      schema_version: "1.0.0",
      candidate: { kind: "decision", title: "Errors use problem+json", statement: "Every 4xx/5xx is RFC 7807.", source: "https://example.com/pr/14" },
      unfit: { rubric_version: "rubric@v4", policy_hash: H1, hypothesis: HYPOTHESIS, evidence: [] },
    });
  });

  // admits: the --output json record loses the echo, so a script cannot tell a filed-for-an-answer candidate from a judged one; observed at stdout, byte for byte.
  it("prints the receipt's unfit echo in the json record", async () => {
    fake.writeCache(policyResult(H1, ORG_POLICY));
    const r = await fake.drive(["submit", ...CANDIDATE, ...UNFIT], { format: "json" });
    expect(r).toMatchObject({ rc: 0, stderr: "" });
    expect(r.stdout).toBe('{"candidate_id":"cand_1","deduped":false,"contract_version":"1.0.0","unfit":{"state":"needs_input"},"redactions":{"count":0,"classes":[]},"overrides":[]}\n');
    expect(fake.calls.map((c) => c.method)).toEqual(["POST"]);
  });

  // admits: a deduped unfit submit onto a candidate that is no longer waiting prints "filed for an answer: filed", which says the hypothesis was kept when the server kept nothing; observed at stdout for each receipt state, and at the json record, which stays the bare echo.
  it("says what the endpoint holds, and that nothing was kept, when an equal candidate is already held", async () => {
    const run = async (deduped: boolean, state: string, format: "text" | "json" = "text") => {
      fake.answer.submit = () => Response.json({ ...RECEIPT_UNFIT, deduped, unfit: { state } });
      return fake.drive(["submit", ...CANDIDATE, ...UNFIT], { format });
    };
    expect((await run(false, "needs_input")).stdout).toBe("submitted: cand_1\n  filed for an answer: needs-input\n");
    expect((await run(true, "needs_input")).stdout).toBe("already submitted: cand_1\n  filed for an answer: needs-input\n");
    expect((await run(true, "filed")).stdout).toBe("already submitted: cand_1\n  not stored: an equal candidate is already filed; the hypothesis and evidence were not kept\n");
    expect((await run(true, "resolved")).stdout).toBe("already submitted: cand_1\n  not stored: an equal candidate is already resolved; the hypothesis and evidence were not kept\n");
    expect((await run(false, "filed")).stdout).toBe("submitted: cand_1\n  state: filed\n");
    expect((await run(true, "filed", "json")).stdout).toBe('{"candidate_id":"cand_1","deduped":true,"contract_version":"1.0.0","unfit":{"state":"filed"},"redactions":{"count":0,"classes":[]},"overrides":[]}\n');
  });

  // admits: the unfit stamp reads the repo's eris.yaml like the answers stamp does, so a repo layer rides on a body the server does not score, or a looser layer blocks a submit that scores nothing; observed at the body, and at the answers form refusing under the same layer.
  it("does not read the repo's eris.yaml", async () => {
    fake.writeCache(policyResult(H1, ORG_POLICY));
    fake.erisYaml("socrates:\n  policy:\n    threshold: 4\n");
    expect(await fake.drive(["submit", ...CANDIDATE, ...answers()])).toMatchObject({ rc: 1, slug: "socrates-repo-policy-looser" });
    expect(fake.calls).toEqual([]);
    expect(await fake.drive(["submit", ...CANDIDATE, ...UNFIT])).toMatchObject({ rc: 0 });
    expect(Object.keys(sent().unfit as object).sort()).toEqual(["evidence", "hypothesis", "policy_hash", "rubric_version"]);
    expect(sent().classification).toBeUndefined();
  });

  // admits: the evidence file is dropped, reordered or rewritten on the way to the body; the server then stores fragments the caller did not send. Observed at the body.
  it("sends the evidence file's entries, in order", async () => {
    const file = fake.file("ev.json", JSON.stringify(evidence(2)));
    expect(await fake.drive(["submit", ...CANDIDATE, ...UNFIT, "--evidence-file", file])).toMatchObject({ rc: 0 });
    expect((sent().unfit as { evidence: unknown }).evidence).toEqual(evidence(2));
  });

  // admits: `--evidence-file -` reads nothing, or hangs on a terminal; observed at the body for a pipe and at the slug, with no request, for a terminal.
  it("reads the evidence from stdin for -, and refuses a terminal rather than waiting on it", async () => {
    expect(await fake.drive(["submit", ...CANDIDATE, ...UNFIT, "--evidence-file", "-"], { stdin: JSON.stringify(evidence(3)) })).toMatchObject({ rc: 0 });
    expect((sent().unfit as { evidence: unknown }).evidence).toEqual(evidence(3));
    fake.calls.length = 0;
    const tty = await fake.drive(["submit", ...CANDIDATE, ...UNFIT, "--evidence-file", "-"], { stdin: JSON.stringify(evidence(3)), stdinIsTty: true });
    expect(tty).toMatchObject({ rc: 1, stdout: "", slug: "socrates-evidence-file-invalid" });
    expect(fake.calls).toEqual([]);
  });

  // admits: a sixth entry reaches the wire (the server refuses the whole submit after the policy fetch) or five are refused; observed at the slug with no request for six, and at the body for five.
  it("refuses six evidence entries and sends five", async () => {
    expect(await fake.drive(["submit", ...CANDIDATE, ...UNFIT, "--evidence-file", fake.file("five.json", JSON.stringify(evidence(5)))])).toMatchObject({ rc: 0 });
    expect((sent().unfit as { evidence: unknown[] }).evidence).toHaveLength(5);
    fake.calls.length = 0;
    const six = await fake.drive(["submit", ...CANDIDATE, ...UNFIT, "--evidence-file", fake.file("six.json", JSON.stringify(evidence(6)))]);
    expect(six).toMatchObject({ rc: 1, stdout: "", slug: "socrates-evidence-file-invalid" });
    expect(six.stderr).toContain("at most 5");
    expect(fake.calls).toEqual([]);
  });

  // admits: a file that is not the contract's evidence array (not JSON, not an array, a kind or provenance the server refuses, a blank content, a missing file) is sent or read as empty; observed at the slug naming the entry, with no request.
  it("refuses an evidence file that is not an array of {kind, provenance, content}", async () => {
    const bad: [string, string | undefined, string][] = [
      ["not json", "{nope", "not JSON"],
      ["an object", JSON.stringify(ev(0)), "array"],
      ["a kind the contract lacks", JSON.stringify([ev(0), ev(1, { kind: "screenshot" })]), "evidence.1.kind"],
      ["a provenance that is no url or repo@sha:path#L", JSON.stringify([ev(0, { provenance: "src/retry.ts" })]), "evidence.0.provenance"],
      ["a blank content", JSON.stringify([ev(0, { content: "  " })]), "evidence.0.content"],
      ["a missing file", undefined, "cannot read"],
    ];
    for (const [name, text, mentions] of bad) {
      const path = text === undefined ? `${fake.cwd}/absent.json` : fake.file("bad.json", text);
      const r = await fake.drive(["submit", ...CANDIDATE, ...UNFIT, "--evidence-file", path]);
      expect({ name, rc: r.rc, slug: r.slug, stdout: r.stdout }).toEqual({ name, rc: 1, slug: "socrates-evidence-file-invalid", stdout: "" });
      expect({ name, mentioned: r.stderr.includes(mentions) }).toEqual({ name, mentioned: true });
    }
    expect(fake.calls).toEqual([]);
  });

  // admits: a decision or practice leaves unstamped (the server files it unjudged, with neither answers nor evidence); observed at the slug, with no request, for both kinds, and at the fix line, which advises a practice --answer only because only a decision can be unfit.
  it("refuses a decision or practice that carries neither --answer nor --unfit, advising a decision both ways and a practice --answer", async () => {
    for (const [kind, flags] of [["decision", []], ["practice", ["--kind", "practice"]]] as const) {
      const r = await fake.drive(["submit", ...CANDIDATE, ...flags]);
      expect({ kind, rc: r.rc, slug: r.slug, stdout: r.stdout }).toEqual({ kind, rc: 1, slug: "socrates-stamp-required", stdout: "" });
      const fix = fixOf(r.stderr);
      expect(fix).toContain("--answer <question>=<answer>...");
      expect({ kind, advisesUnfit: fix.includes("--unfit --hypothesis <text>") }).toEqual({ kind, advisesUnfit: kind === "decision" });
      if (kind === "practice") expect(fix).not.toContain("--unfit");
    }
    expect(fake.calls).toEqual([]);
  });

  // admits: the fix line of socrates-stamp-required advises a form the parser refuses, so the remedy loops; observed by taking each advised form from the printed fix line, for the kind it was printed for, and running it.
  it("accepts each form the stamp-required fix line advises", async () => {
    const advisedForms: [string, string[], RegExp[]][] = [
      ["decision", [], [/--answer <question>=<answer>\.\.\./, /--unfit --hypothesis <text>/]],
      ["practice", ["--kind", "practice"], [/--answer <question>=<answer>\.\.\./]],
    ];
    let ran = 0;
    for (const [kind, kindFlags, forms] of advisedForms) {
      const fix = fixOf((await fake.drive(["submit", ...CANDIDATE, ...kindFlags])).stderr);
      for (const re of forms) {
        const form = fix.match(re)?.[0];
        if (form === undefined) throw new Error(`the ${kind} fix line names no ${re}: ${fix}`);
        fake.calls.length = 0;
        const args: string[] = [];
        for (const word of form.split(" ")) {
          if (word === "<question>=<answer>...") {
            const pairs = Object.entries(PASSING).map(([q, a]) => `${q}=${a}`);
            args.push(pairs[0]!, ...pairs.slice(1).flatMap((pair) => ["--answer", pair]));
          } else {
            args.push(word === "<text>" ? "a hypothesis" : word);
          }
        }
        const r = await fake.drive(["submit", ...CANDIDATE, ...kindFlags, ...args]);
        expect({ kind, form, rc: r.rc, slug: r.slug }).toEqual({ kind, form, rc: 0, slug: undefined });
        expect(posts()).toHaveLength(1);
        ran += 1;
      }
    }
    expect(ran).toBe(3);
  });

  // admits: a practice sent as unfit reaches the server, which refuses it (a practice is written to the Practices doc and never becomes an item a person answers); or a decision is refused with --kind decision; observed at the slug and fix line with no request for a practice, and at the body for an explicit decision.
  it("refuses --unfit on anything but a decision, and says a practice takes --answer", async () => {
    const practice = await fake.drive(["submit", ...CANDIDATE, "--kind", "practice", ...UNFIT]);
    expect(practice).toMatchObject({ rc: 1, stdout: "", slug: "socrates-unfit-invalid" });
    expect(fixOf(practice.stderr)).toContain("must be a decision (a practice takes --answer");
    expect(fake.calls).toEqual([]);
    expect(await fake.drive(["submit", ...CANDIDATE, "--kind", "decision", ...UNFIT])).toMatchObject({ rc: 0 });
    expect((sent().unfit as { hypothesis: string }).hypothesis).toBe(HYPOTHESIS);
    fake.calls.length = 0;
    expect(await fake.drive(["submit", ...CANDIDATE, "--kind", "practice", ...answers()])).toMatchObject({ rc: 0 });
    expect(sent().classification).toBeDefined();
  });

  // admits: a prd or conflict picks up the stamp rule (and is refused for lacking one), or takes --unfit; observed at the body sent for a prd with neither flag, and at the slug, with no request, for --unfit.
  it("leaves a prd unchanged: it takes neither flag", async () => {
    const prd = ["--kind", "prd", "--title", "PRD — Acme Billing", "--source", "https://docs.example.com/acme/document/billing", "--statement", "Decisions: `ACME-K1`–`ACME-K57`\nConfirmed by: dana"];
    fake.answer.submit = () => Response.json({ candidate_id: "cand_1", deduped: false, contract_version: "1.0.0" });
    expect(await fake.drive(["submit", ...prd])).toMatchObject({ rc: 0, stdout: "submitted: cand_1\n" });
    expect(sent()).toEqual({ schema_version: "1.0.0", candidate: expect.objectContaining({ kind: "prd" }) });
    fake.calls.length = 0;
    expect(await fake.drive(["submit", ...prd, ...UNFIT])).toMatchObject({ rc: 1, slug: "socrates-unfit-invalid" });
    expect(fake.calls).toEqual([]);
  });

  // admits: the two stamps travel together (the server refuses the body) or a flag is silently ignored; observed at the slug, with no request, for each misuse.
  it("refuses --unfit with answers or overrides, and its flags without --unfit or without --hypothesis", async () => {
    const refused: [string[], string][] = [
      [[...UNFIT, ...answers()], "socrates-unfit-invalid"],
      [[...UNFIT, "--override", "end_condition=a"], "socrates-unfit-invalid"],
      [["--unfit"], "socrates-flag-required"],
      [["--hypothesis", HYPOTHESIS, ...answers()], "socrates-flag-required"],
      [["--evidence-file", fake.file("ev.json", "[]"), ...answers()], "socrates-flag-required"],
    ];
    for (const [flags, slug] of refused) {
      const r = await fake.drive(["submit", ...CANDIDATE, ...flags]);
      expect({ flags, rc: r.rc, slug: r.slug, stdout: r.stdout }).toEqual({ flags, rc: 1, slug, stdout: "" });
    }
    expect(fake.calls).toEqual([]);
  });

  // admits: a blank hypothesis, or one over the contract's 1000, is sent (the server refuses the whole submit); a 1000-character one is refused; observed at the slug with no request, and at the body for 1000.
  it("bounds the hypothesis at 1000 characters and refuses a blank one", async () => {
    expect(await fake.drive(["submit", ...CANDIDATE, "--unfit", "--hypothesis", "h".repeat(1000)])).toMatchObject({ rc: 0 });
    expect((sent().unfit as { hypothesis: string }).hypothesis).toHaveLength(1000);
    fake.calls.length = 0;
    for (const hypothesis of ["h".repeat(1001), "   "]) {
      const r = await fake.drive(["submit", ...CANDIDATE, "--unfit", "--hypothesis", hypothesis]);
      expect({ length: hypothesis.length, rc: r.rc, slug: r.slug, stdout: r.stdout }).toEqual({ length: hypothesis.length, rc: 1, slug: "socrates-unfit-invalid", stdout: "" });
    }
    expect(fake.calls).toEqual([]);
  });

  // admits: the hypothesis or an evidence entry skips the secret scan the other fields get, so a live credential leaves the machine in a field the stamp added; observed at the requests (none) and at the block, which names the field and never prints the secret.
  it("never sends a secret in the hypothesis or in an evidence entry", async () => {
    const clean = fake.file("clean.json", JSON.stringify(evidence(2)));
    expect(await fake.drive(["submit", ...CANDIDATE, ...UNFIT, "--evidence-file", clean])).toMatchObject({ rc: 0 });
    expect(posts()).toHaveLength(1);
    fake.calls.length = 0;
    const shapes: [string, string[], string][] = [
      ["hypothesis", ["--unfit", "--hypothesis", `it is ${GHP}`, "--evidence-file", clean], "hypothesis"],
      ["content", [...UNFIT, "--evidence-file", fake.file("c.json", JSON.stringify([ev(0), ev(1, { content: `token ${GHP}` })]))], "evidence.1"],
      ["provenance", [...UNFIT, "--evidence-file", fake.file("p.json", JSON.stringify([ev(0, { provenance: `https://example.com/blob?t=${GHP}` })]))], "evidence.0"],
    ];
    for (const [name, flags, field] of shapes) {
      const r = await fake.drive(["submit", ...CANDIDATE, ...flags]);
      expect({ name, rc: r.rc, slug: r.slug, stdout: r.stdout }).toEqual({ name, rc: 1, slug: "socrates-secret-detected", stdout: "" });
      expect(r.stderr).toContain(field);
      expect(r.stderr).not.toContain(GHP);
    }
    expect(fake.calls).toEqual([]);
  });

  // admits: our redaction classes skip the hypothesis and evidence, so a token the other fields would have scrubbed reaches the endpoint; observed at the body the endpoint received and the WARN.
  it("redacts the hypothesis and evidence the way it redacts the other fields", async () => {
    const sib = ["sib", "01HZX3K5Q8W2N4R6T8V0Y2B4D6", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
    const file = fake.file("sib.json", JSON.stringify([ev(0, { content: `ERIS_TOKEN=${sib}` })]));
    const r = await fake.drive(["submit", ...CANDIDATE, "--unfit", "--hypothesis", `ERIS_TOKEN=${sib}`, "--evidence-file", file]);
    expect(r.rc).toBe(0);
    expect(r.stderr).toContain("socrates-redacted");
    expect(r.stderr).toContain("2 redacted before sending");
    const unfit = sent().unfit as { hypothesis: string; evidence: { content: string }[] };
    expect(unfit.hypothesis).toBe("ERIS_TOKEN=«redacted:sib-token»");
    expect(unfit.evidence[0]!.content).toBe("ERIS_TOKEN=«redacted:sib-token»");
  });

  // admits: a server that does not know `unfit` strips it, answers a plain receipt and eris prints success for a candidate filed without its hypothesis; observed at the slug and exit code, with nothing on stdout, after the one POST.
  it("fails when the receipt does not echo unfit", async () => {
    fake.answer.submit = () => Response.json({ candidate_id: "cand_1", deduped: false, contract_version: "1.0.0" });
    const r = await fake.drive(["submit", ...CANDIDATE, ...UNFIT], { format: "json" });
    expect(r).toMatchObject({ rc: 1, stdout: "", slug: "socrates-unfit-unsupported" });
    expect(r.stderr).toContain("cand_1");
    expect(posts()).toHaveLength(1);
    fake.answer.submit = () => Response.json(RECEIPT_UNFIT);
    expect(await fake.drive(["submit", ...CANDIDATE, ...UNFIT])).toMatchObject({ rc: 0, slug: undefined });
  });
});

describe("the policy a stamp carries is at most an hour old", () => {
  const HOUR = 60 * 60 * 1000;
  const stamps: [string, string[], (body: ReturnType<typeof sent>) => string][] = [
    ["--unfit", UNFIT, (b) => (b.unfit as { policy_hash: string }).policy_hash],
    ["--answer", answers(), (b) => (b.classification as { policy_hash: string }).policy_hash],
  ];

  for (const [name, flags, hashOf] of stamps) {
    for (const [when, ageMs] of [["fetched two hours ago", 2 * HOUR], ["dated an hour ahead of the clock", -HOUR]] as const) {
      // admits: a cache older than an hour (or dated in the future, by a clock set back) is stamped as it stands, so the server reclassifies a stamp that was one GET from current; observed at the requests (a GET before the POST) and the hash in the body.
      it(`${name}: refetches a cache ${when} before stamping`, async () => {
        fake.writeCache(policyResult(H1, ORG_POLICY), ageMs);
        fake.answer.policy = () => Response.json(policyResult(H2, ORG_POLICY));
        expect(await fake.drive(["submit", ...CANDIDATE, ...flags])).toMatchObject({ rc: 0 });
        expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/socrates/policy", "POST /v1/socrates/submit"]);
        expect(hashOf(sent())).toBe(H2);
        expect(JSON.parse(readFileSync(fake.cachePath(), "utf8"))).toMatchObject({ policy_hash: H2 });
      });
    }

    // admits: every stamp refetches the policy, one extra GET per submit; observed at the requests (only the POST) and the cached hash in the body, though the server's policy has moved.
    it(`${name}: stamps a cache fetched five minutes ago as it stands`, async () => {
      fake.writeCache(policyResult(H1, ORG_POLICY), 5 * 60 * 1000);
      fake.answer.policy = () => Response.json(policyResult(H2, ORG_POLICY));
      expect(await fake.drive(["submit", ...CANDIDATE, ...flags])).toMatchObject({ rc: 0 });
      expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/socrates/submit"]);
      expect(hashOf(sent())).toBe(H1);
    });
  }
});

describe("eris socrates submit --unfit, through the eris entrypoint", () => {
  let sb: Sandbox;
  let server: ReturnType<typeof Bun.serve>;
  const seen: { method: string; path: string; body: unknown }[] = [];

  beforeAll(() => {
    sb = sandbox("eris-socrates-unfit-");
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const path = new URL(req.url).pathname;
        seen.push({ method: req.method, path, body: req.method === "GET" ? undefined : await req.json() });
        return path === "/v1/socrates/policy" ? Response.json(policyResult(H1, ORG_POLICY)) : Response.json(RECEIPT_UNFIT);
      },
    });
  });
  afterAll(() => {
    server.stop(true);
    sb.cleanup();
  });

  // admits: the compiled and checkout entrypoints read a different stdin than the in-process seam, so `--evidence-file -` hangs or reads nothing for a user; observed at the body a real listener received from the child process.
  it("reads the evidence from a piped stdin and files the candidate for an answer", async () => {
    const env = { ERIS_YAKS_URL: `http://127.0.0.1:${server.port}`, ERIS_YAKS_TOKEN: TOKEN };
    const r = await sb.run(["socrates", "submit", ...CANDIDATE, ...UNFIT, "--evidence-file", "-"], { env, stdin: JSON.stringify(evidence(2)) });
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ status: 0, stdout: "submitted: cand_1\n  filed for an answer: needs-input\n", stderr: "" });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /v1/socrates/policy", "POST /v1/socrates/submit"]);
    expect((seen[1]!.body as { unfit: unknown }).unfit).toEqual({ rubric_version: "rubric@v4", policy_hash: H1, hypothesis: HYPOTHESIS, evidence: evidence(2) });
  });
});
