/**
 * consult.ts — `eris socrates consult [--canon|--practices|--brief]`, loaded only when `eris socrates
 * consult` dispatches (./submit.ts routes the group).
 *
 * Reads living docs from the Socrates endpoint, whole, and prints their markdown for the local agent
 * to read or grep as it likes. `--canon` and `--practices` are one GET of the gateway's consult route
 * each; `--brief` is the client-side bundle of six (the route set has no brief route), and a bare
 * `consult` is a brief.
 *
 * Invariants:
 *   - Nothing leaves the machine before `eris/outbound-scan` has run over the request: a gitleaks hit
 *     refuses it (`socrates-secret-detected`). The request is the contract's parse of `{doc, project?}`.
 *   - A consult is a read: a GET with a query and no body (./client.ts types the two apart), one
 *     attempt per doc, no retry, no state kept.
 *   - Doc text reaches stdout only through `renderSection`, which strips terminal controls
 *     (`printableMarkdown`). `--output json` carries the text as JSON, which escapes it.
 *   - Output is held back until every doc is read: a refusal that aborts a brief prints no half-brief.
 *   - A brief skips a doc only when the endpoint says it is not there (404, 409) and says so on stderr
 *     with the refusal's settings link; any other refusal aborts it. A brief that read no doc fails
 *     with the first refusal.
 */

import { scanStrings } from "eris/outbound-scan";
import type { z } from "zod";
import { readArgs, renderWarnLines, type VerbContext } from "../../src/cli/plugin";
import { fail, printable, printableMarkdown, refuse, type SocratesCall, type SocratesDeps, type SocratesEndpoint, sendSocrates, socratesEndpoint } from "./client";
import plugin from "./index";
import { SOCRATES_ROUTES, SocratesConsultRequest, SocratesConsultResponse, type SocratesConsultResult, type SocratesDocKind } from "./socrates-contract.v1.verbs";

type DocKind = z.infer<typeof SocratesDocKind>;

/** WARN lines this module prints; each has a docs/ERRORS.md heading. */
export type SocratesWarnSlug = "socrates-doc-unavailable";

/** The brief's docs, in the order they print: Canon outranks the project docs; Practices come last. */
export const BRIEF_DOCS: readonly DocKind[] = ["canon", "one_pager", "lbd", "ka", "retro", "practices"];

/** What each selecting flag reads. */
const DOCS_BY_FLAG = { "--canon": ["canon"], "--practices": ["practices"], "--brief": BRIEF_DOCS } as const satisfies Record<string, readonly DocKind[]>;

/** The statuses that mean "this org has no such doc": a brief skips it, any other refusal aborts. */
const MISSING_DOC = new Set([404, 409]);

export const CONSULT_USAGE = `Usage: eris socrates consult [--canon | --practices | --brief] [--project <name>]

Read living docs from the Socrates endpoint, whole, and print their markdown.

  --canon            the org's Canon doc
  --practices        the project's Practices doc
  --brief            Canon, then the project's 1-Pager, Load-Bearing Decisions, Key Assumptions,
                     Retro Findings and Practices, each under a '<!-- eris socrates consult: <doc>
                     <url> -->' line (the default when no flag is given)
  --project <name>   the enrolled project; required when the org enrols several

A doc the org does not have is skipped in a brief with a WARN naming it (and the settings link when the
endpoint sent one); a brief that read nothing fails. '--canon' with no Canon doc chosen fails with the
link to the setting. Doc text is shown with terminal control characters removed.

--output json prints {docs: [{doc, title, url, markdown, fetched_at, contract_version}], unavailable:
[{doc, status, code, detail, settings?}], contract_version}.

Sign in first with 'eris login'.
`;

const refusalFix = (status: number): string | undefined => {
  if (status === 404) return "pass --project <name>: the detail lists the enrolled projects, and a doc the project has not created yet is not served";
  if (status === 409) return "ask an org admin to choose a Canon doc in Socrates settings";
  return undefined;
};

const badResponseFix = (status: number): string | undefined =>
  status === 404 || status === 405 ? `this endpoint does not serve ${SOCRATES_ROUTES.consult.path}: update the server, or check the url points at a Socrates endpoint` : undefined;

/** One section of the output: the markdown, with a marker line above it in a brief, ending in a newline. */
function renderSection(result: SocratesConsultResult, marked: boolean): string {
  const markdown = printableMarkdown(result.markdown);
  const body = markdown === "" || markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  const marker = marked ? `<!-- eris socrates consult: ${result.doc} ${printable(result.url).replace(/>/g, "%3E")} -->\n` : "";
  return `${marker}${body}`;
}

export async function runConsult(args: string[], ctx: VerbContext, deps: SocratesDeps = {}): Promise<number> {
  const a = readArgs(plugin.rows, "socrates consult", args, ctx, { help: CONSULT_USAGE });
  if (a === null) return 0;
  const usage = "eris socrates consult [--canon | --practices | --brief] [--project <name>]";
  const chosen = (Object.keys(DOCS_BY_FLAG) as (keyof typeof DOCS_BY_FLAG)[]).filter((f) => a.flags[f] === true);
  if (chosen.length > 1) fail(ctx, "socrates-flag-required", `pass one of --canon, --practices, --brief, not ${chosen.join(" and ")}`, usage);
  const project = a.flags["--project"];
  const docs: readonly DocKind[] = chosen[0] === undefined ? BRIEF_DOCS : DOCS_BY_FLAG[chosen[0]];
  const brief = docs.length > 1;

  const requests = docs.map((doc) => {
    const parsed = SocratesConsultRequest.safeParse({ doc, ...(typeof project === "string" ? { project } : {}) });
    if (!parsed.success) fail(ctx, "socrates-flag-required", `not a project name: ${printable(parsed.error.issues.map((i) => i.message).join(", "))}`, usage);
    return parsed.data;
  });
  const leaked = scanStrings(requests[0]);
  if (leaked.length > 0) fail(ctx, "socrates-secret-detected", `a secret was found in the arguments (${leaked.map((h) => h.rule).join(", ")}); nothing was sent`, "pass the project's name; this check cannot be overridden");

  const endpoint: SocratesEndpoint = await socratesEndpoint(ctx, deps);
  const read: SocratesConsultResult[] = [];
  const skipped: { doc: DocKind; problem: Parameters<typeof refuse>[1]; call: SocratesCall<SocratesConsultResult> }[] = [];
  for (const request of requests) {
    const call: SocratesCall<SocratesConsultResult> = {
      method: "GET",
      path: SOCRATES_ROUTES.consult.path,
      query: { doc: request.doc, ...(request.project === undefined ? {} : { project: request.project }) },
      decoder: SocratesConsultResponse,
      subject: `the ${request.doc} doc`,
      refusalFix,
      badResponseFix,
    };
    const outcome = await sendSocrates(ctx, deps, endpoint, call);
    if (outcome.kind === "reply") {
      read.push(outcome.reply);
      continue;
    }
    if (!brief || !MISSING_DOC.has(outcome.problem.status)) refuse(ctx, outcome.problem, call);
    skipped.push({ doc: request.doc, problem: outcome.problem, call });
  }
  const first = skipped[0];
  if (read.length === 0 && first !== undefined) refuse(ctx, first.problem, first.call);

  const slug: SocratesWarnSlug = "socrates-doc-unavailable";
  for (const { doc, problem } of skipped) {
    const settings = problem._links?.settings?.href;
    const why = settings !== undefined ? `open ${printable(settings)} to change the setting` : printable(problem.detail);
    ctx.stderr.write(renderWarnLines(`${doc} is unavailable (HTTP ${problem.status} ${printable(problem.code)}): ${why}`, slug));
  }

  if (ctx.format === "json") {
    const unavailable = skipped.map(({ doc, problem }) => ({
      doc,
      status: problem.status,
      code: problem.code,
      detail: problem.detail,
      ...(problem._links?.settings === undefined ? {} : { settings: problem._links.settings.href }),
    }));
    ctx.stdout.write(`${JSON.stringify({ docs: read, unavailable, contract_version: read[0]?.contract_version })}\n`);
    return 0;
  }
  ctx.stdout.write(read.map((r) => renderSection(r, brief)).join(brief ? "\n" : ""));
  return 0;
}
