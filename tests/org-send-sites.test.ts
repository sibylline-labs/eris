/**
 * Where a bearer is sent: a repo whose `eris.yaml` names org B sends org B's
 * bearer to org B's url, never the default org's, from every site that
 * resolves one (`eris yak` submit, `eris yak status` and `ready`, the
 * socrates client, `eris org members`, `eris org members deactivate`, `eris org delete` and `eris org connect-linear`).
 *
 * The seam is each verb's entry point with an injected `fetch` and `cwd` over a
 * sandbox HOME holding two orgs. The resolver itself is covered by
 * credentials-orgs.test.ts; these tests catch a call site that hands it the
 * wrong directory. Bearers are assembled at runtime so no literal trips a
 * secret scanner.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliExit } from "../src/cli/ts-verb";
import { runSocrates } from "../plugins/socrates/submit";
import { runOrg } from "../plugins/yak/org";
import { runYak } from "../plugins/yak/yak";
import { runReady, runStatus } from "../plugins/yak/yak-admin";
import { runTokens } from "../plugins/yak/tokens";

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, "..");
const B64 = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
const ORG_A = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const ORG_B = "01J0AAAAAAAAAAAAAAAAAAAAAB";
const bearer = (org: string) => ["sib", org, B64].join("_");
const TOKEN_A = bearer(ORG_A);
const TOKEN_B = bearer(ORG_B);
const URL_A = "https://a.example.test";
const URL_B = "https://b.example.test";

let sandbox: string;
let home: string;
let repoB: string;
let repoDefault: string;

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "send-sites-")));
  home = join(sandbox, "home");
  mkdirSync(join(home, ".eris"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".eris", "yaks.json"), JSON.stringify({ url: URL_A, token: TOKEN_A, orgs: { [ORG_B]: { url: URL_B, token: TOKEN_B } } }), { mode: 0o600 });
  repoB = join(sandbox, "repo-b");
  mkdirSync(join(repoB, ".git"), { recursive: true });
  writeFileSync(join(repoB, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(repoB, "eris.yaml"), `service: b\nrepo:\n  org: ${ORG_B}\n`);
  repoDefault = join(sandbox, "repo-default");
  mkdirSync(join(repoDefault, ".git"), { recursive: true });
  writeFileSync(join(repoDefault, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(repoDefault, "eris.yaml"), "service: a\n");
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

interface Seen {
  url: string;
  authorization: string | null;
}

/** A fetch that records where each request went and with which bearer, and answers `reply`. */
function recorder(reply: () => unknown): { seen: Seen[]; fetch: typeof fetch } {
  const seen: Seen[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return Response.json(reply());
  }) as unknown as typeof fetch;
  return { seen, fetch: f };
}

const STATUS_BODY = () => ({ configured: true, observation_count: 1, last_filed_issue_identifier: null });
const env = () => ({ PATH: process.env.PATH, HOME: home });
const ctx = () => {
  const out = { stdout: "", stderr: "" };
  return {
    out,
    ctx: {
      erisDir: REPO,
      env: env(),
      format: "text" as const,
      stdout: { write: (s: string) => ((out.stdout += s), true) },
      stderr: { write: (s: string) => ((out.stderr += s), true) },
    },
  };
};
const swallow = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
  }
};

describe("a repo that selects org B sends org B's bearer and url", () => {
  // admits: another send site resolving from the process cwd; only the sites listed here are driven
  it("eris yak submit", async () => {
    /** When yak.ts hands the resolver the wrong cwd, an org-B repo files its yak into the default org with the default bearer: observed in the request the injected fetch receives. */
    for (const [cwd, token, url] of [[repoB, TOKEN_B, URL_B], [repoDefault, TOKEN_A, URL_A]] as const) {
      const { seen, fetch } = recorder(() => ({}));
      await runYak({ argv: ["issue", "--summary", "s", "--body", "b"], env: env(), cwd, home, ppid: 1, fetchImpl: fetch, isStdinTTY: () => true });
      const post = seen.find((r) => r.url.endsWith("/v1/yaks"));
      expect(post).toEqual({ url: `${url}/v1/yaks`, authorization: `Bearer ${token}` });
    }
  });

  // admits: another admin verb resolving from the process cwd; status and ready are the two resolution paths
  it("eris yak status and eris yak ready", async () => {
    /** When yak-admin.ts resolves from process.cwd() instead of the caller's, status and ready read the default org's yaks from an org-B repo: observed in the request the injected fetch receives. */
    for (const run of [runStatus, runReady]) {
      for (const [cwd, token, url] of [[repoB, TOKEN_B, URL_B], [repoDefault, TOKEN_A, URL_A]] as const) {
        const { seen, fetch } = recorder(STATUS_BODY);
        await swallow(() => run([], ctx().ctx, { cwd, home, fetchImpl: fetch }));
        expect(seen[0]).toEqual({ url: `${url}/v1/yaks/status`, authorization: `Bearer ${token}` });
      }
    }
  });

  // admits: another tokens verb resolving from the process cwd; ls, create and revoke are the three sends
  it("eris tokens ls, create and revoke", async () => {
    /** When tokens.ts resolves from process.cwd() instead of the caller's, an org-B repo lists, mints or revokes tokens in the default org with the default bearer: observed in the request the injected fetch receives. */
    const minted = { token: bearer(B64.replace("A", "Z")), tokenId: "01K0000000000000000000000A", name: "n", scopes: [] };
    const verbs: [string[], string, string][] = [
      [["ls"], "GET", "/v1/org/tokens"],
      [["create", "--name", "n", "--scope", "yak:write"], "POST", "/v1/org/tokens"],
      [["revoke", "01K0000000000000000000000A"], "DELETE", "/v1/org/tokens/01K0000000000000000000000A"],
    ];
    for (const [args, method, path] of verbs) {
      for (const [cwd, token, url] of [[repoB, TOKEN_B, URL_B], [repoDefault, TOKEN_A, URL_A]] as const) {
        const seen: (Seen & { method: string })[] = [];
        const f = (async (input: string | URL | Request, init?: RequestInit) => {
          seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization"), method: init?.method ?? "GET" });
          if (method === "GET") return Response.json({ tokens: [], entitled: [], serviceTokens: { live: 0, limit: 3 } });
          return method === "POST" ? Response.json(minted, { status: 201 }) : Response.json({ tokenId: "01K0000000000000000000000A" });
        }) as unknown as typeof fetch;
        await swallow(() => runTokens(args, ctx().ctx, { cwd, home, fetchImpl: f }));
        expect(seen[0]).toEqual({ url: `${url}${path}`, authorization: `Bearer ${token}`, method });
      }
    }
  });

  // admits: another socrates verb resolving elsewhere; every verb shares socratesEndpoint, status is the one driven
  it("eris socrates", async () => {
    /** When socrates/client.ts hands the resolver the wrong cwd, an org-B repo calls the default org's Socrates with the default bearer: observed in the request the injected fetch receives. */
    for (const [cwd, token, url] of [[repoB, TOKEN_B, URL_B], [repoDefault, TOKEN_A, URL_A]] as const) {
      const { seen, fetch } = recorder(() => ({ rubric_version: "rubric@v2", policy_hash: "h", pending_candidates: 0, open_epics: [], contract_version: 1 }));
      await swallow(() => runSocrates(["status"], ctx().ctx, { cwd, home, fetch }));
      expect(seen[0]?.authorization).toBe(`Bearer ${token}`);
      expect(seen[0]?.url.startsWith(url)).toBe(true);
    }
  });

  // admits: another org verb resolving from the process cwd; both org verbs share runOrg's request, each is driven
  it("eris org members, members deactivate and delete", async () => {
    /** When org.ts resolves from process.cwd() instead of the caller's, an org-B repo lists or deactivates the default org's members with the default bearer: observed in the request the injected fetch receives, from an org-B repo, a default repo and a directory (`/`) with no eris.yaml at all. */
    const members = { members: [] };
    const deactivated = { memberId: "01J0CCCCCCCCCCCCCCCCCCCCCC", status: "deactivated" };
    for (const [args, body, path] of [
      [["members"], members, "/v1/org/members"],
      [["members", "deactivate", "01J0CCCCCCCCCCCCCCCCCCCCCC"], deactivated, "/v1/org/members/01J0CCCCCCCCCCCCCCCCCCCCCC/deactivate"],
      [["delete", "--confirm", "Acme"], { dueAt: "2026-11-17T12:00:00.000Z", cause: "self_serve" }, "/v1/org/deletion"],
      [["delete", "--cancel"], { cancelled: true }, "/v1/org/deletion"],
    ] as const) {
      for (const [cwd, token, url] of [[repoB, TOKEN_B, URL_B], [repoDefault, TOKEN_A, URL_A], ["/", TOKEN_A, URL_A]] as const) {
        const { seen, fetch } = recorder(() => body);
        await swallow(() => runOrg([...args], ctx().ctx, { cwd, home, fetchImpl: fetch }));
        expect(seen[0]).toEqual({ url: `${url}${path}`, authorization: `Bearer ${token}` });
      }
    }
  });
  // admits: another org verb resolving from the process cwd; connect-linear sends twice (the org read, the mint) and polls, so each send is checked
  it("eris org connect-linear", async () => {
    /** When connect-linear's reads or its mint resolve from process.cwd(), an org-B repo mints an install link for the default org with the default bearer, so the browser connects the wrong workspace: observed in the url and bearer of every request the injected fetch receives, from an org-B repo, a default repo and a directory (`/`) with no eris.yaml. */
    for (const [cwd, token, url] of [[repoB, TOKEN_B, URL_B], [repoDefault, TOKEN_A, URL_A], ["/", TOKEN_A, URL_A]] as const) {
      const seen: (Seen & { method: string })[] = [];
      const f = (async (input: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization"), method });
        if (method === "POST") return Response.json({ url: "https://dash.example.test/auth/linear/connect?link=x", expires_at: new Date(Date.now() + 600_000).toISOString() }, { status: 201 });
        return Response.json({ orgId: ORG_A, memberId: "m", role: "admin", linear: { status: seen.length > 2 ? "connected" : "disconnected" } });
      }) as unknown as typeof fetch;
      await swallow(() => runOrg(["connect-linear"], ctx().ctx, { cwd, home, fetchImpl: f, openBrowser: async () => {}, sleep: async () => {} }));
      expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${url}/v1/org/me`, `POST ${url}/v1/org/linear/connect`, `GET ${url}/v1/org/me`]);
      for (const r of seen) expect(r.authorization).toBe(`Bearer ${token}`);
    }
  });
});
