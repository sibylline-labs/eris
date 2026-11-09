/**
 * `eris tokens ls|create|revoke`.
 *
 * The seam is the tokens group handler (`runTokens`) with a loopback
 * `Bun.serve` standing in for the gateway's `/v1/org/tokens` routes and a
 * sandbox HOME holding the login. Every request crosses real HTTP; the server
 * records each one so a test can assert what was sent. The plaintext secret is
 * assembled at runtime so no literal trips a secret scanner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runTokens } from "../plugins/yak/tokens";
import { CliExit } from "../src/cli/ts-verb";

const REPO = resolve(import.meta.dir, "..");
const B64 = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
const ORG = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const bearer = (secret: string) => ["sib", ORG, secret].join("_");
const LOGIN = bearer(B64);
const MINTED = bearer("ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210-_ZyXwV");
const TOKEN_ID = "01K0000000000000000000000A";

type Route = (req: Request, body: unknown) => Response;

let sandbox: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let routes: Record<string, Route>;
const requests: { method: string; path: string; body: unknown; auth: string | null }[] = [];

const listBody = () => ({
  tokens: [
    { id: TOKEN_ID, name: "ci", kind: "service", scopes: [{ product: "yak", access: "write" }, { product: "graph", access: "read" }], createdAt: "2026-11-09T10:00:00.000Z", lastUsedAt: null },
    { id: "01K0000000000000000000000B", name: "laptop", kind: "user", scopes: [{ product: "accounts", access: "admin" }], memberId: "m1", device: "laptop", createdAt: "2026-11-01T09:30:00.000Z", lastUsedAt: "2026-11-08T12:00:00.000Z" },
  ],
  entitled: ["yak", "graph"],
  serviceTokens: { live: 1, limit: 3 },
});
const mintedBody = () => ({ token: MINTED, tokenId: TOKEN_ID, name: "ci", scopes: [{ product: "yak", access: "write" }] });
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  Response.json({ type: "about:blank", status, error: { code }, ...extra }, { status, headers: { "content-type": "application/problem+json" } });

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "tokens-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      const body: unknown = text.length > 0 ? JSON.parse(text) : undefined;
      requests.push({ method: req.method, path: url.pathname, body, auth: req.headers.get("authorization") });
      const route = routes[`${req.method} ${url.pathname}`] ?? (url.pathname.startsWith("/v1/org/tokens/") ? routes[`${req.method} /v1/org/tokens/:id`] : undefined);
      return route ? route(req, body) : problem(404, "not_found");
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(sandbox, "home-")));
  mkdirSync(join(home, ".eris"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".eris", "yaks.json"), JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token: LOGIN }), { mode: 0o600 });
  requests.length = 0;
  routes = {
    "GET /v1/org/tokens": () => Response.json(listBody()),
    "POST /v1/org/tokens": () => Response.json(mintedBody(), { status: 201 }),
    "DELETE /v1/org/tokens/:id": () => Response.json({ tokenId: TOKEN_ID }),
  };
});

interface Captured {
  rc: number;
  stdout: string;
  stderr: string;
}

async function tokens(args: string[], format: "text" | "json" = "text"): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  let rc: number;
  try {
    rc = await runTokens(
      args,
      {
        erisDir: REPO,
        env: { PATH: process.env.PATH, HOME: home },
        format,
        stdout: { write: (s: string) => ((stdout += s), true) },
        stderr: { write: (s: string) => ((stderr += s), true) },
      },
      { cwd: sandbox },
    );
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    rc = e.code;
  }
  return { rc, stdout, stderr };
}

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("eris tokens ls", () => {
  it("text: one row per token, the cap on stderr, and nothing else on stdout", async () => {
    /** When ls drops the scope column or prints the cap on stdout, a script parsing the table breaks or an admin cannot see how many free tokens remain: observed on both streams. */
    const r = await tokens(["ls"]);
    expect(r.rc).toBe(0);
    expect(r.stdout.split("\n")[0]).toMatch(/^id\s+name\s+kind\s+scope\s+created\s+last used$/);
    expect(r.stdout).toContain(`${TOKEN_ID}  ci`);
    expect(r.stdout).toContain("yak:write,graph:read");
    expect(r.stdout).toContain("never");
    expect(r.stderr).toContain("service tokens: 1 of 3");
    expect(requests[0]).toMatchObject({ method: "GET", path: "/v1/org/tokens", auth: `Bearer ${LOGIN}` });
  });

  it("json: the server's body, bare, with nothing on stderr", async () => {
    /** When json mode reshapes the list or leaks the cap note to stderr, a machine caller's parse breaks: observed on both streams. */
    const r = await tokens(["ls"], "json");
    expect(r).toEqual({ rc: 0, stdout: `${JSON.stringify(listBody())}\n`, stderr: "" });
  });

  it("never prints a secret or hash the server echoes on a row", async () => {
    /** When ls passes a row through unfiltered, a server that echoed a plaintext or hash field puts it on stdout in text and json: observed on stdout. */
    routes["GET /v1/org/tokens"] = () => {
      const body = listBody();
      return Response.json({ ...body, tokens: body.tokens.map((t) => ({ ...t, token: MINTED, tokenHash: "deadbeef" })) });
    };
    for (const format of ["text", "json"] as const) {
      const r = await tokens(["ls"], format);
      expect(r.rc).toBe(0);
      expect(r.stdout + r.stderr).not.toContain(MINTED);
      expect(r.stdout + r.stderr).not.toContain("deadbeef");
    }
  });
});

describe("eris tokens create", () => {
  it("text: the secret is the only line on stdout, once, and the id and scopes go to stderr", async () => {
    /** When create prints the secret twice, to stderr, or with decoration, a `$(eris tokens create ...)` capture holds the wrong value or the secret lands in a log: observed on both streams. */
    const r = await tokens(["create", "--name", "ci", "--scope", "yak:write"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toBe(`${MINTED}\n`);
    expect(r.stderr).not.toContain(MINTED);
    expect(r.stderr).toContain(TOKEN_ID);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "POST", path: "/v1/org/tokens", auth: `Bearer ${LOGIN}`, body: { kind: "service", name: "ci", scopes: [{ product: "yak", access: "write" }] } });
  });

  it("json: the minted body once, the secret nowhere else", async () => {
    /** When json mode also echoes the secret on stderr, or ls later prints it, the "shown once" promise is false: observed on both streams. */
    const r = await tokens(["create", "--name", "ci", "--scope", "yak:write"], "json");
    expect(r.rc).toBe(0);
    expect(r.stdout).toBe(`${JSON.stringify(mintedBody())}\n`);
    expect(occurrences(r.stdout, MINTED)).toBe(1);
    expect(r.stderr).toBe("");
  });

  it("repeats --scope into the scopes list in order", async () => {
    /** When a second --scope replaces the first, the token is minted narrower or wider than asked: observed in the body the server receives. */
    await tokens(["create", "--name", "ci", "--scope", "yak:write", "--scope", "graph:read"]);
    expect(requests[0]?.body).toMatchObject({ scopes: [{ product: "yak", access: "write" }, { product: "graph", access: "read" }] });
  });

  it("refuses the 3-free cap as tokens-service-limit: exit 1, nothing on stdout", async () => {
    /** When the 409 cap reads as a generic failure, an admin retries instead of revoking one: observed in the slug and the empty stdout. */
    routes["POST /v1/org/tokens"] = () => problem(409, "service_token_limit");
    const r = await tokens(["create", "--name", "ci", "--scope", "yak:write"]);
    expect(r.rc).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("slug: tokens-service-limit");
    expect(r.stderr).toContain("eris tokens revoke");
  });

  it("maps a member's 403 admin_required, a 400 invalid_spec and a 401 to their slugs", async () => {
    /** When the refusals collapse to one slug, a member cannot tell "ask an admin" from "fix the scope" from "log in again": observed in each slug. */
    const cases: [number, string, string][] = [
      [403, "admin_required", "tokens-admin-required"],
      [400, "invalid_spec", "tokens-invalid-spec"],
      [401, "unauthorized", "yak-unauthorized"],
      [403, "user_required", "tokens-forbidden"],
    ];
    for (const [status, code, slug] of cases) {
      routes["POST /v1/org/tokens"] = () => problem(status, code);
      const r = await tokens(["create", "--name", "ci", "--scope", "yak:write"]);
      expect(r.rc).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(`slug: ${slug}`);
    }
  });

  it("never echoes a server error body into the block", async () => {
    /** When a refusal prints the response text, a server that included the credential in an error body leaks it to stderr: observed on stderr. */
    routes["POST /v1/org/tokens"] = () => problem(500, "boom", { detail: `token ${MINTED}` });
    const r = await tokens(["create", "--name", "ci", "--scope", "yak:write"]);
    expect(r.rc).toBe(1);
    expect(r.stdout + r.stderr).not.toContain(MINTED);
    expect(r.stderr).toContain("slug: tokens-unavailable");
  });

  it("rejects bad input before any request is sent", async () => {
    /** When validation happens server-side only, a typo'd scope spends a round trip and an unbounded name reaches the wire: observed in the slug and the empty request log. */
    const cases: [string[], string][] = [
      [["create", "--scope", "yak:write"], "tokens-name-required"],
      [["create", "--name", "ci"], "tokens-scope-required"],
      [["create", "--name", "ci", "--scope", "yak"], "tokens-scope-invalid"],
      [["create", "--name", "ci", "--scope", "yak:owner"], "tokens-scope-invalid"],
      [["create", "--name", "x".repeat(129), "--scope", "yak:write"], "tokens-name-invalid"],
      [["create", "--name", "ci", ...Array.from({ length: 17 }, (_, i) => ["--scope", `p${i}:read`]).flat()], "tokens-scope-invalid"],
    ];
    for (const [args, slug] of cases) {
      const r = await tokens(args);
      expect(r.rc).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(`slug: ${slug}`);
    }
    expect(requests).toHaveLength(0);
  });
});

describe("eris tokens revoke", () => {
  it("text: names the id it revoked and sends DELETE with the id encoded", async () => {
    /** When revoke sends the id unencoded or to the wrong path, a crafted id reaches another route: observed in the path the server receives. */
    const r = await tokens(["revoke", "a/b c"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toBe(`revoked ${TOKEN_ID}\n`);
    expect(requests[0]).toMatchObject({ method: "DELETE", path: "/v1/org/tokens/a%2Fb%20c", auth: `Bearer ${LOGIN}` });
  });

  it("json: the ack, bare", async () => {
    /** When json mode wraps the ack, a machine caller cannot read the revoked id: observed on stdout. */
    const r = await tokens(["revoke", TOKEN_ID], "json");
    expect(r).toEqual({ rc: 0, stdout: `${JSON.stringify({ tokenId: TOKEN_ID })}\n`, stderr: "" });
  });

  it("an unknown id is tokens-not-found, exit 1", async () => {
    /** When a revoke of an unknown id exits 0, a script believes a token it never killed is dead: observed in the exit code. */
    routes["DELETE /v1/org/tokens/:id"] = () => problem(404, "not_found");
    const r = await tokens(["revoke", TOKEN_ID]);
    expect(r.rc).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("slug: tokens-not-found");
  });

  it("no id is tokens-id-required and sends nothing", async () => {
    /** When revoke without an id sends DELETE /v1/org/tokens/, a router that maps it to the collection could act on it: observed in the empty request log. */
    const r = await tokens(["revoke"]);
    expect(r.rc).toBe(1);
    expect(r.stderr).toContain("slug: tokens-id-required");
    expect(requests).toHaveLength(0);
  });
});

describe("eris tokens (group)", () => {
  it("bare prints the usage on stdout; an unknown sub is tokens-unknown-command", async () => {
    /** When a typo'd sub falls through to ls, a user who meant revoke lists instead and believes it ran: observed in the slug and the empty request log. */
    const bare = await tokens([]);
    expect(bare.rc).toBe(0);
    expect(bare.stdout).toContain("Usage: eris tokens");
    const bad = await tokens(["delete", TOKEN_ID]);
    expect(bad.rc).toBe(1);
    expect(bad.stderr).toContain("slug: tokens-unknown-command");
    expect(requests).toHaveLength(0);
  });
});
