/**
 * status.ts — `eris socrates status [--candidate <id>]`, loaded only when `eris socrates status`
 * dispatches (./submit.ts routes the group).
 *
 * Reads the endpoint's status: how many candidates are pending, which review Epics are open and,
 * when asked, the state of one candidate. A read: one GET with a query and no body.
 *
 * Invariants:
 *   - Nothing leaves the machine before `eris/outbound-scan` has run over the request: a gitleaks
 *     hit refuses it (`socrates-secret-detected`). The request is the contract's parse of
 *     `{candidate_id?}`.
 *   - The reply is read only through `SocratesStatusResponse`; `--output json` prints the decoded
 *     record, text prints it with terminal control characters removed (`printable`).
 *   - An answer about a candidate must be about the one that was asked: a reply with no state for
 *     it, or another candidate's, is `socrates-bad-response` (an older server ignores the query
 *     and answers for the org).
 */

import { scanStrings } from "eris/outbound-scan";
import { readArgs, type VerbContext } from "../../src/cli/plugin";
import { fail, postSocrates, printable, type SocratesDeps, socratesEndpoint } from "./client";
import plugin from "./index";
import { SOCRATES_ROUTES, SocratesStatusRequest, SocratesStatusResponse } from "./socrates-contract.v1.verbs";

export const STATUS_USAGE = `Usage: eris socrates status [--candidate <id>]

Ask the Socrates endpoint what is waiting and print it:
'pending candidates: <n>', 'open review Epics: <n>' and one line per Epic
('  <epic>  <project>  <n> open  <url>'). With --candidate, then
'candidate <id>: <state>' and the issue it is filed as. --output json prints
{rubric_version, policy_hash, pending_candidates, open_epics: [{epic, project,
url, open_children}], candidate?: {candidate_id, state, issue_url?},
contract_version}.

  --candidate <id>   a candidate id, as 'eris socrates submit' prints it. State
                     is pending, filed, needs_input (filed for a person's
                     answer), resolved or rejected

Sign in first with 'eris login'.
`;

const refusalFix = (status: number): string | undefined => (status === 404 ? "check the candidate id: 'eris socrates submit' prints it" : undefined);

const badResponseFix = (status: number): string | undefined =>
  status === 404 || status === 405 ? `this endpoint does not serve ${SOCRATES_ROUTES.status.path}: update the server, or check the url points at a Socrates endpoint` : undefined;

export async function runStatus(args: string[], ctx: VerbContext, deps: SocratesDeps = {}): Promise<number> {
  const a = readArgs(plugin.rows, "socrates status", args, ctx, { help: STATUS_USAGE });
  if (a === null) return 0;
  const asked = a.flags["--candidate"];
  const parsed = SocratesStatusRequest.safeParse(asked === undefined ? {} : { candidate_id: asked });
  if (!parsed.success) fail(ctx, "socrates-flag-required", `not a candidate id: '${printable(asked ?? "")}'`, "eris socrates status --candidate <id>: 'eris socrates submit' prints the id");
  const leaked = scanStrings(parsed.data);
  if (leaked.length > 0) fail(ctx, "socrates-secret-detected", `a secret was found in --candidate (${leaked.map((h) => h.rule).join(", ")}); nothing was sent`, "pass the candidate's id; this check cannot be overridden");

  const endpoint = await socratesEndpoint(ctx, deps);
  const { candidate_id } = parsed.data;
  const reply = await postSocrates(ctx, deps, endpoint, {
    method: "GET",
    path: SOCRATES_ROUTES.status.path,
    query: candidate_id === undefined ? {} : { candidate_id },
    decoder: SocratesStatusResponse,
    subject: "the status request",
    refusalFix,
    badResponseFix,
  });
  if (candidate_id !== undefined && reply.candidate?.candidate_id !== candidate_id) {
    fail(ctx, "socrates-bad-response", `asked about candidate ${printable(candidate_id)} and the endpoint answered ${reply.candidate === undefined ? "without a state for it" : `about ${printable(reply.candidate.candidate_id)}`}`, "update the server, or check the url points at a Socrates endpoint");
  }

  if (ctx.format === "json") {
    ctx.stdout.write(`${JSON.stringify(reply)}\n`);
    return 0;
  }
  let out = `pending candidates: ${reply.pending_candidates}\nopen review Epics: ${reply.open_epics.length}\n`;
  for (const e of reply.open_epics) out += `  ${printable(e.epic)}  ${printable(e.project)}  ${e.open_children} open  ${printable(e.url)}\n`;
  if (candidate_id !== undefined && reply.candidate !== undefined) {
    out += `candidate ${printable(reply.candidate.candidate_id)}: ${reply.candidate.state}\n`;
    if (reply.candidate.issue_url !== undefined) out += `  issue: ${printable(reply.candidate.issue_url)}\n`;
  }
  ctx.stdout.write(out);
  return 0;
}
