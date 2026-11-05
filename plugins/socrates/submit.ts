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
 *     check before it files the issue. It is never scored, so it takes no
 *     `--answer`, `--override` or `--unfit`.
 *   - With `--answer`, the body carries the classification stamp: the inputs
 *     eris scored (answers, overrides, the repo's `eris.yaml` layer) and the
 *     org policy hash it scored against, never a verdict. The answers and
 *     overrides are checked as `classify` checks them, and a repo layer looser
 *     than the org policy is refused, before anything is sent. The policy is
 *     fetched (one GET) first when none is cached or it is over an hour old.
 *     A `prd` or `conflict` takes no stamp: its body and exchange carry none.
 *   - A receipt that says the server reclassified the stamp prints a WARN and
 *     refreshes the cached policy, so the next stamp carries the current hash.
 *   - A decision or practice is stamped: it carries `--answer` or `--unfit`, and
 *     a submit with neither is refused (`socrates-stamp-required`) with nothing
 *     sent. A policy hash older than an hour is fetched again before it is
 *     stamped (`readFreshPolicy`).
 *   - With `--unfit`, the body carries the unfit stamp instead: the rubric
 *     version and fresh org policy hash, the hypothesis and up to five evidence
 *     entries, never answers. The hypothesis and every evidence entry go
 *     through `prepareOutbound` with the other fields, and the stamp does not
 *     read the repo's `eris.yaml`. A receipt without the `unfit` echo means the
 *     server did not read the field: that is a failure, never a success.
 */

import { isRedactionClass, prepareOutbound, REDACTION_CLASSES, redact, type Override, type RedactionClass, type SecretHit, scanSecrets, scanStrings } from "eris/outbound-scan";
import { CURRENT_RUBRIC, extractFeatures, issueEntryOf } from "eris/socrates-core";
import { groupArgs, readArgs, renderWarnLines, runErisVerb, type VerbContext } from "../../src/cli/plugin";
import { ANSWER_FIX, answersOf, issues, OVERRIDE_FIX, overridesOf, pairs } from "./answers";
import { fail, postSocrates, printable, type SocratesDeps, type SocratesEndpoint, socratesEndpoint } from "./client";
import plugin from "./index";
import { localPolicy, readFreshPolicy, readRepoPolicy, refreshPolicyAfterSubmit } from "./policy";
import { SOCRATES_CONTRACT_VERSION, SOCRATES_SUBMIT_PATH, type SocratesClassificationStamp, SocratesSubmitRequest, SocratesSubmitResponse, SocratesUnfit } from "./socrates-contract.v1";
import { readEvidenceFile } from "./unfit";

export { type SocratesDeps } from "./client";

/** WARN lines this module prints; each has a docs/ERRORS.md heading. */
export type SocratesWarnSlug = "socrates-redacted" | "socrates-override-unused" | "socrates-override-unreported" | "socrates-reclassified";

/** The vendor yak's own POST is bounded at 30s; this covers bun's start on top. */
const YAK_TIMEOUT_MS = 40_000;

export const SOCRATES_USAGE = `Usage: eris socrates <command>

Commands:
  classify  Score one candidate's rubric answers locally and print the verdict
  consult   Print a living doc, or a brief of several, from the Socrates endpoint
  discover  List the commits in this repo since the processed-source cursor
  policy    Print the org's scoring policy, and refresh the cached copy
  resolve   Resolve a closed review Epic on the server and print what it did
  settings  Change where this org's Socrates reviews file (team)
  status    Print the pending count, the open review Epics and one candidate's state
  submit    Submit one candidate (a decision, practice, PRD or conflict) for review

Run 'eris socrates <command> --help' for its flags.
`;

export const SUBMIT_USAGE = `Usage: eris socrates submit --title <text> --statement <text> --source <url> [--kind <kind>] [--project <name>] [--now]
                            (--answer <question>=<answer>... [--override <gate>=<reason>]...
                             | --unfit --hypothesis <text> [--evidence-file <path|->])
                            [--allow-redaction <class> --override-reason <text>]

Send one candidate to the Socrates endpoint and print its receipt:
'submitted: <id>', or 'already submitted: <id>' when the endpoint already
holds it, then '  verdict: <verdict> (<rubric>, policy <hash>)' when the
candidate was stamped with answers, or '  filed for an answer: needs-input'
when it was sent as unfit. --output json prints {candidate_id, deduped,
contract_version, classification?, unfit?: {state}, redactions: {count,
classes}, overrides: [class]}.

A decision or practice carries one stamp, --answer or --unfit, and is refused
with neither. A prd or conflict takes neither.

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
  --answer <question>=<answer>
                       repeatable, a decision or practice only: stamp the
                       submit with the rubric answers, as 'eris socrates
                       classify' takes them. The stamp carries the org policy
                       hash from ~/.eris/socrates-policy.json (fetched first
                       when absent or over an hour old) and the eris.yaml
                       socrates.policy layer; the server scores it under the
                       org's current policy and a WARN says when that
                       reclassified it
  --override <gate>=<reason>
                       repeatable, with --answer: bypass this rejecting gate,
                       with a one-line reason (<= 200 chars)
  --unfit              a decision or practice only, instead of --answer: the
                       rubric's answers cannot express it, so send it as a
                       hypothesis plus evidence. It is not scored; the endpoint
                       files it for a person to answer. Carries the rubric
                       version and the org policy hash from
                       ~/.eris/socrates-policy.json (fetched first when absent
                       or over an hour old); the eris.yaml layer is not read
  --hypothesis <text>  required with --unfit: what you think it is, <= 1000 chars
  --evidence-file <path|->
                       with --unfit: a JSON array of at most 5 {kind,
                       provenance, content} entries. kind is code, doc or
                       session_utterance; provenance an http(s) URL or
                       repo@sha:path#L<n>; content <= 20000 chars. '-' reads
                       stdin. Each entry is stored as an evidence fragment;
                       only its provenance reaches the review issue
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

/** A 409 from submit is the unenrolled refusal, and its detail names the step to take. */
const refusalFix = (status: number): string | undefined => (status === 409 ? "follow the step named above, then run the command again" : undefined);

/** The two ways to stamp a decision or practice; `tests/socrates-unfit.test.ts` runs each form it names through the parser. */
const STAMP_FIX = "stamp it with the rubric's answers, --answer <question>=<answer>... (run 'eris socrates classify --help' for the questions), or, when the answers cannot express it, send it as unfit: --unfit --hypothesis <text> [--evidence-file <path|->]";
const UNFIT_FIX = "run 'eris socrates submit --help' for the bounds of --hypothesis and --evidence-file";

export async function runSocrates(args: string[], ctx: VerbContext, deps: SocratesDeps = {}): Promise<number> {
  const g = groupArgs(plugin.rows, "socrates", args);
  if (g.kind === "bare" || g.kind === "help") {
    ctx.stdout.write(SOCRATES_USAGE);
    return 0;
  }
  if (g.kind === "unknown") fail(ctx, "socrates-unknown-verb", `unknown socrates command '${g.sub}'`, "use: classify, consult, discover, policy, resolve, settings, status, submit\nrun 'eris socrates --help' for the command list");
  if (g.sub === "classify") return (await import("./classify")).runClassify(g.rest, ctx, deps);
  if (g.sub === "consult") return (await import("./consult")).runConsult(g.rest, ctx, deps);
  if (g.sub === "resolve") return (await import("./resolve")).runResolve(g.rest, ctx, deps);
  if (g.sub === "discover") return (await import("./discover")).runDiscover(g.rest, ctx, deps);
  if (g.sub === "settings") return (await import("./settings")).runSettings(g.rest, ctx, deps);
  if (g.sub === "status") return (await import("./status")).runStatus(g.rest, ctx, deps);
  if (g.sub === "policy") return (await import("./policy-verb")).runPolicy(g.rest, ctx, deps);

  const a = readArgs(plugin.rows, "socrates submit", g.rest, ctx, { help: SUBMIT_USAGE });
  if (a === null) return 0;
  const { "--title": title, "--statement": statement, "--source": source, "--kind": kind, "--project": project, "--now": now, "--allow-redaction": allowArgs, "--override-reason": reason, "--answer": answerArgs, "--override": overrideArgs, "--unfit": asUnfit, "--hypothesis": hypothesis, "--evidence-file": evidenceFile } = a.flags;
  const missing = (["--title", "--statement", "--source"] as const).filter((f) => a.flags[f] === undefined);
  if (missing.length > 0) fail(ctx, "socrates-flag-required", `missing ${missing.join(", ")}`, "eris socrates submit --title <text> --statement <text> --source <url>");
  if (allowArgs.length > 0 && reason === undefined) fail(ctx, "socrates-flag-required", "--allow-redaction needs --override-reason", "add --override-reason <why the match is not a secret>");
  if (allowArgs.length === 0 && reason !== undefined) fail(ctx, "socrates-flag-required", "--override-reason is only read with --allow-redaction", "add --allow-redaction <class>, or drop --override-reason");
  const unknown = allowArgs.filter((c) => !isRedactionClass(c));
  if (unknown.length > 0) fail(ctx, "socrates-override-invalid", `not a redaction class: ${unknown.map(printable).join(", ")}`, `use one of: ${REDACTION_CLASSES.join(", ")}`);
  const allow = new Set(allowArgs as RedactionClass[]);
  if (kind === "prd" || kind === "conflict") {
    if (answerArgs.length > 0) fail(ctx, "socrates-answers-invalid", `a ${kind} entry is not scored, so it takes no rubric answers`, "drop --answer");
    if (overrideArgs.length > 0) fail(ctx, "socrates-override-invalid", `a ${kind} entry has no gate to override`, "drop --override");
    if (asUnfit) fail(ctx, "socrates-unfit-invalid", `a ${kind} entry is not scored, so it is never unfit`, "drop --unfit");
  }
  if (asUnfit) {
    if (answerArgs.length > 0 || overrideArgs.length > 0) fail(ctx, "socrates-unfit-invalid", "--unfit sends no rubric answers, so it cannot be given with --answer or --override", "drop --unfit, or drop --answer and --override");
    if (hypothesis === undefined) fail(ctx, "socrates-flag-required", "--unfit needs --hypothesis", "add --hypothesis <what you think it is>");
  } else {
    if (hypothesis !== undefined) fail(ctx, "socrates-flag-required", "--hypothesis is only read with --unfit", "add --unfit, or drop --hypothesis");
    if (evidenceFile !== undefined) fail(ctx, "socrates-flag-required", "--evidence-file is only read with --unfit", "add --unfit --hypothesis <text>, or drop --evidence-file");
  }
  if (answerArgs.length === 0 && overrideArgs.length > 0) fail(ctx, "socrates-flag-required", "--override is only read with --answer", "add the rubric answers with --answer <question>=<answer>..., or drop --override");
  const answerPairs = pairs(ctx, "--answer", answerArgs, "socrates-answers-invalid", ANSWER_FIX);
  const overridePairs = Object.entries(pairs(ctx, "--override", overrideArgs, "socrates-override-invalid", OVERRIDE_FIX)).map(([gate, reason]) => ({ gate, reason }));
  const entries = asUnfit && evidenceFile !== undefined ? await readEvidenceFile(ctx, deps, evidenceFile) : [];

  // The reason travels in the vendor yak, so it is scanned like a field.
  const reasonHits = reason === undefined ? [] : scanSecrets({ "--override-reason": reason });
  if (reasonHits.length > 0) secretFound(ctx, reasonHits);
  // The unfit stamp's text is scanned and redacted with the candidate's: a field the stamp adds is not exempt.
  const unfitText: Record<string, string> = asUnfit ? { hypothesis: hypothesis ?? "", ...Object.fromEntries(entries.flatMap((e, i) => [[`evidence.${i}`, e.content], [`evidence.${i}.provenance`, e.provenance]])) } : {};
  const fields: Record<string, string | undefined> = { title, statement, source, project, ...unfitText };
  const outbound = prepareOutbound(fields, allow);
  if (outbound.kind === "secret") secretFound(ctx, outbound.hits);
  const clean = outbound.fields;

  const parsed = SocratesSubmitRequest.safeParse({
    schema_version: SOCRATES_CONTRACT_VERSION,
    candidate: { kind: kind ?? "decision", title: clean.title, statement: clean.statement, source: clean.source, ...(clean.project !== undefined ? { project: clean.project } : {}) },
    ...(now ? { now: true } : {}),
  });
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.slice(1).join(".") || "candidate"}: ${i.message}`).join("; ");
    fail(ctx, "socrates-candidate-invalid", `the candidate does not match the contract (${problems})`, "run 'eris socrates submit --help' for each flag's bounds");
  }
  const { candidate } = parsed.data;
  if (candidate.kind === "prd" || candidate.kind === "conflict") {
    const entry = issueEntryOf({ ...candidate, kind: candidate.kind });
    if (!entry.ok) fail(ctx, "socrates-candidate-invalid", `the ${candidate.kind} statement cannot be filed (${printable(entry.reason)})`, "run 'eris socrates classify --help' for the statement grammar");
  }
  if (answerArgs.length === 0 && !asUnfit && (candidate.kind === "decision" || candidate.kind === "practice")) {
    fail(ctx, "socrates-stamp-required", `a ${candidate.kind} carries --answer or --unfit, and this one carries neither; nothing was sent`, STAMP_FIX);
  }
  let body = parsed.data;
  let endpoint: SocratesEndpoint | undefined;
  if (answerArgs.length > 0) {
    endpoint = await socratesEndpoint(ctx, deps);
    const classification = await stamp(ctx, deps, endpoint, candidate.statement, answerPairs, overridePairs);
    const stamped = SocratesSubmitRequest.safeParse({ ...parsed.data, classification });
    if (!stamped.success) fail(ctx, "socrates-answers-invalid", `the classification stamp does not match the contract (${printable(stamped.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "))})`, ANSWER_FIX);
    body = stamped.data;
  } else if (asUnfit) {
    const text = SocratesUnfit.pick({ hypothesis: true, evidence: true }).safeParse({
      hypothesis: clean.hypothesis,
      evidence: entries.map((e, i) => ({ kind: e.kind, provenance: clean[`evidence.${i}.provenance`], content: clean[`evidence.${i}`] })),
    });
    if (!text.success) fail(ctx, "socrates-unfit-invalid", `the unfit does not match the contract (${printable(issues(text.error, "unfit"))})`, UNFIT_FIX);
    endpoint = await socratesEndpoint(ctx, deps);
    const cache = await readFreshPolicy(ctx, deps, endpoint);
    const stamped = SocratesSubmitRequest.safeParse({ ...parsed.data, unfit: { rubric_version: CURRENT_RUBRIC.version, policy_hash: cache.policy_hash, ...text.data } });
    if (!stamped.success) fail(ctx, "socrates-unfit-invalid", `the unfit stamp does not match the contract (${printable(issues(stamped.error, "unfit"))})`, UNFIT_FIX);
    body = stamped.data;
  }
  const leaked = scanStrings(body);
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

  endpoint ??= await socratesEndpoint(ctx, deps);
  if (outbound.overrides.length > 0) await fileOverrideYak(ctx, outbound.overrides, reason ?? "");

  const reply = await postSocrates(ctx, deps, endpoint, { path: SOCRATES_SUBMIT_PATH, body, decoder: SocratesSubmitResponse, subject: "the candidate", refusalFix });
  // The server strips a field it does not know, so a receipt without the echo is a candidate filed without its hypothesis.
  if (asUnfit && reply.unfit === undefined) {
    fail(ctx, "socrates-unfit-unsupported", `the endpoint received ${printable(reply.candidate_id)} but its receipt does not echo unfit, so the hypothesis and evidence were not read`, "update the Socrates server to a version that supports unfit submits, or check the url points at the right endpoint");
  }
  const classified = reply.classification;
  if (classified?.reclassified) {
    const refreshed = await refreshPolicyAfterSubmit(ctx, deps, endpoint);
    const was = classified.stamped_policy_hash?.slice(0, 12) ?? "";
    const slug: SocratesWarnSlug = "socrates-reclassified";
    const cache = refreshed ? "the cached policy is refreshed" : "the cached policy could not be refreshed, so the next stamped submit fetches it";
    ctx.stderr.write(renderWarnLines(`reclassified under ${classified.policy_hash.slice(0, 12)} (was ${was}): ${classified.verdict}; ${cache}`, slug));
  }

  if (ctx.format === "json") {
    const record = {
      candidate_id: reply.candidate_id,
      deduped: reply.deduped,
      contract_version: reply.contract_version,
      ...(classified !== undefined ? { classification: classified } : {}),
      ...(asUnfit && reply.unfit !== undefined ? { unfit: reply.unfit } : {}),
      redactions: outbound.redactions,
      overrides: [...overridden].sort(),
    };
    ctx.stdout.write(`${JSON.stringify(record)}\n`);
  } else {
    ctx.stdout.write(`${reply.deduped ? "already submitted" : "submitted"}: ${printable(reply.candidate_id)}\n`);
    if (classified !== undefined) ctx.stdout.write(`  verdict: ${classified.verdict} (${classified.rubric_version}, policy ${classified.policy_hash.slice(0, 12)})\n`);
    if (asUnfit && reply.unfit !== undefined) ctx.stdout.write(`  filed for an answer: ${reply.unfit.state === "needs_input" ? "needs-input" : reply.unfit.state}\n`);
  }
  return 0;
}

/**
 * The classification stamp for a decision or practice: its answers and overrides checked against
 * the current rubric under the cached org policy (fetched first when none is cached, or it is over
 * an hour old) merged with the repo layer, which must not loosen it. Nothing of the candidate is
 * sent to build it.
 */
async function stamp(ctx: VerbContext, deps: SocratesDeps, endpoint: SocratesEndpoint, statement: string, answerPairs: Record<string, string>, overridePairs: { gate: string; reason: string }[]): Promise<SocratesClassificationStamp> {
  const rubric = CURRENT_RUBRIC;
  const answers = answersOf(ctx, rubric, answerPairs);
  const features = extractFeatures(rubric, statement, { recorded: [] });
  const repo = await readRepoPolicy(ctx, deps.cwd ?? process.cwd());
  const cache = await readFreshPolicy(ctx, deps, endpoint);
  const local = localPolicy(ctx, rubric, cache, repo);
  const overrides = overridesOf(ctx, rubric, local.policy, overridePairs, answers, features);
  return {
    rubric_version: rubric.version,
    policy_hash: cache.policy_hash,
    answers: answers as Record<string, string>,
    ...(overrides.length > 0 ? { overrides } : {}),
    ...(local.repo_policy !== null ? { repo_policy: local.repo_policy } : {}),
  };
}
