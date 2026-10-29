/**
 * `eris yak status`, `discover`, `config get|set`, and the parked-yak WARN a
 * delivered `eris yak issue|suggest|fatal` raises when its org has no
 * destination.
 *
 * The seam is the yak group handler (`runYakVerb`) with a loopback `Bun.serve`
 * standing in for the gateway's `/v1/yaks/*` routes, and a sandbox HOME. Every
 * request crosses real HTTP; the server records each one so a test can assert
 * what was sent, and what was not.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { YAKS_CONTRACT_VERSION } from "eris/yak-contract";
import { runYakVerb } from "../plugins/yak/handlers";
import { CliExit } from "../src/cli/ts-verb";

const REPO = resolve(import.meta.dir, "..");

const TEAM = "11111111-1111-4111-8111-111111111111";
const OTHER_TEAM = "22222222-2222-4222-8222-222222222222";
const TRIAGE = "33333333-3333-4333-8333-333333333333";
const BACKLOG = "44444444-4444-4444-8444-444444444444";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const LABEL_YAK = "66666666-6666-4666-8666-666666666666";
const LABEL_CLI = "77777777-7777-4777-8777-777777777777";
const LABEL_GROUP = "88888888-8888-4888-8888-888888888888";

function discovery(teamId: string) {
  return {
    teams: [
      { id: TEAM, key: "ENG", name: "Engineering" },
      { id: OTHER_TEAM, key: "OPS", name: "Operations" },
    ],
    team_id: teamId,
    projects: [{ id: PROJECT, name: "Tooling", status: { id: "s", name: "Started", type: "started" } }],
    workflow_states: [
      { id: BACKLOG, name: "Backlog", type: "backlog", position: 1 },
      { id: TRIAGE, name: "Triage", type: "triage", position: 0 },
    ],
    labels: [
      { id: LABEL_YAK, name: "Yak", color: "#fff", isGroup: false, teamId: null },
      { id: LABEL_CLI, name: "CLI", color: "#000", isGroup: false, teamId },
      { id: LABEL_GROUP, name: "Area", color: "#111", isGroup: true, teamId },
    ],
    default_state_id: TRIAGE,
  };
}

function stored(config: Record<string, unknown>) {
  return {
    config: { project_id: null, state_id: null, label_ids: [], new_issue_cap: 20, ...config },
    updated_at: "2026-10-29T12:00:00.000Z",
    updated_by: { kind: "user", id: "mem_1", name: "admin" },
  };
}

type Route = (req: Request, body: unknown) => Response;

let sandbox: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let routes: Record<string, Route>;
const requests: { method: string; path: string; body: unknown; auth: string | null }[] = [];

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "yak-admin-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      const body: unknown = text.length > 0 ? JSON.parse(text) : undefined;
      requests.push({ method: req.method, path: `${url.pathname}${url.search}`, body, auth: req.headers.get("authorization") });
      const route = routes[`${req.method} ${url.pathname}`];
      return route ? route(req, body) : Response.json({ error: { code: "not_found", message: "no such endpoint" } }, { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(sandbox, "home-")));
  requests.length = 0;
  routes = {
    "GET /v1/yaks/status": () => Response.json({ configured: false, observation_count: 3, last_filed_issue_identifier: null }),
    "GET /v1/yaks/config": () => Response.json({ configured: false }),
    "GET /v1/yaks/discovery": (req) => Response.json(discovery(new URL(req.url).searchParams.get("team_id") ?? TEAM)),
    "PUT /v1/yaks/config": (_req, body) => Response.json(stored({ team_id: TEAM, ...(body as object) })),
    "POST /v1/yaks": (_req, body) =>
      Response.json({ id: "obs-1", idempotency_key: (body as { idempotency_key: string }).idempotency_key, replay: false, contract_version: YAKS_CONTRACT_VERSION }),
  };
});

interface Captured {
  rc: number;
  stdout: string;
  stderr: string;
}

async function yak(args: string[], format: "text" | "json" = "text"): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  let rc: number;
  try {
    rc = await runYakVerb(
      args,
      {
        erisDir: REPO,
        env: { PATH: process.env.PATH, HOME: home, ERIS_YAKS_URL: `http://127.0.0.1:${server.port}`, ERIS_YAKS_TOKEN: "tok" },
        format,
        stdout: { write: (s: string) => ((stdout += s), true) },
        stderr: { write: (s: string) => ((stderr += s), true) },
      },
      { cwd: sandbox, ppid: 1 },
    );
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    rc = e.code;
  }
  return { rc, stdout, stderr };
}

const puts = () => requests.filter((r) => r.method === "PUT");

describe("eris yak status", () => {
  it("text: the three facts on stdout, and the parked note on stderr when unconfigured", async () => {
    /** When status hides the unconfigured state, an agent reads 'observations: 3' and never learns its yaks are parked: observed on stdout/stderr. */
    const r = await yak(["status"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toBe("configured:    no\nobservations:  3\nlast filed:    none\n");
    expect(r.stderr).toContain("parked until a destination is set");
    expect(requests[0]).toMatchObject({ method: "GET", path: "/v1/yaks/status", auth: "Bearer tok" });
  });

  it("json: the server's body, bare, and nothing on stderr", async () => {
    /** When json mode wraps or reshapes the body, or leaks the note to stderr, a machine caller's parse breaks: observed on both streams. */
    const r = await yak(["status"], "json");
    expect(r).toEqual({ rc: 0, stdout: `${JSON.stringify({ configured: false, observation_count: 3, last_filed_issue_identifier: null })}\n`, stderr: "" });
  });

  it("no token: the yak-token-unresolved block, exit 1, nothing sent", async () => {
    /** When a missing token reads as success, an agent believes it checked the org: observed at the exit code and the request log. */
    let stderr = "";
    const rc = await runYakVerb(["status"], { erisDir: REPO, env: { PATH: process.env.PATH, HOME: home }, format: "text", stdout: { write: () => true }, stderr: { write: (s: string) => ((stderr += s), true) } });
    expect(rc).toBe(1);
    expect(stderr).toContain("slug: yak-token-unresolved");
    expect(requests).toHaveLength(0);
  });
});

describe("eris yak discover", () => {
  it("text: every section, the chosen team starred, states by position with the default marked", async () => {
    /** When discover prints names without ids, or hides the default state, an agent cannot build a config set: observed on stdout. */
    const r = await yak(["discover"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toContain(`*  ENG  Engineering  ${TEAM}`);
    expect(r.stdout).toContain(`states (team ENG):\nTriage   triage   ${TRIAGE}  (default)\nBacklog  backlog  ${BACKLOG}\n`);
    expect(r.stdout).toContain(`labels (team ENG):\nYak  workspace  ${LABEL_YAK}\nCLI  team       ${LABEL_CLI}\n`);
  });

  it("--team by key asks for that team's lists; one section prints alone", async () => {
    /** When a key is not resolved to its id, discovery always answers the first team's states: observed at the second request's query. */
    const r = await yak(["discover", "states", "--team", "ops"]);
    expect(r.rc).toBe(0);
    expect(requests.map((q) => q.path)).toEqual(["/v1/yaks/discovery", `/v1/yaks/discovery?team_id=${OTHER_TEAM}`]);
    expect(r.stdout.startsWith("states (team OPS):\n")).toBe(true);
    expect(r.stdout).not.toContain("teams:");
  });

  it("403 admin_required: the yak-admin-required block naming the Linear-admin approver, exit 1, stdout empty", async () => {
    /** When a non-admin refusal reads as an empty list, an agent concludes the workspace has no teams: observed on all three outputs. */
    routes["GET /v1/yaks/discovery"] = () => Response.json({ error: { code: "admin_required", message: "x" } }, { status: 403 });
    const r = await yak(["discover"], "json");
    expect(r.rc).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("slug: yak-admin-required");
    expect(r.stderr).toContain("Linear admin");
  });

  it("an unknown kind is yak-discover-unknown-kind, exit 1, nothing sent", async () => {
    /** When a typo'd section prints everything, a script filtering one section silently gets four: observed at the exit code. */
    const r = await yak(["discover", "team"]);
    expect(r.rc).toBe(1);
    expect(r.stderr).toContain("slug: yak-discover-unknown-kind");
    expect(requests).toHaveLength(0);
  });
});

describe("eris yak config get", () => {
  it("unconfigured: 'configured: no' and the next command on stderr", async () => {
    /** When get prints nothing for an unconfigured org, an agent cannot tell an empty config from a failed read: observed on stdout. */
    const r = await yak(["config", "get"]);
    expect(r).toMatchObject({ rc: 0, stdout: "configured: no\n" });
    expect(r.stderr).toContain("eris yak config set --team");
  });

  it("configured, json: the read body, bare, unknown fields kept", async () => {
    /** When the client's schema strips caps and label maps, a json caller re-printing the config loses them: observed on stdout. */
    routes["GET /v1/yaks/config"] = () => Response.json({ configured: true, ...stored({ team_id: TEAM, verb_label_ids: { issue: LABEL_CLI } }) });
    const r = await yak(["config", "get"], "json");
    expect(r.rc).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ configured: true, ...stored({ team_id: TEAM, verb_label_ids: { issue: LABEL_CLI } }) });
  });
});

describe("eris yak config set", () => {
  it("names resolve to ids: --team by key, --state and --labels by name or id, and only given keys are sent", async () => {
    /** When a name is sent as-is the server 422s, and when an absent flag is sent as null it clears a stored value: observed in the PUT body. */
    const r = await yak(["config", "set", "--team", "ENG", "--state", "triage", "--labels", `yak,${LABEL_CLI}`], "json");
    expect(r.rc).toBe(0);
    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.body).toEqual({ team_id: TEAM, state_id: TRIAGE, label_ids: [LABEL_YAK, LABEL_CLI] });
    expect(JSON.parse(r.stdout).config.team_id).toBe(TEAM);
  });

  it("a UUID team still goes through discovery, so a team the workspace lacks is refused before any PUT", async () => {
    /** When a UUID skips the check, a set stores a team no yak can be filed into: observed as the absent PUT. */
    routes["GET /v1/yaks/discovery"] = (req) =>
      new URL(req.url).searchParams.get("team_id") === OTHER_TEAM ? Response.json({ error: { code: "team_not_found", message: "x" } }, { status: 404 }) : Response.json(discovery(TEAM));
    const r = await yak(["config", "set", "--team", OTHER_TEAM]);
    expect(r.rc).toBe(1);
    expect(r.stderr).toContain("slug: yak-team-not-found");
    expect(puts()).toHaveLength(0);
  });

  it("--project none clears the project; a project by name on a configured org resolves against its stored team", async () => {
    /** When `none` is sent as a name, or a name resolves against the wrong team, the stored project is wrong: observed in the PUT body and discovery query. */
    expect((await yak(["config", "set", "--project", "none"])).rc).toBe(0);
    expect(puts()[0]!.body).toEqual({ project_id: null });
    requests.length = 0;
    routes["GET /v1/yaks/config"] = () => Response.json({ configured: true, ...stored({ team_id: OTHER_TEAM }) });
    const r = await yak(["config", "set", "--project", "Tooling"]);
    expect(r.rc).toBe(0);
    expect(requests.some((q) => q.path === `/v1/yaks/discovery?team_id=${OTHER_TEAM}`)).toBe(true);
    expect(puts()[0]!.body).toEqual({ project_id: PROJECT });
    expect(r.stdout.startsWith("configured: yes\n")).toBe(true);
  });

  it("an unmatched name is yak-config-no-match listing the candidates, and nothing is PUT", async () => {
    /** When an unmatched name falls through to the server, the fix the agent needs (the real names) is lost: observed on stderr and the absent PUT. */
    const r = await yak(["config", "set", "--team", "ENG", "--state", "Doing"]);
    expect(r.rc).toBe(1);
    expect(r.stderr).toContain("slug: yak-config-no-match");
    expect(r.stderr).toContain(`fix: Triage  ${TRIAGE}`);
    expect(puts()).toHaveLength(0);
  });

  it("a UUID label is checked too: a group label is refused before any PUT; --labels none clears", async () => {
    /** When a UUID label skips discovery, a group label (which Linear will not apply) is stored and filing breaks later: observed as the absent PUT, then the clearing PUT body. */
    routes["GET /v1/yaks/config"] = () => Response.json({ configured: true, ...stored({ team_id: TEAM }) });
    const group = await yak(["config", "set", "--labels", LABEL_GROUP]);
    expect(group.rc).toBe(1);
    expect(group.stderr).toContain("slug: yak-config-no-match");
    expect(puts()).toHaveLength(0);
    expect((await yak(["config", "set", "--labels", "none"])).rc).toBe(0);
    expect(puts()[0]!.body).toEqual({ label_ids: [] });
  });

  it("no flag at all is yak-config-set-empty, and a 422 is yak-config-invalid", async () => {
    /** When an empty set or a refused set exits 0, an agent reports a destination it never stored: observed at the exit code. */
    const empty = await yak(["config", "set"]);
    expect(empty.rc).toBe(1);
    expect(empty.stderr).toContain("slug: yak-config-set-empty");
    routes["PUT /v1/yaks/config"] = () => Response.json({ error: { code: "invalid_config", message: "x" } }, { status: 422 });
    const refused = await yak(["config", "set", "--team", TEAM], "json");
    expect(refused).toMatchObject({ rc: 1, stdout: "" });
    expect(refused.stderr).toContain("slug: yak-config-invalid");
  });
});

describe("eris yak config, the group", () => {
  it("--output json on the group (bare or --help) is refused; text prints its usage", async () => {
    /** When the group answers json mode with usage text, a parser downstream breaks on prose: observed at the slug and an empty stdout. */
    for (const args of [["config"], ["config", "--help"]]) {
      const r = await yak(args, "json");
      expect({ rc: r.rc, stdout: r.stdout }).toEqual({ rc: 1, stdout: "" });
      expect(r.stderr).toContain("slug: output-json-unsupported");
    }
    expect((await yak(["config"])).stdout).toContain("Usage: eris yak config <command>");
  });
});

describe("the parked-yak WARN on a delivered yak", () => {
  const FILE = ["issue", "--summary", "s", "--body", "b"];

  it("unconfigured, text: 'recorded: <id>', then the WARN naming the fix; exit 0", async () => {
    /** When a parked yak prints only 'recorded:', the user believes it filed while it sits unfiled: the defect this WARN exists for, observed on stderr. */
    const r = await yak(FILE);
    expect(r.rc).toBe(0);
    expect(r.stdout).toBe("recorded: obs-1\n");
    expect(r.stderr).toContain("WARN yak obs-1 is parked");
    expect(r.stderr).toContain("eris yak config set --team <key>");
    expect(r.stderr).toContain("slug: yak-parked-unconfigured");
  });

  it("unconfigured, json: configured:false on the record, stderr empty", async () => {
    /** When json mode drops the fact, or prints the WARN on stderr, a machine caller either misses it or breaks the yak surface's empty-stderr rule. */
    const r = await yak(FILE, "json");
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toMatchObject({ delivered: true, id: "obs-1", configured: false });
  });

  it("configured: no WARN in text, configured:true in json", async () => {
    /** When a configured org still warns, every yak carries a false alarm the agent learns to ignore. */
    routes["GET /v1/yaks/status"] = () => Response.json({ configured: true, observation_count: 9, last_filed_issue_identifier: "ENGINEERING-1" });
    expect(await yak(FILE)).toEqual({ rc: 0, stdout: "recorded: obs-1\n", stderr: "" });
    expect(JSON.parse((await yak(FILE, "json")).stdout).configured).toBe(true);
  });

  it("a status that fails adds nothing: no WARN, no configured field", async () => {
    /** When a failed status read becomes a WARN or a failure, a delivered yak looks broken. */
    routes["GET /v1/yaks/status"] = () => new Response("boom", { status: 500 });
    expect(await yak(FILE)).toEqual({ rc: 0, stdout: "recorded: obs-1\n", stderr: "" });
    expect(JSON.parse((await yak(FILE, "json")).stdout)).not.toHaveProperty("configured");
  });

  it("a vendor yak reads no status: the caller's config is not its destination", async () => {
    /** When a vendor report checks the caller's org, an unconfigured workspace gets a false parked WARN on a yak that files fine. */
    const r = await yak([...FILE, "--vendor"]);
    expect(r).toEqual({ rc: 0, stdout: "recorded: obs-1\n", stderr: "" });
    expect(requests.map((q) => `${q.method} ${q.path}`)).toEqual(["POST /v1/yaks"]);
  });
});
