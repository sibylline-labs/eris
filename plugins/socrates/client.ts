/**
 * client.ts — the one exchange every `eris socrates` verb that calls the
 * endpoint makes: the `eris login` url and bearer from the SDK's credential
 * resolvers, one POST, and a body read only through the route's decoder.
 *
 * Invariants:
 *   - The request body is whatever the caller parsed through the route's
 *     request schema; this module adds nothing to it.
 *   - A response body is read only through the route's decoder: a reply
 *     returns, a problem+json error becomes a failure block, and anything else
 *     is `socrates-bad-response`. No untyped JSON reaches a caller.
 *   - One request, no retry. The deadline covers the whole exchange, headers
 *     and body.
 *   - A failure is a slugged block on stderr and exit 1, with nothing on
 *     stdout. A 402's subscribe link is the block's `fix:` line.
 *   - Text a server sent is shown only after control characters are stripped.
 */

import { homedir } from "node:os";
import type { ZodType } from "zod";
import { CliExit, readYaksFileConfig, renderFailureBlock, resolveToken, resolveUrl, type VerbContext } from "../../src/cli/plugin";
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
  | "socrates-discover-invalid";

const REQUEST_TIMEOUT_MS = 30_000;

export interface SocratesDeps {
  home?: string;
  fetch?: typeof fetch;
  /** Where `discover` looks for the repo; the process's cwd when absent. */
  cwd?: string;
}

/** Drop control characters, so text a server sent cannot drive the terminal. */
export function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

export function fail(ctx: VerbContext, slug: SocratesSlug | "yak-config-permissive" | "yak-config-malformed" | "yak-token-unresolved", what: string, fix: string): never {
  ctx.stderr.write(renderFailureBlock({ slug, what, fix }, ctx.erisDir));
  throw new CliExit(1);
}

/** What one route posts and how its refusals read. */
export interface SocratesCall<T> {
  path: string;
  body: unknown;
  /** The route's response union: its reply, or the gateway's problem+json. */
  decoder: ZodType<T | SocratesProblem>;
  /** What the endpoint refused, for the failure line: "the candidate". */
  subject: string;
  /** The `fix:` line for a refusal that is neither 401 nor 402, by HTTP status. */
  refusalFix?: (status: number) => string | undefined;
  /** The `fix:` line for a body that does not decode, by HTTP status. */
  badResponseFix?: (status: number) => string | undefined;
}

function refusal(ctx: VerbContext, problem: SocratesProblem, call: SocratesCall<unknown>): never {
  const what = `the endpoint refused ${call.subject}: ${printable(problem.detail)} (${printable(problem.code)}, HTTP ${problem.status})`;
  const subscribe = problem._links?.subscribe?.href;
  if (subscribe !== undefined) fail(ctx, "socrates-not-entitled", what, `subscribe: ${printable(subscribe)}`);
  const fix = problem.status === 401 ? "run 'eris login' to sign this machine in again" : (call.refusalFix?.(problem.status) ?? `check ${call.subject}, then run the command again`);
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
  const file = await readYaksFileConfig(home);
  if ("reason" in file) fail(ctx, file.slug, file.reason, "fix or remove the file, then run 'eris login'");
  const token = resolveToken(file.value, ctx.env);
  if ("reason" in token) fail(ctx, token.slug, token.reason, "run 'eris login'");
  return { base: resolveUrl(file.value, ctx.env).value.replace(/\/+$/, ""), token: token.value };
}

/** POST `call.body` to the endpoint with its bearer and return the decoded reply. */
export async function postSocrates<T extends object>(ctx: VerbContext, deps: SocratesDeps, endpoint: SocratesEndpoint, call: SocratesCall<T>): Promise<T> {
  const url = `${endpoint.base}${call.path}`;

  let status: number;
  let body: unknown;
  try {
    const res = await (deps.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, application/problem+json", authorization: `Bearer ${endpoint.token}` },
      body: JSON.stringify(call.body),
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

  const fallbackFix = "check the url points at a Socrates endpoint";
  const decoded = call.decoder.safeParse(body);
  if (!decoded.success) fail(ctx, "socrates-bad-response", `${url} answered HTTP ${status} with a body that is neither a receipt nor a problem+json error`, call.badResponseFix?.(status) ?? fallbackFix);
  const reply = decoded.data;
  if ("type" in reply) refusal(ctx, reply as SocratesProblem, call);
  if (status < 200 || status > 299) fail(ctx, "socrates-bad-response", `${url} answered HTTP ${status} with a receipt`, fallbackFix);
  return reply as T;
}
