/**
 * resolve.ts — `eris socrates resolve <epic>`, loaded only when `eris socrates
 * resolve` dispatches (./submit.ts routes the group).
 *
 * Asks the endpoint to resolve one closed review Epic and prints its receipt:
 * what was applied, what was carried over and to which Epic. The server does
 * every Linear read and write; this verb names the Epic and, with --amend, the
 * edits to make to Done children before they are written.
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
 *   - An amendment is never assumed applied: a resolved receipt that does not
 *     name every amended child fails (`socrates-amend-ignored`), since a server
 *     without amendments resolves the Epic with the filed text instead.
 */

import { scanStrings } from "eris/outbound-scan";
import { readArgs, type VerbContext } from "../../src/cli/plugin";
import { fail, postSocrates, printable, type SocratesDeps, socratesEndpoint } from "./client";
import plugin from "./index";
import { SOCRATES_CONTRACT_VERSION } from "./socrates-contract.v1";
import {
  SOCRATES_AMEND_TARGETS,
  SOCRATES_ROUTES,
  SocratesAmendmentFields,
  SocratesResolveRequest,
  SocratesResolveResponse,
  type SocratesResolveAmendment,
} from "./socrates-contract.v1.verbs";

export const RESOLVE_USAGE = `Usage: eris socrates resolve <epic> [--amend <child>=<path>]...

Resolve one closed review Epic on the Socrates endpoint and print what it did:
'resolved <epic>: <n> applied, <m> carried over to <carry-over epic>', then
the applied, amended and carried-over entries. Resolving the same Epic again
changes nothing and prints the same receipt. --output json prints {epic,
outcome, applied, carried_over, carry_over_epic?, amended?, reporting,
contract_version}.

  <epic>                  the review Epic's identifier, as its path comment
                          prints it
  --amend <child>=<path>  repeatable: before resolve writes the Done child
                          <child> (its identifier, as the Epic lists it),
                          apply the edit in the JSON file <path>:
                            {"title"?: <text>, "statement"?: <text>,
                             "target"?: ${SOCRATES_AMEND_TARGETS.join(" | ")},
                             "source_comment"?: <comment id>}
                          at least one of title, statement or target. target
                          reroutes the entry to Load-Bearing Decisions, Key
                          Assumptions or Practices. Only a decision a person
                          marked Done can be amended; the endpoint refuses
                          every other child before writing anything.

The endpoint applies the Done entries to the living docs, records the
Canceled ones as rejected and moves every open entry to a new carry-over
Epic. It refuses an Epic that is still open.

Sign in first with 'eris login'.
`;

const refusalFix = (status: number): string | undefined => {
  if (status === 404) return "check the Epic's identifier: the Epic's Socrates comment prints the command to run";
  if (status === 422) return "fix or drop the --amend the message names, then run the command again";
  if (status === 409) return "follow the step named above (resolve also needs the review Epic closed in Linear), then run the command again";
  return undefined;
};

const badResponseFix = (status: number): string | undefined =>
  status === 404 ? `this endpoint does not serve ${SOCRATES_ROUTES.resolve.path}: update the server, or check the url points at a Socrates endpoint` : undefined;

const list = (ids: readonly string[]): string => ids.map(printable).join(", ");

const AMEND_FIX = "pass --amend <child>=<path>, the file a JSON object with at least one of title, statement or target: run 'eris socrates resolve --help'";

/** Each `--amend <child>=<path>`: the child, and the edit its JSON file holds. */
async function readAmendments(ctx: VerbContext, deps: SocratesDeps, args: readonly string[]): Promise<SocratesResolveAmendment[]> {
  const amendments: SocratesResolveAmendment[] = [];
  for (const arg of args) {
    const at = arg.indexOf("=");
    const child = at < 0 ? "" : arg.slice(0, at).trim();
    const path = at < 0 ? "" : arg.slice(at + 1).trim();
    if (child === "" || path === "") fail(ctx, "socrates-amend-invalid", `--amend '${printable(arg)}' is not <child>=<path>`, AMEND_FIX);
    if (amendments.some((a) => a.child === child)) fail(ctx, "socrates-amend-invalid", `${printable(child)} is amended twice`, "merge the edits into one file per child");
    let text = "";
    try {
      text = await (deps.readFile ?? ((p) => Bun.file(p).text()))(path);
    } catch (err) {
      fail(ctx, "socrates-amend-invalid", `cannot read ${printable(path)}: ${printable((err as Error).message)}`, AMEND_FIX);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      fail(ctx, "socrates-amend-invalid", `${printable(path)} is not JSON`, AMEND_FIX);
    }
    const fields = SocratesAmendmentFields.strict().safeParse(raw);
    if (!fields.success) {
      const why = fields.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; ");
      fail(ctx, "socrates-amend-invalid", `${printable(path)} is not an amendment (${printable(why)})`, AMEND_FIX);
    }
    amendments.push({ child, ...fields.data });
  }
  return amendments;
}

export async function runResolve(args: string[], ctx: VerbContext, deps: SocratesDeps = {}): Promise<number> {
  const a = readArgs(plugin.rows, "socrates resolve", args, ctx, { help: RESOLVE_USAGE });
  if (a === null) return 0;
  const [epic] = a.pos;
  if (epic === undefined) fail(ctx, "socrates-flag-required", "missing <epic>", "eris socrates resolve <epic>: the closed Epic's Socrates comment prints the exact command");
  if (SocratesResolveRequest.shape.epic.safeParse(epic).success === false) {
    fail(ctx, "socrates-flag-required", `not an Epic identifier: '${printable(epic)}'`, "eris socrates resolve <epic>: the closed Epic's Socrates comment prints the exact command");
  }

  const amendments = await readAmendments(ctx, deps, a.flags["--amend"] ?? []);
  const parsed = SocratesResolveRequest.safeParse({
    schema_version: SOCRATES_CONTRACT_VERSION,
    epic,
    ...(amendments.length === 0 ? {} : { amendments }),
  });
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    fail(ctx, "socrates-amend-invalid", `the amendments do not fit the contract (${printable(why)})`, AMEND_FIX);
  }

  const leaked = scanStrings(parsed.data);
  if (leaked.length > 0) fail(ctx, "socrates-secret-detected", `a secret was found in the resolve request (${leaked.map((h) => h.rule).join(", ")}); nothing was sent`, "remove it from <epic> or the --amend files; this check cannot be overridden");

  const endpoint = await socratesEndpoint(ctx, deps);
  const receipt = await postSocrates(ctx, deps, endpoint, {
    path: SOCRATES_ROUTES.resolve.path,
    body: parsed.data,
    decoder: SocratesResolveResponse,
    subject: `the resolve of ${printable(epic)}`,
    refusalFix,
    badResponseFix,
  });

  // A server that predates amendments ignores the field and writes the filed text: fail rather
  // than report an edit that never landed. A child named by its uuid is counted, not matched.
  if (amendments.length > 0 && receipt.outcome === "resolved") {
    const named = receipt.amended ?? [];
    const missing = amendments.filter((am) => !named.includes(am.child)).map((am) => am.child);
    if (missing.length > 0 && named.length < amendments.length) {
      fail(ctx, "socrates-amend-ignored", `the endpoint resolved ${printable(receipt.epic)} without applying the amendment to ${list(missing)}`, "an endpoint that predates amendments ignores them (update the server); otherwise the entry's sub-issue names why its write was refused. The Epic is resolved, so fix the entries in the living doc by hand");
    }
  }

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
  if (receipt.amended !== undefined && receipt.amended.length > 0) out += `  amended: ${list(receipt.amended)}\n`;
  if (receipt.carried_over.length > 0) out += `  carried over: ${list(receipt.carried_over)}\n`;
  ctx.stdout.write(out);
  return 0;
}
