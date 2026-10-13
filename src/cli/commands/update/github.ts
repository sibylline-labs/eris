/**
 * github.ts — `eris update`'s only network code: the releases API of the build's
 * own repository, and the download of a release's assets.
 *
 * What it guarantees, and why each line is here:
 *
 *   - An asset is fetched through its API url (`assets[].url`) with
 *     `Accept: application/octet-stream`, never through `browser_download_url`:
 *     for a private repository the API url with a token answers (a redirect to
 *     storage) and the browser url answers 404.
 *   - The token (`GH_TOKEN`, else `GITHUB_TOKEN`) is read only when the API base
 *     is `https://api.github.com` or a loopback host (a test's server), so an
 *     `ERIS_UPDATE_API` naming any other host never receives it (`sendsToken`).
 *     It is sent only to the API's own origin. Redirects are followed by hand,
 *     so each hop is judged on its own:
 *     the redirect to storage carries no `Authorization` (storage rejects a
 *     request that has both a signature and a token), and an asset url on
 *     another host never receives it.
 *   - The API base is `https://api.github.com` unless `ERIS_UPDATE_API` names
 *     another (a GitHub Enterprise host, or a test's loopback server). It must be
 *     https, or http for a loopback host only, and carry no credentials: the
 *     bearer never travels in the clear to a host nobody chose.
 *   - Every request has an idle deadline, a redirect chain has a limit, and a body
 *     has a size limit, so a stalled or hostile server ends the command.
 *
 * It decides nothing about versions or files; that is src/cli/commands/update.ts.
 */

import { Refusal, reasonOf } from "./refusal";

export const DEFAULT_API = "https://api.github.com/";

/** The loopback hosts an `http:` API base may name (`URL.hostname` brackets IPv6). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const MAX_REDIRECTS = 5;
const MAX_JSON_BYTES = 4 << 20;
export const MAX_TEXT_BYTES = 1 << 20;
export const MAX_BINARY_BYTES = 1 << 30;

/** A release tag as `build()` accepts one (src/build.ts). */
export const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The API base from `ERIS_UPDATE_API`, or the default; null when it is not usable. */
export function parseApiBase(raw: string | undefined): URL | null {
  let url: URL;
  try {
    url = new URL(raw === undefined || raw === "" ? DEFAULT_API : raw);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  if (url.protocol === "http:" ? !LOOPBACK_HOSTS.has(url.hostname) : url.protocol !== "https:") return null;
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url;
}

/** Whether the token may go to `api`: GitHub's own API, or a loopback host on any scheme. */
export function sendsToken(api: URL): boolean {
  return api.origin === new URL(DEFAULT_API).origin || LOOPBACK_HOSTS.has(api.hostname);
}

/** Whether a download may follow a redirect (or list an asset) at `to`: https always, http only under a loopback `http:` API. */
export function allowedRedirect(api: URL, to: URL): boolean {
  return to.protocol === "https:" || (to.protocol === "http:" && api.protocol === "http:");
}

export interface Asset {
  readonly name: string;
  readonly url: URL;
}

export interface Release {
  readonly tag: string;
  readonly prerelease: boolean;
  readonly draft: boolean;
  readonly assets: readonly Asset[];
}

export interface GitHubOptions {
  readonly base: URL;
  /** Sent to `base`'s origin and nowhere else. */
  readonly token: string | undefined;
  /** `owner/name`. */
  readonly repo: string;
  readonly userAgent: string;
  /** How long the API may stay silent, in ms. */
  readonly apiTimeoutMs: number;
  /** How long a download may stay silent between two chunks, in ms. */
  readonly downloadTimeoutMs: number;
}

/** An idle deadline: `touch` restarts it, and when it runs out `signal` aborts. */
class Deadline {
  private readonly ctl = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  fired = false;
  constructor(readonly ms: number) {
    this.touch();
  }
  get signal(): AbortSignal {
    return this.ctl.signal;
  }
  touch(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.fired = true;
      this.ctl.abort();
    }, this.ms);
  }
  done(): void {
    clearTimeout(this.timer);
  }
}

const seconds = (ms: number): string => String(+(ms / 1000).toFixed(2));
const isoSeconds = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

const TOKEN_NAMES = "GH_TOKEN (or GITHUB_TOKEN)";

export class GitHub {
  constructor(private readonly o: GitHubOptions) {}

  private get host(): string {
    return this.o.base.host;
  }

  private get api(): string {
    return this.o.base.href.replace(/\/$/, "");
  }

  private get releasesUrl(): string {
    return `https://github.com/${this.o.repo}/releases`;
  }

  private unreachable(why: string): Refusal {
    return new Refusal({
      slug: "update-unreachable",
      what: why,
      fix: `check the network connection (eris update needs https access to ${this.host}), then run eris update again`,
    });
  }

  private apiError(what: string, fix: string): Refusal {
    return new Refusal({ slug: "update-api-error", what, fix });
  }

  /** The refusal for a non-success answer. `notFound` says what a 404 means for the request. */
  private refusal(res: Response, notFound: () => Refusal): Refusal {
    const status = res.status;
    const limited = status === 429 || (status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")));
    if (limited) {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const until = Number.isFinite(reset) && reset > 0 ? isoSeconds(reset) : undefined;
      const retry = res.headers.get("retry-after");
      const when = until !== undefined ? ` until ${until}` : retry !== null && /^\d{1,6}$/.test(retry) ? ` for ${retry}s` : "";
      return new Refusal({
        slug: "update-rate-limited",
        what: `${this.host} refused the request: the rate limit is spent${when}`,
        fix:
          this.o.token === undefined
            ? `set ${TOKEN_NAMES} to a GitHub token: an authenticated request has a far higher limit than an anonymous one\nthen run eris update again`
            : `the limit for ${TOKEN_NAMES} is spent: wait${when === "" ? "" : ` (it resets${when})`}, then run eris update again`,
      });
    }
    if (status === 404) return notFound();
    const what = `${this.host} answered ${status}${res.statusText !== "" ? ` ${res.statusText.replace(/[^\x20-\x7e]/g, "")}` : ""}`;
    if (status === 401) {
      return this.apiError(
        what,
        this.o.token === undefined
          ? `the API asked for credentials: set ${TOKEN_NAMES} to a GitHub token that can read ${this.o.repo}`
          : `${TOKEN_NAMES} was rejected: unset it, or replace it with a valid token`,
      );
    }
    if (status === 403) return this.apiError(what, `if ${this.o.repo} is private, ${TOKEN_NAMES} must be a token that can read it`);
    return this.apiError(what, `retry in a few minutes; if it persists, check ${this.releasesUrl}`);
  }

  private releaseNotFound(tag: string | undefined): Refusal {
    return this.o.token === undefined
      ? new Refusal({
          slug: "update-needs-token",
          what: `${this.host} answered 404 for ${this.o.repo}'s ${tag === undefined ? "latest release" : `release ${tag}`}, and no token is set`,
          fix: `if ${this.o.repo} is private, set ${TOKEN_NAMES} to a token that can read it, then run eris update again\notherwise the release does not exist: see ${this.releasesUrl}`,
        })
      : notFound(this.o.repo, tag);
  }

  /**
   * One GET with redirects followed by hand. The `Authorization` header is set per
   * hop, for the API's origin only. The deadline restarts on every hop, and the
   * caller restarts it per chunk while it reads the body.
   */
  private async get(first: URL, accept: string, idleMs: number): Promise<{ res: Response; deadline: Deadline }> {
    const deadline = new Deadline(idleMs);
    let at = first;
    try {
      for (let hops = 0; ; hops++) {
        const headers = new Headers({ accept, "user-agent": this.o.userAgent });
        if (at.origin === this.o.base.origin) {
          headers.set("x-github-api-version", "2022-11-28");
          if (this.o.token !== undefined) headers.set("authorization", `Bearer ${this.o.token}`);
        }
        deadline.touch();
        const res = await fetch(at, { headers, redirect: "manual", signal: deadline.signal });
        if (![301, 302, 303, 307, 308].includes(res.status)) return { res, deadline };
        await res.body?.cancel();
        const location = res.headers.get("location");
        if (hops >= MAX_REDIRECTS) throw this.apiError(`${at.host} redirected ${MAX_REDIRECTS + 1} times in a row`, `retry in a few minutes; if it persists, check ${this.releasesUrl}`);
        let next: URL | undefined;
        try {
          next = location === null ? undefined : new URL(location, at);
        } catch {
          next = undefined;
        }
        if (next === undefined || !allowedRedirect(this.o.base, next)) {
          throw this.apiError(`${at.host} redirected to a location eris will not follow`, `retry in a few minutes; if it persists, check ${this.releasesUrl}`);
        }
        at = next;
      }
    } catch (e) {
      deadline.done();
      if (e instanceof Refusal) throw e;
      throw this.unreachable(deadline.fired ? `${at.host} did not respond within ${seconds(idleMs)}s` : `could not reach ${at.host}: ${reasonOf(e)}`);
    }
  }

  /** Every chunk of the body to `onChunk`, refusing past `limit` bytes. */
  private async read(res: Response, deadline: Deadline, limit: number, onChunk: (chunk: Uint8Array) => void): Promise<void> {
    const reader = res.body?.getReader();
    if (reader === undefined) return;
    let total = 0;
    try {
      for (;;) {
        deadline.touch();
        const { done, value } = await reader.read();
        if (done) return;
        total += value.length;
        if (total > limit) {
          await reader.cancel();
          throw this.apiError(`${res.url === "" ? this.host : new URL(res.url).host} sent more than ${limit} bytes`, "this is not a release eris recognises; check the release page");
        }
        onChunk(value);
      }
    } catch (e) {
      if (e instanceof Refusal) throw e;
      throw this.unreachable(deadline.fired ? `${this.host} stopped sending data for ${seconds(deadline.ms)}s` : `the download from ${this.host} failed: ${reasonOf(e)}`);
    } finally {
      deadline.done();
    }
  }

  private async text(res: Response, deadline: Deadline, limit: number): Promise<string> {
    const chunks: Uint8Array[] = [];
    await this.read(res, deadline, limit, (c) => chunks.push(c));
    return Buffer.concat(chunks).toString("utf8");
  }

  /** The latest release, or the one tagged `tag`. */
  async release(tag: string | undefined): Promise<Release> {
    const path = tag === undefined ? "latest" : `tags/${encodeURIComponent(tag)}`;
    const { res, deadline } = await this.get(new URL(`${this.api}/repos/${this.o.repo}/releases/${path}`), "application/vnd.github+json", this.o.apiTimeoutMs);
    if (!res.ok) {
      deadline.done();
      await res.body?.cancel();
      throw this.refusal(res, () => this.releaseNotFound(tag));
    }
    const malformed = () => this.apiError(`${this.host} answered with something that is not a release record`, `retry in a few minutes; if it persists, check ${this.releasesUrl}`);
    let body: unknown;
    try {
      body = JSON.parse(await this.text(res, deadline, MAX_JSON_BYTES));
    } catch (e) {
      if (e instanceof Refusal) throw e;
      throw malformed();
    }
    const r = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    if (typeof r.tag_name !== "string" || !TAG.test(r.tag_name) || !Array.isArray(r.assets)) throw malformed();
    const assets: Asset[] = [];
    for (const a of r.assets as unknown[]) {
      const rec = (typeof a === "object" && a !== null ? a : {}) as Record<string, unknown>;
      let url: URL | undefined;
      try {
        url = typeof rec.url === "string" ? new URL(rec.url) : undefined;
      } catch {
        url = undefined;
      }
      if (typeof rec.name !== "string" || url === undefined || !allowedRedirect(this.o.base, url)) throw malformed();
      assets.push({ name: rec.name, url });
    }
    return { tag: r.tag_name, prerelease: r.prerelease === true, draft: r.draft === true, assets };
  }

  /** An asset's bytes, to `onChunk`, in order. */
  async download(asset: Asset, limit: number, onChunk: (chunk: Uint8Array) => void): Promise<void> {
    const { res, deadline } = await this.get(asset.url, "application/octet-stream", this.o.downloadTimeoutMs);
    if (!res.ok) {
      deadline.done();
      await res.body?.cancel();
      throw this.refusal(res, () => this.assetNotFound(asset));
    }
    await this.read(res, deadline, limit, onChunk);
  }

  /** An asset's text. */
  async downloadText(asset: Asset): Promise<string> {
    const chunks: Uint8Array[] = [];
    await this.download(asset, MAX_TEXT_BYTES, (c) => chunks.push(c));
    return Buffer.concat(chunks).toString("utf8");
  }

  private assetNotFound(asset: Asset): Refusal {
    return new Refusal({
      slug: "update-asset-missing",
      what: `${this.host} listed ${asset.name} but answered 404 for it`,
      fix: `retry in a few minutes; if it persists, the release is incomplete: check ${this.releasesUrl}`,
    });
  }
}

/** A release the repository does not have (or has only as a draft or prerelease). */
export function notFound(repo: string, tag: string | undefined, why = ""): Refusal {
  return new Refusal({
    slug: "update-release-not-found",
    what: `${repo} has no ${tag === undefined ? "published release" : `release ${tag}`} that eris can install${why}`,
    fix: `check the tag against https://github.com/${repo}/releases\nif ${repo} is private, ${TOKEN_NAMES} must be a token that can read it`,
  });
}
