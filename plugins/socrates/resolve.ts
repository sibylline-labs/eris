/**
 * resolve.ts — `eris socrates resolve <epic>`, loaded only when `eris socrates
 * resolve` dispatches (./submit.ts routes the group).
 *
 * Asks the endpoint to resolve one closed review Epic and prints its receipt:
 * what was applied, what was carried over and to which Epic. The server does
 * every Linear read and write; this verb names the Epic and nothing else.
 *
 * Invariants:
 *   - Nothing leaves the machine before `eris/outbound-scan` has run over the
 *     body: a gitleaks hit refuses it (`socrates-secret-detected`).
 *   - The request body is `SocratesResolveRequest`'s parse; the reply is read
 *     only through `SocratesResolveResponse` (./client.ts owns the exchange).
 *   - The Epic is required. The contract's request needs it, and the client
 *     holds no Linear access to find closed Epics itself; the Epic's path
 *     comment names the exact command.
 *   - A repeat run prints the server's stored receipt. The client keeps no
 *     state and cannot tell a first run from a repeat.
 */

import { scanStrings } from "eris/outbound-scan";
import { readArgs, type VerbContext } from "../../src/cli/plugin";
import { fail, postSocrates, printable, type SocratesDeps, socratesEndpoint } from "./client";
import plugin from "./index";
import { SOCRATES_CONTRACT_VERSION } from "./socrates-contract.v1";
import { SOCRATES_ROUTES, SocratesResolveRequest, SocratesResolveResponse } from "./socrates-contract.v1.verbs";

export const RESOLVE_USAGE = `Usage: eris socrates resolve <epic>

Resolve one closed review Epic on the Socrates endpoint and print what it did:
'resolved <epic>: <n> applied, <m> carried over to <carry-over epic>', then
the applied and carried-over entries. Resolving the same Epic again changes
nothing and prints the same receipt. --output json prints {epic, outcome,
applied, carried_over, carry_over_epic?, reporting, contract_version}.

  <epic>  the review Epic's identifier, as its path comment prints it

The endpoint applies the Done entries to the living docs, records the
Canceled ones as rejected and moves every open entry to a new carry-over
Epic. It refuses an Epic that is still open.

Sign in first with 'eris login'.
`;

const refusalFix = (status: number): string | undefined => {
  if (status === 404) return "check the Epic's identifier: the Epic's Socrates comment prints the command to run";
  if (status === 409) return "resolve runs on a closed review Epic: close it in Linear, then run the command again";
  return undefined;
};

const badResponseFix = (status: number): string | undefined =>
  status === 404 ? `this endpoint does not serve ${SOCRATES_ROUTES.resolve.path}: update the server, or check the url points at a Socrates endpoint` : undefined;

const list = (ids: readonly string[]): string => ids.map(printable).join(", ");

export async function runResolve(args: string[], ctx: VerbContext, deps: SocratesDeps = {}): Promise<number> {
  const a = readArgs(plugin.rows, "socrates resolve", args, ctx, { help: RESOLVE_USAGE });
  if (a === null) return 0;
  const [epic] = a.pos;
  if (epic === undefined) fail(ctx, "socrates-flag-required", "missing <epic>", "eris socrates resolve <epic>: the closed Epic's Socrates comment prints the exact command");

  const parsed = SocratesResolveRequest.safeParse({ schema_version: SOCRATES_CONTRACT_VERSION, epic });
  if (!parsed.success) fail(ctx, "socrates-flag-required", `not an Epic identifier: '${printable(epic)}'`, "eris socrates resolve <epic>: the closed Epic's Socrates comment prints the exact command");

  const leaked = scanStrings(parsed.data);
  if (leaked.length > 0) fail(ctx, "socrates-secret-detected", `a secret was found in <epic> (${leaked.map((h) => h.rule).join(", ")}); nothing was sent`, "pass the Epic's identifier; this check cannot be overridden");

  const endpoint = await socratesEndpoint(ctx, deps);
  const receipt = await postSocrates(ctx, deps, endpoint, {
    path: SOCRATES_ROUTES.resolve.path,
    body: parsed.data,
    decoder: SocratesResolveResponse,
    subject: `the resolve of ${printable(epic)}`,
    refusalFix,
    badResponseFix,
  });

  if (ctx.format === "json") {
    ctx.stdout.write(`${JSON.stringify(receipt)}\n`);
    return 0;
  }
  const id = printable(receipt.epic);
  if (receipt.outcome === "queued") {
    ctx.stdout.write(`queued ${id}: the server resolves it in the background\n`);
    return 0;
  }
  const to = receipt.carry_over_epic === undefined ? "" : ` to ${printable(receipt.carry_over_epic)}`;
  let out = `resolved ${id}: ${receipt.applied.length} applied, ${receipt.carried_over.length} carried over${to}\n`;
  if (receipt.applied.length > 0) out += `  applied: ${list(receipt.applied)}\n`;
  if (receipt.carried_over.length > 0) out += `  carried over: ${list(receipt.carried_over)}\n`;
  ctx.stdout.write(out);
  return 0;
}
