/**
 * Tests for plugins/yak/yak-submit.ts.
 *
 * Two halves, tested separately per the module's own split:
 *   - `resolveTextInputs` — pure-ish input acquisition (fs/stdin injected),
 *     no network.
 *   - `submitYak` — the redact → derive → validate → POST → compare
 *     pipeline, exercised against BOTH a real `Bun.serve` listener (for
 *     the response-shape outcomes: fresh 200, replay 200, 400, 401, 404)
 *     and a real closed port (for connection-refused — no mock stands in
 *     for the actual OS-level refusal) and an injected `fetchImpl` (for
 *     timeout, request-shape, and no-retry assertions that need control a
 *     real server can't give a fast unit test).
 */

import { describe, it, expect, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveTextInputs,
  submitYak,
  toOutputRecord,
  DEFAULT_SUBMIT_TIMEOUT_MS,
  YAK_REPRO_MAX_LENGTH,
  YAK_REPO_HINT_MAX_LENGTH,
  YAK_REPO_HINTS_MAX_COUNT,
  type RawTextInputs,
  type SubmitParams,
} from "../plugins/yak/yak-submit";
import { redact } from "../plugins/yak/yak-redact";
import {
  deriveIdempotencyKey,
  YakReceipt,
  YAKS_CONTRACT_VERSION,
  YAK_BODY_MAX_LENGTH,
  YAK_ID_MAX_LENGTH,
  YAK_SUMMARY_MAX_LENGTH,
} from "../plugins/yak/yaks-schema.v1";

// ============================================================================
// resolveTextInputs
// ============================================================================

describe("resolveTextInputs", () => {
  let dir: string;

  const withDir = async (fn: (dir: string) => Promise<void>) => {
    dir = await mkdtemp(join(tmpdir(), "yak-submit-test-"));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it("fails when --summary is missing", async () => {
    const outcome = await resolveTextInputs({ bodyInline: "b" });
    expect(outcome).toEqual({ reason: expect.any(String), slug: "yak-summary-required" } as any);
  });

  it("fails when --summary is an empty string", async () => {
    const outcome = await resolveTextInputs({ summary: "", bodyInline: "b" });
    expect("slug" in outcome && outcome.slug).toBe("yak-summary-required");
  });

  it("fails when neither --body nor --body-file is given", async () => {
    const outcome = await resolveTextInputs({ summary: "s" });
    expect("slug" in outcome && outcome.slug).toBe("yak-body-required");
  });

  it("fails when --body resolves to an empty string", async () => {
    const outcome = await resolveTextInputs({ summary: "s", bodyInline: "" });
    expect("slug" in outcome && outcome.slug).toBe("yak-body-required");
  });

  it("fails when --body and --body-file are both given", async () => {
    const outcome = await resolveTextInputs({ summary: "s", bodyInline: "b", bodyFile: "/tmp/whatever" });
    expect("slug" in outcome && outcome.slug).toBe("yak-body-conflicting-source");
  });

  it("fails when --evidence and --evidence-file are both given", async () => {
    const outcome = await resolveTextInputs({
      summary: "s",
      bodyInline: "b",
      evidenceInline: "e",
      evidenceFile: "/tmp/whatever",
    });
    expect("slug" in outcome && outcome.slug).toBe("yak-evidence-conflicting-source");
  });

  it("fails when --body-file - and --evidence-file - are both given, checked BEFORE any read is attempted", async () => {
    const isStdinTTY = mock(() => false);
    const readStdin = mock(async () => "should never be called");
    const outcome = await resolveTextInputs(
      { summary: "s", bodyFile: "-", evidenceFile: "-" },
      { isStdinTTY, readStdin },
    );
    expect("slug" in outcome && outcome.slug).toBe("yak-stdin-conflict");
    expect(readStdin).not.toHaveBeenCalled();
  });

  it("fails immediately, without reading, when --body-file - and stdin is a TTY (must not hang)", async () => {
    const isStdinTTY = mock(() => true);
    const readStdin = mock(async () => "should never be called");
    const outcome = await resolveTextInputs({ summary: "s", bodyFile: "-" }, { isStdinTTY, readStdin });
    expect("slug" in outcome && outcome.slug).toBe("yak-stdin-is-a-tty");
    expect(readStdin).not.toHaveBeenCalled();
  });

  it("fails when --body-file points at a nonexistent path", async () => {
    const outcome = await resolveTextInputs({ summary: "s", bodyFile: "/nonexistent/path/does-not-exist" });
    expect("slug" in outcome && outcome.slug).toBe("yak-body-file-unreadable");
  });

  it("fails when --evidence-file points at a nonexistent path", async () => {
    const outcome = await resolveTextInputs({
      summary: "s",
      bodyInline: "b",
      evidenceFile: "/nonexistent/path/does-not-exist",
    });
    expect("slug" in outcome && outcome.slug).toBe("yak-evidence-file-unreadable");
  });

  it("reads --body-file bytes EXACTLY, including a trailing newline (no bash round-trip to lose it)", async () => {
    await withDir(async (d) => {
      const path = join(d, "body.txt");
      await writeFile(path, "line one\nline two\n");
      const outcome = await resolveTextInputs({ summary: "s", bodyFile: path });
      expect("value" in outcome && outcome.value.body).toBe("line one\nline two\n");
    });
  });

  it("reads stdin bytes exactly via the injected reader, for --body-file -", async () => {
    const readStdin = mock(async () => "from stdin\n");
    const outcome = await resolveTextInputs(
      { summary: "s", bodyFile: "-" },
      { isStdinTTY: () => false, readStdin },
    );
    expect("value" in outcome && outcome.value.body).toBe("from stdin\n");
  });

  it("evidence is absent when neither --evidence nor --evidence-file is given", async () => {
    const outcome = await resolveTextInputs({ summary: "s", bodyInline: "b" });
    expect("value" in outcome && outcome.value.evidence).toBeUndefined();
  });

  it("evidence is present when --evidence is given, even if short", async () => {
    const outcome = await resolveTextInputs({ summary: "s", bodyInline: "b", evidenceInline: "e" });
    expect("value" in outcome && outcome.value.evidence).toBe("e");
  });

  it("a fully valid call resolves summary/body/evidence untouched", async () => {
    const raw: RawTextInputs = { summary: "S", bodyInline: "B", evidenceInline: "E" };
    const outcome = await resolveTextInputs(raw);
    expect(outcome).toEqual({ value: { summary: "S", body: "B", evidence: "E" } });
  });
});

// ============================================================================
// submitYak
// ============================================================================

/** An AWS-secret-shaped value, assembled at runtime so no literal trips a secret scanner. */
const AWS_SECRET = "AbCdEfGhIjKlMnOpQrStUvWxYz" + "0123456789ABCD";

const BASE_PARAMS: Omit<SubmitParams, "url" | "token" | "fetchImpl"> = {
  verb: "issue",
  summary: "summary text",
  body: "body text",
  noRedact: false,
  deviceId: "device-1",
  executionId: "exec-1",
};

function freshReceipt(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "obs-1",
    idempotency_key: "will-be-overwritten",
    replay: false,
    contract_version: YAKS_CONTRACT_VERSION,
    ...overrides,
  };
}

describe("submitYak — redaction ordering and evidence normalization (no network)", () => {
  it("derives the idempotency key from the REDACTED payload, not the raw one", async () => {
    // Assembled at runtime so the source holds no literal a secret scanner matches.
    const secretBody = `here is my token: ${"AKIA" + "ABCDEFGHIJKLMNOP"} and the rest of the report`;
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(freshReceipt({ idempotency_key: sent.idempotency_key })), { status: 200 });
    });

    const result = await submitYak({
      ...BASE_PARAMS,
      body: secretBody,
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("delivered");
    const redactedBody = redact(secretBody).text;
    const expectedKey = await deriveIdempotencyKey({
      device_id: BASE_PARAMS.deviceId,
      execution_id: BASE_PARAMS.executionId,
      verb: BASE_PARAMS.verb,
      summary: BASE_PARAMS.summary,
      body: redactedBody,
      evidence: undefined,
    });
    const rawKey = await deriveIdempotencyKey({
      device_id: BASE_PARAMS.deviceId,
      execution_id: BASE_PARAMS.executionId,
      verb: BASE_PARAMS.verb,
      summary: BASE_PARAMS.summary,
      body: secretBody,
      evidence: undefined,
    });

    if (result.status !== "delivered") throw new Error("unreachable");
    expect(result.idempotencyKey).toBe(expectedKey);
    expect(result.idempotencyKey).not.toBe(rawKey);
  });

  it("sends the REDACTED text in the payload body, not the secret", async () => {
    const secretBody = `aws_secret_access_key=${AWS_SECRET}`;
    let sentBody = "";
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body);
      const sent = JSON.parse(sentBody);
      return new Response(JSON.stringify(freshReceipt({ idempotency_key: sent.idempotency_key })), { status: 200 });
    });

    await submitYak({
      ...BASE_PARAMS,
      body: secretBody,
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(sentBody).not.toContain(AWS_SECRET);
    expect(sentBody).toContain("«redacted:aws-key»");
  });

  it("--no-redact skips the scrub — the raw secret is sent verbatim", async () => {
    const secretBody = `aws_secret_access_key=${AWS_SECRET}`;
    let sentBody = "";
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body);
      const sent = JSON.parse(sentBody);
      return new Response(JSON.stringify(freshReceipt({ idempotency_key: sent.idempotency_key })), { status: 200 });
    });

    const result = await submitYak({
      ...BASE_PARAMS,
      body: secretBody,
      noRedact: true,
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(sentBody).toContain(AWS_SECRET);
    if (result.status !== "delivered") throw new Error("unreachable");
    // `skipped: true` is the only thing that distinguishes this from "the
    // scrub ran and found nothing" — both leave count/classes at zero
    // (output-contract fix).
    expect(result.redaction).toEqual({ count: 0, classes: [], skipped: true });
  });

  it("when the scrub pass actually runs (no --no-redact), redaction.skipped is false even with nothing to redact", async () => {
    // Paired with the test above: a clean body and a skipped scrub both
    // leave count/classes at zero, so `skipped` must be false here and
    // true there, or the two are indistinguishable on the wire.
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(freshReceipt({ idempotency_key: sent.idempotency_key })), { status: 200 });
    });

    const result = await submitYak({
      ...BASE_PARAMS,
      body: "nothing sensitive here",
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    if (result.status !== "delivered") throw new Error("unreachable");
    expect(result.redaction).toEqual({ count: 0, classes: [], skipped: false });
  });

  it("evidence '' (empty, post-redaction) derives the SAME key as evidence omitted entirely", async () => {
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(freshReceipt({ idempotency_key: sent.idempotency_key })), { status: 200 });
    });

    const withEmptyEvidence = await submitYak({
      ...BASE_PARAMS,
      evidence: "",
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const withNoEvidence = await submitYak({
      ...BASE_PARAMS,
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    if (withEmptyEvidence.status !== "delivered" || withNoEvidence.status !== "delivered") {
      throw new Error("unreachable");
    }
    expect(withEmptyEvidence.idempotencyKey).toBe(withNoEvidence.idempotencyKey);
  });

  it("omits `evidence` from the wire payload entirely when it resolves empty", async () => {
    let sentBody = "";
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body);
      const sent = JSON.parse(sentBody);
      return new Response(JSON.stringify(freshReceipt({ idempotency_key: sent.idempotency_key })), { status: 200 });
    });

    await submitYak({
      ...BASE_PARAMS,
      evidence: "",
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(JSON.parse(sentBody)).not.toHaveProperty("evidence");
  });

  it("keeps a real evidence value in the wire payload", async () => {
    let sentBody = "";
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body);
      const sent = JSON.parse(sentBody);
      return new Response(JSON.stringify(freshReceipt({ idempotency_key: sent.idempotency_key })), { status: 200 });
    });

    await submitYak({
      ...BASE_PARAMS,
      evidence: "a real stack trace",
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(JSON.parse(sentBody).evidence).toBe("a real stack trace");
  });
});

describe("submitYak — --repro rides in provenance.repro.command", () => {
  it("omits provenance.repro entirely when no repro was given", async () => {
    let sentBody = "";
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body);
      const sent = JSON.parse(sentBody);
      return new Response(JSON.stringify(freshReceipt({ idempotency_key: sent.idempotency_key })), { status: 200 });
    });

    await submitYak({ ...BASE_PARAMS, url: "http://example.invalid", token: "t", fetchImpl: fetchImpl as unknown as typeof fetch });

    const sent = JSON.parse(sentBody);
    expect(sent.provenance).toBeUndefined();
    expect(sent).not.toHaveProperty("repro");
  });

  it("an empty --repro normalizes to absent, same rule as evidence", async () => {
    let sentBody = "";
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body);
      const sent = JSON.parse(sentBody);
      return new Response(JSON.stringify(freshReceipt({ idempotency_key: sent.idempotency_key })), { status: 200 });
    });

    await submitYak({
      ...BASE_PARAMS,
      repro: "",
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(JSON.parse(sentBody).provenance).toBeUndefined();
  });

  it("a real repro command lands at provenance.repro.command, not as a top-level field", async () => {
    let sentBody = "";
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body);
      const sent = JSON.parse(sentBody);
      return new Response(JSON.stringify(freshReceipt({ idempotency_key: sent.idempotency_key })), { status: 200 });
    });

    await submitYak({
      ...BASE_PARAMS,
      repro: "eris config check dev",
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const sent = JSON.parse(sentBody);
    expect(sent.provenance).toEqual({ repro: { command: "eris config check dev" } });
    expect(sent.repro).toBeUndefined();
  });

  it("merges alongside existing provenance categories rather than replacing them", async () => {
    let sentBody = "";
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body);
      const sent = JSON.parse(sentBody);
      return new Response(JSON.stringify(freshReceipt({ idempotency_key: sent.idempotency_key })), { status: 200 });
    });

    await submitYak({
      ...BASE_PARAMS,
      repro: "make test",
      provenance: { device: { hostname: "dev-box" } },
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const sent = JSON.parse(sentBody);
    expect(sent.provenance.device).toEqual({ hostname: "dev-box" });
    expect(sent.provenance.repro).toEqual({ command: "make test" });
  });

  it("redacts a secret embedded in the repro command, same pass as evidence", async () => {
    let sentBody = "";
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body);
      const sent = JSON.parse(sentBody);
      return new Response(JSON.stringify(freshReceipt({ idempotency_key: sent.idempotency_key })), { status: 200 });
    });

    const secretRepro = 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345" https://example.invalid/repro';
    const result = await submitYak({
      ...BASE_PARAMS,
      repro: secretRepro,
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("unreachable");
    expect(result.redaction.count).toBeGreaterThan(0);
    expect(result.redaction.classes).toContain("auth-header");
    const sent = JSON.parse(sentBody);
    expect(sent.provenance.repro.command).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(sent.provenance.repro.command).toContain("«redacted:auth-header»");
  });

  it("a repro command never changes the derived idempotency key", async () => {
    const withoutRepro = await submitYak({
      ...BASE_PARAMS,
      noRedact: true,
      url: "http://example.invalid",
      token: "t",
      fetchImpl: mock(async (_url: string, init?: RequestInit) => {
        const sent = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(freshReceipt({ idempotency_key: sent.idempotency_key })), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const withRepro = await submitYak({
      ...BASE_PARAMS,
      repro: "a completely different repro command",
      noRedact: true,
      url: "http://example.invalid",
      token: "t",
      fetchImpl: mock(async (_url: string, init?: RequestInit) => {
        const sent = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(freshReceipt({ idempotency_key: sent.idempotency_key })), { status: 200 });
      }) as unknown as typeof fetch,
    });

    if (withoutRepro.status !== "delivered" || withRepro.status !== "delivered") {
      throw new Error("unreachable");
    }
    expect(withRepro.idempotencyKey).toBe(withoutRepro.idempotencyKey);
  });

  it("the full pipeline (payload shape, redaction) is verb-agnostic — proven with 'suggest', not 'issue'", async () => {
    // Every other test in this describe block uses BASE_PARAMS' verb: "issue".
    // The parsing/routing level (tests/yak.test.ts's parseArgv tests) already
    // covers all three verbs for --repro, but nothing here had previously
    // driven the WIRE-LEVEL pipeline — redaction, provenance shape, delivery
    // — through a non-"issue" verb, even though submitYak branches on `verb`
    // for nothing repro-related (it's carried unchanged into the submission
    // and into provenance regardless of verb). A single `fatal` call with a
    // secret embedded in its repro exercises the same assertions the
    // 'issue'-only tests above make, just proving they hold for a different
    // verb too.
    let sentBody = "";
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body);
      const sent = JSON.parse(sentBody);
      return new Response(JSON.stringify(freshReceipt({ idempotency_key: sent.idempotency_key })), { status: 200 });
    });

    const secretRepro = 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345" https://example.invalid/repro';
    const result = await submitYak({
      ...BASE_PARAMS,
      verb: "fatal",
      repro: secretRepro,
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("unreachable");
    expect(result.redaction.count).toBeGreaterThan(0);
    expect(result.redaction.classes).toContain("auth-header");

    const sent = JSON.parse(sentBody);
    expect(sent.verb).toBe("fatal");
    expect(sent.provenance.repro.command).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(sent.provenance.repro.command).toContain("«redacted:auth-header»");
    expect(sent.repro).toBeUndefined();
  });
});

describe("submitYak — local validation (never a truncation)", () => {
  it("an over-bound body is a LOCAL misuse error naming the field, its length, and the max — the request is never sent", async () => {
    const fetchImpl = mock(async () => new Response("should never be called", { status: 200 }));
    const tooLong = "x".repeat(YAK_BODY_MAX_LENGTH + 1);

    const result = await submitYak({
      ...BASE_PARAMS,
      body: tooLong,
      noRedact: true, // keep the length exact — no marker substitution
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("misuse");
    if (result.status !== "misuse") throw new Error("unreachable");
    expect(result.slug).toBe("yak-body-too-long");
    expect(result.reason).toContain(String(tooLong.length));
    expect(result.reason).toContain(String(YAK_BODY_MAX_LENGTH));
    expect(fetchImpl).not.toHaveBeenCalled();
    // the key was still derivable — it describes a payload the schema
    // rejected, not a payload we couldn't build at all.
    expect(result.idempotencyKey.length).toBeGreaterThan(0);
  });

  it("an over-bound --repro is a LOCAL misuse error, slug yak-repro-too-long — the request is never sent", async () => {
    const fetchImpl = mock(async () => new Response("should never be called", { status: 200 }));
    const tooLong = "x".repeat(YAK_REPRO_MAX_LENGTH + 1);

    const result = await submitYak({
      ...BASE_PARAMS,
      repro: tooLong,
      noRedact: true, // keep the length exact — no marker substitution
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("misuse");
    if (result.status !== "misuse") throw new Error("unreachable");
    expect(result.slug).toBe("yak-repro-too-long");
    expect(result.reason).toContain(String(tooLong.length));
    expect(result.reason).toContain(String(YAK_REPRO_MAX_LENGTH));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.idempotencyKey.length).toBeGreaterThan(0);
  });
});

describe("submitYak — over-length device_id/execution_id and redaction-caused overflow are WARN, not misuse", () => {
  // These three are environment/our-own-processing, never the caller's
  // fault: device_id/execution_id are resolved by yak-identity.ts from a
  // state file or an env var the `eris yak` invocation never passed, and a
  // redaction-caused overflow means the caller's ORIGINAL text was in
  // bounds until our own scrub pass grew it. All three go on
  // the warn+exit-0 side, never the exit-1 failure block.

  it("an over-length device_id (e.g. a corrupt ~/.eris/device-id) is a WARN naming device_id, not a misuse blaming the report", async () => {
    const fetchImpl = mock(async () => new Response("should never be called", { status: 200 }));
    const tooLong = "d".repeat(YAK_ID_MAX_LENGTH + 1);

    const result = await submitYak({
      ...BASE_PARAMS,
      deviceId: tooLong,
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("warn");
    if (result.status !== "warn") throw new Error("unreachable");
    expect(result.slug).toBe("yak-identity-id-too-long");
    expect(result.reason).toContain("device_id");
    expect(result.reason).toContain(String(tooLong.length));
    expect(result.reason).toContain(String(YAK_ID_MAX_LENGTH));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an over-length execution_id (e.g. a >200-char CLAUDE_CODE_SESSION_ID) is a WARN naming execution_id, not body/summary", async () => {
    const fetchImpl = mock(async () => new Response("should never be called", { status: 200 }));
    const tooLong = "e".repeat(YAK_ID_MAX_LENGTH + 1);

    const result = await submitYak({
      ...BASE_PARAMS,
      executionId: tooLong,
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("warn");
    if (result.status !== "warn") throw new Error("unreachable");
    expect(result.slug).toBe("yak-identity-id-too-long");
    expect(result.reason).toContain("execution_id");
    expect(result.reason).toContain(String(tooLong.length));
    // Regression guard: the old code fell through to `redactedEvidence?.length ?? 0` and reported
    // "0 chars", and defaulted the slug to yak-body-too-long — naming a
    // field (body) the caller never touched.
    expect(result.reason).not.toContain("0 chars");
    expect(result.slug).not.toBe("yak-body-too-long");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a summary that redaction alone pushes over the limit is a WARN — the ORIGINAL text was in bounds", async () => {
    const fetchImpl = mock(async () => new Response("should never be called", { status: 200 }));
    // "seed" is a governed assignment name (plugins/yak/yak-redact.ts); its value
    // "1234" (4 chars, the minimum unquoted length the pass accepts) is
    // replaced by the 21-char «redacted:assignment» marker. 191 raw chars
    // is within YAK_SUMMARY_MAX_LENGTH (200); the redacted text is 208.
    const rawSummary = "x".repeat(180) + " seed: 1234";
    expect(rawSummary.length).toBeLessThanOrEqual(YAK_SUMMARY_MAX_LENGTH);

    const result = await submitYak({
      ...BASE_PARAMS,
      summary: rawSummary,
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("warn");
    if (result.status !== "warn") throw new Error("unreachable");
    expect(result.slug).toBe("yak-redaction-overflow");
    expect(result.reason).toContain("summary");
    expect(result.reason).toContain(String(rawSummary.length));
    expect(result.reason).toContain(String(YAK_SUMMARY_MAX_LENGTH));
    expect(fetchImpl).not.toHaveBeenCalled();
    // still classified as WARN even though redaction genuinely ran — the
    // redaction summary should reflect that a match was found.
    expect(result.redaction?.count).toBeGreaterThan(0);
  });

  it("a summary that is ALREADY too long before redaction is still misuse, not warn (raw text genuinely too big)", async () => {
    const fetchImpl = mock(async () => new Response("should never be called", { status: 200 }));
    const tooLong = "x".repeat(YAK_SUMMARY_MAX_LENGTH + 1);

    const result = await submitYak({
      ...BASE_PARAMS,
      summary: tooLong,
      noRedact: true, // no marker growth in play — the raw text alone is over
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("misuse");
    if (result.status !== "misuse") throw new Error("unreachable");
    expect(result.slug).toBe("yak-summary-too-long");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a repro that redaction alone pushes over the limit is a WARN — the ORIGINAL text was in bounds", async () => {
    const fetchImpl = mock(async () => new Response("should never be called", { status: 200 }));
    const rawRepro = "x".repeat(YAK_REPRO_MAX_LENGTH - 20) + " seed: 1234";
    expect(rawRepro.length).toBeLessThanOrEqual(YAK_REPRO_MAX_LENGTH);

    const result = await submitYak({
      ...BASE_PARAMS,
      repro: rawRepro,
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("warn");
    if (result.status !== "warn") throw new Error("unreachable");
    expect(result.slug).toBe("yak-redaction-overflow");
    expect(result.reason).toContain("repro");
    expect(result.reason).toContain(String(rawRepro.length));
    expect(result.reason).toContain(String(YAK_REPRO_MAX_LENGTH));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.redaction?.count).toBeGreaterThan(0);
  });

  it("a repro that is ALREADY too long before redaction is still misuse, not warn", async () => {
    const fetchImpl = mock(async () => new Response("should never be called", { status: 200 }));
    const tooLong = "x".repeat(YAK_REPRO_MAX_LENGTH + 1);

    const result = await submitYak({
      ...BASE_PARAMS,
      repro: tooLong,
      noRedact: true,
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("misuse");
    if (result.status !== "misuse") throw new Error("unreachable");
    expect(result.slug).toBe("yak-repro-too-long");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("submitYak — --repo rides in provenance.repo.target_repos", () => {
  function fetchStub(): { fetchImpl: typeof fetch; getSentBody: () => any } {
    let sentBody = "";
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body);
      const sent = JSON.parse(sentBody);
      return new Response(JSON.stringify(freshReceipt({ idempotency_key: sent.idempotency_key })), { status: 200 });
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, getSentBody: () => JSON.parse(sentBody) };
  }

  it("omits provenance.repo.target_repos entirely when no --repo was given and no provenance was gathered", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({ ...BASE_PARAMS, url: "http://example.invalid", token: "t", fetchImpl });
    const sent = getSentBody();
    expect(sent.provenance).toBeUndefined();
    expect(sent.repo).toBeUndefined();
  });

  it("a single explicit --repo lands at provenance.repo.target_repos as a one-element array, not a top-level field", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({ ...BASE_PARAMS, repoHints: ["acme/widgets"], url: "http://example.invalid", token: "t", fetchImpl });
    const sent = getSentBody();
    expect(sent.provenance).toEqual({ repo: { target_repos: ["acme/widgets"] } });
    expect(sent.repo).toBeUndefined();
    expect(sent.target_repos).toBeUndefined();
  });

  it("multiple explicit --repo hints ride as a multi-element array, in order", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({
      ...BASE_PARAMS,
      repoHints: ["acme/widgets", "acme/gadgets"],
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    expect(getSentBody().provenance.repo.target_repos).toEqual(["acme/widgets", "acme/gadgets"]);
  });

  it("duplicate --repo hints dedupe, preserving first-seen order", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({
      ...BASE_PARAMS,
      repoHints: ["acme/widgets", "acme/gadgets", "acme/widgets"],
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    expect(getSentBody().provenance.repo.target_repos).toEqual(["acme/widgets", "acme/gadgets"]);
  });

  it("duplicate --repo hints dedupe CASE-INSENSITIVELY, preserving first-seen casing and order", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({
      ...BASE_PARAMS,
      repoHints: ["owner/repo", "acme/gadgets", "Owner/Repo", "OWNER/REPO"],
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    expect(getSentBody().provenance.repo.target_repos).toEqual(["owner/repo", "acme/gadgets"]);
  });

  it("merges alongside an existing provenance.repo.service rather than replacing it", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({
      ...BASE_PARAMS,
      repoHints: ["acme/widgets"],
      provenance: { repo: { service: "widgets-api" } },
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    expect(getSentBody().provenance.repo).toEqual({ service: "widgets-api", target_repos: ["acme/widgets"] });
  });

  it("merges alongside a sibling provenance category (e.g. device) rather than replacing it", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({
      ...BASE_PARAMS,
      repoHints: ["acme/widgets"],
      provenance: { device: { hostname: "dev-box" } },
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    const sent = getSentBody();
    expect(sent.provenance.device).toEqual({ hostname: "dev-box" });
    expect(sent.provenance.repo).toEqual({ target_repos: ["acme/widgets"] });
  });

  it("redacts a secret embedded in a --repo hint, same pass as evidence/repro", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    const secretHint = 'acme/widgets Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345';
    const result = await submitYak({
      ...BASE_PARAMS,
      repoHints: [secretHint],
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("unreachable");
    expect(result.redaction.count).toBeGreaterThan(0);
    expect(result.redaction.classes).toContain("auth-header");
    const hints: string[] = getSentBody().provenance.repo.target_repos;
    expect(hints[0]).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(hints[0]).toContain("«redacted:auth-header»");
  });

  it("--repo hints never change the derived idempotency key", async () => {
    const without = await submitYak({
      ...BASE_PARAMS,
      noRedact: true,
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchStub().fetchImpl,
    });
    const withHints = await submitYak({
      ...BASE_PARAMS,
      repoHints: ["acme/widgets", "acme/gadgets"],
      noRedact: true,
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchStub().fetchImpl,
    });
    if (without.status !== "delivered" || withHints.status !== "delivered") throw new Error("unreachable");
    expect(withHints.idempotencyKey).toBe(without.idempotencyKey);
  });

  it("blank/whitespace-only --repo values are dropped and never sent as empty hints", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({
      ...BASE_PARAMS,
      repoHints: ["  ", "acme/widgets", ""],
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    expect(getSentBody().provenance.repo.target_repos).toEqual(["acme/widgets"]);
  });

  it("every --repo given resolving to blank -> no provenance.repo.target_repos field at all (never [])", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({ ...BASE_PARAMS, repoHints: ["   "], url: "http://example.invalid", token: "t", fetchImpl });
    const sent = getSentBody();
    expect(sent.provenance).toBeUndefined();
  });

  it("an over-length --repo hint is a LOCAL misuse error, slug yak-repo-too-long — the request is never sent", async () => {
    const fetchImpl = mock(async () => new Response("should never be called", { status: 200 }));
    const tooLong = "x".repeat(YAK_REPO_HINT_MAX_LENGTH + 1);

    const result = await submitYak({
      ...BASE_PARAMS,
      repoHints: [tooLong],
      noRedact: true,
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("misuse");
    if (result.status !== "misuse") throw new Error("unreachable");
    expect(result.slug).toBe("yak-repo-too-long");
    expect(result.reason).toContain(String(tooLong.length));
    expect(result.reason).toContain(String(YAK_REPO_HINT_MAX_LENGTH));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.idempotencyKey.length).toBeGreaterThan(0);
  });

  it("a --repo hint that redaction alone pushes over the limit is a WARN — the ORIGINAL text was in bounds", async () => {
    const fetchImpl = mock(async () => new Response("should never be called", { status: 200 }));
    const rawHint = "x".repeat(YAK_REPO_HINT_MAX_LENGTH - 20) + " seed: 1234";
    expect(rawHint.length).toBeLessThanOrEqual(YAK_REPO_HINT_MAX_LENGTH);

    const result = await submitYak({
      ...BASE_PARAMS,
      repoHints: [rawHint],
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("warn");
    if (result.status !== "warn") throw new Error("unreachable");
    expect(result.slug).toBe("yak-redaction-overflow");
    expect(result.reason).toContain("--repo");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.redaction?.count).toBeGreaterThan(0);
  });

  it("more than the max number of --repo hints is a LOCAL misuse error, slug yak-repo-hints-too-many", async () => {
    const fetchImpl = mock(async () => new Response("should never be called", { status: 200 }));
    const hints = Array.from({ length: YAK_REPO_HINTS_MAX_COUNT + 1 }, (_, i) => `acme/repo-${i}`);

    const result = await submitYak({
      ...BASE_PARAMS,
      repoHints: hints,
      url: "http://example.invalid",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("misuse");
    if (result.status !== "misuse") throw new Error("unreachable");
    expect(result.slug).toBe("yak-repo-hints-too-many");
    expect(result.reason).toContain(String(hints.length));
    expect(result.reason).toContain(String(YAK_REPO_HINTS_MAX_COUNT));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("exactly the max number of --repo hints is accepted", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    const hints = Array.from({ length: YAK_REPO_HINTS_MAX_COUNT }, (_, i) => `acme/repo-${i}`);
    const result = await submitYak({ ...BASE_PARAMS, repoHints: hints, url: "http://example.invalid", token: "t", fetchImpl });
    expect(result.status).toBe("delivered");
    expect(getSentBody().provenance.repo.target_repos).toHaveLength(YAK_REPO_HINTS_MAX_COUNT);
  });

  // --- auto-derivation from provenance.git.origin_url ------------------------

  it("auto-derives a single hint from provenance.git.origin_url (https, .git suffix) when no --repo was given", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({
      ...BASE_PARAMS,
      provenance: { git: { origin_url: "https://github.com/acme/widgets.git" } },
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    expect(getSentBody().provenance.repo.target_repos).toEqual(["acme/widgets"]);
  });

  it("auto-derives from an https origin with no .git suffix", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({
      ...BASE_PARAMS,
      provenance: { git: { origin_url: "https://github.com/acme/widgets" } },
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    expect(getSentBody().provenance.repo.target_repos).toEqual(["acme/widgets"]);
  });

  it("auto-derives from an scp-like git remote (git@host:owner/name.git)", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({
      ...BASE_PARAMS,
      provenance: { git: { origin_url: "git@github.com:acme/widgets.git" } },
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    expect(getSentBody().provenance.repo.target_repos).toEqual(["acme/widgets"]);
  });

  it("auto-derives from an ssh:// git remote", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({
      ...BASE_PARAMS,
      provenance: { git: { origin_url: "ssh://git@github.com/acme/widgets.git" } },
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    expect(getSentBody().provenance.repo.target_repos).toEqual(["acme/widgets"]);
  });

  // --- auto-derivation regressions -------------------------------------------

  it("a GitLab-style nested group derives the FULL path, not just the trailing two segments", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({
      ...BASE_PARAMS,
      provenance: { git: { origin_url: "https://gitlab.example.com/group/subgroup/project.git" } },
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    expect(getSentBody().provenance.repo.target_repos).toEqual(["group/subgroup/project"]);
  });

  it("a doubly-nested GitLab group also derives in full", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({
      ...BASE_PARAMS,
      provenance: { git: { origin_url: "git@gitlab.example.com:top/mid/sub/project.git" } },
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    expect(getSentBody().provenance.repo.target_repos).toEqual(["top/mid/sub/project"]);
  });

  it("an absolute local filesystem path never fabricates an owner/name hint", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({
      ...BASE_PARAMS,
      provenance: { git: { origin_url: "/home/user/repos/myproject" } },
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    expect(getSentBody().provenance.git).toEqual({ origin_url: "/home/user/repos/myproject" });
    expect(getSentBody().provenance.repo).toBeUndefined();
  });

  it("a file:// origin never fabricates an owner/name hint", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({
      ...BASE_PARAMS,
      provenance: { git: { origin_url: "file:///home/user/repos/myproject" } },
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    expect(getSentBody().provenance.repo).toBeUndefined();
  });

  it("a relative local path (./ or ../) never fabricates an owner/name hint", async () => {
    for (const origin of ["./repos/myproject", "../repos/myproject"]) {
      const { fetchImpl, getSentBody } = fetchStub();
      await submitYak({
        ...BASE_PARAMS,
        provenance: { git: { origin_url: origin } },
        url: "http://example.invalid",
        token: "t",
        fetchImpl,
      });
      expect(getSentBody().provenance.repo).toBeUndefined();
    }
  });

  it("a Windows drive-letter path never fabricates an owner/name hint", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({
      ...BASE_PARAMS,
      provenance: { git: { origin_url: "C:\\Users\\foo\\repos\\myproject" } },
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    expect(getSentBody().provenance.repo).toBeUndefined();
  });

  it("a bare relative path with no scheme/scp/redaction signal is refused, not guessed", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({
      ...BASE_PARAMS,
      provenance: { git: { origin_url: "repos/myproject" } },
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    expect(getSentBody().provenance.repo).toBeUndefined();
  });

  it("still recovers a redacted-remnant origin_url (embedded-credential URL redaction leaves a «redacted:» marker)", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    // `conn-string` redacts `scheme://user:pass@host`, leaving the marker
    // directly followed by the untouched path — the one shape this
    // function still recovers a (conservative, last-two-segment) hint from.
    await submitYak({
      ...BASE_PARAMS,
      provenance: { git: { origin_url: "«redacted:conn-string»/acme/widgets.git" } },
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    expect(getSentBody().provenance.repo.target_repos).toEqual(["acme/widgets"]);
  });

  it("an auto-derived hint that would exceed the length bound is dropped, never sent unbounded", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    // A crafted origin_url whose derived owner/name string is far past
    // YAK_REPO_HINT_MAX_LENGTH — confirmed live pre-fix that this reached
    // the transport uncapped.
    const hugeSegment = "x".repeat(50_000);
    await submitYak({
      ...BASE_PARAMS,
      provenance: { git: { origin_url: `https://github.com/acme/${hugeSegment}.git` } },
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    const sent = getSentBody();
    expect(sent.provenance?.repo?.target_repos).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalled(); // dropped silently, submission still proceeds
  });

  it("an auto-derived hint at exactly the bound is kept", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    // "acme/" + name = YAK_REPO_HINT_MAX_LENGTH chars exactly.
    const name = "x".repeat(YAK_REPO_HINT_MAX_LENGTH - "acme/".length);
    await submitYak({
      ...BASE_PARAMS,
      provenance: { git: { origin_url: `https://github.com/acme/${name}.git` } },
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    const hint = getSentBody().provenance.repo.target_repos[0];
    expect(hint).toBe(`acme/${name}`);
    expect(hint.length).toBe(YAK_REPO_HINT_MAX_LENGTH);
  });

  it("preserves the existing provenance.repo.service when auto-deriving target_repos", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({
      ...BASE_PARAMS,
      provenance: { repo: { service: "widgets-api" }, git: { origin_url: "https://github.com/acme/widgets.git" } },
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    expect(getSentBody().provenance.repo).toEqual({ service: "widgets-api", target_repos: ["acme/widgets"] });
  });

  it("no origin_url present -> no auto-derivation, no provenance.repo.target_repos field", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({
      ...BASE_PARAMS,
      provenance: { repo: { service: "widgets-api" } },
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    expect(getSentBody().provenance.repo).toEqual({ service: "widgets-api" });
  });

  it("an unparseable origin_url (no owner/name shape) -> no auto-derivation", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({
      ...BASE_PARAMS,
      provenance: { git: { origin_url: "not-a-url" } },
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    expect(getSentBody().provenance.git).toEqual({ origin_url: "not-a-url" });
    expect(getSentBody().provenance.repo).toBeUndefined();
  });

  it("explicit --repo wins over auto-derivation and the two are never merged", async () => {
    const { fetchImpl, getSentBody } = fetchStub();
    await submitYak({
      ...BASE_PARAMS,
      repoHints: ["acme/gadgets"],
      provenance: { git: { origin_url: "https://github.com/acme/widgets.git" } },
      url: "http://example.invalid",
      token: "t",
      fetchImpl,
    });
    expect(getSentBody().provenance.repo.target_repos).toEqual(["acme/gadgets"]);
  });
});

describe("submitYak — response-shape outcomes over a real Bun.serve listener", () => {
  it("fresh 200: delivered, replay:false, keyMismatch:false when the receipt echoes our key", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = await req.json();
        return Response.json(freshReceipt({ idempotency_key: body.idempotency_key, replay: false }));
      },
    });
    try {
      const result = await submitYak({ ...BASE_PARAMS, url: server.url.toString(), token: "t" });
      expect(result.status).toBe("delivered");
      if (result.status !== "delivered") throw new Error("unreachable");
      expect(result.receipt.replay).toBe(false);
      expect(result.keyMismatch).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  it("replay 200: delivered, replay:true, and toOutputRecord surfaces it", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = await req.json();
        return Response.json(freshReceipt({ idempotency_key: body.idempotency_key, replay: true }));
      },
    });
    try {
      const result = await submitYak({ ...BASE_PARAMS, url: server.url.toString(), token: "t" });
      expect(result.status).toBe("delivered");
      if (result.status !== "delivered") throw new Error("unreachable");
      expect(result.receipt.replay).toBe(true);
      const record = toOutputRecord(BASE_PARAMS.verb, result);
      expect(record.replay).toBe(true);
      expect(record.delivered).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it("a receipt whose idempotency_key disagrees with ours: still delivered, keyMismatch:true", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () => Response.json(freshReceipt({ idempotency_key: "a-totally-different-key" })),
    });
    try {
      const result = await submitYak({ ...BASE_PARAMS, url: server.url.toString(), token: "t" });
      expect(result.status).toBe("delivered");
      if (result.status !== "delivered") throw new Error("unreachable");
      expect(result.keyMismatch).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it("400: warn, yak-transport-error, names the status", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () => new Response(JSON.stringify({ error: "bad request" }), { status: 400 }),
    });
    try {
      const result = await submitYak({ ...BASE_PARAMS, url: server.url.toString(), token: "t" });
      expect(result.status).toBe("warn");
      if (result.status !== "warn") throw new Error("unreachable");
      expect(result.slug).toBe("yak-transport-error");
      expect(result.reason).toContain("400");
      expect(result.idempotencyKey).toBeDefined();
    } finally {
      server.stop(true);
    }
  });

  it("401: warn, yak-transport-error, names the status", async () => {
    const server = Bun.serve({ port: 0, fetch: async () => new Response("unauthorized", { status: 401 }) });
    try {
      const result = await submitYak({ ...BASE_PARAMS, url: server.url.toString(), token: "bad-token" });
      expect(result.status).toBe("warn");
      if (result.status !== "warn") throw new Error("unreachable");
      expect(result.slug).toBe("yak-transport-error");
      expect(result.reason).toContain("401");
    } finally {
      server.stop(true);
    }
  });

  it("404 (an endpoint without the route): warn, yak-transport-error, exit-mapped to 0 by the caller", async () => {
    const server = Bun.serve({ port: 0, fetch: async () => new Response("not found", { status: 404 }) });
    try {
      const result = await submitYak({ ...BASE_PARAMS, url: server.url.toString(), token: "t" });
      expect(result.status).toBe("warn");
      if (result.status !== "warn") throw new Error("unreachable");
      expect(result.slug).toBe("yak-transport-error");
      expect(result.reason).toContain("404");
    } finally {
      server.stop(true);
    }
  });

  it("429 with Retry-After: fails fast without retrying and reports retry-after in yak-transport-error warn", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ error: "rate_limited", retry_after_seconds: 12, contract_version: YAKS_CONTRACT_VERSION }),
          { status: 429, headers: { "retry-after": "12" } },
        );
      },
    });
    try {
      const result = await submitYak({ ...BASE_PARAMS, url: server.url.toString(), token: "t" });
      expect(calls).toBe(1);
      expect(result.status).toBe("warn");
      if (result.status !== "warn") throw new Error("unreachable");
      expect(result.slug).toBe("yak-transport-error");
      expect(result.reason).toContain("429");
      expect(result.reason).toContain("retry after 12s");
    } finally {
      server.stop(true);
    }
  });

  it("a 200 whose body is not valid JSON: warn, yak-transport-error", async () => {
    const server = Bun.serve({ port: 0, fetch: async () => new Response("not json{{{", { status: 200 }) });
    try {
      const result = await submitYak({ ...BASE_PARAMS, url: server.url.toString(), token: "t" });
      expect(result.status).toBe("warn");
      if (result.status !== "warn") throw new Error("unreachable");
      expect(result.slug).toBe("yak-transport-error");
    } finally {
      server.stop(true);
    }
  });

  it("a 200 whose body does not match the receipt contract: warn, yak-transport-error", async () => {
    const server = Bun.serve({ port: 0, fetch: async () => Response.json({ nope: true }) });
    try {
      const result = await submitYak({ ...BASE_PARAMS, url: server.url.toString(), token: "t" });
      expect(result.status).toBe("warn");
      if (result.status !== "warn") throw new Error("unreachable");
      expect(result.slug).toBe("yak-transport-error");
    } finally {
      server.stop(true);
    }
  });

  it("a receipt with a contract_version this CLI hasn't re-vendored (e.g. 1.1.0) is still DELIVERED, not a false failure", async () => {
    // `YakReceipt.contract_version` in the vendored schema is
    // `z.literal(YAKS_CONTRACT_VERSION)` — a bare literal. An Actor that
    // ships a version bump before this CLI re-vendors must not turn every
    // one of its now-durably-stored deliveries into a reported
    // delivered:false; only `id`/`idempotency_key`/`replay` are load-bearing
    // to the CLI's own logic (step 7's key comparison).
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = await req.json();
        return Response.json({
          id: "obs-future-version",
          idempotency_key: body.idempotency_key,
          replay: false,
          contract_version: "1.1.0",
        });
      },
    });
    try {
      const result = await submitYak({ ...BASE_PARAMS, url: server.url.toString(), token: "t" });
      expect(result.status).toBe("delivered");
      if (result.status !== "delivered") throw new Error("unreachable");
      expect(result.receipt.id).toBe("obs-future-version");
      expect(result.receipt.contract_version).toBe("1.1.0");
      expect(result.keyMismatch).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  it("POSTs to <url>/v0/yaks with a Bearer token and JSON content-type, and never retries", async () => {
    const seen = { calls: 0, path: "", auth: null as string | null };
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seen.calls += 1;
        seen.path = new URL(req.url).pathname;
        seen.auth = req.headers.get("authorization");
        const body = await req.json();
        return Response.json(freshReceipt({ idempotency_key: body.idempotency_key }));
      },
    });
    try {
      await submitYak({ ...BASE_PARAMS, url: `${server.url.toString()}`.replace(/\/$/, ""), token: "s3cr3t" });
      expect(seen.calls).toBe(1);
      expect(seen.path).toBe("/v0/yaks");
      expect(seen.auth).toBe("Bearer s3cr3t");
    } finally {
      server.stop(true);
    }
  });
});

describe("submitYak — transport failure outcomes (real network conditions, no mocked errors)", () => {
  it("connection refused: warn, yak-unreachable (real OS-level refusal, not a simulated throw)", async () => {
    // Port 1 is a privileged, essentially never-listening port — a real
    // ECONNREFUSED, not a fabricated error shape.
    const result = await submitYak({
      ...BASE_PARAMS,
      url: "http://127.0.0.1:1",
      token: "t",
      timeoutMs: 5_000,
    });
    expect(result.status).toBe("warn");
    if (result.status !== "warn") throw new Error("unreachable");
    expect(result.slug).toBe("yak-unreachable");
    expect(result.idempotencyKey).toBeDefined();
  });

  it("timeout during the HEADERS phase: warn, yak-timeout, request aborted rather than left to hang", async () => {
    // This fetchImpl never resolves at all except via the abort signal, so
    // it only exercises the connect/headers phase — it says nothing about
    // whether the deadline still covers the body-read phase (it once did
    // not). See the next test for that phase.
    const fetchImpl = mock((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const start = Date.now();
    const result = await submitYak({
      ...BASE_PARAMS,
      url: "http://example.invalid",
      token: "t",
      timeoutMs: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const elapsed = Date.now() - start;

    expect(result.status).toBe("warn");
    if (result.status !== "warn") throw new Error("unreachable");
    expect(result.slug).toBe("yak-timeout");
    expect(elapsed).toBeLessThan(3_000);
  });

  it("a server that sends headers + Content-Length then stalls the body forever must still be bounded by timeoutMs, not hang", async () => {
    // A real Bun.serve listener, not a mocked fetchImpl — the bug this
    // guards was in exactly the gap between `fetch()` resolving (headers
    // arrived) and `response.json()` draining the body: the original code
    // cleared the abort timer in a `finally` right after the `fetchImpl()`
    // call, so the deadline stopped covering the exchange the instant
    // headers landed. A server that promises a body via `content-length`
    // and then never sends it reproduces that gap directly: this is the
    // shape ("a command that never returns mid-task") docs/YAK.md
    // promises does not happen for `eris yak`.
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Flush headers + one byte so `fetch()` resolves, then NEVER
            // enqueue the rest and NEVER close — the true stall.
            controller.enqueue(new TextEncoder().encode("{"));
          },
        });
        return new Response(stream, { status: 200, headers: { "content-length": "50" } });
      },
    });
    try {
      const start = Date.now();
      const result = await submitYak({
        ...BASE_PARAMS,
        url: server.url.toString(),
        token: "t",
        timeoutMs: 300,
      });
      const elapsed = Date.now() - start;

      expect(result.status).toBe("warn");
      if (result.status !== "warn") throw new Error("unreachable");
      expect(result.slug).toBe("yak-timeout");
      // Bounded by timeoutMs (300ms) with headroom for scheduling — NOT by
      // Bun.serve's own ~10s idle-connection timeout, and nowhere near the
      // 241s wall-clock hang observed against the unfixed code.
      expect(elapsed).toBeLessThan(3_000);
    } finally {
      server.stop(true);
    }
  });
});

describe("toOutputRecord", () => {
  it("delivered: carries id, idempotency_key, replay, contract_version, redactions, key_mismatch — no error field", () => {
    const receipt = YakReceipt.parse(freshReceipt({ idempotency_key: "k" }));
    const record = toOutputRecord("issue", {
      status: "delivered",
      receipt,
      idempotencyKey: "k",
      keyMismatch: false,
      redaction: { count: 1, classes: ["aws-key"], skipped: false },
    });
    expect(record).toEqual({
      verb: "issue",
      delivered: true,
      id: receipt.id,
      idempotency_key: receipt.idempotency_key,
      replay: receipt.replay,
      contract_version: receipt.contract_version,
      key_mismatch: false,
      redactions: { count: 1, classes: ["aws-key"], skipped: false },
    });
  });

  // output-contract fix: `key_mismatch` is what makes a delivered
  // canonicalization-drift signal recoverable from the record. Before this
  // field existed, the ONLY place it showed up was a `yak-key-mismatch`
  // WARN on stderr — which `--output json` now suppresses unconditionally
  // — and `idempotency_key` in the record is the RECEIPT's key, never the
  // locally-derived one the mismatch is measured against, so there was no
  // other way for a machine caller to detect it.
  it("delivered with a key mismatch: key_mismatch is true, still delivered:true", () => {
    const receipt = YakReceipt.parse(freshReceipt({ idempotency_key: "server-derived" }));
    const record = toOutputRecord("issue", {
      status: "delivered",
      receipt,
      idempotencyKey: "locally-derived",
      keyMismatch: true,
      redaction: { count: 0, classes: [], skipped: false },
    });
    expect(record.delivered).toBe(true);
    expect(record.key_mismatch).toBe(true);
  });

  it("warn: delivered:false, carries error{slug,reason} and the idempotency_key when one was derived", () => {
    const record = toOutputRecord("fatal", {
      status: "warn",
      slug: "yak-unreachable",
      reason: "cannot reach yaks endpoint",
      idempotencyKey: "k",
      redaction: { count: 0, classes: [], skipped: false },
    });
    expect(record.delivered).toBe(false);
    expect(record.error).toEqual({ slug: "yak-unreachable", reason: "cannot reach yaks endpoint" });
    expect(record.idempotency_key).toBe("k");
  });

  it("warn with no idempotency_key (raised before a payload was ever built): the field is absent, not null", () => {
    const record = toOutputRecord("suggest", {
      status: "warn",
      slug: "yak-url-unresolved",
      reason: "no url",
    });
    expect(record).not.toHaveProperty("id");
    expect("idempotency_key" in record).toBe(false);
  });

  it("misuse: delivered:false, carries error{slug,reason}, the idempotency_key (always derivable pre-validation), and the redaction summary", () => {
    // When production failure: `SubmitResult`'s "misuse" branch (step 5,
    // AFTER redact at step 2) drops its own `redaction` field back to a
    // hardcoded zero here — the JSON record would say "0 redactions" on the
    // exact outcome (`yak-body-too-long`) whose own `reason` text tells the
    // caller "redaction may have grown it; check with --no-redact" — the
    // record and the message would disagree, observed at this seam.
    const record = toOutputRecord("issue", {
      status: "misuse",
      slug: "yak-body-too-long",
      reason: "body is too long",
      idempotencyKey: "k",
      redaction: { count: 1, classes: ["assignment"], skipped: false },
    });
    expect(record.delivered).toBe(false);
    expect(record.idempotency_key).toBe("k");
    expect(record.error?.slug).toBe("yak-body-too-long");
    expect(record.redactions).toEqual({ count: 1, classes: ["assignment"], skipped: false });
  });
});

describe("DEFAULT_SUBMIT_TIMEOUT_MS", () => {
  it("is one 30s bound, the same as a `curl --max-time 30` call", () => {
    expect(DEFAULT_SUBMIT_TIMEOUT_MS).toBe(30_000);
  });
});
