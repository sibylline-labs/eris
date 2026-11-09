/**
 * `eris org members` and `eris org members deactivate <id>`.
 *
 * The seam is the group handler (`runOrg`) with a loopback `Bun.serve` standing in for the
 * gateway's `/v1/org/*` routes, and a sandbox HOME holding one signed-in org. Every request
 * crosses real HTTP; the server records what it received so a test can assert what was sent.
 * The bearer is assembled at runtime so no literal trips a secret scanner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runOrg } from "../plugins/yak/org";
import { CliExit } from "../src/cli/ts-verb";

const REPO = resolve(import.meta.dir, "..");
const ORG = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const TOKEN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const ADA = "01J0AAAAAAAAAAAAAAAAAAAAAA";
const MIA = "01J0BBBBBBBBBBBBBBBBBBBBBB";

const MEMBERS = {
  members: [
    { memberId: ADA, name: "Ada Admin", email: "ada@example.test", role: "admin", status: "active", seats: ["yak", "linear-proxy"] },
    { memberId: MIA, name: null, email: "mia@example.test", role: "member", status: "deactivated", seats: [] },
  ],
};

const problem = (status: number, code: string) =>
  new Response(JSON.stringify({ type: "urn:hera:error:" + code, title: code, status, code, detail: "d" }), { status, headers: { "content-type": "application/problem+json" } });

let sandbox: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let reply: (req: Request) => Response;
const seen: { method: string; path: string; auth: string | null }[] = [];

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "org-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      seen.push({ method: req.method, path: new URL(req.url).pathname, auth: req.headers.get("authorization") });
      return reply(req);
    },
  });
  home = join(sandbox, "home");
  mkdirSync(join(home, ".eris"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".eris", "yaks.json"), JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token: TOKEN }), { mode: 0o600 });
});
afterAll(() => {
  server.stop(true);
  rmSync(sandbox, { recursive: true, force: true });
});
beforeEach(() => {
  seen.length = 0;
  reply = () => Response.json(MEMBERS);
});

async function run(args: string[], format: "text" | "json" = "text", homeDir = home) {
  const out = { stdout: "", stderr: "" };
  const ctx = {
    erisDir: REPO,
    env: { PATH: process.env.PATH, HOME: homeDir },
    format,
    stdout: { write: (s: string) => ((out.stdout += s), true) },
    stderr: { write: (s: string) => ((out.stderr += s), true) },
  };
  let code: number;
  try {
    code = await runOrg(args, ctx, { cwd: sandbox, home: homeDir });
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    code = e.code;
  }
  return { code, ...out };
}

describe("eris org members", () => {
  it("lists the members the dash lists: name or email, role, status, seat names", async () => {
    /** When the table drops a dash column or prints raw seat ids, the CLI list stops matching the dashboard's Members page: observed in the stdout rows. */
    const r = await run(["members"]);
    expect(r.code).toBe(0);
    expect(seen).toEqual([{ method: "GET", path: "/v1/org/members", auth: `Bearer ${TOKEN}` }]);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^NAME\s+EMAIL\s+ROLE\s+STATUS\s+SEATS$/);
    expect(lines[1]).toMatch(/^Ada Admin\s+ada@example\.test\s+admin\s+active\s+Yaks, Linear proxy$/);
    expect(lines[2]).toMatch(/^mia\s+mia@example\.test\s+member\s+deactivated\s+none$/);
    expect(lines).toHaveLength(3);
    expect(r.stderr).toBe("");
  });

  it("prints the server body bare under --output json", async () => {
    /** When json mode reshapes or wraps the body, a script reading `.members[].memberId` breaks: observed in the parsed stdout. */
    const r = await run(["members"], "json");
    expect(JSON.parse(r.stdout)).toEqual(MEMBERS);
    expect(r.stderr).toBe("");
  });

  it("refuses a body that does not match the contract", async () => {
    /** When a changed server body is printed as if valid, the list shows nothing silently: observed in the exit code and the slug. */
    reply = () => Response.json({ members: [{ memberId: ADA }] });
    const r = await run(["members"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("slug: org-unavailable");
  });

  it("answers 401 with the sign-in fix", async () => {
    /** When a rejected bearer is reported as a generic failure, the operator is not told to log in again: observed in the slug and fix. */
    reply = () => problem(401, "invalid_token");
    const r = await run(["members"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("slug: org-unauthorized");
    expect(r.stderr).toContain("eris login");
  });

  it("reports an unreachable endpoint", async () => {
    /** When a refused connection escapes as a stack trace, the operator sees no slug: observed in the stderr block. */
    const dead = join(sandbox, "dead-home");
    mkdirSync(join(dead, ".eris"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dead, ".eris", "yaks.json"), JSON.stringify({ url: "http://127.0.0.1:1", token: TOKEN }), { mode: 0o600 });
    const r = await run(["members"], "text", dead);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("slug: org-unavailable");
  });

  it("never writes the bearer to either stream", async () => {
    /** When an error path echoes the request headers, the token lands in a terminal or a log: observed in both streams of a success and a failure. */
    const ok = await run(["members"]);
    reply = () => problem(403, "admin_required");
    const bad = await run(["members", "deactivate", MIA]);
    for (const r of [ok, bad]) expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });
});

describe("eris org members deactivate", () => {
  it("posts to the member's deactivate route and says so", async () => {
    /** When the id lands in the wrong path or the wrong verb is sent, a different member is changed or nothing is: observed in the recorded request. */
    reply = () => Response.json({ memberId: MIA, status: "deactivated" });
    const r = await run(["members", "deactivate", MIA]);
    expect(r.code).toBe(0);
    expect(seen).toEqual([{ method: "POST", path: `/v1/org/members/${MIA}/deactivate`, auth: `Bearer ${TOKEN}` }]);
    expect(r.stdout).toBe(`deactivated ${MIA}\n`);
    expect(r.stderr).toBe("");
  });

  it("prints the server body under --output json", async () => {
    /** When json mode prints prose, a script cannot confirm the status: observed in the parsed stdout. */
    reply = () => Response.json({ memberId: MIA, status: "deactivated" });
    const r = await run(["members", "deactivate", MIA], "json");
    expect(JSON.parse(r.stdout)).toEqual({ memberId: MIA, status: "deactivated" });
  });

  it("prints a non-admin's 403 as a clear refusal", async () => {
    /** When the 403 is reported as 'unavailable' or a bare status, the member is not told that only an admin may deactivate: observed in the slug and the what-line. */
    reply = () => problem(403, "admin_required");
    const r = await run(["members", "deactivate", MIA]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("slug: org-admin-required");
    expect(r.stderr).toMatch(/only an admin/i);
  });

  it("maps 404 and the self-deactivation refusal to their own slugs", async () => {
    /** When every refusal collapses into one slug, the operator cannot tell a wrong id from their own id: observed in two slugs. */
    reply = () => problem(404, "member_not_found");
    expect((await run(["members", "deactivate", MIA])).stderr).toContain("slug: org-member-not-found");
    reply = () => problem(400, "cannot_deactivate_self");
    expect((await run(["members", "deactivate", ADA])).stderr).toContain("slug: org-cannot-deactivate-self");
  });

  it("percent-encodes the id operand and needs exactly one", async () => {
    /** When an id with a slash is spliced raw, the request reaches another route: observed in the recorded path, and in the missing-operand failure. */
    reply = () => problem(404, "member_not_found");
    await run(["members", "deactivate", "a/b"]);
    expect(seen[0]?.path).toBe("/v1/org/members/a%2Fb/deactivate");
    seen.length = 0;
    const none = await run(["members", "deactivate"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("slug: org-member-id-missing");
    expect(seen).toEqual([]);
  });
});

describe("eris org", () => {
  it("prints the group usage bare and fails an unknown sub", async () => {
    /** When `eris org` does nothing or an unknown sub exits 0, the group is undiscoverable: observed in stdout and the exit code. */
    const bare = await run([]);
    expect(bare.code).toBe(0);
    expect(bare.stdout).toContain("members deactivate <member-id>");
    const bad = await run(["nope"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("slug: org-unknown-verb");
  });
});
