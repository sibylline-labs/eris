/**
 * `eris socrates resolve <epic>`: one POST of the contract's resolve request,
 * and the receipt printed.
 *
 * Drives the group handler in-process against a loopback `Bun.serve` that
 * stands in for the endpoint, so every request crosses real HTTP. The stand-in
 * keeps a stored receipt per Epic the way the server's tenant does, which is
 * what makes a second run a no-op. The token is assembled at runtime so no
 * literal trips a secret scanner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { runSocrates } from "../plugins/socrates/submit";
import { CliExit } from "../src/cli/ts-verb";

const REPO = resolve(import.meta.dir, "..");
const TOKEN = ["sib", "01HZX3K5Q8W2N4R6T8V0Y2B4D6", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");

const RECEIPT = { epic: "epic_412", outcome: "resolved", applied: ["epic_413", "epic_414"], carried_over: ["epic_415"], carry_over_epic: "epic_420", reporting: "none", contract_version: "1.0.0" };

let server: ReturnType<typeof Bun.serve>;
let answer: (epic: string) => Response;
const requests: { path: string; auth: string | null; body: unknown }[] = [];
/** The stand-in's resolution ledger: an Epic resolved once answers its stored receipt. */
const stored = new Map<string, typeof RECEIPT>();
let writes = 0;

const problem = (status: number, code: string, detail: string, extra: Record<string, unknown> = {}) =>
  Response.json({ type: `urn:hera:error:${code}`, title: code, status, detail, code, ...extra }, { status, headers: { "content-type": "application/problem+json" } });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as { epic: string };
      requests.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), body });
      return answer(body.epic);
    },
  });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  requests.length = 0;
  stored.clear();
  writes = 0;
  answer = (epic) => {
    let receipt = stored.get(epic);
    if (receipt === undefined) {
      writes += 1;
      receipt = { ...RECEIPT, epic };
      stored.set(epic, receipt);
    }
    return Response.json(receipt);
  };
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

describe("eris socrates resolve", () => {
  it("posts the contract's resolve request with the login bearer and prints the receipt", async () => {
    /** When the path, body or bearer drifts, the endpoint refuses every resolve; observed at the loopback endpoint and on stdout. */
    expect(await drive(["resolve", "epic_412"])).toMatchObject({
      rc: 0,
      stdout: "resolved epic_412: 2 applied, 1 carried over to epic_420\n  applied: epic_413, epic_414\n  carried over: epic_415\n",
      stderr: "",
    });
    expect(requests).toEqual([{ path: "/v1/socrates/resolve", auth: `Bearer ${TOKEN}`, body: { schema_version: "1.0.0", epic: "epic_412" } }]);
  });

  it("resolves an Epic once: a second run sends the same request and prints the same receipt", async () => {
    /** When the client adds state of its own (a retry, a changed body), a repeat run could apply an Epic twice; observed as one server write across two identical requests. */
    const first = await drive(["resolve", "epic_412"], { format: "json" });
    const second = await drive(["resolve", "epic_412"], { format: "json" });
    expect(first).toMatchObject({ rc: 0, stderr: "" });
    expect(second.stdout).toBe(first.stdout);
    expect(JSON.parse(first.stdout)).toEqual(RECEIPT);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]!);
    expect(writes).toBe(1);
  });

  it("prints a receipt with nothing carried over, and a queued one, without empty lines", async () => {
    /** When an empty list prints a bare label or a queued outcome reads as resolved, the user is told work happened that did not. */
    answer = () => Response.json({ ...RECEIPT, applied: ["epic_413"], carried_over: [], carry_over_epic: undefined });
    expect((await drive(["resolve", "epic_412"])).stdout).toBe("resolved epic_412: 1 applied, 0 carried over\n  applied: epic_413\n");
    answer = () => Response.json({ ...RECEIPT, outcome: "queued", applied: [], carried_over: [], carry_over_epic: undefined });
    expect((await drive(["resolve", "epic_412"])).stdout).toBe("queued epic_412: the server resolves it in the background\n");
  });

  it("says to close the Epic when the endpoint refuses an open one, and to check the id on a 404 problem", async () => {
    /** When every refusal reads alike, a user resolving an open Epic is told to check a candidate; observed at the block's fix line. */
    answer = () => problem(409, "conflict", "Resolve runs only once the review Epic is closed");
    const open = await drive(["resolve", "epic_412"]);
    expect(open).toMatchObject({ rc: 1, stdout: "", slug: "socrates-refused" });
    expect(open.stderr).toContain("fix: resolve runs on a closed review Epic: close it in Linear");
    answer = () => problem(404, "not_found", "No Socrates review Epic has that id");
    expect((await drive(["resolve", "epic_499"])).stderr).toContain("fix: check the Epic's identifier");
  });

  it("names a route the endpoint does not serve, and the subscribe link of an unentitled workspace", async () => {
    /** When a gateway without the route reads as a generic bad response, the user cannot tell an old server from a wrong url; when a 402 loses its link, there is no way forward. */
    answer = () => Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
    const missing = await drive(["resolve", "epic_412"]);
    expect(missing).toMatchObject({ rc: 1, stdout: "", slug: "socrates-bad-response" });
    expect(missing.stderr).toContain("fix: this endpoint does not serve /v1/socrates/resolve");
    answer = () => problem(402, "entitlement_lapsed", "not entitled to socrates", { _links: { subscribe: { href: "https://example.com/subscribe" } } });
    const lapsed = await drive(["resolve", "epic_412"]);
    expect(lapsed).toMatchObject({ rc: 1, slug: "socrates-not-entitled" });
    expect(lapsed.stderr).toContain("fix: subscribe: https://example.com/subscribe\n");
  });

  it("sends nothing without an Epic, or with one the contract refuses", async () => {
    /** When a bare resolve reaches the wire, the endpoint's validation error hides the local fix. */
    expect(await drive(["resolve"])).toMatchObject({ rc: 1, stdout: "", slug: "socrates-flag-required" });
    expect(await drive(["resolve", " "])).toMatchObject({ rc: 1, slug: "socrates-flag-required" });
    expect(await drive(["resolve", "epic_401", "epic_402"])).toMatchObject({ rc: 1 });
    expect(requests).toEqual([]);
  });
});
