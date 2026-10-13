/**
 * fake-runner.ts — a `Runner` that records every call and answers from a
 * function, so a test injects one instead of stubbing PATH
 * (src/runtime/process.ts holds the real adapter and the interface).
 */

import type { RunOptions, RunResult, Runner } from "../src/runtime/process";

export type FakeRunner = Runner & { calls: Array<{ argv: readonly string[]; opts: RunOptions }> };

/** A Runner that records every call and answers from `respond`. */
export function createFakeRunner(
  respond: (argv: readonly string[], opts: RunOptions) => RunResult | Promise<RunResult>,
): FakeRunner {
  const calls: FakeRunner["calls"] = [];
  return {
    calls,
    async run(argv, opts) {
      calls.push({ argv, opts });
      return respond(argv, opts);
    },
  };
}
