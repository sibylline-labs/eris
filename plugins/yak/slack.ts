/**
 * slack.ts — `eris slack link <link-url|code> [--confirm]` and `eris slack unlink`: bind or remove the
 * Slack account the signed-in member answers asks from, over the Bearer routes
 * `POST /v1/asks/slack/link/preview`, `/slack/link` and `/slack/unlink`. Loaded only when `eris slack`
 * dispatches (the manifest is ./index.ts).
 *
 * The link URL is the one Slack showed the Slack user when they pressed an ask button
 * (`<dash>/slack/link?code=…`); a code is minted only by that press, so this verb consumes it and mints
 * nothing. Without `--confirm` it reads whom the code would bind (the Slack account's name) and binds
 * nothing; with `--confirm` it binds the signed-in member to that account.
 *
 * Invariants:
 *   - The bearer comes from `resolveOrgBearer` (see org.ts); the bearer and the code are never written to
 *     either stream, and a refusal names neither.
 *   - The member and org are the server's, from the bearer; the request body carries the code alone.
 *   - A failure is the slugged block on stderr, nothing on stdout, exit 1. Under `--output json` a
 *     success prints the server's body, bare.
 */

import { CliExit, groupArgs, readArgs, renderFailureBlock, type VerbContext } from "../../src/cli/plugin";
import { z } from "zod";
import { type Failure, type OrgDeps, fail, plain, request } from "./org";
import plugin from "./index";

// A `…Slug`-named union: `tests/errors-doc.test.ts` harvests its members.
export type SlackSlug = "slack-code-missing" | "slack-code-invalid" | "slack-code-unknown" | "slack-already-linked" | "slack-unavailable" | "slack-member-required" | "slack-scope-denied" | "slack-unknown-verb";

/** The longest code the server accepts. */
const CODE_MAX = 64;
const CODE_RE = /^[A-Za-z0-9_-]+$/;

// passthrough: --output json prints the server's body as sent; only the fields shown are read.
const Preview = z.object({ slackUserId: z.string(), slackTeamId: z.string(), realName: z.string(), displayName: z.string() }).passthrough();
const Linked = z.object({ linked: z.literal(true), slackUserId: z.string(), slackTeamId: z.string() }).passthrough();
const Unlinked = z.object({ unlinked: z.number() }).passthrough();

export const SLACK_USAGE = `Usage: eris slack <command>

Commands:
  link <link-url|code> [--confirm]  Show the Slack account a link would bind to you; --confirm binds it
  unlink                            Remove your Slack link

The org and member are the ones this directory acts as ('eris whoami').
`;

export const LINK_USAGE = `Usage: eris slack link <link-url|code> [--confirm]

Link your Slack account so an ask you answer in Slack is answered as you. In Slack, press an ask
button: Slack replies, only to you, with a one-time 'Link Slack account' link (it works once, for
10 minutes). Give that link's URL, or just its 'code=' value, to this command.

  eris slack link <link-url>             shows whose Slack account the link is for, and binds nothing
  eris slack link <link-url> --confirm   binds that Slack account to you

Check the name before you confirm: a link made for someone else's Slack account would bind that
account to you. A service token cannot link (slack-member-required); sign in with 'eris login'.
'eris --output json slack link' prints the server's body.
`;

export const UNLINK_USAGE = `Usage: eris slack unlink

Remove the Slack account linked to you; 'unlinked: 0' says there was none. To link another account,
unlink first, then press an ask button in Slack for a new link. 'eris --output json slack unlink'
prints the server's body.
`;

/** The code a link URL or a bare code names, or the reason it names none. Never echoes the input. */
export function codeOf(input: string): { ok: true; code: string } | { ok: false; slug: SlackSlug; what: string } {
  const text = input.trim();
  let code = text;
  if (/^https?:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return { ok: false, slug: "slack-code-invalid", what: "the link is not a URL" };
    }
    code = url.searchParams.get("code") ?? "";
    if (code === "") return { ok: false, slug: "slack-code-invalid", what: "the link carries no 'code=' value" };
  }
  if (code.length > CODE_MAX || !CODE_RE.test(code)) {
    return { ok: false, slug: "slack-code-invalid", what: `the code is not 1 to ${CODE_MAX} letters, digits, '-' or '_'` };
  }
  return { ok: true, code };
}

/** The slack-specific refusals; anything else falls to the org refusals (401, rate limit, unavailable). */
function refuse(status: number, code: string | undefined, target: string): Failure | null {
  const answered = `the asks endpoint answered ${status}${code ? ` ${code}` : ""} for ${target}`;
  if (status === 403 && code === "member_required") {
    return { slug: "slack-member-required", what: `${answered}: a service token has no member to link`, fix: "run: eris login   (a person's login links; a service token does not)" };
  }
  if (status === 403 && code === "scope_denied") {
    return { slug: "slack-scope-denied", what: `${answered}: this token does not carry the linear-proxy scope`, fix: "run: eris login   ('eris whoami' lists what the token carries)" };
  }
  if (status === 404 && code === "invalid_code") {
    return { slug: "slack-code-unknown", what: `${answered}: the link is unknown, used, expired, or made for another org`, fix: "press an ask button in Slack again for a new link, and run this within 10 minutes" };
  }
  if (status === 409 && code === "slack_already_linked") {
    return { slug: "slack-already-linked", what: `${answered}: that Slack account, or you, already has a link`, fix: "unlink first: eris slack unlink, then press an ask button in Slack for a new link" };
  }
  if (status === 502 && code === "slack_unavailable") {
    return { slug: "slack-unavailable", what: `${answered}: Slack could not name the account, so no link is offered`, fix: "retry in a moment" };
  }
  return null;
}

const sayWho = (p: z.infer<typeof Preview>): string => {
  const names = [plain(p.realName), p.displayName === "" ? "" : `@${plain(p.displayName)}`].filter((n) => n !== "").join(" ");
  return `${names === "" ? "an unnamed Slack account" : names} (${plain(p.slackUserId)} in ${plain(p.slackTeamId)})`;
};

async function runLink(arg: string | undefined, confirm: boolean, ctx: VerbContext, deps: OrgDeps): Promise<number> {
  if (arg === undefined || arg === "") {
    return fail(ctx, { slug: "slack-code-missing", what: "eris slack link was given no link or code", fix: "eris slack link <link-url|code> [--confirm]   (press an ask button in Slack for the link)" });
  }
  const parsed = codeOf(arg);
  if (!parsed.ok) return fail(ctx, { slug: parsed.slug, what: `${parsed.what}; nothing was sent`, fix: "give the 'Link Slack account' link Slack sent you, or its code=… value" });
  if (!confirm) {
    const got = await request("POST", "/v1/asks/slack/link/preview", Preview, ctx, deps, { body: { code: parsed.code }, refuse });
    if (!got.ok) return fail(ctx, got.failure);
    if (ctx.format === "json") {
      ctx.stdout.write(`${JSON.stringify(got.value)}\n`);
      return 0;
    }
    ctx.stdout.write(`this link would bind ${sayWho(got.value)} to you\nnothing is linked yet; if that is your Slack account, run again with --confirm\n`);
    return 0;
  }
  const got = await request("POST", "/v1/asks/slack/link", Linked, ctx, deps, { body: { code: parsed.code }, refuse });
  if (!got.ok) return fail(ctx, got.failure);
  ctx.stdout.write(ctx.format === "json" ? `${JSON.stringify(got.value)}\n` : `linked ${plain(got.value.slackUserId)} in ${plain(got.value.slackTeamId)}\n`);
  return 0;
}

async function runUnlink(ctx: VerbContext, deps: OrgDeps): Promise<number> {
  const got = await request("POST", "/v1/asks/slack/unlink", Unlinked, ctx, deps, { body: {}, refuse });
  if (!got.ok) return fail(ctx, got.failure);
  ctx.stdout.write(ctx.format === "json" ? `${JSON.stringify(got.value)}\n` : got.value.unlinked > 0 ? "unlinked\n" : "no Slack account was linked\n");
  return 0;
}

export async function runSlack(args: string[], ctx: VerbContext, deps: OrgDeps = {}): Promise<number> {
  const g = groupArgs(plugin.rows, "slack", args);
  if (g.kind === "bare" || g.kind === "help") {
    if (ctx.format === "json") {
      ctx.stderr.write(renderFailureBlock({ slug: "output-json-unsupported", what: "eris slack has no JSON rendering", fix: "use: eris --output json slack link <link-url>" }, ctx.erisDir));
      throw new CliExit(1);
    }
    ctx.stdout.write(SLACK_USAGE);
    return 0;
  }
  if (g.kind === "unknown") {
    ctx.stderr.write(renderFailureBlock({ slug: "slack-unknown-verb", what: `unknown slack command '${g.sub}'`, fix: "use: link, unlink\nrun 'eris slack --help' for the full command list" }, ctx.erisDir));
    throw new CliExit(1);
  }
  if (g.sub === "unlink") {
    const u = readArgs(plugin.rows, "slack unlink", g.rest, ctx, { help: UNLINK_USAGE });
    if (u === null) return 0;
    return runUnlink(ctx, deps);
  }
  const l = readArgs(plugin.rows, "slack link", g.rest, ctx, { help: LINK_USAGE });
  if (l === null) return 0;
  return runLink(l.pos[0], l.flags["--confirm"] === true, ctx, deps);
}
