/**
 * credentials.ts — the one place eris reads and writes the `eris login`
 * credential: `~/.eris/yaks.json` holding `{ url?, token?, orgs? }` at mode
 * 0600, and the resolvers every client that sends that bearer uses (`eris
 * yak`, `eris login`, `eris socrates`). Plugins reach it through the SDK
 * (src/cli/plugin.ts).
 *
 * One file holds a bearer per org. The top-level `{ url, token }` is the
 * DEFAULT org, the org a directory acts as when nothing selects another, and
 * it is what a single-org file already holds. `orgs` maps each other org's id
 * (the ULID inside its `sib_<org>_<secret>` bearer) to its own `{ url, token }`.
 * The org for a directory is `ERIS_ORG`, else `repo.org` in the nearest
 * `eris.yaml` that names one (up to the checkout root), else the default
 * (`resolveOrgSelection`). `selectOrgConfig` narrows the file to that org's
 * flat `{ url, token }`, so `resolveYaksBearer` and `resolveUrl` read one org
 * at a time, and `resolveOrgBearer` does both steps.
 *
 * Invariants:
 *   - A group- or world-readable file is refused before a byte of it is read,
 *     so a permissive file's token never reaches a log line or an error.
 *   - No failure message carries the token's value.
 *   - The URL resolves in one order, `--url` → `ERIS_YAKS_URL` → the file's
 *     `url` → `DEFAULT_YAKS_URL`, so every command sends the bearer to the same
 *     place (the `yaks-url-single-resolver` rule holds it).
 *   - The bearer leaves only as a `YaksBearer`, which carries its URL: an
 *     `ERIS_YAKS_TOKEN` bearer pairs with a URL someone named, never with
 *     `DEFAULT_YAKS_URL`, which only the `eris login` file's bearer may use (the
 *     type holds it; `yaks-token-single-resolver` holds the env read).
 *   - A selected org that holds no bearer fails closed (`org-not-signed-in`),
 *     never falling back to the default org's bearer; an `orgs` entry whose key
 *     is not its own token's org is dropped on read, so a key never routes
 *     another org's bearer.
 *   - Every function returns a typed outcome, `{ value }` or `{ reason, slug }`,
 *     and never throws.
 */

import { promises as fs, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { isGitCheckoutRoot } from "./git-checkout";

/** `{ value }` on success, `{ reason, slug }` on failure: `"reason" in outcome` tells them apart. */
export type CredentialOutcome<T, TSlug extends string> = { value: T } | { reason: string; slug: TSlug };

export function yaksConfigPath(home: string = homedir()): string {
  return join(home, ".eris", "yaks.json");
}


// --- Token/URL config file ---------------------------------------------------

/** One org's sign-in: the bearer and the endpoint it goes to. */
export type YaksOrgEntry = { url?: string; token?: string };

/** `url`/`token` are the default org; `orgs` keys every other org by its id. */
export type YaksFileConfig = { url?: string; token?: string; orgs?: Readonly<Record<string, YaksOrgEntry>> };

/** An org id: a 26-character Crockford base32 ULID, uppercase. */
const ORG_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
// lift-candidate: sib-token-org-claim — the org a sib_<org>_<secret> bearer claims
const SIB_TOKEN_RE = /^sib_([0-9A-HJKMNP-TV-Z]{26})_[A-Za-z0-9_-]{43}$/;

export function isOrgId(value: unknown): value is string {
  return typeof value === "string" && ORG_ID_RE.test(value);
}

/** The org a `sib_<org>_<secret>` bearer claims, or `null` for any other shape. The server checks the claim; here it only picks which slot the bearer lives in. */
export function tokenOrg(token: string | undefined): string | null {
  if (token === undefined) return null;
  const match = SIB_TOKEN_RE.exec(token);
  return match === null ? null : (match[1] as string);
}

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
  const refused = permissive(path, stat.mode);
  if (refused !== null) return refused;

  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    return {
      reason: `cannot read ${path}: ${(err as Error).message}`,
      slug: "yak-config-malformed",
    };
  }

  return parseYaksFile(path, raw);
}

/** The bits `chmod 0644` sets: a token file with either is refused unread. */
function permissive(path: string, mode: number): { reason: string; slug: "yak-config-permissive" } | null {
  if ((mode & 0o044) === 0) return null;
  return {
    reason: `${path} is group- or world-readable (mode ${(mode & 0o777).toString(8).padStart(3, "0")}) — refusing to read a bearer-token file with permissive bits`,
    slug: "yak-config-permissive",
  };
}

/**
 * `readYaksFileConfig` for a caller that cannot await (a synchronous resolver
 * deep in a command): the same mode check before any byte is read, the same
 * parse, the same outcomes.
 */
export function readYaksFileConfigSync(
  home: string = homedir(),
): CredentialOutcome<YaksFileConfig, "yak-config-permissive" | "yak-config-malformed"> {
  const path = yaksConfigPath(home);
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { value: {} };
    return { reason: `cannot stat ${path}: ${(err as Error).message}`, slug: "yak-config-malformed" };
  }
  const refused = permissive(path, mode);
  if (refused !== null) return refused;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { reason: `cannot read ${path}: ${(err as Error).message}`, slug: "yak-config-malformed" };
  }
  return parseYaksFile(path, raw);
}

function parseYaksFile(path: string, raw: string): CredentialOutcome<YaksFileConfig, "yak-config-malformed"> {
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
  const orgs = readOrgs(obj.orgs);
  if (orgs !== undefined) config.orgs = orgs;
  return { value: config };
}

/** The `orgs` map, keeping only entries keyed by their own token's org. */
function readOrgs(raw: unknown): Record<string, YaksOrgEntry> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, YaksOrgEntry> = {};
  for (const [org, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!isOrgId(org) || entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.token !== "string" || tokenOrg(e.token) !== org) continue;
    out[org] = typeof e.url === "string" && e.url.length > 0 ? { url: e.url, token: e.token } : { token: e.token };
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
  if (config.orgs !== undefined && Object.keys(config.orgs).length > 0) body.orgs = config.orgs;
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

/** Where the bearer came from: `ERIS_YAKS_TOKEN`, or the `token` in `yaks.json`. */
export type YaksTokenSource = "env" | "config";

/**
 * The bearer and the URL it is sent to, resolved together. The `env` arm cannot
 * hold `urlSource: "default"`, so a token set for one endpoint is never sent
 * to the built-in host by omission.
 */
export type YaksBearer =
  | { token: string; tokenSource: "config"; url: string; urlSource: YaksUrlSource }
  | { token: string; tokenSource: "env"; url: string; urlSource: Exclude<YaksUrlSource, "default"> };

/** Which source would supply the bearer, without the bearer: `null` when none does. */
export function yaksTokenSource(
  fileConfig: YaksFileConfig,
  env: Record<string, string | undefined> = process.env,
): YaksTokenSource | null {
  if (env.ERIS_YAKS_TOKEN && env.ERIS_YAKS_TOKEN.length > 0) return "env";
  if (fileConfig.token && fileConfig.token.length > 0) return "config";
  return null;
}

/**
 * The one bearer resolver for every client that sends it: `ERIS_YAKS_TOKEN` →
 * `yaks.json`'s `token`, paired with `resolveUrl`'s URL. An env bearer with no
 * named URL fails `yak-url-unresolved` before any request. Neither failure
 * carries a token value; `fix` is the line a failure block prints.
 */
export function resolveYaksBearer(
  fileConfig: YaksFileConfig,
  env: Record<string, string | undefined> = process.env,
  flag?: string,
): { value: YaksBearer } | { reason: string; slug: "yak-token-unresolved" | "yak-url-unresolved"; fix: string } {
  const source = yaksTokenSource(fileConfig, env);
  if (source === null) {
    return { reason: "no yaks token: run 'eris login', or set ERIS_YAKS_TOKEN", slug: "yak-token-unresolved", fix: "run 'eris login'" };
  }
  const url = resolveUrl(fileConfig, env, flag);
  if (source === "config") {
    return { value: { token: fileConfig.token as string, tokenSource: "config", url: url.value, urlSource: url.source } };
  }
  const token = env.ERIS_YAKS_TOKEN as string;
  if (url.source === "default") {
    const fix = "set ERIS_YAKS_URL to the endpoint that token belongs to, or unset ERIS_YAKS_TOKEN and run 'eris login'";
    return {
      reason: `ERIS_YAKS_TOKEN is set but no Yaks URL is, so the token is not sent to ${DEFAULT_YAKS_URL}: ${fix}`,
      slug: "yak-url-unresolved",
      fix,
    };
  }
  return { value: { token, tokenSource: "env", url: url.value, urlSource: url.source } };
}

// --- Org selection -------------------------------------------------------------

/** Which org a directory acts as, and why: `ERIS_ORG`, `repo.org` in an `eris.yaml`, or the default. */
export type OrgSelection =
  | { readonly org: string; readonly source: "env" }
  | { readonly org: string; readonly source: "eris.yaml"; readonly path: string }
  | { readonly org: null; readonly source: "default" };

export type OrgSlug = "org-not-signed-in" | "org-selector-invalid" | "org-token-mismatch";

/** A refused selection; `fix` is the line a failure block prints. Never carries a token. */
export type OrgFailure = { reason: string; slug: OrgSlug; fix: string };

/** A checkout never nests this deep; the bound keeps a symlink cycle from making the walk unbounded. */
const ORG_WALK_MAX_DEPTH = 64;

/** The org named by `repo.org` in one parsed manifest: absent, a valid id, or invalid. */
function manifestOrg(value: unknown): { kind: "absent" } | { kind: "org"; org: string } | { kind: "invalid" } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { kind: "absent" };
  const repo = (value as Record<string, unknown>).repo;
  if (repo === null || typeof repo !== "object" || Array.isArray(repo)) return { kind: "absent" };
  if (!Object.hasOwn(repo, "org")) return { kind: "absent" };
  const org = (repo as Record<string, unknown>).org;
  return isOrgId(org) ? { kind: "org", org } : { kind: "invalid" };
}

/**
 * The org this directory acts as: `ERIS_ORG` when set, else `repo.org` in the
 * nearest `eris.yaml` at or above `cwd` that names one, stopping at the
 * enclosing checkout's root (a `.git` entry), the home directory (its own
 * manifest and everything above it are never read) and a hard depth bound, else
 * the default org. A manifest inside a `node_modules` tree is a dependency's, never
 * the repo's, so it is not read. A malformed id, or a manifest on the walk that cannot be read
 * or parsed, fails `org-selector-invalid`: a broken manifest might be the one
 * selecting an org, so it is never skipped.
 */
export async function resolveOrgSelection(
  env: Record<string, string | undefined>,
  cwd: string,
  home: string = homedir(),
): Promise<{ value: OrgSelection } | OrgFailure> {
  return resolveOrgSelectionSync(env, cwd, home);
}

/** `resolveOrgSelection` for a synchronous caller: the same walk, the same outcomes. */
export function resolveOrgSelectionSync(env: Record<string, string | undefined>, cwd: string, home: string = homedir()): { value: OrgSelection } | OrgFailure {
  const fromEnv = env.ERIS_ORG;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    if (isOrgId(fromEnv)) return { value: { org: fromEnv, source: "env" } };
    return {
      reason: "ERIS_ORG is not an org id (26 uppercase Crockford base32 characters)",
      slug: "org-selector-invalid",
      fix: "set ERIS_ORG to the org id 'eris whoami' prints, or unset it",
    };
  }
  let dir = cwd;
  for (let i = 0; i < ORG_WALK_MAX_DEPTH; i++) {
    if (home !== "" && dir === resolve(home)) break;
    const path = join(dir, "eris.yaml");
    let raw: string | undefined;
    if (!dir.split(sep).includes("node_modules")) {
      try {
        raw = readFileSync(path, "utf8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          return { reason: `${path} is unreadable (${code ?? "read failed"}), so the org it may select is unknown`, slug: "org-selector-invalid", fix: `make ${path} readable, then run the command again` };
        }
      }
    }
    if (raw !== undefined) {
      let parsed: unknown;
      try {
        parsed = Bun.YAML.parse(raw);
      } catch {
        return { reason: `${path} is not YAML, so the org it may select is unknown`, slug: "org-selector-invalid", fix: `fix ${path}, then run the command again` };
      }
      const found = manifestOrg(parsed);
      if (found.kind === "org") return { value: { org: found.org, source: "eris.yaml", path } };
      if (found.kind === "invalid") {
        return { reason: `repo.org in ${path} is not an org id (26 uppercase Crockford base32 characters)`, slug: "org-selector-invalid", fix: `set repo.org in ${path} to the org id 'eris whoami' prints, or remove it` };
      }
    }
    if (isGitCheckoutRoot(dir)) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { value: { org: null, source: "default" } };
}

/** One org's flat `{ url, token }` view of the file, ready for `resolveYaksBearer` / `resolveUrl`. */
export type OrgView = { readonly config: YaksFileConfig; readonly org: string | null; readonly isDefault: boolean };

/**
 * Narrow the file to the selected org. The default selection is the file's
 * top-level `{ url, token }`, exactly as a single-org file reads. A selected org
 * is the top-level entry when the default token is that org's, else its `orgs`
 * entry (taking the default's `url` when it holds none), else
 * `org-not-signed-in`: never the default org's bearer. With
 * `ERIS_YAKS_TOKEN` set, a selected org must be that token's own org
 * (`org-token-mismatch` otherwise, including a token whose org cannot be read).
 */
export function selectOrgConfig(
  file: YaksFileConfig,
  selection: OrgSelection,
  env: Record<string, string | undefined> = process.env,
): { value: OrgView } | OrgFailure {
  const envToken = env.ERIS_YAKS_TOKEN !== undefined && env.ERIS_YAKS_TOKEN.length > 0 ? env.ERIS_YAKS_TOKEN : undefined;
  const defaultOrg = tokenOrg(file.token);
  const top: YaksFileConfig = {};
  if (file.url !== undefined) top.url = file.url;
  if (file.token !== undefined) top.token = file.token;
  if (selection.org === null) {
    return { value: { config: top, org: envToken !== undefined ? tokenOrg(envToken) : defaultOrg, isDefault: true } };
  }
  const org = selection.org;
  const why = selection.source === "env" ? "ERIS_ORG" : `repo.org in ${selection.path}`;
  const isDefault = defaultOrg === org;
  const entry: YaksFileConfig | undefined = isDefault ? top : file.orgs?.[org];
  if (envToken !== undefined) {
    if (tokenOrg(envToken) !== org) {
      return {
        reason: `${why} selects org ${org}, but ERIS_YAKS_TOKEN is not a bearer for that org`,
        slug: "org-token-mismatch",
        fix: `unset ERIS_YAKS_TOKEN to use this machine's sign-in for org ${org}, or set it to a bearer for that org`,
      };
    }
    const config: YaksFileConfig = {};
    if (entry?.url !== undefined) config.url = entry.url;
    return { value: { config, org, isDefault } };
  }
  if (entry === undefined || entry.token === undefined) {
    return {
      reason: `${why} selects org ${org}, and this machine is not signed in to it`,
      slug: "org-not-signed-in",
      fix: `run 'eris login' and approve the code while signed in to org ${org} in the dashboard`,
    };
  }
  const config: YaksFileConfig = entry.url === undefined && file.url !== undefined ? { ...entry, url: file.url } : entry;
  return { value: { config, org, isDefault } };
}

/**
 * The file after signing in with `token`: the default slot when the file has
 * no default yet, when either bearer's org cannot be read (a single-org file
 * behaves as it always has), or when `token` is the default org's; otherwise
 * the token's own `orgs` entry, leaving the default alone. `replaced` says the
 * slot already held a different bearer.
 */
export function addOrgLogin(
  file: YaksFileConfig,
  url: string,
  token: string,
): { config: YaksFileConfig; org: string | null; asDefault: boolean; replaced: boolean } {
  const org = tokenOrg(token);
  const defaultOrg = tokenOrg(file.token);
  const orgs: Record<string, YaksOrgEntry> = { ...(file.orgs ?? {}) };
  if (file.token === undefined || org === null || defaultOrg === null || org === defaultOrg) {
    if (org !== null) delete orgs[org];
    const config: YaksFileConfig = Object.keys(orgs).length > 0 ? { url, token, orgs } : { url, token };
    return { config, org, asDefault: true, replaced: file.token !== undefined && file.token !== token };
  }
  const before = orgs[org]?.token;
  orgs[org] = { url, token };
  const config: YaksFileConfig = { ...(file.url !== undefined ? { url: file.url } : {}), token: file.token, orgs };
  return { config, org, asDefault: false, replaced: before !== undefined && before !== token };
}

/** The file after signing the selected org out: the default's token goes (its url stays), or the org's entry. */
export function removeOrgLogin(file: YaksFileConfig, selection: OrgSelection): { config: YaksFileConfig; removed: boolean } {
  const orgs: Record<string, YaksOrgEntry> = { ...(file.orgs ?? {}) };
  const withOrgs = (base: YaksFileConfig): YaksFileConfig => (Object.keys(orgs).length > 0 ? { ...base, orgs } : base);
  const top: YaksFileConfig = {};
  if (file.url !== undefined) top.url = file.url;
  if (file.token !== undefined) top.token = file.token;
  if (selection.org === null || selection.org === tokenOrg(file.token)) {
    if (file.token === undefined) return { config: file, removed: false };
    return { config: withOrgs(file.url !== undefined ? { url: file.url } : {}), removed: true };
  }
  if (orgs[selection.org] === undefined) return { config: file, removed: false };
  delete orgs[selection.org];
  return { config: withOrgs(top), removed: true };
}

/** A resolved bearer plus the org it acts as and why that org was chosen. */
export type OrgBearer = YaksBearer & { readonly org: string | null; readonly isDefault: boolean; readonly selection: OrgSelection };

/**
 * The one bearer resolver for a command running in `cwd`: read the file,
 * choose the org (`resolveOrgSelection`), narrow to it (`selectOrgConfig`),
 * then `resolveYaksBearer` on that org's view. Every failure names its fix and
 * carries no token.
 */
export async function resolveOrgBearer(opts: {
  home: string;
  env: Record<string, string | undefined>;
  cwd: string;
  flag?: string;
}): Promise<
  | { value: OrgBearer }
  | { reason: string; slug: OrgSlug | "yak-config-permissive" | "yak-config-malformed" | "yak-token-unresolved" | "yak-url-unresolved"; fix: string }
> {
  const file = await readYaksFileConfig(opts.home);
  if ("reason" in file) return { reason: file.reason, slug: file.slug, fix: `fix or remove ${yaksConfigPath(opts.home)}, then run 'eris login' again` };
  const selection = await resolveOrgSelection(opts.env, opts.cwd, opts.home);
  if ("reason" in selection) return selection;
  const view = selectOrgConfig(file.value, selection.value, opts.env);
  if ("reason" in view) return view;
  const bearer = resolveYaksBearer(view.value.config, opts.env, opts.flag);
  if ("reason" in bearer) return bearer;
  return { value: { ...bearer.value, org: view.value.org, isDefault: view.value.isDefault, selection: selection.value } };
}
