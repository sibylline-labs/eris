/**
 * tokens.ts — `eris tokens ls|create|revoke`: an org's API tokens, managed
 * from the CLI. Loaded only when `eris tokens` dispatches (the manifest is
 * ./index.ts).
 *
 * The gateway answers `GET`/`POST /v1/org/tokens` and
 * `DELETE /v1/org/tokens/:id` for a signed-in member's bearer (the same routes
 * the dashboard's Settings > API Tokens page drives). `create` mints a service
 * token only: a user token comes from `eris login`'s device code, never from a
 * bearer. The admin-only mint, the scope check and the 3-free cap are the
 * server's; this file reports them.
 *
 * Invariants:
 *   - The plaintext secret is written to stdout exactly once, by `create`, as
 *     the only line in text mode and as the single minted body in JSON. It is
 *     never written to stderr, never inside a failure block, and never by `ls`
 *     or `revoke`.
 *   - Every response is parsed against a schema that drops unknown keys, so a
 *     field the server should not send (a hash, a secret) is never re-printed.
 *   - A failure block carries the status and the server's `error.code` only,
 *     never the response body.
 *   - Every failure is the §4 block on stderr, nothing on stdout, exit 1.
 *   - The bearer is read through `resolveOrgBearer` with the caller's cwd, so
 *     a repo that selects org B manages org B's tokens.
 */

import { CliExit, groupArgs, readArgs, renderFailureBlock, type VerbContext } from "../../src/cli/plugin";
import { z } from "zod";
import { emitJson, fail, home, request, resolveEndpoint, table, type AdminDeps, type Failure } from "./yak-admin";
import plugin from "./index";

// A `…Slug`-named union: `tests/errors-doc.test.ts` harvests its members.
export type TokensSlug =
  | "tokens-admin-required"
  | "tokens-forbidden"
  | "tokens-id-required"
  | "tokens-invalid-spec"
  | "tokens-name-invalid"
  | "tokens-name-required"
  | "tokens-not-found"
  | "tokens-scope-invalid"
  | "tokens-scope-required"
  | "tokens-service-limit"
  | "tokens-unavailable"
  | "tokens-unknown-command";

const TOKENS_PATH = "/v1/org/tokens";
const MAX_NAME = 128;
const MAX_SCOPES = 16;
const SCOPE = /^([a-z][a-z0-9-]*):(read|write|admin)$/;

const Scope = z.object({ product: z.string(), access: z.string() });
const TokenView = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  scopes: z.array(Scope),
  memberId: z.string().optional(),
  device: z.string().optional(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().optional(),
});
const TokensList = z.object({
  tokens: z.array(TokenView),
  entitled: z.array(z.string()),
  serviceTokens: z.object({ live: z.number(), limit: z.union([z.number(), z.literal("unlimited")]) }),
});
const Minted = z.object({
  token: z.string().startsWith("sib_"),
  tokenId: z.string(),
  name: z.string(),
  scopes: z.array(Scope),
  expiresAt: z.string().optional(),
});
const RevokeAck = z.object({ tokenId: z.string() });

export const TOKENS_USAGE = `Usage: eris tokens <command>

Commands:
  ls                                     List this org's tokens: id, name, kind, scope, created,
                                         last used (never a secret)
  create --name <name> --scope <p:a>...  Mint a service token; its sib_ secret is the only line on
                                         stdout and is shown once. <p:a> is product:access
                                         (access: read, write or admin); repeat --scope.
  revoke <id>                            Revoke a token

Creating a service token needs an org admin's login ('eris login'); an org on the free tier
holds at most 3 live service tokens. Run 'eris tokens <command> --help' for a command's flags.
`;

/** The server's `error.code` when it is a short snake_case word: anything else is not echoed. */
const safeCode = (code: string | undefined): string | undefined => (code !== undefined && /^[a-z][a-z_]{0,39}$/.test(code) ? code : undefined);

function refusal(status: number, code: string | undefined, target: string): Failure {
  const c = safeCode(code);
  const answered = `the endpoint answered ${status}${c ? ` ${c}` : ""} for ${target}`;
  if (status === 401) {
    return { slug: "yak-unauthorized", what: `${answered}: it rejected the bearer token`, fix: "run: eris login\n(or check ERIS_YAKS_TOKEN when it is set)" };
  }
  if (status === 403 && c === "admin_required") {
    return { slug: "tokens-admin-required", what: `${answered}: only an admin member of this org can mint a service token`, fix: "have an org admin run it, or mint it on the dashboard's Settings > API Tokens page" };
  }
  if (status === 403) {
    return { slug: "tokens-forbidden", what: `${answered}: this credential cannot manage tokens`, fix: "run: eris login\n(an ERIS_YAKS_TOKEN service token cannot manage tokens; unset it to use the login)" };
  }
  if (status === 409 && c === "service_token_limit") {
    return { slug: "tokens-service-limit", what: `${answered}: this org holds the most live service tokens its tier allows`, fix: "list them: eris tokens ls\nrevoke one: eris tokens revoke <id>" };
  }
  if (status === 400) {
    return { slug: "tokens-invalid-spec", what: `${answered}: the server refused the token spec`, fix: "check the scopes: each --scope is a product the org is entitled to ('eris tokens ls' prints them with --output json), and the name is not empty" };
  }
  if (status === 404) {
    return { slug: "tokens-not-found", what: `${answered}: no such token in this org`, fix: "list the ids: eris tokens ls" };
  }
  return { slug: "tokens-unavailable", what: answered, fix: "retry; 'eris whoami' shows which org and url this directory uses" };
}

/** One bounded request through the shared admin client, with this verb's refusals. */
const call = <S extends z.ZodTypeAny>(ep: Awaited<ReturnType<typeof resolveEndpoint>> & { ok: true }, method: "GET" | "POST" | "DELETE", path: string, schema: S, deps: AdminDeps, body?: unknown) =>
  request(ep.value, method, path, schema, deps, body, refusal);

const scopeText = (scopes: readonly { product: string; access: string }[]) => (scopes.length === 0 ? "none" : scopes.map((s) => `${s.product}:${s.access}`).join(","));

async function runLs(args: string[], ctx: VerbContext, deps: AdminDeps): Promise<number> {
  if (readArgs(plugin.rows, "tokens ls", args, ctx) === null) return 0;
  const ep = await resolveEndpoint(ctx.env, home(ctx, deps), deps.cwd ?? process.cwd());
  if (!ep.ok) return fail(ctx, ep.failure);
  const got = await call(ep, "GET", TOKENS_PATH, TokensList, deps);
  if (!got.ok) return fail(ctx, got.failure);
  if (ctx.format === "json") return emitJson(ctx, got.value);
  const rows = got.value.tokens.map((t) => [t.id, t.name, t.kind, scopeText(t.scopes), t.createdAt, t.lastUsedAt ?? "never"]);
  ctx.stdout.write(table([["id", "name", "kind", "scope", "created", "last used"], ...rows]));
  const { live, limit } = got.value.serviceTokens;
  ctx.stderr.write(`INFO service tokens: ${live} of ${limit === "unlimited" ? "unlimited" : limit} live\n`);
  return 0;
}

async function runCreate(args: string[], ctx: VerbContext, deps: AdminDeps): Promise<number> {
  const p = readArgs(plugin.rows, "tokens create", args, ctx);
  if (p === null) return 0;
  const name = p.flags["--name"]?.trim();
  const given = p.flags["--scope"];
  if (name === undefined || name === "") {
    return fail(ctx, { slug: "tokens-name-required", what: "eris tokens create was given no --name", fix: "eris tokens create --name <name> --scope <product:access>" });
  }
  if (name.length > MAX_NAME) {
    return fail(ctx, { slug: "tokens-name-invalid", what: `the token name is ${name.length} characters`, fix: `use at most ${MAX_NAME}` });
  }
  if (given.length === 0) {
    return fail(ctx, { slug: "tokens-scope-required", what: "eris tokens create was given no --scope", fix: "eris tokens create --name <name> --scope <product:access> (repeat --scope; access is read, write or admin)" });
  }
  const scopes: { product: string; access: string }[] = [];
  for (const s of given) {
    const m = SCOPE.exec(s);
    if (m === null) {
      return fail(ctx, { slug: "tokens-scope-invalid", what: `'${s}' is not a scope`, fix: "write product:access, with access one of read, write, admin (for example yak:write)" });
    }
    scopes.push({ product: m[1]!, access: m[2]! });
  }
  if (scopes.length > MAX_SCOPES) {
    return fail(ctx, { slug: "tokens-scope-invalid", what: `${scopes.length} scopes were given`, fix: `use at most ${MAX_SCOPES}` });
  }
  const ep = await resolveEndpoint(ctx.env, home(ctx, deps), deps.cwd ?? process.cwd());
  if (!ep.ok) return fail(ctx, ep.failure);
  const got = await call(ep, "POST", TOKENS_PATH, Minted, deps, { kind: "service", name, scopes });
  if (!got.ok) return fail(ctx, got.failure);
  if (ctx.format === "json") return emitJson(ctx, got.value);
  ctx.stdout.write(`${got.value.token}\n`);
  ctx.stderr.write(`INFO ✓ minted service token ${got.value.tokenId} '${got.value.name}' (${scopeText(got.value.scopes)}); the secret on stdout is shown once and cannot be read again\n`);
  return 0;
}

async function runRevoke(args: string[], ctx: VerbContext, deps: AdminDeps): Promise<number> {
  const p = readArgs(plugin.rows, "tokens revoke", args, ctx);
  if (p === null) return 0;
  const id = p.pos[0];
  if (id === undefined || id === "") {
    return fail(ctx, { slug: "tokens-id-required", what: "eris tokens revoke was given no token id", fix: "eris tokens revoke <id> (ids: eris tokens ls)" });
  }
  const ep = await resolveEndpoint(ctx.env, home(ctx, deps), deps.cwd ?? process.cwd());
  if (!ep.ok) return fail(ctx, ep.failure);
  const got = await call(ep, "DELETE", `${TOKENS_PATH}/${encodeURIComponent(id)}`, RevokeAck, deps);
  if (!got.ok) return fail(ctx, got.failure);
  if (ctx.format === "json") return emitJson(ctx, got.value);
  ctx.stdout.write(`revoked ${got.value.tokenId}\n`);
  return 0;
}

export async function runTokens(args: string[], ctx: VerbContext, deps: AdminDeps = {}): Promise<number> {
  const g = groupArgs(plugin.rows, "tokens", args);
  if (g.kind === "bare" || g.kind === "help") {
    if (ctx.format === "json") {
      // The allow-list admits `tokens` for its json subs; the group itself has no rendering.
      ctx.stderr.write(renderFailureBlock({ slug: "output-json-unsupported", what: "eris tokens has no JSON rendering", fix: "use: eris --output json tokens ls" }, ctx.erisDir));
      throw new CliExit(1);
    }
    ctx.stdout.write(TOKENS_USAGE);
    return 0;
  }
  if (g.kind === "unknown") {
    ctx.stderr.write(renderFailureBlock({ slug: "tokens-unknown-command", what: `unknown tokens command '${g.sub}'`, fix: "use one of: ls, create, revoke\nrun 'eris tokens --help' for the command list" }, ctx.erisDir));
    throw new CliExit(1);
  }
  if (g.sub === "ls") return runLs(g.rest, ctx, deps);
  if (g.sub === "create") return runCreate(g.rest, ctx, deps);
  return runRevoke(g.rest, ctx, deps);
}
