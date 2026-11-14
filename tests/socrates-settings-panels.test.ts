/**
 * `eris socrates settings policy|enrolment|health|usage|canon`: the CLI side of the dash's settings
 * panels, driven in-process against a stateful loopback `Bun.serve` standing in for the endpoint, so
 * every request crosses real HTTP. The token is assembled at runtime so no literal trips a secret
 * scanner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runSocrates } from "../plugins/socrates/submit";
import { CliExit } from "../src/cli/ts-verb";

const REPO = resolve(import.meta.dir, "..");
const TOKEN = ["sib", "01HZX3K5Q8W2N4R6T8V0Y2B4D6", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const GITHUB_TOKEN = ["ghp", "_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");

const golden = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "socrates-contract-v1.json"), "utf8")) as {
  messages: { settings: { response: { accept: Record<string, any>[] } } };
};
const SERVED = golden.messages.settings.response.accept[1]!;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

let server: ReturnType<typeof Bun.serve>;
let state: Record<string, any>;
let refuse: { method: string; path: string; status: number; code: string } | undefined;
let garble = false;
const requests: { method: string; path: string; search: string; auth: string | null; body: any }[] = [];

const problem = (status: number, code: string, detail: string) =>
  Response.json({ type: `urn:hera:error:${code}`, title: code, status, detail, code }, { status, headers: { "content-type": "application/problem+json" } });

/** The read model the endpoint holds now, built from the stored policy, hash and Canon choice. */
const view = () => ({ ...state.served, policy: { ...state.served.policy, version: state.version, policy_hash: state.hash, policy: state.policy }, canon: { doc_id: state.canon } });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? undefined : await req.json();
      requests.push({ method: req.method, path: url.pathname, search: url.search, auth: req.headers.get("authorization"), body });
      if (refuse && refuse.method === req.method && refuse.path === url.pathname) return problem(refuse.status, refuse.code, `refused ${refuse.code}`);
      if (garble) return new Response("<html>502</html>", { status: 502 });
      const receipt = () => ({ rubric_version: "rubric@v1", policy_version: state.version, policy_hash: state.hash, policy: state.policy, canon_doc_id: state.canon, contract_version: "1.0.0" });
      if (req.method === "GET" && url.pathname === "/v1/socrates/settings") return Response.json(view());
      if (req.method === "PUT" && url.pathname === "/v1/socrates/settings/policy") {
        if (body.expected_version !== undefined && body.expected_version !== state.version) return problem(409, "conflict", "the policy moved");
        state.policy = body.policy;
        state.version += 1;
        state.hash = HASH_B;
        return Response.json(receipt());
      }
      if (req.method === "PUT" && url.pathname === "/v1/socrates/settings/canon") {
        state.canon = body.doc;
        return Response.json(receipt());
      }
      if (req.method === "GET" && url.pathname === "/v1/socrates/consult") {
        if (state.canon === null) return problem(409, "conflict", "no Canon doc is chosen");
        return Response.json({ doc: "canon", title: "Canon", url: `https://tracker.example.com/acme/document/${state.canon}`, markdown: `# Canon ${state.canon}\n`, fetched_at: "2026-11-05T10:00:00.000Z", contract_version: "1.0.0" });
      }
      return problem(404, "not_found", "no such route");
    },
  });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  requests.length = 0;
  refuse = undefined;
  garble = false;
  state = { served: structuredClone(SERVED), version: 3, hash: HASH_A, policy: structuredClone(SERVED.policy.policy), canon: null };
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
const puts = () => requests.filter((r) => r.method === "PUT");

describe("the read panels", () => {
  it("prints enrolment, health and usage from the one settings read, with a Linear link per project", async () => {
    /** When a panel reads a field the model does not carry, or prints a project without its link, the dash's panel has no CLI equivalent; observed on stdout. */
    const enrol = await drive(["settings", "enrolment"]);
    expect(enrol.rc).toBe(0);
    expect(enrol.stdout).toContain("Platform (label) https://tracker.example.com/acme/project/platform-1a2b3c");
    expect(enrol.stdout).toContain("proj_2 (stub) -");
    const health = await drive(["settings", "health"]);
    expect(health.stdout).toContain("install: needs_labels; missing labels: team_1/harmonize");
    expect(health.stdout).toContain("webhook: last delivery never");
    expect(health.stdout).toContain("stuck: 1 retrying write(s)");
    const usage = await drive(["settings", "usage"]);
    expect(usage.stdout).toContain("entries: 4 (pending 1, filed 1, resolved 1, rejected 1, needs input 0)");
    expect(usage.stdout).toContain("accept rate: 50%, reject rate: 50%");
    expect(requests.every((r) => r.method === "GET" && r.path === "/v1/socrates/settings" && r.auth === `Bearer ${TOKEN}` && r.search === "")).toBe(true);
  });

  // admits: a health read that drops the Linear scopes row, mislabels one of its three states, or fails on a server that omits scopes.
  it("prints the Linear scopes row in the dash's three states, and tolerates a server that omits scopes", async () => {
    /** When the row is missing, mislabels a state, or an older server's omitted scopes breaks the read, health parity with the dash is lost; observed on stdout and rc. */
    delete state.served.health.install.scopes;
    const older = await drive(["settings", "health"]);
    expect(older.rc).toBe(0);
    expect(older.stdout).toContain("linear scopes: not checked yet");
    expect(JSON.parse((await drive(["settings", "health"], { format: "json" })).stdout).health.install.scopes).toBeNull();
    state.served.health.install.scopes = { granted: ["read", "write"], missing: [] };
    expect((await drive(["settings", "health"])).stdout).toContain("linear scopes: all granted (read, write)");
    state.served.health.install.scopes = { granted: ["read"], missing: ["write", "issues:create"] };
    const missing = await drive(["settings", "health"]);
    expect(missing.stdout).toContain("linear scopes: 2 missing (write, issues:create); a Linear workspace admin can re-install the app to grant them");
    expect(JSON.parse((await drive(["settings", "health"], { format: "json" })).stdout).health.install.scopes).toEqual({ granted: ["read"], missing: ["write", "issues:create"] });
  });

  it("prints the decoded reply under --output json, one object per verb", async () => {
    /** When a verb prints text under --output json, or drops contract_version, a script reading it breaks; observed on stdout. */
    const enrol = JSON.parse((await drive(["settings", "enrolment"], { format: "json" })).stdout);
    expect(enrol.projects).toHaveLength(2);
    expect(enrol.contract_version).toBe("1.0.0");
    const health = JSON.parse((await drive(["settings", "health"], { format: "json" })).stdout);
    expect(health.health.install.state).toBe("needs_labels");
    const usage = JSON.parse((await drive(["settings", "usage"], { format: "json" })).stdout);
    expect(usage.usage.window_days).toBe(30);
    const policy = JSON.parse((await drive(["settings", "policy"], { format: "json" })).stdout);
    expect(policy.policy.policy_hash).toBe(HASH_A);
    const canon = JSON.parse((await drive(["settings", "canon"], { format: "json" })).stdout);
    expect(canon.canon.doc_id).toBeNull();
  });

  it("shows no terminal control character a server put in a project name", async () => {
    /** When server text reaches stdout unstripped, a project named with an escape sequence can rewrite the operator's terminal; observed on stdout. */
    state.served.enrolment.projects[0].name = "Plat\u001b[2Jform";
    const r = await drive(["settings", "enrolment"]);
    expect(r.stdout).not.toContain("\u001b");
    expect(r.stdout).toContain("Plat[2Jform (label)");
  });

  it("fails with a slugged block, and prints nothing as data, when the body is not a settings read model", async () => {
    /** When an undecodable body is printed as if it were data, the operator reads a made-up health; observed on stderr and an empty stdout. */
    garble = true;
    const r = await drive(["settings", "health"]);
    expect(r.rc).toBe(1);
    expect(r.slug).toBe("socrates-bad-response");
    expect(r.stdout).toBe("");
  });
});

describe("settings policy", () => {
  it("saves the served policy plus the flags, carrying the version it read, and a later show reads the new hash", async () => {
    /** When the PUT omits expected_version, or sends the rubric the server does not score with, a concurrent editor is overwritten or the save is refused; observed in the request the endpoint received. */
    const r = await drive(["settings", "policy", "--threshold", "4", "--gate", "scope=on", "--weight", "scope=3", "--verbosity", "chatty", "--auto-resolve", "on"]);
    expect(r.rc).toBe(0);
    expect(puts()).toHaveLength(1);
    const sent = puts()[0]!;
    expect(sent.path).toBe("/v1/socrates/settings/policy");
    expect(sent.body.expected_version).toBe(3);
    expect(sent.body.rubric_version).toBe("rubric@v1");
    expect(sent.body.policy.threshold).toBe(4);
    expect(sent.body.policy.verbosity).toBe("chatty");
    expect(sent.body.policy.auto_resolve).toBe(true);
    expect(sent.body.policy.gates.scope).toEqual({ enabled: true, weight: 3 });
    expect(sent.body.policy.gates.reversibility).toEqual({ enabled: true, weight: 0 });
    expect(r.stdout).toContain("threshold: 3 -> 4");
    expect(r.stdout).toContain("gate scope: off -> on");
    expect(r.stdout).toContain("saved policy v4, hash bbbbbbbbbbbb");
    const again = await drive(["settings", "policy"]);
    expect(again.stdout).toContain("policy v4");
    expect(again.stdout).toContain("hash bbbbbbbbbbbb");
    expect(again.stdout).toContain("threshold: 4");
  });

  it("with --preview prints the difference and sends nothing but the read", async () => {
    /** When a preview saves, an operator trying a threshold changes the org's policy; observed in the methods the endpoint saw. */
    const r = await drive(["settings", "policy", "--threshold", "5", "--reporting", "pulse", "--preview"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toContain("threshold: 3 -> 5");
    expect(r.stdout).toContain("reporting: none -> pulse");
    expect(r.stdout).toContain("preview: nothing was sent");
    expect(requests.map((q) => q.method)).toEqual(["GET"]);
    const j = JSON.parse((await drive(["settings", "policy", "--threshold", "5", "--preview"], { format: "json" })).stdout);
    expect(j.preview).toBe(true);
    expect(j.changes).toEqual([{ field: "threshold", from: 3, to: 5 }]);
    expect(j.draft.threshold).toBe(5);
    expect(state.version).toBe(3);
  });

  it("sends nothing when the flags change nothing", async () => {
    /** When an unchanged set is sent anyway, it burns a policy version for no change; observed in the methods the endpoint saw. */
    const r = await drive(["settings", "policy", "--threshold", "3", "--gate", "reversibility=on"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toContain("no change: policy v3");
    expect(puts()).toHaveLength(0);
  });

  it("refuses a gate the policy lacks, a bad number and a bad enum before any write", async () => {
    /** When a typo in a gate key is sent, the server stores a policy with a gate the rubric never scores; observed as a slug and no PUT. */
    for (const args of [["--gate", "nope=on"], ["--gate", "scope=maybe"], ["--weight", "scope=-1"], ["--threshold", "abc"], ["--verbosity", "loud"], ["--auto-resolve", "yes"], ["--preview"]]) {
      const r = await drive(["settings", "policy", ...args]);
      expect({ args, rc: r.rc, slug: r.slug }).toEqual({ args, rc: 1, slug: "socrates-flag-required" });
    }
    expect(puts()).toHaveLength(0);
  });

  it("tells the operator to re-run when the policy moved since it was read, and to ask an admin on a 403", async () => {
    /** When a stale save is retried silently or a 403 shows no admin hint, the operator overwrites a colleague or cannot tell why; observed in the fix lines. */
    state.version = 3;
    refuse = { method: "PUT", path: "/v1/socrates/settings/policy", status: 409, code: "conflict" };
    const stale = await drive(["settings", "policy", "--threshold", "4"]);
    expect(stale.slug).toBe("socrates-refused");
    expect(stale.stderr).toContain("run the command again");
    expect(puts()).toHaveLength(1);
    refuse = { method: "PUT", path: "/v1/socrates/settings/policy", status: 403, code: "admin_required" };
    const denied = await drive(["settings", "policy", "--threshold", "4"]);
    expect(denied.stderr).toContain("ask an org admin to run this command");
  });
});

describe("settings canon", () => {
  it("--doc sets the Canon doc and consult --canon returns it afterwards", async () => {
    /** When the write goes to the wrong route or body, consult --canon keeps answering that no Canon doc is chosen; observed on the consult output. */
    const before = await drive(["consult", "--canon"]);
    expect(before.rc).toBe(1);
    const set = await drive(["settings", "canon", "--doc", "doc_01HZ"]);
    expect(set.rc).toBe(0);
    expect(set.stdout).toContain("canon: doc_01HZ");
    expect(puts()[0]!.body).toEqual({ schema_version: "1.0.0", doc: "doc_01HZ" });
    const after = await drive(["consult", "--canon"]);
    expect(after.rc).toBe(0);
    expect(after.stdout).toContain("# Canon doc_01HZ");
    expect((await drive(["settings", "canon"])).stdout).toContain("canon: doc_01HZ");
  });

  it("--clear sends null, and --doc with --clear is refused", async () => {
    /** When --clear sends an empty string or both flags are accepted, the Canon choice cannot be removed or is ambiguous; observed in the PUT body and the slug. */
    state.canon = "doc_01HZ";
    const cleared = await drive(["settings", "canon", "--clear"]);
    expect(cleared.stdout).toContain("canon cleared");
    expect(puts()[0]!.body.doc).toBeNull();
    const both = await drive(["settings", "canon", "--doc", "x", "--clear"]);
    expect(both.slug).toBe("socrates-flag-required");
    expect(puts()).toHaveLength(1);
  });

  it("refuses a secret in the document id before anything leaves the machine", async () => {
    /** When the id is not scanned, a pasted token travels in the PUT body; observed as the slug and an empty request log. */
    const r = await drive(["settings", "canon", "--doc", GITHUB_TOKEN]);
    expect(r.slug).toBe("socrates-secret-detected");
    expect(requests).toHaveLength(0);
  });
});
