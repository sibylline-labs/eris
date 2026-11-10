/**
 * `eris org members`, `eris org members deactivate <id>` and `eris org delete --confirm|--cancel`.
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

const WORKSPACE = "Acme Labs";
const DUE = "2026-11-17T12:00:00.000Z";

const problem = (status: number, code: string) =>
  new Response(JSON.stringify({ type: "urn:hera:error:" + code, title: code, status, code, detail: "d" }), { status, headers: { "content-type": "application/problem+json" } });

let sandbox: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let reply: (req: Request) => Response;
const seen: { method: string; path: string; auth: string | null }[] = [];
const bodies: string[] = [];

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "org-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      bodies.push(await req.clone().text());
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
  bodies.length = 0;
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
    expect(lines[0]).toMatch(/^NAME\s+EMAIL\s+ROLE\s+STATUS\s+SEATS\s+ID$/);
    expect(lines[1]).toMatch(/^Ada Admin\s+ada@example\.test\s+admin\s+active\s+Yaks, Linear proxy\s+01J0A+$/);
    expect(lines[2]).toMatch(/^mia\s+mia@example\.test\s+member\s+deactivated\s+none\s+01J0B+$/);
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

  it("refuses a non-ULID id before sending, and needs exactly one", async () => {
    /** When an id like `..` is sent, fetch rewrites the path and the authenticated POST reaches another route: observed in the recorded requests (none) and in the slug. */
    for (const bad of ["a/b", "..", ".", "not-a-ulid"]) {
      const r = await run(["members", "deactivate", bad]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("slug: org-member-not-found");
    }
    const none = await run(["members", "deactivate"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("slug: org-member-id-missing");
    expect(seen).toEqual([]);
  });

  it("tells a token without the accounts scope to log in, not to retry", async () => {
    /** When 403 scope_denied falls through to 'unavailable: retry', the operator retries a refusal that only a new login fixes: observed in the slug and fix. */
    reply = () => problem(403, "scope_denied");
    const r = await run(["members"]);
    expect(r.stderr).toContain("slug: org-scope-denied");
    expect(r.stderr).toContain("eris login");
  });

  it("prints fields this build does not know under --output json", async () => {
    /** When the parsed value is printed, a field the server adds is dropped and a script cannot read it: observed in the parsed stdout. */
    reply = () => Response.json({ memberId: MIA, status: "deactivated", extra: 1 });
    const r = await run(["members", "deactivate", MIA], "json");
    expect(JSON.parse(r.stdout)).toEqual({ memberId: MIA, status: "deactivated", extra: 1 });
  });
});

describe("eris org delete", () => {
  it("posts the typed name with the bearer and prints the due date", async () => {
    /** When the name lands outside a JSON `confirm` field, or the verb or path is wrong, the gateway schedules nothing or the wrong thing: observed in the recorded request body and stdout. */
    reply = () => Response.json({ dueAt: DUE, cause: "self_serve" }, { status: 202 });
    const r = await run(["delete", "--confirm", WORKSPACE]);
    expect(r.code).toBe(0);
    expect(seen).toEqual([{ method: "POST", path: "/v1/org/deletion", auth: `Bearer ${TOKEN}` }]);
    expect(bodies.map((b) => JSON.parse(b))).toEqual([{ confirm: WORKSPACE }]);
    expect(r.stdout).toBe(`deletion scheduled for ${DUE}\n`);
    expect(r.stderr).toContain("revoked");
  });

  it("cancels with DELETE and says whether anything was scheduled", async () => {
    /** When cancel sends POST or reads `cancelled` wrongly, a scheduled deletion stays or a no-op is reported as a cancel: observed in the request and both stdout lines. */
    reply = () => Response.json({ cancelled: true });
    const yes = await run(["delete", "--cancel"]);
    expect(seen).toEqual([{ method: "DELETE", path: "/v1/org/deletion", auth: `Bearer ${TOKEN}` }]);
    expect(yes.stdout).toBe("deletion cancelled\n");
    reply = () => Response.json({ cancelled: false });
    expect((await run(["delete", "--cancel"])).stdout).toBe("no deletion was scheduled\n");
  });

  it("prints the server body bare under --output json", async () => {
    /** When json mode drops a field the server adds or prints prose, a script cannot read the due date: observed in the parsed stdout. */
    reply = () => Response.json({ dueAt: DUE, cause: "self_serve", extra: 1 }, { status: 202 });
    expect(JSON.parse((await run(["delete", "--confirm", WORKSPACE], "json")).stdout)).toEqual({ dueAt: DUE, cause: "self_serve", extra: 1 });
    reply = () => Response.json({ cancelled: true });
    expect(JSON.parse((await run(["delete", "--cancel"], "json")).stdout)).toEqual({ cancelled: true });
  });

  it("refuses neither, both and an empty name before sending anything", async () => {
    /** When a bare `eris org delete` or an empty --confirm reaches the gateway, an unintended request is made against a destructive route: observed in zero recorded requests and the slug. */
    for (const args of [["delete"], ["delete", "--confirm", "x", "--cancel"], ["delete", "--confirm", "  "]]) {
      const r = await run(args);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("slug: org-delete-flags");
    }
    const valueless = await run(["delete", "--confirm", ""]);
    expect(valueless.code).toBe(1);
    expect(valueless.stdout).toBe("");
    expect(seen).toEqual([]);
  });

  it("names a wrong name, an unset workspace name and a non-admin each by slug, never echoing the name", async () => {
    /** When the mismatch collapses into 'unavailable' or the typed name is echoed into a log, the operator cannot tell a typo from an unset name, and the name leaks to a terminal: observed in three slugs and both streams. */
    const typed = "Typo Workspace Name";
    reply = () => problem(400, "confirmation_mismatch");
    const mismatch = await run(["delete", "--confirm", typed]);
    expect(mismatch.stderr).toContain("slug: org-confirmation-mismatch");
    expect(mismatch.stderr).toContain("nothing was scheduled");
    reply = () => problem(409, "workspace_name_unknown");
    const unset = await run(["delete", "--confirm", typed]);
    expect(unset.stderr).toContain("slug: org-workspace-name-unknown");
    reply = () => problem(403, "admin_required");
    const member = await run(["delete", "--confirm", typed]);
    expect(member.stderr).toContain("slug: org-admin-required");
    expect(member.stderr).toContain("delete the org");
    for (const r of [mismatch, unset, member]) {
      expect(r.stdout).toBe("");
      expect(r.stdout + r.stderr).not.toContain(typed);
    }
  });

  it("prints the due date as one plain line even from a hostile body", async () => {
    /** When the server's dueAt is printed raw, a compromised endpoint injects terminal escapes or a fake second line: observed in the stdout line count and bytes. */
    reply = () => Response.json({ dueAt: "\u001b[2Jx\nfake line", cause: "self_serve" }, { status: 202 });
    const r = await run(["delete", "--confirm", WORKSPACE]);
    expect(r.stdout).toBe("deletion scheduled for ?[2Jx?fake line\n");
  });

  it("names the verb a non-admin tried: cancel is not delete", async () => {
    /** When a refused cancel says the member tried to delete the org, the refusal misdescribes what was run: observed in the what-line. */
    reply = () => problem(403, "admin_required");
    expect((await run(["delete", "--cancel"])).stderr).toContain("can cancel the org's deletion");
  });

  it("explains the revoked-token 401 a schedule leaves behind, and still sends a plain 401 to eris login", async () => {
    /** When the post-schedule 401 `revoked` is reported as 'run eris login', the operator signs in again to a token that stays revoked and never learns the cancel is the dashboard's: observed in the slug and fix of the two 401s. */
    reply = () => problem(401, "revoked");
    const revoked = await run(["delete", "--cancel"]);
    expect(revoked.stderr).toContain("slug: org-tokens-revoked");
    expect(revoked.stderr).toContain("Danger zone");
    reply = () => problem(401, "invalid_token");
    expect((await run(["delete", "--cancel"])).stderr).toContain("slug: org-unauthorized");
  });
});

describe("eris org", () => {
  it("prints the group usage bare and fails an unknown sub", async () => {
    /** When `eris org` does nothing or an unknown sub exits 0, the group is undiscoverable: observed in stdout and the exit code. */
    const bare = await run([]);
    expect(bare.code).toBe(0);
    expect(bare.stdout).toContain("members deactivate <member-id>");
    expect(bare.stdout).toContain("delete --confirm <workspace>");
    const bad = await run(["nope"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("slug: org-unknown-verb");
  });
});
