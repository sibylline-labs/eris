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
 *   - A response body is read only through `SocratesSubmitResponse`, by
 *     ./client.ts, which owns the exchange's own invariants.
 *   - A `prd` or `conflict` candidate is sent only when socrates-core's
 *     `issueEntryOf` files its (redacted) statement; the server runs the same
 *     check before it files the issue.
 */

import { isRedactionClass, prepareOutbound, REDACTION_CLASSES, redact, type Override, type RedactionClass, type SecretHit, scanSecrets, scanStrings } from "eris/outbound-scan";
import { issueEntryOf } from "eris/socrates-core";
import { groupArgs, readArgs, renderWarnLines, runErisVerb, type VerbContext } from "../../src/cli/plugin";
import { fail, postSocrates, printable, type SocratesDeps, socratesEndpoint } from "./client";
import plugin from "./index";
import { SOCRATES_CONTRACT_VERSION, SOCRATES_SUBMIT_PATH, SocratesSubmitRequest, SocratesSubmitResponse } from "./socrates-contract.v1";

export { type SocratesDeps } from "./client";

/** WARN lines this module prints; each has a docs/ERRORS.md heading. */
export type SocratesWarnSlug = "socrates-redacted" | "socrates-override-unused" | "socrates-override-unreported";

/** The vendor yak's own POST is bounded at 30s; this covers bun's start on top. */
const YAK_TIMEOUT_MS = 40_000;

export const SOCRATES_USAGE = `Usage: eris socrates <command>

Commands:
  classify  Score one candidate's rubric answers locally and print the verdict
  discover  List the commits in this repo since the processed-source cursor
  resolve   Resolve a closed review Epic on the server and print what it did
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
  --kind <kind>        decision (default), practice, prd or conflict; a prd or
                       conflict statement follows the grammar in
                       'eris socrates classify --help' and files as one issue
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
  if (g.kind === "unknown") fail(ctx, "socrates-unknown-verb", `unknown socrates command '${g.sub}'`, "use: classify, discover, resolve, submit\nrun 'eris socrates --help' for the command list");
  if (g.sub === "classify") return (await import("./classify")).runClassify(g.rest, ctx);
  if (g.sub === "resolve") return (await import("./resolve")).runResolve(g.rest, ctx, deps);
  if (g.sub === "discover") return (await import("./discover")).runDiscover(g.rest, ctx, deps);

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
  const { candidate } = parsed.data;
  if (candidate.kind === "prd" || candidate.kind === "conflict") {
    const entry = issueEntryOf({ ...candidate, kind: candidate.kind });
    if (!entry.ok) fail(ctx, "socrates-candidate-invalid", `the ${candidate.kind} statement cannot be filed (${printable(entry.reason)})`, "run 'eris socrates classify --help' for the statement grammar");
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

  const endpoint = await socratesEndpoint(ctx, deps);
  if (outbound.overrides.length > 0) await fileOverrideYak(ctx, outbound.overrides, reason ?? "");

  const reply = await postSocrates(ctx, deps, endpoint, { path: SOCRATES_SUBMIT_PATH, body: parsed.data, decoder: SocratesSubmitResponse, subject: "the candidate" });

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
