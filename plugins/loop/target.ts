/**
 * target.ts — the issue a loop operand names. An issue key (`ABC-123`) is normalised with no request.
 * A yak id (a 26-character ULID, or a 36-character UUID) is resolved through the gates client on the
 * `eris login` bearer: the observation's cluster, then the cluster's current issue. The key a yak
 * resolves to is validated exactly as a typed one is.
 */

import { resolveYakIssue, YAK_ULID_RE, YAK_UUID_RE } from "eris/gates-contract";
import { endpoint, type Run } from "./deps";
import { unwrap } from "./failure";
import { normaliseIssue } from "./names";

export interface Target {
  readonly issue: string;
  /** The yak id the operand named (a ULID upper-cased, a UUID lower-cased); absent for a typed key. */
  readonly yak?: string;
}

/** `{ issue, yak? }` for an operand, resolved on the bearer of the org `cwd` acts as. */
export async function resolveTarget(run: Run, raw: string, cwd: string): Promise<Target> {
  const arg = raw.trim();
  const yak = YAK_ULID_RE.test(arg) ? arg.toUpperCase() : YAK_UUID_RE.test(arg) ? arg.toLowerCase() : undefined;
  if (yak === undefined) return { issue: normaliseIssue(raw) };
  const key = unwrap(await resolveYakIssue(await endpoint(run, cwd), yak));
  return { issue: normaliseIssue(key), yak };
}
