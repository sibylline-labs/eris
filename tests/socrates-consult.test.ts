/**
 * `eris socrates consult [--canon|--practices|--brief]`: a GET of the gateway's consult route and the
 * doc's markdown printed.
 *
 * Drives the group handler in-process against a loopback `Bun.serve` standing in for the endpoint, so
 * every request crosses real HTTP and the stand-in sees the method, query, headers and body the verb
 * sent. The token and the secret-shaped value are assembled at runtime so no literal trips a secret
 * scanner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { runSocrates } from "../plugins/socrates/submit";
import { CliExit } from "../src/cli/ts-verb";

const REPO = resolve(import.meta.dir, "..");
const TOKEN = ["sib", "01HZX3K5Q8W2N4R6T8V0Y2B4D6", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const PAT = ["ghp", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("_");

const BRIEF_ORDER = ["canon", "one_pager", "lbd", "ka", "retro", "practices"];
const SETTINGS = "https://dash.example.com/socrates";

const doc = (name: string, markdown = `# ${name}\nbody of ${name}\n`) => ({
  doc: name,
  title: `P - ${name}`,
  url: `https://docs.example.com/${name}`,
  markdown,
  fetched_at: "2026-11-04T12:00:00.000Z",
  contract_version: "1.0.0",
});

let server: ReturnType<typeof Bun.serve>;
let answer: (doc: string, project: string | null) => Response;
const requests: { method: string; path: string; search: string; auth: string | null; contentType: string | null; body: string }[] = [];

const problem = (status: number, code: string, detail: string, extra: Record<string, unknown> = {}) =>
  Response.json({ type: `urn:hera:error:${code}`, title: code, status, detail, code, ...extra }, { status, headers: { "content-type": "application/problem+json" } });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      requests.push({ method: req.method, path: url.pathname, search: url.search, auth: req.headers.get("authorization"), contentType: req.headers.get("content-type"), body: await req.text() });
      return answer(url.searchParams.get("doc") ?? "", url.searchParams.get("project"));
    },
  });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  requests.length = 0;
  answer = (d) => Response.json(doc(d));
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
  const slugs = stderr.split("\n").filter((l) => l.startsWith("slug: ")).map((l) => l.slice("slug: ".length));
  return { rc, stdout, stderr, slug: slugs[0], slugs };
}

describe("eris socrates consult: one doc", () => {
  it("sends a body-less GET with the login bearer and prints the Canon markdown", async () => {
    /** When the call is a POST, carries a body or content-type, or drops the bearer, the gateway refuses the consult; observed at the loopback endpoint and on stdout. */
    expect(await drive(["consult", "--canon"])).toMatchObject({ rc: 0, stdout: "# canon\nbody of canon\n", stderr: "" });
    expect(requests).toEqual([{ method: "GET", path: "/v1/socrates/consult", search: "?doc=canon", auth: `Bearer ${TOKEN}`, contentType: null, body: "" }]);
  });

  it("sends the project hint with --practices", async () => {
    /** When --project is not carried into the query, an org with several enrolled projects answers 404 and the user cannot reach the doc; observed in the request's query. */
    expect(await drive(["consult", "--practices", "--project", "Platform Core"])).toMatchObject({ rc: 0, stdout: "# practices\nbody of practices\n" });
    expect(requests.map((r) => r.search)).toEqual(["?doc=practices&project=Platform+Core"]);
  });

  it("prints the doc as one bare JSON record under --output json", async () => {
    /** When the JSON record drifts from {docs, unavailable, contract_version}, a machine caller reads the wrong field; observed on stdout. */
    const r = await drive(["consult", "--practices", "--project", "P"], { format: "json" });
    expect(r).toMatchObject({ rc: 0, stderr: "" });
    expect(JSON.parse(r.stdout)).toEqual({ docs: [doc("practices")], unavailable: [], contract_version: "1.0.0" });
  });

  it("decodes a reply carrying keys beyond the contract, and refuses one of another shape", async () => {
    /** When the decoder is strict about extra keys the live gateway adds (ok, data, request_id), every consult fails; when it accepts a shapeless body, junk reaches stdout. */
    answer = (d) => Response.json({ ok: true, ...doc(d), data: { doc: d }, request_id: "req_1" });
    expect(await drive(["consult", "--canon"])).toMatchObject({ rc: 0, stdout: "# canon\nbody of canon\n" });
    answer = () => Response.json({ doc: "canon" });
    expect(await drive(["consult", "--canon"])).toMatchObject({ rc: 1, stdout: "", slug: "socrates-bad-response" });
    answer = () => new Response("<html>502 Bad Gateway</html>", { status: 502 });
    expect(await drive(["consult", "--canon"])).toMatchObject({ rc: 1, stdout: "", slug: "socrates-bad-response" });
  });

  it("refuses a reply that is another doc than the one asked for", async () => {
    /** When the reply's doc is trusted, a wrong or replayed answer is printed under the wrong marker as if it were Canon; observed as the slug and empty stdout. */
    answer = () => Response.json(doc("canon"));
    expect(await drive(["consult", "--practices", "--project", "P"])).toMatchObject({ rc: 1, stdout: "", slug: "socrates-bad-response" });
    expect(await drive(["consult", "--brief", "--project", "P"])).toMatchObject({ rc: 1, stdout: "", slug: "socrates-bad-response" });
  });

  it("strips terminal controls from the markdown and keeps newlines and tabs", async () => {
    /** When server text reaches the terminal with an ESC, C1 or BEL, the endpoint can drive the user's terminal; observed on stdout bytes. */
    answer = (d) => Response.json(doc(d, "a\u001b[31mred\u001b[0m\u009b\u0007 b\r\nc\rd\te\n"));
    const r = await drive(["consult", "--canon"]);
    expect(r).toMatchObject({ rc: 0, stderr: "" });
    expect(r.stdout).toBe("a[31mred[0m b\nc\nd\te\n");
    const json = await drive(["consult", "--canon"], { format: "json" });
    expect(JSON.parse(json.stdout).docs[0].markdown).toBe("a\u001b[31mred\u001b[0m\u009b\u0007 b\r\nc\rd\te\n");
  });

  it("ends a markdown body that has no trailing newline with one", async () => {
    /** When the last line has no newline, the shell prompt lands on it; observed on stdout. */
    answer = (d) => Response.json(doc(d, "no newline"));
    expect((await drive(["consult", "--canon"])).stdout).toBe("no newline\n");
  });
});

describe("eris socrates consult: refusals", () => {
  it("prints the settings link on the fix line when the org has no Canon doc", async () => {
    /** When the 409's _links.settings is dropped, a user with no Canon doc is told nothing about how to set one; observed at the block's fix line. */
    answer = () => problem(409, "conflict", "Conflict", { _links: { settings: { href: SETTINGS, title: "eris socrates settings canon --doc <id>" } } });
    const r = await drive(["consult", "--canon"]);
    expect(r).toMatchObject({ rc: 1, stdout: "", slug: "socrates-refused" });
    expect(r.stderr).toContain(`fix: open ${SETTINGS} to change the setting`);
  });

  it("tells a user with no settings link to ask an org admin", async () => {
    /** When a 409 without a link reads like any refusal, the user is told to check a candidate; observed at the fix line. */
    answer = () => problem(409, "conflict", "Conflict");
    expect((await drive(["consult", "--canon"])).stderr).toContain("fix: ask an org admin to choose a Canon doc in Socrates settings");
  });

  it("tells the user to pass --project when a project doc is asked for without one", async () => {
    /** When a 404 reads like a missing doc, a user on an org with several projects retries the same command; observed at the fix line. */
    answer = () => problem(404, "not_found", "A project is required when multiple projects are enrolled in Socrates; enrolled projects: A, B");
    const r = await drive(["consult", "--practices"]);
    expect(r).toMatchObject({ rc: 1, stdout: "", slug: "socrates-refused" });
    expect(r.stderr).toContain("fix: pass --project <name>");
    expect(r.stderr).toContain("enrolled projects: A, B");
  });

  it("prints the subscribe link on a 402 and the login fix on a 401", async () => {
    /** When the shared refusal path is bypassed, an unentitled or signed-out user gets a generic line; observed at the fix line. */
    answer = () => problem(402, "entitlement_lapsed", "not entitled", { _links: { subscribe: { href: "https://example.com/subscribe" } } });
    const paid = await drive(["consult", "--canon"]);
    expect(paid).toMatchObject({ rc: 1, stdout: "", slug: "socrates-not-entitled" });
    expect(paid.stderr).toContain("fix: subscribe: https://example.com/subscribe");
    answer = () => problem(401, "unauthorized", "bad token");
    expect((await drive(["consult", "--canon"])).stderr).toContain("fix: run 'eris login'");
  });

  it("refuses two selecting flags and a bad project, and sends nothing", async () => {
    /** When flags are not exclusive or --project is unchecked, the user gets a doc they did not ask for or a request the contract forbids; observed in slug and request count. */
    expect(await drive(["consult", "--canon", "--practices"])).toMatchObject({ rc: 1, stdout: "", slug: "socrates-flag-required" });
    expect(await drive(["consult", "--practices", "--project", "x".repeat(201)])).toMatchObject({ rc: 1, stdout: "", slug: "socrates-flag-required" });
    expect(requests).toHaveLength(0);
  });

  it("refuses a secret in --project and sends nothing", async () => {
    /** When the request skips the outbound scan, a pasted credential in --project leaves the machine; observed as zero requests at the loopback endpoint. */
    const r = await drive(["consult", "--practices", "--project", PAT]);
    expect(r).toMatchObject({ rc: 1, stdout: "", slug: "socrates-secret-detected" });
    expect(requests).toHaveLength(0);
  });

  it("prints usage for --help", async () => {
    /** When the help text is missing, `eris socrates consult --help` falls through to an error; observed on stdout. */
    const r = await drive(["consult", "--help"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toContain("Usage: eris socrates consult");
    expect(requests).toHaveLength(0);
  });
});

describe("eris socrates consult --brief", () => {
  it("reads the six docs in order and prints them under one marker line each", async () => {
    /** When the bundle changes order or drops a marker, an agent reading the brief cannot tell where Canon ends and the project docs begin; observed on stdout and in request order. */
    const r = await drive(["consult", "--brief", "--project", "P"]);
    expect(r).toMatchObject({ rc: 0, stderr: "" });
    expect(requests.map((q) => new URLSearchParams(q.search).get("doc"))).toEqual(BRIEF_ORDER);
    expect(r.stdout).toBe(
      BRIEF_ORDER.map((d) => `<!-- eris socrates consult: ${d} https://docs.example.com/${d} -->\n# ${d}\nbody of ${d}\n`).join("\n"),
    );
  });

  it("is what a bare `consult` does", async () => {
    /** When the bare verb does something else, the issue's optional flag brackets are broken; observed in request order. */
    expect(await drive(["consult", "--project", "P"])).toMatchObject({ rc: 0 });
    expect(requests.map((q) => new URLSearchParams(q.search).get("doc"))).toEqual(BRIEF_ORDER);
  });

  it("skips a doc the org does not have with a WARN and the settings link, and prints the rest", async () => {
    /** When a missing Canon aborts the brief, a project with no Canon can never be briefed; when the skip is silent, the reader assumes Canon said nothing; observed on stdout and stderr. */
    answer = (d) => (d === "canon" ? problem(409, "conflict", "Conflict", { _links: { settings: { href: SETTINGS } } }) : d === "ka" ? problem(404, "not_found", "The org has no such doc in Linear yet") : Response.json(doc(d)));
    const r = await drive(["consult", "--brief", "--project", "P"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).not.toContain("consult: canon");
    expect(r.stdout).not.toContain("consult: ka");
    expect(r.stdout).toContain("<!-- eris socrates consult: one_pager https://docs.example.com/one_pager -->");
    expect(r.slugs).toEqual(["socrates-doc-unavailable", "socrates-doc-unavailable"]);
    expect(r.stderr).toContain(`canon is unavailable (HTTP 409 conflict): open ${SETTINGS} to change the setting`);
    expect(r.stderr).toContain("ka is unavailable (HTTP 404 not_found): The org has no such doc in Linear yet");
  });

  it("lists the skipped docs under unavailable in the JSON record", async () => {
    /** When a skipped doc is missing from the JSON, a machine caller cannot tell Canon was absent; observed on stdout. */
    answer = (d) => (d === "canon" ? problem(409, "conflict", "Conflict", { _links: { settings: { href: SETTINGS } } }) : Response.json(doc(d)));
    const r = await drive(["consult", "--brief", "--project", "P"], { format: "json" });
    const record = JSON.parse(r.stdout);
    expect(record.docs.map((d: { doc: string }) => d.doc)).toEqual(BRIEF_ORDER.slice(1));
    expect(record.unavailable).toEqual([{ doc: "canon", status: 409, code: "conflict", detail: "Conflict", settings: SETTINGS }]);
  });

  it("fails with the first refusal when no doc could be read", async () => {
    /** When a brief of nothing exits 0, a script treats an empty bundle as a success; observed in exit code and block. */
    answer = () => problem(404, "not_found", "A project is required when multiple projects are enrolled in Socrates; enrolled projects: A, B");
    const r = await drive(["consult", "--brief"]);
    expect(r).toMatchObject({ rc: 1, stdout: "", slug: "socrates-refused" });
    expect(r.stderr).toContain("fix: pass --project <name>");
  });

  it("aborts on a refusal that is not a missing doc, and prints nothing", async () => {
    /** When a 402 or a 5xx is treated as a skippable doc, an unentitled org gets a brief of nothing with five WARNs; when output is not held back, a half-brief is printed before the abort; observed on stdout and the slug. */
    answer = (d) => (d === "lbd" ? problem(402, "entitlement_lapsed", "not entitled", { _links: { subscribe: { href: "https://example.com/subscribe" } } }) : Response.json(doc(d)));
    const r = await drive(["consult", "--brief", "--project", "P"]);
    expect(r).toMatchObject({ rc: 1, stdout: "", slug: "socrates-not-entitled" });
    expect(requests.map((q) => new URLSearchParams(q.search).get("doc"))).toEqual(["canon", "one_pager", "lbd"]);
  });
});
