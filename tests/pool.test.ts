/**
 * Tests for ts/lib/pool.ts — the ERIS_BATCH_CONCURRENCY /
 * ERIS_BATCH_TIMEOUT env resolution (an invalid value clamps, never disables
 * the bound) and the in-process bounded concurrency runner.
 */

import { describe, it, expect } from "bun:test";
import { resolveConcurrency, resolveDeadlineMs, runPool } from "../ts/lib/pool";

describe("resolveConcurrency", () => {
  it("defaults to 8 when unset", () => {
    expect(resolveConcurrency(undefined)).toBe(8);
  });

  it("uses a positive integer value verbatim", () => {
    expect(resolveConcurrency("3")).toBe(3);
    expect(resolveConcurrency("16")).toBe(16);
  });

  // A non-numeric or <=0 value clamps to 8 rather than disabling throttling
  // (unlimited fan-out) — goes red if either boundary starts falling through
  // to "unlimited".
  it("clamps a non-numeric value to 8, not 'unlimited'", () => {
    expect(resolveConcurrency("banana")).toBe(8);
    expect(resolveConcurrency("")).toBe(8);
  });

  it("clamps zero and negative values to 8", () => {
    expect(resolveConcurrency("0")).toBe(8);
    expect(resolveConcurrency("-5")).toBe(8);
  });

  it("clamps a decimal or a value with a leading '+' to 8 (integer-only)", () => {
    expect(resolveConcurrency("3.5")).toBe(8);
    expect(resolveConcurrency("+3")).toBe(8);
  });
});

describe("resolveDeadlineMs", () => {
  it("defaults to 60000ms (60s) when unset", () => {
    expect(resolveDeadlineMs(undefined)).toBe(60000);
  });

  it("converts a positive integer of seconds to milliseconds", () => {
    expect(resolveDeadlineMs("5")).toBe(5000);
    expect(resolveDeadlineMs("120")).toBe(120000);
  });

  it("falls back to the 60s default for non-numeric or non-positive input", () => {
    expect(resolveDeadlineMs("nope")).toBe(60000);
    expect(resolveDeadlineMs("0")).toBe(60000);
    expect(resolveDeadlineMs("-1")).toBe(60000);
  });
});

describe("runPool", () => {
  it("returns results in input order regardless of completion order", async () => {
    const items = [30, 10, 20];
    const results = await runPool(items, 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(results).toEqual([30, 10, 20]);
  });

  // The whole point of the port: replace one-subprocess-per-key with
  // in-process fan-out bounded by a real concurrency cap. This goes red if
  // the pool ever lets more than `concurrency` workers run at once.
  it("never runs more than `concurrency` workers concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await runPool(items, 4, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i;
    });
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1); // proves it actually parallelizes
  });

  it("propagates a worker's thrown error rather than swallowing it", async () => {
    const items = [1, 2, 3];
    await expect(
      runPool(items, 2, async (i) => {
        if (i === 2) throw new Error("boom");
        return i;
      })
    ).rejects.toThrow("boom");
  });

  it("handles an empty item list without hanging", async () => {
    const results = await runPool<number, number>([], 4, async (i) => i);
    expect(results).toEqual([]);
  });

  it("handles concurrency higher than the item count", async () => {
    const results = await runPool([1, 2], 10, async (i) => i * 2);
    expect(results).toEqual([2, 4]);
  });
});
