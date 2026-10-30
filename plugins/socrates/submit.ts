/**
 * submit.ts — `eris socrates submit`, loaded only when `eris socrates`
 * dispatches (the manifest is ./index.ts).
 *
 * Sends one candidate to `<url>/v1/socrates/submit` with the bearer `eris
 * login` wrote, and prints the receipt. The url and token come from the SDK's
 * credential resolvers, the same ones `eris yak` uses.
 *
 * Invariants:
 *   - Nothing leaves the machine before `eris/outbound-scan` has run over every
 *     field: a gitleaks hit refuses the candidate (`socrates-secret-detected`)
 *     and no flag reaches past it; our redaction classes rewrite their matches.
 *     The request body is scanned again, string leaf by string leaf, right
 *     before the fetch.
 *   - A redaction class is let through only by name (`--allow-redaction
 *     <class>`, a member of `REDACTION_CLASSES`) with a reason. An override
 *     that let text through files one `eris yak issue --vendor` before the
 *     POST; the yak names classes, fields and counts, never the text. A yak
 *     that is not delivered is a WARN, as yak failures are everywhere.
 *   - The request body is the contract's parse of the scanned candidate;
 *     nothing else reaches the wire. A candidate that fails it never leaves
 *     the machine.
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
import { isRedactionClass, prepareOutbound, REDACTION_CLASSES, redact, type Override, type RedactionClass, type SecretHit, scanSecrets, scanStrings } from "eris/outbound-scan";
import { CliExit, groupArgs, readArgs, readYaksFileConfig, renderFailureBlock, renderWarnLines, resolveToken, resolveUrl, runErisVerb, type VerbContext } from "../../src/cli/plugin";
import plugin from "./index";
import { SOCRATES_CONTRACT_VERSION, SOCRATES_SUBMIT_PATH, type SocratesProblem, SocratesSubmitRequest, SocratesSubmitResponse } from "./socrates-contract.v1";

/** The `docs/ERRORS.md` slugs this module raises (`tests/errors-doc.test.ts`). */
export type SocratesSlug =
  | "socrates-unknown-verb"
  | "socrates-answers-invalid"
  | "socrates-flag-required"
  | "socrates-candidate-invalid"
  | "socrates-secret-detected"
  | "socrates-override-invalid"
  | "socrates-unreachable"
  | "socrates-not-entitled"
  | "socrates-refused"
  | "socrates-bad-response";

/** WARN lines this module prints; each has a docs/ERRORS.md heading. */
export type SocratesWarnSlug = "socrates-redacted" | "socrates-override-unused" | "socrates-override-unreported";

const REQUEST_TIMEOUT_MS = 30_000;
/** The vendor yak's own POST is bounded at 30s; this covers bun's start on top. */
const YAK_TIMEOUT_MS = 40_000;

export const SOCRATES_USAGE = `Usage: eris socrates <command>

Commands:
  classify  Score one candidate's rubric answers locally and print the verdict
  submit    Submit one candidate (a decision, practice, PRD or conflict) for review

Run 'eris socrates <command> --help' for its flags.
`;

export const SUBMIT_USAGE = `Usage: eris socrates submit --title <text> --statement <text> --source <url> [--kind <kind>] [--project <name>] [--now]
                            [--allow-redaction <class> --override-reason <text>]

Send one candidate to the Socrates endpoint and print its receipt:
'submitted: <id>', or 'already submitted: <id>' when the endpoint already
holds it. --output json prints {candidate_id, deduped, contract_version,
redactions: {count, classes}, overrides: [class]}.

Before anything is sent, every field is scanned. A secret (the gitleaks rules)
refuses the candidate and cannot be overridden. Our redaction classes replace
what they match with «redacted:<class>» and print a WARN.

  --title <text>       required, <= 200 chars
  --statement <text>   required, <= 4000 chars
  --source <url>       required, an absolute http(s) link to where it was decided
  --kind <kind>        decision (default), practice, prd or conflict
  --project <name>     optional project hint, <= 200 chars
  --now                file under today's review Epic straight away (every
                       submit already does; the flag says so explicitly)
  --allow-redaction <class>
                       repeatable: send what this redaction class matched as
                       written. Files one 'eris yak issue --vendor' naming the
                       class (never the text). A later class may still match
                       the same text; allow it too. Classes:
                       ${REDACTION_CLASSES.join(", ")}
  --override-reason <text>
                       required with --allow-redaction: why the match is not a secret

Sign in first with 'eris login'; the url and token are the ones it wrote to
~/.eris/yaks.json (or ERIS_YAKS_URL / ERIS_YAKS_TOKEN).
`;

export interface SocratesDeps {
  home?: string;
  fetch?: typeof fetch;
}

/** Drop control characters, so text a server sent cannot drive the terminal. */
export function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

export function fail(ctx: VerbContext, slug: SocratesSlug | "yak-config-permissive" | "yak-config-malformed" | "yak-token-unresolved", what: string, fix: string): never {
  ctx.stderr.write(renderFailureBlock({ slug, what, fix }, ctx.erisDir));
  throw new CliExit(1);
}

function refusal(ctx: VerbContext, problem: SocratesProblem): never {
  const what = `the endpoint refused the candidate: ${printable(problem.detail)} (${printable(problem.code)}, HTTP ${problem.status})`;
  const subscribe = problem._links?.subscribe?.href;
  if (subscribe !== undefined) fail(ctx, "socrates-not-entitled", what, `subscribe: ${printable(subscribe)}`);
  fail(ctx, "socrates-refused", what, problem.status === 401 ? "run 'eris login' to sign this machine in again" : "check the candidate, then run the command again");
}

function secretFound(ctx: VerbContext, hits: readonly SecretHit[]): never {
  const where = hits.map((h) => `${h.field} (${h.rule})`).join(", ");
  fail(ctx, "socrates-secret-detected", `a secret was found in ${where}; nothing was sent`, "remove the secret from the field and run the command again; this check cannot be overridden");
}

/** The vendor yak's text: deterministic for the same override, so a retried submit dedupes onto the same yak. */
function overrideYak(overrides: readonly Override[], reason: string): { summary: string; body: string } {
  const classes = [...new Set(overrides.map((o) => o.class))].sort();
  const lines = [...overrides].sort((a, b) => a.class.localeCompare(b.class) || a.field.localeCompare(b.field)).map((o) => `- ${o.class} in ${o.field} (${o.count})`);
  return {
    summary: `eris socrates submit: redaction override (${classes.join(", ")})`,
    body: [
      "A caller let text through eris's redaction on an outbound Socrates candidate.",
      "",
      "Overridden:",
      ...lines,
      "",
      `Reason: ${redact(reason).text}`,
      "",
      "The overridden text is not included. If the class matched text that is not a secret, its pattern needs narrowing.",
    ].join("\n"),
  };
}

async function fileOverrideYak(ctx: VerbContext, overrides: readonly Override[], reason: string): Promise<void> {
  const { summary, body } = overrideYak(overrides, reason);
  const r = await runErisVerb(["--output", "json", "yak", "issue", "--vendor", "--summary", summary, "--body", body], { env: ctx.env, timeoutMs: YAK_TIMEOUT_MS });
  let why = `the yak run ended ${r.kind}`;
  try {
    const record = JSON.parse(r.stdout.toString("utf8")) as { delivered?: boolean; error?: { slug?: string; reason?: string } };
    if (record.delivered === true) return;
    if (record.error?.slug !== undefined) why = `${printable(record.error.slug)}: ${printable(record.error.reason ?? "")}`;
  } catch {
    // not a yak record: `why` already names how the run ended
  }
  const slug: SocratesWarnSlug = "socrates-override-unreported";
  ctx.stderr.write(renderWarnLines(`the redaction override was not reported to the eris vendor tracker (${why}); the candidate is sent anyway`, slug));
}

export async function runSocrates(args: string[], ctx: VerbContext, deps: SocratesDeps = {}): Promise<number> {
  const g = groupArgs(plugin.rows, "socrates", args);
  if (g.kind === "bare" || g.kind === "help") {
    ctx.stdout.write(SOCRATES_USAGE);
    return 0;
  }
  if (g.kind === "unknown") fail(ctx, "socrates-unknown-verb", `unknown socrates command '${g.sub}'`, "use: classify, submit\nrun 'eris socrates --help' for the command list");
  if (g.sub === "classify") return (await import("./classify")).runClassify(g.rest, ctx);

  const a = readArgs(plugin.rows, "socrates submit", g.rest, ctx, { help: SUBMIT_USAGE });
  if (a === null) return 0;
  const { "--title": title, "--statement": statement, "--source": source, "--kind": kind, "--project": project, "--now": now, "--allow-redaction": allowArgs, "--override-reason": reason } = a.flags;
  const missing = (["--title", "--statement", "--source"] as const).filter((f) => a.flags[f] === undefined);
  if (missing.length > 0) fail(ctx, "socrates-flag-required", `missing ${missing.join(", ")}`, "eris socrates submit --title <text> --statement <text> --source <url>");
  if (allowArgs.length > 0 && reason === undefined) fail(ctx, "socrates-flag-required", "--allow-redaction needs --override-reason", "add --override-reason <why the match is not a secret>");
  if (allowArgs.length === 0 && reason !== undefined) fail(ctx, "socrates-flag-required", "--override-reason is only read with --allow-redaction", "add --allow-redaction <class>, or drop --override-reason");
  const unknown = allowArgs.filter((c) => !isRedactionClass(c));
  if (unknown.length > 0) fail(ctx, "socrates-override-invalid", `not a redaction class: ${unknown.map(printable).join(", ")}`, `use one of: ${REDACTION_CLASSES.join(", ")}`);
  const allow = new Set(allowArgs as RedactionClass[]);

  // The reason travels in the vendor yak, so it is scanned like a field.
  const reasonHits = reason === undefined ? [] : scanSecrets({ "--override-reason": reason });
  if (reasonHits.length > 0) secretFound(ctx, reasonHits);
  const outbound = prepareOutbound({ title, statement, source, project }, allow);
  if (outbound.kind === "secret") secretFound(ctx, outbound.hits);
  const clean = outbound.fields;

  const parsed = SocratesSubmitRequest.safeParse({
    schema_version: SOCRATES_CONTRACT_VERSION,
    candidate: { kind: kind ?? "decision", title: clean.title, statement: clean.statement, source: clean.source, ...(clean.project !== undefined ? { project: clean.project } : {}) },
    ...(now ? { now: true } : {}),
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.slice(1).join(".") || "candidate"}: ${i.message}`).join("; ");
    fail(ctx, "socrates-candidate-invalid", `the candidate does not match the contract (${issues})`, "run 'eris socrates submit --help' for each flag's bounds");
  }
  const leaked = scanStrings(parsed.data);
  if (leaked.length > 0) secretFound(ctx, leaked);

  if (outbound.redactions.count > 0) {
    const slug: SocratesWarnSlug = "socrates-redacted";
    ctx.stderr.write(renderWarnLines(`${outbound.redactions.count} redacted before sending: ${outbound.redactions.classes.join(", ")}`, slug));
  }
  const overridden = new Set(outbound.overrides.map((o) => o.class));
  const unused = [...allow].filter((c) => !overridden.has(c));
  if (unused.length > 0) {
    const slug: SocratesWarnSlug = "socrates-override-unused";
    ctx.stderr.write(renderWarnLines(`--allow-redaction ${unused.join(", ")} matched nothing; no override was reported`, slug));
  }

  const home = deps.home ?? ctx.env.HOME ?? homedir();
  const file = await readYaksFileConfig(home);
  if ("reason" in file) fail(ctx, file.slug, file.reason, "fix or remove the file, then run 'eris login'");
  const token = resolveToken(file.value, ctx.env);
  if ("reason" in token) fail(ctx, token.slug, token.reason, "run 'eris login'");
  const url = `${resolveUrl(file.value, ctx.env).value.replace(/\/+$/, "")}${SOCRATES_SUBMIT_PATH}`;

  if (outbound.overrides.length > 0) await fileOverrideYak(ctx, outbound.overrides, reason ?? "");

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
    const record = {
      candidate_id: reply.candidate_id,
      deduped: reply.deduped,
      contract_version: reply.contract_version,
      redactions: outbound.redactions,
      overrides: [...overridden].sort(),
    };
    ctx.stdout.write(`${JSON.stringify(record)}\n`);
  } else {
    ctx.stdout.write(`${reply.deduped ? "already submitted" : "submitted"}: ${printable(reply.candidate_id)}\n`);
  }
  return 0;
}
