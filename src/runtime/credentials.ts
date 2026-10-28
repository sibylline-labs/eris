/**
 * credentials.ts — the one place eris reads and writes the `eris login`
 * credential: `~/.eris/yaks.json` holding `{ url?, token? }` at mode 0600, and
 * the resolvers every client that sends that bearer uses (`eris yak`, `eris
 * login`, `eris socrates`). Plugins reach it through the SDK (src/cli/plugin.ts).
 *
 * Invariants:
 *   - A group- or world-readable file is refused before a byte of it is read,
 *     so a permissive file's token never reaches a log line or an error.
 *   - No failure message carries the token's value.
 *   - The URL resolves in one order, `--url` → `ERIS_YAKS_URL` → the file's
 *     `url` → `DEFAULT_YAKS_URL`, so every command sends the bearer to the same
 *     place (the `yaks-url-single-resolver` rule holds it).
 *   - Every function returns a typed outcome, `{ value }` or `{ reason, slug }`,
 *     and never throws.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `{ value }` on success, `{ reason, slug }` on failure: `"reason" in outcome` tells them apart. */
export type CredentialOutcome<T, TSlug extends string> = { value: T } | { reason: string; slug: TSlug };

export function yaksConfigPath(home: string = homedir()): string {
  return join(home, ".eris", "yaks.json");
}


// --- Token/URL config file ---------------------------------------------------

export type YaksFileConfig = { url?: string; token?: string };

/**
 * Read `~/.eris/yaks.json`. An ABSENT file is not an error — `{ value: {} }`
 * lets `ERIS_YAKS_TOKEN`/`ERIS_YAKS_URL` alone supply what's needed. A group-
 * or world-READABLE file is refused before a single byte of its content is
 * read: `fs.stat` runs, the mode bits are checked, and only then does
 * `fs.readFile` run — so a permissive file's token can never reach a log
 * line or an error message by construction, not by discipline.
 */
export async function readYaksFileConfig(
  home: string = homedir(),
): Promise<CredentialOutcome<YaksFileConfig, "yak-config-permissive" | "yak-config-malformed">> {
  const path = yaksConfigPath(home);

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { value: {} };
    return {
      reason: `cannot stat ${path}: ${(err as Error).message}`,
      slug: "yak-config-malformed",
    };
  }

  // Group-read (0o040) or other-read (0o004) — same two bits a `chmod 0644`
  // sets. ~/.eris is 0755 (observed) so this is the only guard.
  const groupOrWorldReadable = (stat.mode & 0o044) !== 0;
  if (groupOrWorldReadable) {
    const mode = (stat.mode & 0o777).toString(8).padStart(3, "0");
    return {
      reason: `${path} is group- or world-readable (mode ${mode}) — refusing to read a bearer-token file with permissive bits`,
      slug: "yak-config-permissive",
    };
  }

  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    return {
      reason: `cannot read ${path}: ${(err as Error).message}`,
      slug: "yak-config-malformed",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reason: `${path} is not valid JSON`, slug: "yak-config-malformed" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { reason: `${path} must be a JSON object`, slug: "yak-config-malformed" };
  }

  const obj = parsed as Record<string, unknown>;
  const config: YaksFileConfig = {};
  if (typeof obj.url === "string" && obj.url.length > 0) config.url = obj.url;
  if (typeof obj.token === "string" && obj.token.length > 0) config.token = obj.token;
  return { value: config };
}

/**
 * Replace `~/.eris/yaks.json` with `config`, whole. The temp file sits in the
 * same directory and is CREATED at 0600 (`wx`: it never exists readable, and
 * an existing path is never followed), then renamed over the destination, so
 * a reader sees the old file or the new one and never a half-written or
 * readable one. `~/.eris` is created 0700 when absent. The failure names the
 * path, never a field's value. Returns the path written.
 */
export async function writeYaksFileConfig(
  config: YaksFileConfig,
  home: string = homedir(),
): Promise<CredentialOutcome<string, "yak-config-unwritable">> {
  const path = yaksConfigPath(home);
  const tmp = join(home, ".eris", `.yaks.json.tmp-${process.pid}-${crypto.randomUUID()}`);
  const body: YaksFileConfig = {};
  if (config.url !== undefined) body.url = config.url;
  if (config.token !== undefined) body.token = config.token;
  try {
    await fs.mkdir(join(home, ".eris"), { recursive: true, mode: 0o700 });
    await fs.writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(tmp, path);
    return { value: path };
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    return { reason: `cannot write ${path}: ${(err as NodeJS.ErrnoException).code ?? "error"}`, slug: "yak-config-unwritable" };
  }
}

/** `ERIS_YAKS_TOKEN` env → `yaks.json`'s `token`. Never includes
 *  the resolved token's own value in a failure message — there IS no token on
 *  the failure path, by construction. */
export function resolveToken(
  fileConfig: YaksFileConfig,
  env: Record<string, string | undefined> = process.env,
): CredentialOutcome<string, "yak-token-unresolved"> {
  const fromEnv = env.ERIS_YAKS_TOKEN;
  if (fromEnv && fromEnv.length > 0) return { value: fromEnv };
  if (fileConfig.token && fileConfig.token.length > 0) return { value: fileConfig.token };
  return {
    reason: "no yaks token: run 'eris login', or set ERIS_YAKS_TOKEN",
    slug: "yak-token-unresolved",
  };
}

/** Where a Yaks endpoint lives when nothing names another one. */
export const DEFAULT_YAKS_URL = "https://api.sibylline.group";

/**
 * The one Yaks base URL resolver, for `eris login` and every yak client:
 * `--url` (the caller passes the flag's value) → `ERIS_YAKS_URL` env →
 * `yaks.json`'s `url` → `DEFAULT_YAKS_URL`. An empty value at any step falls
 * through to the next, so a URL always resolves; `source` says which step won.
 */
export type YaksUrlSource = "flag" | "env" | "config" | "default";

export function resolveUrl(
  fileConfig: YaksFileConfig,
  env: Record<string, string | undefined> = process.env,
  flag?: string,
): { value: string; source: YaksUrlSource } {
  if (flag !== undefined && flag.length > 0) return { value: flag, source: "flag" };
  const fromEnv = env.ERIS_YAKS_URL;
  if (fromEnv && fromEnv.length > 0) return { value: fromEnv, source: "env" };
  if (fileConfig.url && fileConfig.url.length > 0) return { value: fileConfig.url, source: "config" };
  return { value: DEFAULT_YAKS_URL, source: "default" };
}
