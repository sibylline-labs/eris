/**
 * release-fixture.ts — a loopback stand-in for GitHub's releases API, for
 * `eris update`. Two real `Bun.serve` listeners, never a PATH `curl` fake
 * (`fetch()` cannot be intercepted that way):
 *
 *   - `api`: `/repos/<repo>/releases/latest`, `/releases/tags/<tag>` and
 *     `/releases/assets/<id>`, which answers a download request with a redirect to
 *   - `cdn`: a second origin (another port) that serves the bytes, as GitHub's
 *     API hands an asset download to its storage host. Every request to either
 *     server is recorded with the `Authorization` and `Accept` it carried.
 *
 * `private: true` makes the API answer 404 to a request without the fixture's
 * token, as GitHub does for a private repository. `override` takes over any
 * request (a status, a hang); the asset download calls `midDownload` between
 * two halves of the body, so a test can look at the disk while it streams.
 */

import { createHash } from "node:crypto";

export interface Hit {
  server: "api" | "cdn";
  path: string;
  authorization: string | null;
  accept: string | null;
}

export interface PublishedRelease {
  tag: string;
  prerelease: boolean;
  draft: boolean;
  /** name → id */
  ids: Map<string, number>;
}

export const sha256Hex = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export interface ReleaseFixture {
  repo: string;
  /** The API base (`ERIS_UPDATE_API`). */
  api: string;
  cdn: string;
  hits: Hit[];
  /** Publish a release. `sums`: "auto" lists every asset; a string replaces the file; null omits it. */
  publish(r: { tag: string; prerelease?: boolean; draft?: boolean; assets: Record<string, string | Uint8Array>; sums?: "auto" | string | null }): PublishedRelease;
  /** What `releases/latest` answers (a tag), else the newest published non-prerelease. */
  latest: string | null;
  /** Requests to a path under `/browser/` (the `browser_download_url` shape), which a private repository 404s. */
  browserHits(): number;
  /** Take over a request: return a Response, or undefined to serve it normally. */
  override: ((req: Request, server: "api" | "cdn") => Response | Promise<Response | undefined> | undefined) | null;
  /** Called between the two halves of an asset body. */
  midDownload: (() => void) | null;
  /** Answer 404 on the API to a request without this token. */
  requireToken: string | null;
  /** Point `assets[].url` at the cdn directly instead of at the API's download endpoint. */
  assetUrlsOnCdn: boolean;
  stop(): void;
}

export function releaseFixture(repo = "sibylline-labs/eris"): ReleaseFixture {
  const releases = new Map<string, PublishedRelease>();
  const bodies = new Map<number, Uint8Array>();
  let nextId = 100;
  let apiBase = "";
  let cdnBase = "";

  const json = (value: unknown, status = 200): Response => Response.json(value, { status });
  const toBytes = (v: string | Uint8Array): Uint8Array => (typeof v === "string" ? new TextEncoder().encode(v) : v);

  const fx: ReleaseFixture = {
    repo,
    api: "",
    cdn: "",
    hits: [],
    latest: null,
    override: null,
    midDownload: null,
    requireToken: null,
    assetUrlsOnCdn: false,
    browserHits: () => fx.hits.filter((h) => h.path.startsWith("/browser/")).length,
    publish({ tag, prerelease = false, draft = false, assets, sums = "auto" }) {
      const ids = new Map<string, number>();
      const add = (name: string, bytes: Uint8Array) => {
        const id = nextId++;
        ids.set(name, id);
        bodies.set(id, bytes);
      };
      for (const [name, v] of Object.entries(assets)) add(name, toBytes(v));
      if (sums === "auto") {
        add("SHA256SUMS", toBytes(Object.entries(assets).map(([name, v]) => `${sha256Hex(toBytes(v))}  ${name}\n`).join("")));
      } else if (sums !== null) add("SHA256SUMS", toBytes(sums));
      const rel: PublishedRelease = { tag, prerelease, draft, ids };
      releases.set(tag, rel);
      return rel;
    },
    stop() {
      api.stop(true);
      cdn.stop(true);
    },
  };

  const describeRelease = (rel: PublishedRelease) => ({
    tag_name: rel.tag,
    name: rel.tag,
    draft: rel.draft,
    prerelease: rel.prerelease,
    assets: [...rel.ids].map(([name, id]) => ({
      id,
      name,
      size: bodies.get(id)!.length,
      url: fx.assetUrlsOnCdn ? `${cdnBase}/blob/${id}` : `${apiBase}/repos/${repo}/releases/assets/${id}`,
      browser_download_url: `${cdnBase}/browser/${rel.tag}/${name}`,
    })),
  });

  const newest = (): PublishedRelease | undefined => [...releases.values()].filter((r) => !r.prerelease && !r.draft).at(-1);

  const record = (server: "api" | "cdn", req: Request): void => {
    fx.hits.push({ server, path: new URL(req.url).pathname, authorization: req.headers.get("authorization"), accept: req.headers.get("accept") });
  };

  const stream = (bytes: Uint8Array): Response => {
    const half = Math.floor(bytes.length / 2);
    return new Response(
      new ReadableStream({
        async start(c) {
          c.enqueue(bytes.slice(0, half));
          await new Promise((r) => setTimeout(r, 25));
          fx.midDownload?.();
          c.enqueue(bytes.slice(half));
          c.close();
        },
      }),
      { headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) } },
    );
  };

  const api = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      record("api", req);
      const taken = await fx.override?.(req, "api");
      if (taken !== undefined) return taken;
      const path = new URL(req.url).pathname;
      if (fx.requireToken !== null && req.headers.get("authorization") !== `Bearer ${fx.requireToken}`) return json({ message: "Not Found" }, 404);
      const prefix = `/repos/${repo}/releases`;
      if (path === `${prefix}/latest`) {
        const rel = (fx.latest !== null ? releases.get(fx.latest) : undefined) ?? newest();
        return rel === undefined ? json({ message: "Not Found" }, 404) : json(describeRelease(rel));
      }
      if (path.startsWith(`${prefix}/tags/`)) {
        const rel = releases.get(decodeURIComponent(path.slice(`${prefix}/tags/`.length)));
        return rel === undefined ? json({ message: "Not Found" }, 404) : json(describeRelease(rel));
      }
      if (path.startsWith(`${prefix}/assets/`)) {
        const id = Number(path.slice(`${prefix}/assets/`.length));
        if (!bodies.has(id)) return json({ message: "Not Found" }, 404);
        // GitHub answers a download request (octet-stream) with a redirect to its storage host.
        if (req.headers.get("accept") !== "application/octet-stream") return json({ id });
        return new Response(null, { status: 302, headers: { location: `${cdnBase}/blob/${id}` } });
      }
      return json({ message: "Not Found" }, 404);
    },
  });

  const cdn = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      record("cdn", req);
      const taken = await fx.override?.(req, "cdn");
      if (taken !== undefined) return taken;
      const path = new URL(req.url).pathname;
      if (path.startsWith("/blob/")) {
        const bytes = bodies.get(Number(path.slice("/blob/".length)));
        return bytes === undefined ? new Response("missing", { status: 404 }) : stream(bytes);
      }
      // The `browser_download_url` shape: 404 for a private repository, never what update fetches.
      return new Response("not found", { status: 404 });
    },
  });

  apiBase = `http://127.0.0.1:${api.port}`;
  cdnBase = `http://127.0.0.1:${cdn.port}`;
  fx.api = apiBase;
  fx.cdn = cdnBase;
  return fx;
}
