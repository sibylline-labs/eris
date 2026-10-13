/**
 * Contract tests for the vendored Yaks wire contract.
 *
 * Locks in:
 *   1. The vendor header: `plugins/yak/yaks-schema.v1.ts` states the contract
 *      version it carries, and exports that same version. (A byte-for-byte
 *      drift check against the server's copy needs the server's source and is
 *      not part of this suite.)
 *   2. The golden derivation vectors ported from the server's own contract
 *      tests — key order stability,
 *      evidence-omission in `canonicalPayload`, the sha256-hex shape, and the
 *      adversarial `\n`-delimiter prefix-collision case. These run
 *      unconditionally (no checkout needed): they exercise the vendored
 *      *code*, not upstream's copy of it.
 *   3. One vector upstream does NOT have: `evidence: ""` must derive a
 *      DIFFERENT idempotency key than `evidence` omitted entirely. The CLI's
 *      submission core depends on this NOT collapsing on its own — it
 *      normalizes an empty `--evidence-file` read to "omit the key"
 *      specifically because the contract does not do it for it. Pinning the
 *      raw fact here means the submission core can cite this test instead of
 *      re-deriving it.
 *   4. `zod` resolves to a version compatible with the declared range
 *      (`^3.23.0`): a byte-identical vendored file can
 *      still behave differently across a zod major even though nothing in
 *      the file itself changed.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  YAKS_CONTRACT_VERSION,
  canonicalPayload,
  deriveIdempotencyKey,
} from "../plugins/yak/yaks-schema.v1";

// --- Vendor header ------------------------------------------------------------

const ERIS_ROOT = join(import.meta.dir, "..");
const VENDORED_PATH = join(ERIS_ROOT, "plugins/yak/yaks-schema.v1.ts");

// The vendored file's own header line is the single source of truth for the pin.
const VENDORED_CONTENT = readFileSync(VENDORED_PATH, "utf-8");
const HEADER = VENDORED_CONTENT.slice(0, VENDORED_CONTENT.indexOf("\n"));

describe("vendored contract", () => {
  it("carries a well-formed vendor header", () => {
    expect(HEADER).toMatch(
      /^\/\/ Vendored Yaks wire contract — yaks-schema\.v1\.ts \(YAKS_CONTRACT_VERSION \d+\.\d+\.\d+\)\./,
    );
  });

  // Offline half: catches a hand-edited version string that was never re-vendored.
  it("exports the YAKS_CONTRACT_VERSION its header claims", () => {
    const stated = HEADER.match(/YAKS_CONTRACT_VERSION (\d+\.\d+\.\d+)/)?.[1];
    if (!stated) throw new Error(`No YAKS_CONTRACT_VERSION in the vendor header: ${HEADER}`);
    expect(YAKS_CONTRACT_VERSION).toBe(stated);
  });
});

// --- Golden derivation vectors (ported from the server's contract tests) ---
//
// These exercise the CODE this repo vendored, proving the copy actually
// behaves as documented.

describe("canonicalPayload", () => {
  it("key order is fixed regardless of the input object's own key order", () => {
    const a = { summary: "x", body: "y", evidence: "z" };
    const b = { evidence: "z", body: "y", summary: "x" };
    expect(canonicalPayload(a)).toBe(canonicalPayload(b));
    expect(canonicalPayload(a)).toBe('{"summary":"x","body":"y","evidence":"z"}');
  });

  it("evidence absent is OMITTED, not serialized as null/empty", () => {
    const withoutEvidence = canonicalPayload({ summary: "x", body: "y" });
    expect(withoutEvidence).toBe('{"summary":"x","body":"y"}');
  });
});

describe("deriveIdempotencyKey", () => {
  it("is stable across JSON key-insertion order of the logical submission", async () => {
    const inOrder = {
      device_id: "dev-1",
      execution_id: "exec-1",
      verb: "issue" as const,
      summary: "same report",
      body: "same body",
      evidence: "same evidence",
    };
    const scrambled = {
      evidence: "same evidence",
      body: "same body",
      summary: "same report",
      verb: "issue" as const,
      execution_id: "exec-1",
      device_id: "dev-1",
    };
    const [keyA, keyB] = await Promise.all([
      deriveIdempotencyKey(inOrder),
      deriveIdempotencyKey(scrambled),
    ]);
    expect(keyA).toBe(keyB);
    expect(keyA).toMatch(/^[0-9a-f]{64}$/); // sha256 hex digest
  });

  // The whole reason the `\n` delimiters exist: bare concatenation of
  // device_id + execution_id is prefix-ambiguous: device="ab",exec="c" and device="a",exec="bc" both
  // concatenate to "abc" and would hash identically. A happy-path round-trip
  // test cannot catch this — it has to construct exactly this pair and prove
  // the keys differ.
  it("adversarial: the \\n delimiter defeats the prefix-ambiguous bare-concatenation collision", async () => {
    const shared = {
      verb: "issue" as const,
      summary: "identical report text",
      body: "identical body text",
      evidence: "identical evidence",
    };
    const collisionCandidateA = { ...shared, device_id: "ab", execution_id: "c" };
    const collisionCandidateB = { ...shared, device_id: "a", execution_id: "bc" };

    // Prove the premise: bare concatenation WOULD collide for this pair.
    const bareConcatA = `${collisionCandidateA.device_id}${collisionCandidateA.execution_id}`;
    const bareConcatB = `${collisionCandidateB.device_id}${collisionCandidateB.execution_id}`;
    expect(bareConcatA).toBe(bareConcatB); // "abc" === "abc" — the trap the delimiters close

    const keyA = await deriveIdempotencyKey(collisionCandidateA);
    const keyB = await deriveIdempotencyKey(collisionCandidateB);
    expect(keyA).not.toBe(keyB);
  });

  // The vector upstream does NOT have. `canonicalPayload` OMITS the
  // `evidence` key when it is `undefined` but KEEPS it when it is `""`
  // (JSON.stringify's own behavior — an object literal drops an undefined
  // property but keeps an empty string). Those are two different JSON
  // strings and therefore two different sha256 inputs. When the CLI reads an empty
  // `--evidence-file` and does NOT normalize it to "omit the flag" before
  // calling deriveIdempotencyKey, this test goes red the moment someone
  // "simplifies" that normalization away — observed here, at the contract
  // function itself, so the submission core doesn't have to re-derive the fact.
  it("evidence: '' derives a DIFFERENT key than evidence omitted entirely", async () => {
    const shared = {
      device_id: "d1",
      execution_id: "e1",
      verb: "issue" as const,
      summary: "s",
      body: "b",
    };
    const omittedKey = await deriveIdempotencyKey(shared);
    const emptyKey = await deriveIdempotencyKey({ ...shared, evidence: "" });
    expect(omittedKey).not.toBe(emptyKey);

    // And at the canonicalPayload layer directly, since that's where the
    // divergence actually originates.
    expect(canonicalPayload(shared)).toBe('{"summary":"s","body":"b"}');
    expect(canonicalPayload({ ...shared, evidence: "" })).toBe(
      '{"summary":"s","body":"b","evidence":""}',
    );
  });
});

// --- Resolved zod version -----------------------------------------------------
//
// package.json pins `zod: "^3.23.0"`, which resolves 3.25.76 (observed
// 2026-08-12). A byte-identical vendored file can
// still behave differently across a zod MAJOR bump even though the file's own
// bytes never changed, so this is recorded as a live TEST ASSERTION rather
// than a static comment in the vendor header. Decision: test assertion, not
// header comment — a header can only state a version at vendor time, and the
// risk this exists to catch is exactly a version that drifts AFTER vendoring.
// A comment would go stale silently; this fails loudly.

describe("resolved zod version", () => {
  const zodPkgPath = join(ERIS_ROOT, "node_modules/zod/package.json");
  const zodPkg = JSON.parse(readFileSync(zodPkgPath, "utf-8"));
  const erisPkg = JSON.parse(readFileSync(join(ERIS_ROOT, "package.json"), "utf-8"));

  it("the installed zod version satisfies eris's declared ^3.23.0 range", () => {
    expect(erisPkg.dependencies.zod).toBe("^3.23.0");
    const [major, minor] = String(zodPkg.version).split(".").map(Number);
    // `^3.23.0` means >=3.23.0 <4.0.0 — major pinned at 3, minor at least 23.
    expect(major).toBe(3);
    expect(minor).toBeGreaterThanOrEqual(23);
  });
});
