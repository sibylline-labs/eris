/**
 * submit.ts — `eris socrates submit`, loaded only when `eris socrates`
 * dispatches (the manifest is ./index.ts).
 *
 * Sends one candidate to `<url>/v1/socrates/submit` with the bearer `eris
 * login` wrote, and prints the receipt. The url and token come from the SDK's
 * credential resolvers, the same ones `eris yak` uses.
 *
 * Invariants:
 *   - The request body is the contract's parse of the candidate; nothing else
 *     reaches the wire. A candidate that fails it never leaves the machine.
 *   - A response body is read only through `SocratesSubmitResponse`: a receipt
 *     prints, a problem+json error becomes a failure block, and anything else
 *     is `socrates-bad-response`. No untyped JSON reaches the output.
 *   - One request, no retry. The deadline covers the whole exchange, headers
 *     and body.
 *   - A failure is a slugged block on stderr and exit 1, with nothing on
 *     stdout. A 402's subscribe link is the block's `fix:` line.
 *   - Text a server sent is shown only after control characters are stripped.
 */

import { homedir } from "node:os";
import { CliExit, groupArgs, readArgs, readYaksFileConfig, renderFailureBlock, resolveToken, resolveUrl, type VerbContext } from "../../src/cli/plugin";
import plugin from "./index";
import { SOCRATES_CONTRACT_VERSION, SOCRATES_SUBMIT_PATH, type SocratesProblem, SocratesSubmitRequest, SocratesSubmitResponse } from "./socrates-contract.v1";

/** The `docs/ERRORS.md` slugs this module raises (`tests/errors-doc.test.ts`). */
export type SocratesSlug =
  | "socrates-unknown-verb"
  | "socrates-flag-required"
  | "socrates-candidate-invalid"
  | "socrates-unreachable"
  | "socrates-not-entitled"
  | "socrates-refused"
  | "socrates-bad-response";

const REQUEST_TIMEOUT_MS = 30_000;

export const SOCRATES_USAGE = `Usage: eris socrates <command>

Commands:
  submit    Submit one candidate (a decision, practice, PRD or conflict) for review

Run 'eris socrates submit --help' for its flags.
`;

export const SUBMIT_USAGE = `Usage: eris socrates submit --title <text> --statement <text> --source <url> [--kind <kind>] [--project <name>]

Send one candidate to the Socrates endpoint and print its receipt:
'submitted: <id>', or 'already submitted: <id>' when the endpoint already
holds it. --output json prints {candidate_id, deduped, contract_version}.

  --title <text>       required, <= 200 chars
  --statement <text>   required, <= 4000 chars
  --source <url>       required, an absolute http(s) link to where it was decided
  --kind <kind>        decision (default), practice, prd or conflict
  --project <name>     optional project hint, <= 200 chars

Sign in first with 'eris login'; the url and token are the ones it wrote to
~/.eris/yaks.json (or ERIS_YAKS_URL / ERIS_YAKS_TOKEN).
`;

export interface SocratesDeps {
  home?: string;
  fetch?: typeof fetch;
}

/** Drop control characters, so text a server sent cannot drive the terminal. */
function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function fail(ctx: VerbContext, slug: SocratesSlug | "yak-config-permissive" | "yak-config-malformed" | "yak-token-unresolved", what: string, fix: string): never {
  ctx.stderr.write(renderFailureBlock({ slug, what, fix }, ctx.erisDir));
  throw new CliExit(1);
}

function refusal(ctx: VerbContext, problem: SocratesProblem): never {
  const what = `the endpoint refused the candidate: ${printable(problem.detail)} (${printable(problem.code)}, HTTP ${problem.status})`;
  const subscribe = problem._links?.subscribe?.href;
  if (subscribe !== undefined) fail(ctx, "socrates-not-entitled", what, `subscribe: ${printable(subscribe)}`);
  fail(ctx, "socrates-refused", what, problem.status === 401 ? "run 'eris login' to sign this machine in again" : "check the candidate, then run the command again");
}

export async function runSocrates(args: string[], ctx: VerbContext, deps: SocratesDeps = {}): Promise<number> {
  const g = groupArgs(plugin.rows, "socrates", args);
  if (g.kind === "bare" || g.kind === "help") {
    ctx.stdout.write(SOCRATES_USAGE);
    return 0;
  }
  if (g.kind === "unknown") fail(ctx, "socrates-unknown-verb", `unknown socrates command '${g.sub}'`, "use: submit\nrun 'eris socrates --help' for the command list");

  const a = readArgs(plugin.rows, "socrates submit", g.rest, ctx, { help: SUBMIT_USAGE });
  if (a === null) return 0;
  const { "--title": title, "--statement": statement, "--source": source, "--kind": kind, "--project": project } = a.flags;
  const missing = (["--title", "--statement", "--source"] as const).filter((f) => a.flags[f] === undefined);
  if (missing.length > 0) fail(ctx, "socrates-flag-required", `missing ${missing.join(", ")}`, "eris socrates submit --title <text> --statement <text> --source <url>");

  const parsed = SocratesSubmitRequest.safeParse({
    schema_version: SOCRATES_CONTRACT_VERSION,
    candidate: { kind: kind ?? "decision", title, statement, source, ...(project !== undefined ? { project } : {}) },
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.slice(1).join(".") || "candidate"}: ${i.message}`).join("; ");
    fail(ctx, "socrates-candidate-invalid", `the candidate does not match the contract (${issues})`, "run 'eris socrates submit --help' for each flag's bounds");
  }

  const home = deps.home ?? ctx.env.HOME ?? homedir();
  const file = await readYaksFileConfig(home);
  if ("reason" in file) fail(ctx, file.slug, file.reason, "fix or remove the file, then run 'eris login'");
  const token = resolveToken(file.value, ctx.env);
  if ("reason" in token) fail(ctx, token.slug, token.reason, "run 'eris login'");
  const url = `${resolveUrl(file.value, ctx.env).value.replace(/\/+$/, "")}${SOCRATES_SUBMIT_PATH}`;

  let status: number;
  let body: unknown;
  try {
    const res = await (deps.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, application/problem+json", authorization: `Bearer ${token.value}` },
      body: JSON.stringify(parsed.data),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    status = res.status;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  } catch (err) {
    const name = (err as { name?: string }).name;
    const why = name === "TimeoutError" || name === "AbortError" ? `no answer within ${REQUEST_TIMEOUT_MS / 1000}s` : printable((err as Error).message);
    fail(ctx, "socrates-unreachable", `cannot reach ${url}: ${why}`, "check the url and your connection, then run the command again");
  }

  const decoded = SocratesSubmitResponse.safeParse(body);
  if (!decoded.success) fail(ctx, "socrates-bad-response", `${url} answered HTTP ${status} with a body that is neither a receipt nor a problem+json error`, "check the url points at a Socrates endpoint");
  const reply = decoded.data;
  if ("type" in reply) refusal(ctx, reply);
  if (status < 200 || status > 299) fail(ctx, "socrates-bad-response", `${url} answered HTTP ${status} with a receipt`, "check the url points at a Socrates endpoint");

  if (ctx.format === "json") {
    ctx.stdout.write(`${JSON.stringify({ candidate_id: reply.candidate_id, deduped: reply.deduped, contract_version: reply.contract_version })}\n`);
  } else {
    ctx.stdout.write(`${reply.deduped ? "already submitted" : "submitted"}: ${printable(reply.candidate_id)}\n`);
  }
  return 0;
}
