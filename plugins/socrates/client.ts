/**
 * client.ts — the one exchange every `eris socrates` verb that calls the
 * endpoint makes: the `eris login` url and bearer from the SDK's credential
 * resolvers, one POST, and a body read only through the route's decoder.
 *
 * Invariants:
 *   - The request body is whatever the caller parsed through the route's
 *     request schema; this module adds nothing to it. A GET carries a query
 *     and never a body, and the type of `SocratesCall` keeps the two apart.
 *   - A response body is read only through the route's decoder: a reply
 *     returns, a problem+json error becomes a failure block, and anything else
 *     is `socrates-bad-response`. No untyped JSON reaches a caller.
 *   - One request, no retry. The deadline covers the whole exchange, headers
 *     and body.
 *   - A failure is a slugged block on stderr and exit 1, with nothing on
 *     stdout. A 402's subscribe link is the block's `fix:` line. The one
 *     exception is an ambiguous Linear name (409 `linear_ref_ambiguous`): a
 *     `WARN` naming the candidates and exit 0, because the user's next step is
 *     to retype the name, not to repair anything.
 *   - Text a server sent is shown only after control characters are stripped;
 *     markdown keeps its newlines and tabs (`printableMarkdown`).
 */

import { homedir } from "node:os";
import type { ZodType } from "zod";
import { CliExit, renderFailureBlock, renderWarnLines, resolveOrgBearer, type OrgSlug, type VerbContext } from "../../src/cli/plugin";
import type { SocratesProblem } from "./socrates-contract.v1";

/** The `docs/ERRORS.md` slugs the socrates plugin raises (`tests/errors-doc.test.ts`). */
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
  | "socrates-bad-response"
  | "socrates-not-a-repo"
  | "socrates-cursor-invalid"
  | "socrates-discover-invalid"
  | "socrates-repo-policy-invalid"
  | "socrates-repo-policy-looser"
  | "socrates-stamp-required"
  | "socrates-unfit-invalid"
  | "socrates-unfit-unsupported"
  | "socrates-evidence-file-invalid"
  | "socrates-evidence-invalid"
  | "socrates-policy-not-cached"
  | "socrates-ref-ambiguous"
  | "socrates-amend-invalid"
  | "socrates-amend-ignored";

const REQUEST_TIMEOUT_MS = 30_000;

export interface SocratesDeps {
  home?: string;
  fetch?: typeof fetch;
  /** Where `discover` looks for the repo; the process's cwd when absent. */
  cwd?: string;
  /** What `--evidence-file <path>` reads; a file's text, `Bun.file(path).text()` when absent. */
  readFile?: (path: string) => Promise<string>;
  /** What `--evidence-file -` reads; all of `process.stdin` as text when absent. */
  readStdin?: () => Promise<string>;
  /** Whether stdin is a terminal, checked before `--evidence-file -` reads it; `process.stdin.isTTY` when absent. */
  isStdinTTY?: () => boolean;
}

/** Drop control characters, so text a server sent cannot drive the terminal. */
export function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** The line that says the review Epic's verbosity cap holds a candidate, and until when, in UTC:
 *  `held by the verbosity cap until Nov-12 00:00Z`. */
export function heldLine(heldUntil: string): string {
  const at = new Date(heldUntil);
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  return `held by the verbosity cap until ${MONTHS[at.getUTCMonth()]}-${String(at.getUTCDate()).padStart(2, "0")} ${hh}:${mm}Z`;
}

/**
 * Drop control characters from markdown a server sent, keeping `\n` and `\t`. A carriage return
 * (alone or before a newline) becomes a newline, since a bare one rewrites the line it follows.
 */
export function printableMarkdown(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export function fail(ctx: VerbContext, slug: SocratesSlug | OrgSlug | "yak-config-permissive" | "yak-config-malformed" | "yak-token-unresolved" | "yak-url-unresolved", what: string, fix: string): never {
  ctx.stderr.write(renderFailureBlock({ slug, what, fix }, ctx.erisDir));
  throw new CliExit(1);
}

/** What every route call carries, whatever its method. */
interface SocratesCallBase<T> {
  path: string;
  /** The route's response union: its reply, or the gateway's problem+json. */
  decoder: ZodType<T | SocratesProblem>;
  /** What the endpoint refused, for the failure line: "the candidate". */
  subject: string;
  /** The `fix:` line for a refusal that is neither 401 nor 402, by HTTP status. */
  refusalFix?: (status: number) => string | undefined;
  /** The `fix:` line for a body that does not decode, by HTTP status. */
  badResponseFix?: (status: number) => string | undefined;
}

/** What one route sends and how its refusals read: a GET carries a query, a POST or PUT a body. */
export type SocratesCall<T> =
  | (SocratesCallBase<T> & { method: "GET"; query: Readonly<Record<string, string>> })
  | (SocratesCallBase<T> & {
      /** The route's method; `POST` when absent. */
      method?: "POST" | "PUT";
      body: unknown;
    });

/** One exchange's outcome: the route's reply, or the gateway's problem+json. */
export type SocratesOutcome<T> = { kind: "reply"; reply: T } | { kind: "problem"; problem: SocratesProblem };

/**
 * An ambiguous Linear name is the user's to retype: the candidates on stderr (a
 * `WARN`, `socrates-ref-ambiguous`), one bare record on stdout under
 * `--output json`, nothing stored, exit 0.
 */
function warnAmbiguous(ctx: VerbContext, problem: SocratesProblem, subject: string): never {
  const candidates = problem.candidates ?? [];
  if (ctx.format === "json") {
    ctx.stdout.write(`${JSON.stringify({ ambiguous: { kind: problem.kind ?? null, candidates } })}\n`);
  } else {
    const kind = problem.kind === undefined ? "Linear name" : `Linear ${printable(problem.kind)} name`;
    const list = candidates.length === 0 ? "" : `\n${candidates.map((c) => `  ${printable(c.id)}  ${printable(c.name)}`).join("\n")}\nrun the command again with one candidate's id`;
    ctx.stderr.write(renderWarnLines(`${subject}: the ${kind} matches more than one object, so nothing was changed${list}`, "socrates-ref-ambiguous"));
  }
  throw new CliExit(0);
}

/** The failure block for a refusal: the subscribe link, then a login, then the setting's link, then the route's own fix. */
export function refuse(ctx: VerbContext, problem: SocratesProblem, call: Pick<SocratesCallBase<unknown>, "subject" | "refusalFix">): never {
  if (problem.status === 409 && problem.code === "linear_ref_ambiguous") warnAmbiguous(ctx, problem, call.subject);
  const what = `the endpoint refused ${call.subject}: ${printable(problem.detail)} (${printable(problem.code)}, HTTP ${problem.status})`;
  const subscribe = problem._links?.subscribe?.href;
  if (subscribe !== undefined) fail(ctx, "socrates-not-entitled", what, `subscribe: ${printable(subscribe)}`);
  const settings = problem._links?.settings?.href;
  const fix =
    problem.status === 401
      ? "run 'eris login' to sign this machine in again"
      : settings !== undefined
        ? `open ${printable(settings)} to change the setting`
        : (call.refusalFix?.(problem.status) ?? `check ${call.subject}, then run the command again`);
  fail(ctx, "socrates-refused", what, fix);
}

/** The endpoint's base url and the `eris login` bearer. */
export interface SocratesEndpoint {
  base: string;
  token: string;
}

/** The url and bearer `eris login` wrote (or ERIS_YAKS_URL / ERIS_YAKS_TOKEN); a failure block when none resolves. */
export async function socratesEndpoint(ctx: VerbContext, deps: SocratesDeps): Promise<SocratesEndpoint> {
  const home = deps.home ?? ctx.env.HOME ?? homedir();
  const bearer = await resolveOrgBearer({ home, env: ctx.env, cwd: deps.cwd ?? process.cwd() });
  if ("reason" in bearer) fail(ctx, bearer.slug, bearer.reason, bearer.fix);
  return { base: bearer.value.url.replace(/\/+$/, ""), token: bearer.value.token };
}

/** Send the call (a POST unless the call says GET or PUT) with the endpoint's bearer and return the decoded outcome: the reply, or the gateway's refusal. */
export async function sendSocrates<T extends object>(ctx: VerbContext, deps: SocratesDeps, endpoint: SocratesEndpoint, call: SocratesCall<T>): Promise<SocratesOutcome<T>> {
  const query = call.method === "GET" ? new URLSearchParams(call.query).toString() : "";
  const url = `${endpoint.base}${call.path}${query === "" ? "" : `?${query}`}`;
  const headers: Record<string, string> = { accept: "application/json, application/problem+json", authorization: `Bearer ${endpoint.token}` };
  const init: RequestInit = call.method === "GET" ? { method: "GET", headers } : { method: call.method ?? "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(call.body) };

  let status: number;
  let body: unknown;
  try {
    const res = await (deps.fetch ?? fetch)(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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

  const fallbackFix = "check the url points at a Socrates endpoint";
  const decoded = call.decoder.safeParse(body);
  if (!decoded.success) fail(ctx, "socrates-bad-response", `${url} answered HTTP ${status} with a body that is neither a receipt nor a problem+json error`, call.badResponseFix?.(status) ?? fallbackFix);
  const reply = decoded.data;
  if ("type" in reply) return { kind: "problem", problem: reply as SocratesProblem };
  if (status < 200 || status > 299) fail(ctx, "socrates-bad-response", `${url} answered HTTP ${status} with a receipt`, fallbackFix);
  return { kind: "reply", reply: reply as T };
}

/** `sendSocrates`, with a refusal printed as a failure block. */
export async function postSocrates<T extends object>(ctx: VerbContext, deps: SocratesDeps, endpoint: SocratesEndpoint, call: SocratesCall<T>): Promise<T> {
  const outcome = await sendSocrates(ctx, deps, endpoint, call);
  if (outcome.kind === "problem") refuse(ctx, outcome.problem, call);
  return outcome.reply;
}
