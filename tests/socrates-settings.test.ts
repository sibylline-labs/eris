/**
 * `eris socrates settings team`: one PUT of the contract's settings-team
 * request, and the receipt printed.
 *
 * Drives the group handler in-process against a loopback `Bun.serve` that
 * stands in for the endpoint, so every request crosses real HTTP. The token is
 * assembled at runtime so no literal trips a secret scanner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { runSocrates } from "../plugins/socrates/submit";
import { readdirSync, readFileSync } from "node:fs";
import { CliExit } from "../src/cli/ts-verb";

const REPO = resolve(import.meta.dir, "..");
const TOKEN = ["sib", "01HZX3K5Q8W2N4R6T8V0Y2B4D6", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const ENG = "3f1c2a9e-5b7d-4e8f-9a01-2b3c4d5e6f70";
const SKW = "7c35c8ec-0acb-456a-9e27-6b7cb7640db5";

const SET = { project: "proj_1", override: { id: ENG, key: "ENG" }, filing_team: { id: ENG, key: "ENG", source: "override" }, contract_version: "1.0.0" };
const CLEARED = { project: "proj_1", override: null, filing_team: { id: SKW, key: "SKW", source: "lead" }, contract_version: "1.0.0" };

let server: ReturnType<typeof Bun.serve>;
let answer: (body: { team: string | null }) => Response;
const requests: { method: string; path: string; auth: string | null; body: unknown }[] = [];

const problem = (status: number, code: string, detail: string) =>
  Response.json({ type: `urn:hera:error:${code}`, title: code, status, detail, code }, { status, headers: { "content-type": "application/problem+json" } });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as { team: string | null };
      requests.push({ method: req.method, path: new URL(req.url).pathname, auth: req.headers.get("authorization"), body });
      return answer(body);
    },
  });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  requests.length = 0;
  answer = (body) => Response.json(body.team === null ? CLEARED : SET);
});

async function drive(args: string[], opts: { format?: "text" | "json" } = {}) {
  let stdout = "";
  let stderr = "";
  const ctx = {
    erisDir: REPO,
    env: { HOME: join(REPO, ".scratch", "no-such-home"), ERIS_YAKS_URL: `http://127.0.0.1:${server.port}`, ERIS_YAKS_TOKEN: TOKEN },
    format: opts.format ?? "text",
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: (s: string) => ((stderr += s), true) },
  };
  let rc: number;
  try {
    rc = await runSocrates(args, ctx);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    rc = e.code;
  }
  const slug = stderr.split("\n").find((l) => l.startsWith("slug: "))?.slice("slug: ".length);
  return { rc, stdout, stderr, slug };
}

describe("eris socrates settings team", () => {
  it("PUTs the contract's request with the login bearer and prints where the next Epic files", async () => {
    /** When the method, path, body or bearer drifts, the endpoint refuses every change; observed at the loopback endpoint and on stdout. */
    expect(await drive(["settings", "team", ENG, "--project", "Socrates"])).toMatchObject({ rc: 0, stdout: `files on ENG (override): ${ENG}\n`, stderr: "" });
    expect(requests).toEqual([
      { method: "PUT", path: "/v1/socrates/settings/team", auth: `Bearer ${TOKEN}`, body: { schema_version: "1.0.0", project: "Socrates", team: ENG } },
    ]);
  });

  it("--clear sends a null team, and --output json prints the receipt as one record", async () => {
    /** When --clear sends anything but null, the override can never be removed. */
    const cleared = await drive(["settings", "team", "--clear"], { format: "json" });
    expect(cleared).toMatchObject({ rc: 0, stderr: "" });
    expect(JSON.parse(cleared.stdout)).toEqual(CLEARED);
    expect(requests[0]?.body).toEqual({ schema_version: "1.0.0", team: null });
  });

  it("an admin refusal and an unknown team each say what to do", async () => {
    /** When a 403 or 422 reads as a generic refusal, a member cannot tell they need an admin, nor an admin which ids are valid. */
    answer = () => problem(403, "admin_required", "Only an admin can change where Socrates files");
    const member = await drive(["settings", "team", ENG]);
    expect(member).toMatchObject({ rc: 1, stdout: "", slug: "socrates-refused" });
    expect(member.stderr).toContain("fix: ask an org admin to run this command");
    answer = () => problem(422, "unprocessable", "That team is not on the enrolled project");
    expect((await drive(["settings", "team", ENG])).stderr).toContain("fix: pass one of the teams the detail lists, or --clear");
  });

  it("an unenrolled org is told to follow the step the detail names", async () => {
    /** When a 409 reads as a generic refusal, an admin whose org has no enrolled project is told to check the team they passed. */
    answer = () => problem(409, "conflict", 'No Linear project is enrolled in Socrates. Add the "Socrates › Enrolled" label to a Linear project, then run the command again.');
    const r = await drive(["settings", "team", ENG]);
    expect(r).toMatchObject({ rc: 1, stdout: "", slug: "socrates-refused" });
    expect(r.stderr).toContain('Add the "Socrates › Enrolled" label to a Linear project');
    expect(r.stderr).toContain("(conflict, HTTP 409)");
    expect(r.stderr).toContain("fix: follow the step named above, then run the command again");
  });

  it("sends nothing without a team or --clear, or with both", async () => {
    /** When an empty or contradictory change reaches the wire, the server's validation error hides the local fix. */
    expect(await drive(["settings", "team"])).toMatchObject({ rc: 1, stdout: "", slug: "socrates-flag-required" });
    expect(await drive(["settings", "team", ENG, "--clear"])).toMatchObject({ rc: 1, slug: "socrates-flag-required" });
    expect(requests).toHaveLength(0);
  });

  it("sends a team key as typed, so the server resolves it and the client holds no id table", async () => {
    /** When the client rewrites or validates the string as an id, a key like ENG is refused or swapped before the server sees it; observed as the PUT body at the loopback endpoint. */
    expect(await drive(["settings", "team", "ENG", "--project", "Socrates"])).toMatchObject({ rc: 0, stderr: "" });
    expect(requests[0]?.body).toEqual({ schema_version: "1.0.0", project: "Socrates", team: "ENG" });
  });

  it("an ambiguous name prints its candidates as a WARN, exits 0 and prints nothing to stdout", async () => {
    /** When a 409 linear_ref_ambiguous reads as a failure block, the user gets exit 1 and no list to choose from; observed as rc, stdout and the WARN lines on stderr. */
    answer = () =>
      Response.json(
        { type: "urn:hera:error:linear_ref_ambiguous", title: "linear_ref_ambiguous", status: 409, detail: "More than one Linear object matches the reference", code: "linear_ref_ambiguous", kind: "team", candidates: [{ id: ENG, name: "Engineering" }, { id: SKW, name: "Engineering" }] },
        { status: 409, headers: { "content-type": "application/problem+json" } },
      );
    const r = await drive(["settings", "team", "Engineering"]);
    expect(r).toMatchObject({ rc: 0, stdout: "", slug: "socrates-ref-ambiguous" });
    expect(r.stderr).toStartWith("WARN ");
    expect(r.stderr).toContain(`  ${ENG}  Engineering\n  ${SKW}  Engineering\n`);
    expect(r.stderr).toContain("run the command again with one candidate's id");
    const json = await drive(["settings", "team", "Engineering"], { format: "json" });
    expect(json).toMatchObject({ rc: 0, stderr: "" });
    expect(JSON.parse(json.stdout)).toEqual({ ambiguous: { kind: "team", candidates: [{ id: ENG, name: "Engineering" }, { id: SKW, name: "Engineering" }] } });
  });

  it("no Linear id literal sits in the socrates plugin sources", () => {
    /** When a team or label id is pinned into the client, it goes stale per workspace and leaks one org's ids into the public tree; observed as a UUID-shaped literal in a plugins/socrates source. */
    const dir = join(REPO, "plugins", "socrates");
    const hits = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(readFileSync(join(dir, f), "utf8")));
    expect(hits).toEqual([]);
  });

  it("the settings group prints its usage, and refuses an unknown sub-command", async () => {
    /** When the group swallows an unknown word, a typo reads as success. */
    expect(await drive(["settings"])).toMatchObject({ rc: 0, stdout: expect.stringContaining("team       Set or clear the Linear team") });
    expect(await drive(["settings", "nope"])).toMatchObject({ rc: 1, slug: "socrates-unknown-verb" });
    expect((await drive(["settings", "team", "--help"])).stdout).toContain("<team>            the Linear team's key, name or id");
  });
});
