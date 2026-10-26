/**
 * login.ts — `eris login` and `eris logout`, loaded only when one dispatches
 * (the manifest is ./index.ts).
 *
 * `eris login` is an RFC 8628 device-authorization client. It starts a grant at
 * `<url>/v1/device/code`, shows the user code and the verification URI (and
 * opens a browser when it can), then polls `<url>/v1/device/token` until the
 * code is approved, denied or expired. The bearer it is handed goes into
 * `~/.eris/yaks.json`, the one file `eris yak` reads (./yak-identity.ts), with
 * the url beside it. The url is the one `eris yak` already uses:
 * `--url`, else `ERIS_YAKS_URL`, else the file's own `url`; there is no default
 * host.
 *
 * `eris logout` removes the token from that file and keeps the url. No route
 * lets a bearer revoke itself, so the token stays valid server-side until it is
 * revoked from the dashboard's API tokens settings; the command says so.
 *
 * Invariants:
 *   - Neither the device code nor the bearer is ever written to stdout or
 *     stderr. The user code is the one value shown, and it is not a secret on
 *     its own.
 *   - A grant that does not end approved writes nothing: the file is replaced
 *     once, after a token has been received, through `writeYaksFileConfig`
 *     (created 0600, renamed into place).
 *   - The poll interval only grows: `slow_down` raises it for every later poll
 *     (to the interval it carries, else by 5 s); a 429 waits out `retry-after`
 *     for one poll. The code's `expires_in` ends the loop locally even if the
 *     server never says `expired_token`.
 *   - Two error shapes are read: RFC 6749's `{error: "<code>"}` (every 400) and
 *     the gateway's `{error: {code, message}}` (429, 503). A 5xx or a dropped
 *     connection while polling is retried up to `MAX_TRANSIENT` times in a
 *     row, so a blip after the user approved does not throw the approval away.
 *   - Text from the server is shown only after control characters are
 *     stripped, so a response cannot drive the terminal.
 */

import { hostname as osHostname } from "node:os";
import { renderFailureBlock, renderWarnLines, readArgs, type VerbContext } from "../../src/cli/plugin";
import plugin from "./index";
import { readYaksFileConfig, resolveUrl, runBounded, writeYaksFileConfig, yaksConfigPath } from "./yak-identity";
import { promises as fs } from "node:fs";

/** The `docs/ERRORS.md` slugs this module raises (`tests/errors-doc.test.ts`). */
export type LoginSlug =
  | "login-url-unresolved"
  | "login-unreachable"
  | "login-refused"
  | "login-denied"
  | "login-expired"
  | "login-env-token-overrides";

const DEVICE_AUTHORIZATION_PATH = "/v1/device/code";
const DEVICE_TOKEN_PATH = "/v1/device/token";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** RFC 8628 §3.5: what `slow_down` adds when it carries no interval. */
const SLOW_DOWN_STEP_MS = 5_000;
/** Consecutive 5xx or dropped polls tolerated before giving up. */
const MAX_TRANSIENT = 3;
/** One request's whole exchange, headers and body. */
const REQUEST_TIMEOUT_MS = 15_000;
/** The gateway caps a device label at 128 characters. */
const MAX_LABEL = 128;

export const LOGIN_USAGE = `Usage: eris login [--url <url>] [--no-browser]

Sign this machine in with a device code: approve the code shown here in your
browser, and the token is written to ~/.eris/yaks.json (mode 0600), where
'eris yak' reads it. ERIS_YAKS_TOKEN, when set, still wins over the file.

  --url <url>    the endpoint (default: $ERIS_YAKS_URL, then the url
                 already in ~/.eris/yaks.json)
  --no-browser   print the link without trying to open a browser
`;

export const LOGOUT_USAGE = `Usage: eris logout

Remove this machine's token from ~/.eris/yaks.json, keeping the url. The token
stays valid until it is revoked under Settings > API Tokens.
`;

export interface LoginDeps {
  home?: string;
  hostname?: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Open `url` in a browser, best effort. The default does so only when
   *  stderr is a terminal. */
  openBrowser?: (url: string) => Promise<void>;
}

type Grant = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInMs: number;
  intervalMs: number;
};

type Exchange = { kind: "response"; status: number; headers: Headers; body: unknown } | { kind: "unreachable"; reason: string };

/** Drop control characters, so text a server sent cannot drive the terminal. */
function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

/** The error code from either shape: RFC `{error: "<code>"}` or the gateway's `{error: {code}}`. */
function errorCode(status: number, body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const error = (body as Record<string, unknown>).error;
    if (typeof error === "string") return printable(error);
    if (typeof error === "object" && error !== null) {
      const { code, message } = error as Record<string, unknown>;
      if (typeof code === "string") return printable(typeof message === "string" ? `${code}: ${message}` : code);
    }
  }
  return `HTTP ${status}`;
}

async function post(url: string, form: Record<string, string>): Promise<Exchange> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // A body that is not JSON reads as no body; the status still decides.
    }
    return { kind: "response", status: res.status, headers: res.headers, body };
  } catch (err) {
    const name = (err as { name?: string }).name;
    return { kind: "unreachable", reason: name === "TimeoutError" ? `no answer within ${REQUEST_TIMEOUT_MS / 1000}s` : printable((err as Error).message) };
  }
}

function readGrant(body: unknown): Grant | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval } = b;
  if (typeof device_code !== "string" || typeof user_code !== "string" || typeof verification_uri !== "string") return null;
  if (typeof expires_in !== "number" || !(expires_in > 0)) return null;
  return {
    deviceCode: device_code,
    userCode: printable(user_code),
    verificationUri: printable(typeof verification_uri_complete === "string" ? verification_uri_complete : verification_uri),
    expiresInMs: expires_in * 1000,
    intervalMs: (typeof interval === "number" && interval > 0 ? interval : 5) * 1000,
  };
}

/** `<host> (eris)`, or `<host> (eris, claude-code)` under Claude Code: the
 *  name the minted token carries in the dashboard's token list. */
function deviceLabel(host: string, env: Record<string, string | undefined>): string {
  const short = host.split(".")[0] || "unknown-host";
  const harness = env.CLAUDECODE === "1" ? ", claude-code" : "";
  return `${short} (eris${harness})`.slice(0, MAX_LABEL);
}

async function defaultOpenBrowser(url: string): Promise<void> {
  if (!process.stderr.isTTY) return;
  const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "linux" ? ["xdg-open", url] : null;
  if (cmd !== null) await runBounded(cmd, process.cwd(), 5_000);
}

function fail(ctx: VerbContext, slug: LoginSlug | "yak-config-permissive" | "yak-config-malformed" | "yak-config-unwritable", what: string, fix: string): number {
  ctx.stderr.write(renderFailureBlock({ slug, what, fix }, ctx.erisDir));
  return 1;
}

export async function runLogin(args: string[], ctx: VerbContext, deps: LoginDeps = {}): Promise<number> {
  const a = readArgs(plugin.rows, "login", args, ctx, { help: LOGIN_USAGE });
  if (a === null) return 0;
  const home = deps.home ?? ctx.env.HOME ?? "";
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser;

  const file = await readYaksFileConfig(home);
  if ("reason" in file) return fail(ctx, file.slug, file.reason, `fix or remove ${yaksConfigPath(home)}, then run 'eris login' again`);

  const flagUrl = a.flags["--url"];
  const resolved = flagUrl !== undefined && flagUrl !== "" ? { value: flagUrl } : resolveUrl(file.value, ctx.env);
  if (!("value" in resolved)) {
    return fail(ctx, "login-url-unresolved", "no endpoint to sign in to", "pass --url <url>, or set ERIS_YAKS_URL");
  }
  const url = resolved.value;
  const base = url.replace(/\/+$/, "");

  // --- start -------------------------------------------------------------------
  const started = await post(`${base}${DEVICE_AUTHORIZATION_PATH}`, { device: deviceLabel((deps.hostname ?? osHostname)(), ctx.env) });
  if (started.kind === "unreachable") {
    return fail(ctx, "login-unreachable", `cannot reach ${printable(base)}: ${started.reason}`, "check the url and your connection, then run 'eris login' again");
  }
  const grant = started.status === 200 ? readGrant(started.body) : null;
  if (grant === null) {
    const why = started.status === 200 ? "a malformed device authorization response" : errorCode(started.status, started.body);
    return fail(ctx, "login-refused", `${printable(base)} refused to start a device login (${why})`, "check the url points at an endpoint with device login, then run 'eris login' again");
  }

  const opens = !a.flags["--no-browser"] && /^https?:\/\//i.test(grant.verificationUri);
  ctx.stderr.write(
    `To sign this machine in, open:\n\n  ${grant.verificationUri}\n\nand check it shows the code: ${grant.userCode}\n` +
      `Waiting for approval (the code expires in ${Math.round(grant.expiresInMs / 60_000)} min)...\n`,
  );
  if (opens) await openBrowser(grant.verificationUri).catch(() => undefined);

  // --- poll --------------------------------------------------------------------
  const deadline = now() + grant.expiresInMs;
  let interval = grant.intervalMs;
  let wait = interval;
  let transient = 0;
  for (;;) {
    await sleep(wait);
    wait = interval;
    if (now() >= deadline) {
      return fail(ctx, "login-expired", "the device code expired before it was approved", "run 'eris login' again and approve the new code within its lifetime");
    }
    const polled = await post(`${base}${DEVICE_TOKEN_PATH}`, { grant_type: DEVICE_CODE_GRANT_TYPE, device_code: grant.deviceCode });

    if (polled.kind === "unreachable" || polled.status >= 500) {
      if (++transient > MAX_TRANSIENT) {
        const why = polled.kind === "unreachable" ? polled.reason : errorCode(polled.status, polled.body);
        return fail(ctx, "login-unreachable", `lost ${printable(base)} while waiting for approval (${why})`, "run 'eris login' again");
      }
      continue;
    }
    transient = 0;

    if (polled.status === 429) {
      const retryAfter = Number(polled.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter * 1000 > wait) wait = retryAfter * 1000;
      continue;
    }

    if (polled.status === 200) {
      const body = polled.body as Record<string, unknown> | null;
      const token = body?.access_token;
      if (typeof token !== "string" || token === "" || String(body?.token_type).toLowerCase() !== "bearer") {
        return fail(ctx, "login-refused", "the endpoint approved the code but sent no bearer token", "run 'eris login' again");
      }
      const written = await writeYaksFileConfig({ url, token }, home);
      if ("reason" in written) return fail(ctx, written.slug, written.reason, `make ${yaksConfigPath(home)} writable, then run 'eris login' again`);
      if (file.value.token !== undefined && file.value.token !== token) {
        ctx.stderr.write("replaced the token that was in the file; revoke it under Settings > API Tokens if nothing else uses it\n");
      }
      if (ctx.env.ERIS_YAKS_TOKEN) {
        ctx.stderr.write(renderWarnLines("ERIS_YAKS_TOKEN is set and overrides the token just written; unset it to use this login", "login-env-token-overrides"));
      }
      const name = typeof body?.name === "string" ? printable(body.name) : "eris";
      ctx.stdout.write(`logged in: token "${name}" written to ${written.value}\n`);
      return 0;
    }

    const code = errorCode(polled.status, polled.body);
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      const raised = (polled.body as Record<string, unknown>).interval;
      interval = typeof raised === "number" && raised * 1000 > interval ? raised * 1000 : interval + SLOW_DOWN_STEP_MS;
      wait = interval;
      continue;
    }
    if (code === "access_denied") {
      return fail(ctx, "login-denied", "the sign-in was denied in the browser", "run 'eris login' again if that was not intended");
    }
    if (code === "expired_token") {
      return fail(ctx, "login-expired", "the device code expired before it was approved", "run 'eris login' again and approve the new code within its lifetime");
    }
    return fail(ctx, "login-refused", `the endpoint refused the device code (${code})`, "run 'eris login' again");
  }
}

export async function runLogout(args: string[], ctx: VerbContext, deps: Pick<LoginDeps, "home"> = {}): Promise<number> {
  const a = readArgs(plugin.rows, "logout", args, ctx, { help: LOGOUT_USAGE });
  if (a === null) return 0;
  const home = deps.home ?? ctx.env.HOME ?? "";
  const path = yaksConfigPath(home);

  const file = await readYaksFileConfig(home);
  if ("reason" in file) return fail(ctx, file.slug, file.reason, `fix or remove ${path}`);

  if (file.value.token === undefined) {
    ctx.stdout.write(`not logged in: no token in ${path}\n`);
  } else {
    if (file.value.url === undefined) {
      try {
        await fs.rm(path, { force: true });
      } catch (err) {
        return fail(ctx, "yak-config-unwritable", `cannot remove ${path}: ${(err as NodeJS.ErrnoException).code ?? "error"}`, `remove ${path} by hand`);
      }
    } else {
      const written = await writeYaksFileConfig({ url: file.value.url }, home);
      if ("reason" in written) return fail(ctx, written.slug, written.reason, `make ${path} writable, then run 'eris logout' again`);
    }
    ctx.stdout.write(`logged out: removed the token from ${path}\n`);
    ctx.stderr.write("the token stays valid until it is revoked under Settings > API Tokens\n");
  }
  if (ctx.env.ERIS_YAKS_TOKEN) {
    ctx.stderr.write(renderWarnLines("ERIS_YAKS_TOKEN is still set, so 'eris yak' keeps authenticating with it", "login-env-token-overrides"));
  }
  return 0;
}
