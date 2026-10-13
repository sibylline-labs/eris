/**
 * refusal.ts — how `eris update` stops: a `Refusal` carries the failure block's
 * input, thrown from wherever the cause is found and rendered once by the verb
 * (src/cli/commands/update.ts), so a failure is one block and nothing cascades.
 */

import type { ErisFailureInput } from "../../../../ts/lib/eris-fail";
import { sanitizeDisplay } from "../../output";

export class Refusal extends Error {
  constructor(readonly input: ErisFailureInput) {
    super(input.what);
  }
}

/** An error's own words on one line, fit to print in a failure block. */
export function reasonOf(e: unknown): string {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  const message = e instanceof Error ? e.message : String(e);
  return sanitizeDisplay(`${typeof code === "string" ? `${code}: ` : ""}${message}`).replace(/\s+/g, " ").slice(0, 200);
}
