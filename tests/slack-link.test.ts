/**
 * `eris slack link` and `eris slack unlink` through the group handler (`runSlack`), with a loopback
 * `Bun.serve` standing in for the gateway's `/v1/asks/slack/*` routes and a sandbox HOME holding one
 * signed-in org. The server's documented bodies are the stand-in's; the live run against a real Slack
 * press is a separate, human step. The token is assembled at runtime so no literal trips a secret scanner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runSlack } from "../plugins/yak/slack";
import { CliExit } from "../src/cli/ts-verb";

const REPO = resolve(import.meta.dir, "..");
const ORG = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const TOKEN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const CODE = "Zk3_sentinel-link-code0123456789ABCDEFGHIJKLM";
const LINK = `https://dash.example.test/slack/link?code=${CODE}`;

const problem = (status: number, code: string) =>
  new Response(JSON.stringify({ type: "urn:hera:error:" + code, title: code, status, code, detail: "d" }), { status, headers: { "content-type": "application/problem+json" } });

let sandbox: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let answer: (path: string) => Response;
const seen: { method: string; path: string; auth: string | null; body: string; redirect?: string }[] = [];

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "slack-link-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push({ method: req.method, path, auth: req.headers.get("authorization"), body: await req.text() });
      return answer(path);
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
  answer = (path) => {
    if (path === "/v1/asks/slack/link/preview") return Response.json({ slackUserId: "U0001", slackTeamId: "T0001", realName: "Eve Mallory", displayName: "eve" });
    if (path === "/v1/asks/slack/link") return Response.json({ linked: true, slackUserId: "U0001", slackTeamId: "T0001" });
    if (path === "/v1/asks/slack/unlink") return Response.json({ unlinked: 1 });
    return problem(404, "not_found");
  };
});

async function run(args: string[], format: "text" | "json" = "text") {
  const out = { stdout: "", stderr: "" };
  const ctx = {
    erisDir: REPO,
    env: { PATH: process.env.PATH, HOME: home },
    format,
    stdout: { write: (s: string) => ((out.stdout += s), true) },
    stderr: { write: (s: string) => ((out.stderr += s), true) },
  };
  let code: number;
  try {
    code = await runSlack(args, ctx, { cwd: sandbox, home });
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    code = e.code;
  }
  return { code, ...out };
}

describe("eris slack link", () => {
  it("shows whose account the link is for and binds nothing without --confirm", async () => {
    /** When the verb confirms without --confirm, or sends anything but the code, a member is bound to a Slack account they never saw: observed in the one request sent and stdout. */
    const r = await run(["link", LINK]);
    expect(r.code).toBe(0);
    expect(seen.map((s) => [s.method, s.path, s.auth, JSON.parse(s.body)])).toEqual([["POST", "/v1/asks/slack/link/preview", `Bearer ${TOKEN}`, { code: CODE }]]);
    expect(r.stdout).toBe("this link would bind Eve Mallory @eve (U0001 in T0001) to you\nnothing is linked yet; if that is your Slack account, run again with --confirm\n");
  });

  it("binds with --confirm, takes a bare code, and prints the server's body under --output json", async () => {
    /** When --confirm does not reach the confirm route, or a bare code is refused, the CLI cannot finish a link: observed in the path sent and the JSON body. */
    const r = await run(["link", CODE, "--confirm"], "json");
    expect(r.code).toBe(0);
    expect(seen.map((s) => [s.path, JSON.parse(s.body)])).toEqual([["/v1/asks/slack/link", { code: CODE }]]);
    expect(JSON.parse(r.stdout)).toEqual({ linked: true, slackUserId: "U0001", slackTeamId: "T0001" });
  });

  it("refuses a missing or malformed link before any request, without echoing the input", async () => {
    /** When a bad input is sent anyway, the server sees an arbitrary string and a typo'd secret lands in a log: observed in zero requests and the absent input text. */
    for (const [args, slug] of [[["link"], "slack-code-missing"], [["link", "https://dash.example.test/slack/link"], "slack-code-invalid"], [["link", "bad code!"], "slack-code-invalid"]] as const) {
      const r = await run([...args]);
      expect([r.code, r.stdout, r.stderr.includes(slug), r.stderr.includes("bad code!")]).toEqual([1, "", true, false]);
    }
    expect(seen).toEqual([]);
  });

  it("renders each server refusal as its slug with a fix, exits 1 and prints nothing on stdout", async () => {
    /** When a refusal collapses to a generic failure, the member is not told to press again, unlink or log in: observed in the slug on stderr per status and code. */
    const cases: [number, string, string][] = [
      [404, "invalid_code", "slack-code-unknown"],
      [409, "slack_already_linked", "slack-already-linked"],
      [403, "member_required", "slack-member-required"],
      [502, "slack_unavailable", "slack-unavailable"],
      [401, "invalid_token", "org-unauthorized"],
    ];
    for (const [status, code, slug] of cases) {
      answer = () => problem(status, code);
      const r = await run(["link", LINK, "--confirm"]);
      expect([r.code, r.stdout, r.stderr.includes(slug), r.stderr.includes(CODE), r.stderr.includes(TOKEN)]).toEqual([1, "", true, false, false]);
    }
  });
});

describe("eris slack unlink", () => {
  it("removes the link and says so, or says there was none", async () => {
    /** When unlink sends a body naming a member, or reads 0 as success, the member cannot tell a removal from a no-op: observed in the sent body and both stdout lines. */
    const first = await run(["unlink"]);
    expect([first.code, first.stdout]).toEqual([0, "unlinked\n"]);
    expect(JSON.parse(seen[0]!.body)).toEqual({});
    answer = () => Response.json({ unlinked: 0 });
    const second = await run(["unlink"]);
    expect([second.code, second.stdout]).toEqual([0, "no Slack account was linked\n"]);
  });
});
