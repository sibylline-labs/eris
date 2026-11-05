/**
 * evidence.ts — `eris socrates evidence <fragment-id>`, loaded only when `eris socrates evidence`
 * dispatches (./submit.ts routes the group).
 *
 * Reads one stored evidence fragment back from the endpoint, whole: its kind, provenance and
 * content. Linear never carries a fragment's content, so this is how a reviewer reads it. A read:
 * one GET with no body.
 *
 * Invariants:
 *   - The id is the contract's parse of `{fragment_id}`, scanned by `eris/outbound-scan` before it
 *     is sent, and percent-encoded into the path, so it names one path segment and nothing else;
 *     `.` and `..`, which encoding leaves as dot segments fetch resolves, are refused.
 *   - The reply is read only through `SocratesEvidenceGetResponse`, and must be the fragment that
 *     was asked for: another id is `socrates-bad-response`.
 *   - `--output json` prints the decoded record; text has terminal control characters removed
 *     (`printable`), and the content keeps its newlines and tabs (`printableMarkdown`).
 */

import { scanStrings } from "eris/outbound-scan";
import { readArgs, type VerbContext } from "../../src/cli/plugin";
import { fail, postSocrates, printable, printableMarkdown, type SocratesDeps, socratesEndpoint } from "./client";
import plugin from "./index";
import { SOCRATES_ROUTES, SocratesEvidenceGetRequest, SocratesEvidenceGetResponse } from "./socrates-contract.v1.verbs";

export const EVIDENCE_USAGE = `Usage: eris socrates evidence <fragment-id>

Read one evidence fragment from the Socrates endpoint and print it:
'fragment: <id>', 'kind: <kind>', 'provenance: <provenance>', 'expires: <time>'
and 'candidate: <id>' when it is linked to one, then a blank line and the
fragment's content. --output json prints {fragment_id, candidate_id?, kind,
provenance, content, created_at, expires_at, contract_version}.

  <fragment-id>  a fragment id, as 'eris socrates submit --evidence' prints it

A fragment is deleted when its candidate resolves, after 30 days at most, and
when the org cancels.

Sign in first with 'eris login'.
`;

const ID_FIX = "eris socrates evidence <fragment-id>: 'eris socrates submit --evidence' prints the id";

const refusalFix = (status: number): string | undefined =>
  status === 404 ? "check the fragment id: 'eris socrates submit --evidence' prints it, and a fragment is deleted when its candidate resolves or after 30 days" : undefined;

const badResponseFix = (status: number): string | undefined =>
  status === 405 ? `this endpoint does not serve ${SOCRATES_ROUTES.evidence_get.path}: update the server, or check the url points at a Socrates endpoint` : undefined;

export async function runEvidence(args: string[], ctx: VerbContext, deps: SocratesDeps = {}): Promise<number> {
  const a = readArgs(plugin.rows, "socrates evidence", args, ctx, { help: EVIDENCE_USAGE });
  if (a === null) return 0;
  const [asked] = a.pos;
  if (asked === undefined) fail(ctx, "socrates-flag-required", "missing <fragment-id>", ID_FIX);
  const parsed = SocratesEvidenceGetRequest.safeParse({ fragment_id: asked });
  // A bare dot segment survives percent-encoding, and fetch resolves it to another route.
  if (!parsed.success || asked === "." || asked === "..") fail(ctx, "socrates-flag-required", `not a fragment id: '${printable(asked)}'`, ID_FIX);
  const leaked = scanStrings(parsed.data);
  if (leaked.length > 0) fail(ctx, "socrates-secret-detected", `a secret was found in <fragment-id> (${leaked.map((h) => h.rule).join(", ")}); nothing was sent`, "pass the fragment's id; this check cannot be overridden");

  const endpoint = await socratesEndpoint(ctx, deps);
  const { fragment_id } = parsed.data;
  const reply = await postSocrates(ctx, deps, endpoint, {
    method: "GET",
    path: SOCRATES_ROUTES.evidence_get.path.replace("{fragment_id}", encodeURIComponent(fragment_id)),
    query: {},
    decoder: SocratesEvidenceGetResponse,
    subject: `the fragment ${printable(fragment_id)}`,
    refusalFix,
    badResponseFix,
  });
  if (reply.fragment_id !== fragment_id) {
    fail(ctx, "socrates-bad-response", `asked for fragment ${printable(fragment_id)} and the endpoint answered with ${printable(reply.fragment_id)}`, "update the server, or check the url points at a Socrates endpoint");
  }

  if (ctx.format === "json") {
    ctx.stdout.write(`${JSON.stringify(reply)}\n`);
    return 0;
  }
  let out = `fragment: ${printable(reply.fragment_id)}\nkind: ${reply.kind}\nprovenance: ${printable(reply.provenance)}\nexpires: ${printable(reply.expires_at)}\n`;
  if (reply.candidate_id !== undefined) out += `candidate: ${printable(reply.candidate_id)}\n`;
  const content = printableMarkdown(reply.content);
  out += `\n${content}${content.endsWith("\n") ? "" : "\n"}`;
  ctx.stdout.write(out);
  return 0;
}
