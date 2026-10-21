/**
 * Tests for yak.ts — `parseArgv` and the full `runYak`
 * orchestration.
 *
 * `runYak` never touches a real stream or calls `process.exit` (see its own
 * header) — every case here asserts directly on the returned
 * `{stdout, stderr, exitCode}` strings, which is what makes "stdout carries
 * only the payload" (docs/OUTPUT-CONTRACT.md §1) a real, checkable claim
 * rather than something proven by eyeballing a captured terminal.
 *
 * Network-touching cases use a real `Bun.serve` listener with `home`
 * pointed at a fresh `mkdtemp` directory — nothing here ever reads or
 * writes this machine's real `~/.eris`.
 */

import { describe, it, expect } from "bun:test";
import { mkdtemp, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YakSubmission, YAKS_CONTRACT_VERSION } from "@sibylline-labs/yak-contract";
import { parseArgv, runYak, type RunYakOptions } from "../plugins/yak/yak";

// ============================================================================
// parseArgv
// ============================================================================

describe("parseArgv", () => {
  it("no args -> help", () => {
    expect(parseArgv([])).toEqual({ kind: "help" });
  });

  it("--help / -h as the first arg -> help", () => {
    expect(parseArgv(["--help"])).toEqual({ kind: "help" });
    expect(parseArgv(["-h"])).toEqual({ kind: "help" });
  });

  it("--help anywhere after a valid verb -> help, not ok", () => {
    expect(parseArgv(["issue", "--summary", "s", "--help"])).toEqual({ kind: "help" });
  });

  it("an unknown verb is a misuse with slug yak-unknown-verb", () => {
    const outcome = parseArgv(["frobnicate"]);
    expect(outcome.kind).toBe("misuse");
    if (outcome.kind !== "misuse") throw new Error("unreachable");
    expect(outcome.slug).toBe("yak-unknown-verb");
    expect(outcome.reason).toContain("frobnicate");
  });

  it("an unknown flag is a misuse with slug yak-unknown-flag", () => {
    const outcome = parseArgv(["issue", "--bogus"]);
    expect(outcome.kind).toBe("misuse");
    if (outcome.kind !== "misuse") throw new Error("unreachable");
    expect(outcome.slug).toBe("yak-unknown-flag");
  });

  it("a flag with no following value is a misuse with slug yak-flag-missing-value", () => {
    const outcome = parseArgv(["issue", "--summary"]);
    expect(outcome.kind).toBe("misuse");
    if (outcome.kind !== "misuse") throw new Error("unreachable");
    expect(outcome.slug).toBe("yak-flag-missing-value");
  });

  it("parses every flag, including --no-redact and --repro, for a full call", () => {
    const outcome = parseArgv([
      "fatal",
      "--summary",
      "S",
      "--body-file",
      "-",
      "--evidence",
      "E",
      "--repro",
      "npm test -- --grep foo",
      "--no-redact",
    ]);
    expect(outcome).toEqual({
      kind: "ok",
      verb: "fatal",
      flags: {
        summary: "S",
        bodyFile: "-",
        evidenceInline: "E",
        repro: "npm test -- --grep foo",
        noRedact: true,
      },
    });
  });

  it("parses --repro on its own, for every verb", () => {
    for (const verb of ["issue", "suggest", "fatal"] as const) {
      const outcome = parseArgv([verb, "--summary", "s", "--body", "b", "--repro", "eris config check dev"]);
      expect(outcome.kind).toBe("ok");
      if (outcome.kind !== "ok") throw new Error("unreachable");
      expect(outcome.flags.repro).toBe("eris config check dev");
    }
  });

  it("--repro with no following value is a misuse with slug yak-flag-missing-value", () => {
    const outcome = parseArgv(["issue", "--summary", "s", "--body", "b", "--repro"]);
    expect(outcome.kind).toBe("misuse");
    if (outcome.kind !== "misuse") throw new Error("unreachable");
    expect(outcome.slug).toBe("yak-flag-missing-value");
  });

  it("a single --repo is parsed as a one-element array", () => {
    const outcome = parseArgv(["issue", "--summary", "s", "--body", "b", "--repo", "acme/widgets"]);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.flags.repoHints).toEqual(["acme/widgets"]);
  });

  it("--repo is repeatable — every occurrence accumulates, in order", () => {
    const outcome = parseArgv([
      "issue",
      "--summary",
      "s",
      "--body",
      "b",
      "--repo",
      "acme/widgets",
      "--repo",
      "acme/gadgets",
    ]);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.flags.repoHints).toEqual(["acme/widgets", "acme/gadgets"]);
  });

  it("no --repo given -> flags.repoHints is undefined, not an empty array", () => {
    const outcome = parseArgv(["issue", "--summary", "s", "--body", "b"]);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.flags.repoHints).toBeUndefined();
  });

  it("--repo with no following value is a misuse with slug yak-flag-missing-value", () => {
    const outcome = parseArgv(["issue", "--summary", "s", "--body", "b", "--repo"]);
    expect(outcome.kind).toBe("misuse");
    if (outcome.kind !== "misuse") throw new Error("unreachable");
    expect(outcome.slug).toBe("yak-flag-missing-value");
  });

  it("accepts each of the three verbs", () => {
    for (const verb of ["issue", "suggest", "fatal"] as const) {
      const outcome = parseArgv([verb, "--summary", "s", "--body", "b"]);
      expect(outcome.kind).toBe("ok");
      if (outcome.kind !== "ok") throw new Error("unreachable");
      expect(outcome.verb).toBe(verb);
    }
  });
});

// ============================================================================
// runYak
// ============================================================================

async function freshHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "yak-cli-test-"));
}

function baseOpts(overrides: Partial<RunYakOptions>): RunYakOptions {
  return {
    argv: [],
    env: {},
    ...overrides,
  };
}

describe("runYak — help", () => {
  it("no args: usage on stdout, nothing on stderr, exit 0", async () => {
    const result = await runYak(baseOpts({ argv: [] }));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("usage: eris yak");
  });
});

describe("runYak — agent misuse (exit 1, the four-line failure block, stdout empty in TEXT mode)", () => {
  it("unknown verb: text mode stdout empty, and STILL empty under --output json (no verb is known — see the bare-record describe block below)", async () => {
    const home = await freshHome();
    try {
      const result = await runYak(baseOpts({ argv: ["nope"], home }));
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("ERROR ");
      expect(result.stderr).toContain("slug: yak-unknown-verb");
      expect(result.stderr).toContain("docs: ");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("missing --summary", async () => {
    const home = await freshHome();
    try {
      const result = await runYak(baseOpts({ argv: ["issue", "--body", "b"], home }));
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("slug: yak-summary-required");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("--body-file - with stdin a TTY does not hang and fails immediately", async () => {
    const home = await freshHome();
    try {
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body-file", "-"],
          home,
          isStdinTTY: () => true,
          readStdin: async () => {
            throw new Error("must never be called");
          },
        }),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("slug: yak-stdin-is-a-tty");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("an over-bound field surfaces as the SAME exit-1 failure block, stdout empty in TEXT mode", async () => {
    const home = await freshHome();
    try {
      const tooLong = "x".repeat(5_000);
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", tooLong],
          env: { ERIS_YAKS_URL: "http://example.invalid", ERIS_YAKS_TOKEN: "t" },
          home,
        }),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("slug: yak-body-too-long");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

// docs/YAK.md and docs/OUTPUT-CONTRACT.md both
// promise "one bare record on stdout regardless of outcome" for `--output
// json`, and tell a consumer to branch on `delivered`, never `id == null`.
// Pre-fix, EVERY misuse outcome left stdout empty under `--output json` —
// the exact outcome class a machine caller most needs to detect
// programmatically got nothing to parse. `exitCode` stays `1` throughout:
// the exit code still carries the misuse signal; the record carries the
// detail, same split `--output json` already uses on the warn/delivered
// paths.
describe("runYak — --output json emits a bare record on misuse too (exit 1 unchanged)", () => {
  it("unknown verb: BOTH streams stay empty under --output json — no verb is known at this point, and the real dispatcher (plugins/yak/handlers.ts) never forwards an unrecognised verb to this file at all", async () => {
    // output-contract fix: stderr is now unconditionally suppressed
    // under `--output json`, on every path this file produces — including
    // this one, where no verb is known and so no record can be built
    // either. The real CLI never reaches this branch: the dispatcher
    // (`plugins/yak/handlers.ts`) forwards only issue|suggest|fatal to the
    // core and answers an unrecognised verb itself (tests/yak-verb.test.ts),
    // so this remains a documented, accepted gap for a path `eris` cannot take.
    const result = await runYak(baseOpts({ argv: ["nope"], env: { ERIS_OUTPUT: "json" } }));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("an unknown flag (argv-level misuse, verb already known): a bare JSON record on stdout, delivered:false, exit 1 unchanged, and NOTHING on stderr (output-contract fix)", async () => {
    const home = await freshHome();
    try {
      const result = await runYak(baseOpts({ argv: ["issue", "--bogus"], home, env: { ERIS_OUTPUT: "json" } }));
      expect(result.exitCode).toBe(1);
      // positive: the failure landed, on stdout, as the documented record
      const record = JSON.parse(result.stdout);
      expect(record).toEqual({
        verb: "issue",
        delivered: false,
        redactions: { count: 0, classes: [], skipped: false },
        error: { slug: "yak-unknown-flag", reason: expect.stringContaining("--bogus") },
      });
      // paired absence: the four-line failure block that used to reach
      // stderr unconditionally, even in json mode, is gone — not just its
      // slug line, the whole stream.
      expect(result.stderr).toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("missing --summary (resolveTextInputs misuse, verb already known): a bare JSON record on stdout, stderr empty", async () => {
    const home = await freshHome();
    try {
      const result = await runYak(baseOpts({ argv: ["suggest", "--body", "b"], home, env: { ERIS_OUTPUT: "json" } }));
      expect(result.exitCode).toBe(1);
      const record = JSON.parse(result.stdout);
      expect(record.verb).toBe("suggest");
      expect(record.delivered).toBe(false);
      expect(record.error).toEqual({ slug: "yak-summary-required", reason: expect.any(String) });
      expect(record.redactions).toEqual({ count: 0, classes: [], skipped: false });
      expect(result.stderr).toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  // Same seam: the over-length misuse comes from
  // `submitYak`, which runs AFTER redaction (step 2) — so unlike the two
  // argv-level cases above, THIS misuse can carry a non-zero redaction
  // summary, and the text-mode `reason` explicitly tells the reader
  // "redaction may have grown it; check with --no-redact". Body is
  // constructed so the RAW (pre-redaction) length already exceeds the
  // 4000-char max — otherwise this would classify as `yak-redaction-overflow`
  // (a warn, not a misuse; see yak-submit.ts's classifyValidationFailure).
  it("an over-bound field WITH a redactable secret — the JSON record's redactions are non-zero, and the text-mode reason and the evidence agree", async () => {
    const home = await freshHome();
    try {
      const tooLongWithSecret = "PASSWORD=hunter12345 " + "x".repeat(4_000);
      const jsonResult = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", tooLongWithSecret],
          env: { ERIS_YAKS_URL: "http://example.invalid", ERIS_YAKS_TOKEN: "t", ERIS_OUTPUT: "json" },
          home,
        }),
      );
      expect(jsonResult.exitCode).toBe(1);
      const record = JSON.parse(jsonResult.stdout);
      expect(record.verb).toBe("issue");
      expect(record.delivered).toBe(false);
      expect(record.error.slug).toBe("yak-body-too-long");
      expect(record.error.reason).toContain("redaction may have grown it");
      expect(record.redactions).toEqual({ count: 1, classes: ["assignment"], skipped: false });
      // paired absence: the redaction summary and the failure block both
      // used to leak onto stderr even under json — the evidence now lives
      // entirely in the record above.
      expect(jsonResult.stderr).toBe("");

      // Same body, TEXT mode: the redaction summary line prints on stderr
      // ahead of the failure block (the warn/delivered wiring, extended to misuse) —
      // the message and the evidence are now on the SAME stream too.
      const textHome = await freshHome();
      try {
        const textResult = await runYak(
          baseOpts({
            argv: ["issue", "--summary", "s", "--body", tooLongWithSecret],
            env: { ERIS_YAKS_URL: "http://example.invalid", ERIS_YAKS_TOKEN: "t" },
            home: textHome,
          }),
        );
        expect(textResult.exitCode).toBe(1);
        expect(textResult.stdout).toBe("");
        expect(textResult.stderr).toContain("1 redaction: assignment");
        expect(textResult.stderr).toContain("slug: yak-body-too-long");
      } finally {
        await rm(textHome, { recursive: true, force: true });
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("runYak — environment/config/transport (exit 0, WARN, never the failure block)", () => {
  it("no token resolvable: WARN + exit 0, stdout empty in text mode", async () => {
    const home = await freshHome();
    try {
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b"],
          env: { ERIS_YAKS_URL: "http://example.invalid" },
          home,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("WARN ");
      expect(result.stderr).toContain("slug: yak-token-unresolved");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("no URL resolvable: WARN + exit 0, slug yak-url-unresolved", async () => {
    const home = await freshHome();
    try {
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b"],
          env: { ERIS_YAKS_TOKEN: "t" },
          home,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("slug: yak-url-unresolved");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("a group-readable ~/.eris/yaks.json is refused, never read: WARN + exit 0", async () => {
    const home = await freshHome();
    try {
      const erisDir = join(home, ".eris");
      await mkdir(erisDir, { recursive: true });
      const path = join(erisDir, "yaks.json");
      await writeFile(path, JSON.stringify({ url: "http://example.invalid", token: "leaked" }));
      await chmod(path, 0o644);

      const result = await runYak(baseOpts({ argv: ["issue", "--summary", "s", "--body", "b"], env: {}, home }));
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("slug: yak-config-permissive");
      expect(result.stderr).not.toContain("leaked");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("actor 404 (an endpoint without the route): text mode — stdout empty, WARN + exit 0", async () => {
    const home = await freshHome();
    const server = Bun.serve({ port: 0, fetch: async () => new Response("not found", { status: 404 }) });
    try {
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b"],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t" },
          home,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("WARN ");
      expect(result.stderr).toContain("slug: yak-transport-error");
      expect(result.stderr).toContain("404");
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });

  it("actor 404: json mode — one bare record with delivered:false on stdout, exit 0, NOTHING on stderr (output-contract fix)", async () => {
    const home = await freshHome();
    const server = Bun.serve({ port: 0, fetch: async () => new Response("not found", { status: 404 }) });
    try {
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b"],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t", ERIS_OUTPUT: "json" },
          home,
        }),
      );
      expect(result.exitCode).toBe(0);
      // positive: the record carries the WARN's content
      const record = JSON.parse(result.stdout);
      expect(record.delivered).toBe(false);
      expect(record.error.slug).toBe("yak-transport-error");
      expect(record.verb).toBe("issue");
      // paired absence: the "WARN .../slug: yak-transport-error" text that
      // reaches stderr in text mode (see the sibling test above) never
      // reaches it here — the whole stream is empty, not just quieter.
      expect(result.stderr).toBe("");
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });

  // Config-resolution warns (token/url/device-id unresolved) never reach
  // `submitYak` at all — they're raised directly in `runYak` via
  // `warnResult`/`warnOutputRecord`, a separate code path from the
  // network-outcome warn above. Both must independently honour the
  // output-contract fix.
  it("no token resolvable, json mode: one bare record, exit 0, stderr empty", async () => {
    const home = await freshHome();
    try {
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b"],
          env: { ERIS_YAKS_URL: "http://example.invalid", ERIS_OUTPUT: "json" },
          home,
        }),
      );
      expect(result.exitCode).toBe(0);
      const record = JSON.parse(result.stdout);
      expect(record.delivered).toBe(false);
      expect(record.error.slug).toBe("yak-token-unresolved");
      expect(record.redactions).toEqual({ count: 0, classes: [], skipped: false });
      expect(result.stderr).toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("connection refused: WARN yak-unreachable, exit 0 (real OS-level refusal)", async () => {
    const home = await freshHome();
    try {
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b"],
          env: { ERIS_YAKS_URL: "http://127.0.0.1:1", ERIS_YAKS_TOKEN: "t" },
          home,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("slug: yak-unreachable");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("a corrupt (>200-char) ~/.eris/device-id is WARN yak-identity-id-too-long, exit 0 — never the exit-1 failure block", async () => {
    // End-to-end regression: before the fix, this shape fell through
    // submitYak's validation-failure classifier as agent misuse (exit 1,
    // wrong slug, message claiming "0 chars"). Full runYak, real fs-backed device-id file — the actual
    // seam an operator hits.
    const home = await freshHome();
    try {
      const erisDir = join(home, ".eris");
      await mkdir(erisDir, { recursive: true });
      await writeFile(join(erisDir, "device-id"), "d".repeat(201));

      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b"],
          env: { ERIS_YAKS_URL: "http://example.invalid", ERIS_YAKS_TOKEN: "t" },
          home,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("WARN ");
      expect(result.stderr).toContain("slug: yak-identity-id-too-long");
      expect(result.stderr).toContain("device_id");
      expect(result.stderr).not.toContain("ERROR ");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("runYak — delivered (exit 0)", () => {
  it("fresh 200, text mode: 'recorded: <id>' on stdout, stderr empty", async () => {
    const home = await freshHome();
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = await req.json();
        return Response.json({
          id: "obs-fresh",
          idempotency_key: body.idempotency_key,
          replay: false,
          contract_version: YAKS_CONTRACT_VERSION,
        });
      },
    });
    try {
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b"],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t" },
          home,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("recorded: obs-fresh\n");
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });

  it("replay 200, text mode: distinguishable 'already recorded' line", async () => {
    const home = await freshHome();
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = await req.json();
        return Response.json({
          id: "obs-replay",
          idempotency_key: body.idempotency_key,
          replay: true,
          contract_version: YAKS_CONTRACT_VERSION,
        });
      },
    });
    try {
      const result = await runYak(
        baseOpts({
          argv: ["suggest", "--summary", "s", "--body", "b"],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t" },
          home,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("already recorded: obs-replay\n");
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });

  it("--repro rides in provenance.repro.command on the wire", async () => {
    const home = await freshHome();
    let sentBody: any;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        sentBody = await req.json();
        return Response.json({
          id: "obs-repro",
          idempotency_key: sentBody.idempotency_key,
          replay: false,
          contract_version: YAKS_CONTRACT_VERSION,
        });
      },
    });
    try {
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b", "--repro", "eris config check dev"],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t" },
          home,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("recorded: obs-repro\n");
      expect(sentBody.provenance.repro).toEqual({ command: "eris config check dev" });
      // `repro` is not part of the contract's `YakSubmission` top-level shape —
      // it must never leak in as a sibling of summary/body/evidence.
      expect(sentBody.repro).toBeUndefined();
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });

  it("no --repro given -> no provenance.repro key at all", async () => {
    const home = await freshHome();
    let sentBody: any;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        sentBody = await req.json();
        return Response.json({
          id: "obs-norepro",
          idempotency_key: sentBody.idempotency_key,
          replay: false,
          contract_version: YAKS_CONTRACT_VERSION,
        });
      },
    });
    try {
      await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b"],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t" },
          home,
        }),
      );
      if (sentBody.provenance) {
        expect(sentBody.provenance.repro).toBeUndefined();
      }
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });

  it("fresh 200, json mode: one bare record, delivered:true, no envelope", async () => {
    const home = await freshHome();
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = await req.json();
        return Response.json({
          id: "obs-json",
          idempotency_key: body.idempotency_key,
          replay: false,
          contract_version: YAKS_CONTRACT_VERSION,
        });
      },
    });
    try {
      const result = await runYak(
        baseOpts({
          argv: ["fatal", "--summary", "s", "--body", "b"],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t", ERIS_OUTPUT: "json" },
          home,
        }),
      );
      expect(result.exitCode).toBe(0);
      const record = JSON.parse(result.stdout);
      expect(record).toEqual({
        verb: "fatal",
        delivered: true,
        id: "obs-json",
        idempotency_key: expect.any(String),
        replay: false,
        contract_version: YAKS_CONTRACT_VERSION,
        key_mismatch: false,
        redactions: { count: 0, classes: [], skipped: false },
      });
      expect(result.stderr).toBe("");
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });

  it("a key-mismatched receipt, json mode: key_mismatch:true on the record, stderr empty (output-contract fix)", async () => {
    // Text-mode equivalent already covered below ("a key-mismatched receipt
    // is still delivered, with an additional WARN on stderr"). Under json,
    // that WARN is suppressed like every other diagnostic — `key_mismatch`
    // is what makes the drift signal recoverable at all, since the record's
    // `idempotency_key` is the RECEIPT's key, never the locally-derived one
    // being compared against it.
    const home = await freshHome();
    const server = Bun.serve({
      port: 0,
      fetch: async () =>
        Response.json({
          id: "obs-mismatch-json",
          idempotency_key: "not-what-we-derived",
          replay: false,
          contract_version: YAKS_CONTRACT_VERSION,
        }),
    });
    try {
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b"],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t", ERIS_OUTPUT: "json" },
          home,
        }),
      );
      expect(result.exitCode).toBe(0);
      const record = JSON.parse(result.stdout);
      expect(record.delivered).toBe(true);
      expect(record.key_mismatch).toBe(true);
      expect(record.idempotency_key).toBe("not-what-we-derived");
      expect(result.stderr).toBe("");
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });

  it("a key-mismatched receipt is still delivered, with an additional WARN on stderr", async () => {
    const home = await freshHome();
    const server = Bun.serve({
      port: 0,
      fetch: async () =>
        Response.json({
          id: "obs-mismatch",
          idempotency_key: "not-what-we-derived",
          replay: false,
          contract_version: YAKS_CONTRACT_VERSION,
        }),
    });
    try {
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b"],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t" },
          home,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("recorded: obs-mismatch\n");
      expect(result.stderr).toContain("slug: yak-key-mismatch");
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });

  it("--no-redact prints a loud warning on stderr even on a successful delivery", async () => {
    const home = await freshHome();
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = await req.json();
        return Response.json({
          id: "obs-noredact",
          idempotency_key: body.idempotency_key,
          replay: false,
          contract_version: YAKS_CONTRACT_VERSION,
        });
      },
    });
    try {
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b", "--no-redact"],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t" },
          home,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("recorded: obs-noredact\n");
      expect(result.stderr).toContain("slug: yak-no-redact");
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });

  // output-contract fix: text mode still prints the `--no-redact`
  // WARN (above). Under `--output json` that WARN is suppressed — stderr is
  // now EMPTY on every path — and the only place the fact survives is
  // `redactions.skipped: true` on the record. Without this field, a
  // skipped scrub and a scrub that ran and found nothing would both read
  // `redactions: {count: 0, classes: []}`, indistinguishable on the wire.
  it("--no-redact, json mode: stderr is empty, and redactions.skipped:true is the only record of the skip", async () => {
    const home = await freshHome();
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = await req.json();
        return Response.json({
          id: "obs-noredact-json",
          idempotency_key: body.idempotency_key,
          replay: false,
          contract_version: YAKS_CONTRACT_VERSION,
        });
      },
    });
    try {
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b", "--no-redact"],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t", ERIS_OUTPUT: "json" },
          home,
        }),
      );
      expect(result.exitCode).toBe(0);
      const record = JSON.parse(result.stdout);
      expect(record.delivered).toBe(true);
      expect(record.redactions).toEqual({ count: 0, classes: [], skipped: true });
      // paired absence: no "WARN --no-redact" text anywhere — not truncated,
      // not folded into another field, gone from the stream entirely.
      expect(result.stderr).toBe("");
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });
});

// The ingress answers a new report with 202 and a v2 receipt. Both renderings
// are driven through `runYak` against a loopback listener that records what it
// was sent, so the request is observed on the wire rather than inferred from
// the code that builds it.
describe("runYak — the ingress contract v2 (202 + v2 receipt, route workspace)", () => {
  /** A loopback ingress answering 202 + a v2 receipt, recording each request's path and body. */
  function acceptingIngress() {
    const requests: Array<{ path: string; body: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { idempotency_key: string };
        requests.push({ path: new URL(req.url).pathname, body });
        return Response.json(
          { id: "obs-v2", idempotency_key: body.idempotency_key, replay: false, contract_version: "2.0.0" },
          { status: 202 },
        );
      },
    });
    return { server, requests };
  }

  it("text mode: a 202 prints the receipt id on stdout, and the one POST strict-parses as a workspace submission", async () => {
    // When the client posts a body the v2 contract refuses, or treats the ingress's 202 as a
    // failure, an agent's report is dropped or reported as undelivered — observed at the CLI
    // seam as the receipt id missing from stdout, or the captured body failing `YakSubmission.strict()`.
    const home = await freshHome();
    const { server, requests } = acceptingIngress();
    try {
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b"],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t" },
          home,
          cwd: home,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("recorded: obs-v2\n");
      // positive: exactly one request reached the ingress, at the v2 path
      expect(requests.map((r) => r.path)).toEqual(["/v1/yaks"]);
      expect(YakSubmission.strict().safeParse(requests[0]!.body).success).toBe(true);
      expect(requests[0]!.body).toMatchObject({ schema_version: "2.0.0", route: "workspace" });
      expect("reporter" in (requests[0]!.body as object)).toBe(false);
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });

  it("json mode: a 202 yields delivered:true and contract_version 2.0.0 in the one record", async () => {
    // When the client reports a 202 as undelivered, or a receipt's contract_version is lost in
    // the record, a machine caller branches on a false failure — observed as `delivered` and
    // `contract_version` in the record `--output json` prints.
    const home = await freshHome();
    const { server, requests } = acceptingIngress();
    try {
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b"],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t", ERIS_OUTPUT: "json" },
          home,
          cwd: home,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const record = JSON.parse(result.stdout);
      expect(record).toMatchObject({ verb: "issue", delivered: true, id: "obs-v2", contract_version: "2.0.0", replay: false });
      expect(requests).toHaveLength(1);
      expect(YakSubmission.strict().safeParse(requests[0]!.body).success).toBe(true);
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });
});

// `yak.ts::runYak` has two wiring
// blocks calling `formatRedactionSummary` (the warn path and the delivered
// path), both gated on `!jsonOutput && redaction.count > 0`. Neither block
// is exercised by `tests/yak-redact.test.ts` (that file tests the pure
// formatter directly) nor by any prior test here — every existing case above
// uses a body with nothing to redact. These pin the WIRING itself: deleting
// either block should turn one of these red. `cwd: home` (a fresh, non-git
// mkdtemp) plus a minimal `env` keeps `gatherProvenance` from adding its own
// extra redaction matches to the counts these tests assert on exactly.
describe("runYak — redaction summary wiring (text mode stderr)", () => {
  const SECRET_BODY = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345 and PASSWORD=hunter12345";

  it("delivered path: a body with redactable secrets prints the count/class summary on stderr; stdout stays the payload", async () => {
    const home = await freshHome();
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = await req.json();
        return Response.json({
          id: "obs-f4-delivered",
          idempotency_key: body.idempotency_key,
          replay: false,
          contract_version: YAKS_CONTRACT_VERSION,
        });
      },
    });
    try {
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", SECRET_BODY],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t" },
          home,
          cwd: home,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("recorded: obs-f4-delivered\n");
      expect(result.stderr).toBe("2 redactions: auth-header, assignment\n");
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });

  it("warn path: an unreachable actor still prints the summary line for a body with redactable secrets", async () => {
    const home = await freshHome();
    try {
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", SECRET_BODY],
          env: { ERIS_YAKS_URL: "http://127.0.0.1:1", ERIS_YAKS_TOKEN: "t" },
          home,
          cwd: home,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("2 redactions: auth-header, assignment");
      expect(result.stderr).toContain("slug: yak-unreachable");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("json mode never prints the summary line on stderr, even with redactable secrets — the record carries `redactions` instead", async () => {
    const home = await freshHome();
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = await req.json();
        return Response.json({
          id: "obs-f4-json",
          idempotency_key: body.idempotency_key,
          replay: false,
          contract_version: YAKS_CONTRACT_VERSION,
        });
      },
    });
    try {
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", SECRET_BODY],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t", ERIS_OUTPUT: "json" },
          home,
          cwd: home,
        }),
      );
      expect(result.exitCode).toBe(0);
      // output-contract fix: not just "no redaction text" — the
      // whole stream is empty under json mode now.
      expect(result.stderr).toBe("");
      const record = JSON.parse(result.stdout);
      expect(record.redactions).toEqual({ count: 2, classes: ["auth-header", "assignment"], skipped: false });
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });

  it("zero redactions: no summary line at all", async () => {
    const home = await freshHome();
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = await req.json();
        return Response.json({
          id: "obs-f4-clean",
          idempotency_key: body.idempotency_key,
          replay: false,
          contract_version: YAKS_CONTRACT_VERSION,
        });
      },
    });
    try {
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "nothing sensitive here"],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t" },
          home,
          cwd: home,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("recorded: obs-f4-clean\n");
      expect(result.stderr).toBe("");
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("runYak — the stream split (docs/OUTPUT-CONTRACT.md §1)", () => {
  it("stdout never carries a WARN or ERROR line, in any outcome", async () => {
    const home = await freshHome();
    const server = Bun.serve({ port: 0, fetch: async () => new Response("nope", { status: 500 }) });
    try {
      const misuse = await runYak(baseOpts({ argv: ["bogus-verb"], home }));
      expect(misuse.stdout).not.toContain("ERROR");
      expect(misuse.stdout).not.toContain("WARN");

      const warn = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b"],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t" },
          home,
        }),
      );
      expect(warn.stdout).not.toContain("ERROR");
      expect(warn.stdout).not.toContain("WARN");
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// runYak — --repo target-repo hints
// ============================================================================

/** Fixture-only git invocation — NEVER the module under test. Throws with
 *  stderr on a nonzero exit so a broken fixture fails loudly at setup time,
 *  not as a mystifying assertion failure three lines later. */
function fixtureGit(dir: string, ...args: string[]): string {
  const proc = Bun.spawnSync({ cmd: ["git", "-C", dir, ...args] });
  if (proc.exitCode !== 0) {
    throw new Error(`fixture setup: git -C ${dir} ${args.join(" ")} failed:\n${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

/** A fresh scratch dir that IS a git checkout with a known `origin` remote —
 *  for asserting the `--repo` auto-derivation hermetically, without
 *  depending on whatever remote this checkout itself happens to have (a
 *  fork's origin differs from this repo's, and a CI clone's remote naming
 *  is not this module's to assume). No commit is needed: `gatherGit`'s
 *  `remote.origin.url` probe reads config, not history. */
async function gitRepoWithOrigin(originUrl: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yak-cli-repo-test-"));
  fixtureGit(dir, "init", "-q", "-b", "main");
  fixtureGit(dir, "remote", "add", "origin", originUrl);
  return dir;
}

describe("runYak — --repo target-repo hints", () => {
  it("a single --repo lands at provenance.repo.target_repos as a one-element array", async () => {
    const home = await freshHome();
    let sentBody: any;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        sentBody = await req.json();
        return Response.json({ id: "obs-repo-1", idempotency_key: sentBody.idempotency_key, replay: false, contract_version: YAKS_CONTRACT_VERSION });
      },
    });
    try {
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b", "--repo", "acme/widgets"],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t" },
          home,
          cwd: home, // non-git — proves the hint came from the flag, not auto-derivation
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("recorded: obs-repo-1\n");
      expect(sentBody.provenance.repo.target_repos).toEqual(["acme/widgets"]);
      // paired absence: never a sibling top-level field on the submission
      expect(sentBody.repo).toBeUndefined();
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });

  it("repeated --repo flags land as a multi-element array, in order — 'a report that spans repos'", async () => {
    const home = await freshHome();
    let sentBody: any;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        sentBody = await req.json();
        return Response.json({ id: "obs-repo-2", idempotency_key: sentBody.idempotency_key, replay: false, contract_version: YAKS_CONTRACT_VERSION });
      },
    });
    try {
      await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b", "--repo", "acme/widgets", "--repo", "acme/gadgets"],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t" },
          home,
          cwd: home,
        }),
      );
      expect(sentBody.provenance.repo.target_repos).toEqual(["acme/widgets", "acme/gadgets"]);
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });

  it("no --repo given, cwd is not a git checkout at all -> no provenance.repo.target_repos on the wire", async () => {
    const home = await freshHome();
    let sentBody: any;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        sentBody = await req.json();
        return Response.json({ id: "obs-repo-3", idempotency_key: sentBody.idempotency_key, replay: false, contract_version: YAKS_CONTRACT_VERSION });
      },
    });
    try {
      await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b"],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t" },
          home,
          cwd: home, // a fresh mkdtemp — not a git checkout
        }),
      );
      if (sentBody.provenance?.repo) {
        expect(sentBody.provenance.repo.target_repos).toBeUndefined();
      }
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });

  it("no --repo given, cwd IS a git checkout with a remote -> auto-derived from the git remote origin url", async () => {
    const home = await freshHome();
    const repo = await gitRepoWithOrigin("https://github.com/acme/widgets.git");
    let sentBody: any;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        sentBody = await req.json();
        return Response.json({ id: "obs-repo-4", idempotency_key: sentBody.idempotency_key, replay: false, contract_version: YAKS_CONTRACT_VERSION });
      },
    });
    try {
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b"],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t" },
          home,
          cwd: repo,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(sentBody.provenance.repo.target_repos).toEqual(["acme/widgets"]);
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("an explicit --repo wins over the git-remote auto-derivation, never merges with it", async () => {
    const home = await freshHome();
    const repo = await gitRepoWithOrigin("https://github.com/acme/widgets.git");
    let sentBody: any;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        sentBody = await req.json();
        return Response.json({ id: "obs-repo-5", idempotency_key: sentBody.idempotency_key, replay: false, contract_version: YAKS_CONTRACT_VERSION });
      },
    });
    try {
      await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b", "--repo", "acme/gadgets"],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t" },
          home,
          cwd: repo,
        }),
      );
      expect(sentBody.provenance.repo.target_repos).toEqual(["acme/gadgets"]);
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("a scp-like git remote (git@host:owner/name.git) is also auto-derived correctly", async () => {
    const home = await freshHome();
    const repo = await gitRepoWithOrigin("git@github.com:acme/widgets.git");
    let sentBody: any;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        sentBody = await req.json();
        return Response.json({ id: "obs-repo-6", idempotency_key: sentBody.idempotency_key, replay: false, contract_version: YAKS_CONTRACT_VERSION });
      },
    });
    try {
      await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b"],
          env: { ERIS_YAKS_URL: server.url.toString(), ERIS_YAKS_TOKEN: "t" },
          home,
          cwd: repo,
        }),
      );
      expect(sentBody.provenance.repo.target_repos).toEqual(["acme/widgets"]);
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("an over-length --repo hint fails locally with slug yak-repo-too-long, request never sent", async () => {
    const home = await freshHome();
    try {
      const tooLong = "x".repeat(201);
      const result = await runYak(
        baseOpts({
          argv: ["issue", "--summary", "s", "--body", "b", "--repo", tooLong, "--no-redact"],
          env: { ERIS_YAKS_URL: "http://127.0.0.1:1", ERIS_YAKS_TOKEN: "t" },
          home,
          cwd: home,
        }),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("slug: yak-repo-too-long");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("more than 20 --repo hints fails locally with slug yak-repo-hints-too-many, request never sent", async () => {
    const home = await freshHome();
    try {
      const argv = ["issue", "--summary", "s", "--body", "b"];
      for (let i = 0; i < 21; i++) argv.push("--repo", `acme/repo-${i}`);
      const result = await runYak(
        baseOpts({
          argv,
          env: { ERIS_YAKS_URL: "http://127.0.0.1:1", ERIS_YAKS_TOKEN: "t" },
          home,
          cwd: home,
        }),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("slug: yak-repo-hints-too-many");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
