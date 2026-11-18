/**
 * The world `eris loop` runs in, for the loop tests: a loopback `Bun.serve` standing in for the
 * gateway (the policy and settings routes, the `/v1/linear` claim, release, comment, transition and
 * issue routes, and the yak lookup), a sandbox HOME holding the login, and a fake `claude` executable
 * on PATH that keeps real job directories under `$HOME/.claude/jobs/<id>/state.json` and answers
 * `--bg`, `stop` and `agents --json` from them.
 *
 * Everything lives under the gitignored `data/scratch/` (never the system temp dir). The gateway keeps
 * one claim per issue as the real one does, records every request, and lets a test refuse any route.
 * The fake records each `claude` call's argv in `calls.log` (fields `\x1f`, records `\x1e`), and each
 * call's env markers (plus any name listed in `FAKE_CLAUDE_ENV_KEYS`) in `calls.log.env`. The bearer
 * is assembled at runtime so no literal trips a secret scanner.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { computeGatesBundleSha, type GatesOrgBundle, type GatesSettings } from "eris/gates-contract";
import { LOOP_DEFAULTS } from "../../plugins/index";
import type { LoopDefaults } from "../../plugins/loop";
import { loopHandler, type LoopDeps } from "../../plugins/loop/handlers";
import { CliExit } from "../../src/cli/ts-verb";

export const REPO = resolve(import.meta.dir, "..", "..");
export const ORG = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
export const LOGIN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const V1 = "linear-contract/v1";

export const LOOP_BODY = "# One shot\n\nRun the issue to a ready PR.\n";
export const BUNDLE: GatesOrgBundle = {
  active: "business-as-usual",
  postures: { "business-as-usual": { name: "Business as usual", bullets: ["The default."], policy: { profile_default: "deep" } } },
  profiles: { deep: ["premise-gate", "final-gates"] },
  loops: { "one-shot": LOOP_BODY, fixer: "# Fixer\n\nFix it.\n" },
} as GatesOrgBundle;
export const SETTINGS: GatesSettings = { staleness: "soft", ci: { check_profile_in_ci: "on", untracked_prs: "block", bot_allowlist: [] } };

/** A claim the fake gateway holds: its id is the holder's guard and never leaves the server. */
export interface HeldClaim {
  claimId: string;
  loop: string;
  runtime: string;
  session_id: string | null;
  agent_session_id: string | null;
}

export interface Issue {
  state: { name: string; type: string };
  parent?: string;
}

export interface Seen {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}

const problem = (status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  Response.json({ type: "about:blank", status, code, ...extra }, { status, headers: { "content-type": "application/problem+json", ...headers } });

/** The fake `claude`: a bun script, so its job files are real JSON. */
const FAKE_CLAUDE = `#!/usr/bin/env -S bun --no-env-file --config=/dev/null
const { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const home = process.env.HOME;
const jobs = join(home, ".claude", "jobs");
appendFileSync(process.env.FAKE_CLAUDE_LOG, args.join("\\x1f") + "\\x1e");
const extraKeys = (process.env.FAKE_CLAUDE_ENV_KEYS ?? "").split(",").filter((k) => k !== "");
appendFileSync(process.env.FAKE_CLAUDE_LOG + ".env", JSON.stringify({ cwd: process.cwd(), CLAUDECODE: process.env.CLAUDECODE ?? null, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT ?? null, ERIS_YAKS_TOKEN: process.env.ERIS_YAKS_TOKEN ?? null, ...Object.fromEntries(extraKeys.map((k) => [k, process.env[k] ?? null])) }) + "\\n");
const flag = (n) => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
if (args[0] === "--bg") {
  if (process.env.FAKE_CLAUDE_FAIL) { process.stderr.write("claude: the daemon is down\\n"); process.exit(1); }
  const countFile = join(process.env.FAKE_CLAUDE_DIR, "count");
  const n = (existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) : 0) + 1;
  writeFileSync(countFile, String(n));
  const id = "job" + String(n).padStart(5, "0");
  const resume = flag("--resume");
  let name = flag("--name");
  if (resume !== undefined) for (const j of readdirSync(jobs)) { const s = JSON.parse(readFileSync(join(jobs, j, "state.json"), "utf8")); if (s.sessionId === resume) name = s.name; }
  mkdirSync(join(jobs, id), { recursive: true });
  writeFileSync(join(jobs, id, "state.json"), JSON.stringify({ state: "working", name, sessionId: "sess-" + id, cwd: process.cwd() }));
  process.stdout.write("backgrounded \\u00b7 " + id + " \\u00b7 " + name + "\\n");
} else if (args[0] === "stop") {
  const f = join(jobs, args[1], "state.json");
  const s = JSON.parse(readFileSync(f, "utf8"));
  writeFileSync(f, JSON.stringify({ ...s, state: "stopped" }));
} else if (args[0] === "agents") {
  if (process.env.FAKE_CLAUDE_AGENTS_FAIL) process.exit(1);
  const rows = existsSync(jobs) ? readdirSync(jobs).map((id) => { const s = JSON.parse(readFileSync(join(jobs, id, "state.json"), "utf8")); return { id, name: s.name, state: s.state, kind: "background", cwd: s.cwd, sessionId: s.sessionId }; }) : [];
  process.stdout.write(JSON.stringify(rows));
}
`;

export interface LoopWorld {
  readonly home: string;
  readonly dir: string;
  readonly repo: string;
  readonly env: Record<string, string | undefined>;
  readonly seen: Seen[];
  readonly claims: Map<string, HeldClaim>;
  readonly issues: Map<string, Issue>;
  /** Answer a route with this instead of the fake's own reply (`"POST /v1/linear/issues/ABC-7/claim"`). */
  readonly refuse: Map<string, () => Response>;
  /** The org's live policy, as the gateway serves it; `setBundle` changes it and its sha. */
  bundle: GatesOrgBundle;
  liveSha: string;
  setBundle(b: GatesOrgBundle): Promise<void>;
  /** Every `claude` call's argv, in order. */
  calls(): string[][];
  /** Each `claude` call's working directory and the session markers and bearer its env carried. */
  childEnvs(): Array<Record<string, string | null>>;
  /** A job's state file, as the fake keeps it. */
  job(id: string): Record<string, unknown>;
  setJob(id: string, patch: Record<string, unknown>): void;
  close(): void;
}

let server: ReturnType<typeof Bun.serve> | null = null;
let current: LoopWorld | null = null;

/** A fresh world: a new HOME, gateway state, fake claude and a target repo directory. */
export async function loopWorld(): Promise<LoopWorld> {
  mkdirSync(join(REPO, "data", "scratch"), { recursive: true });
  const dir = realpathSync(mkdtempSync(join(REPO, "data", "scratch", "loop-")));
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const repo = join(dir, "repo");
  for (const d of [home, bin, repo, join(home, ".eris")]) mkdirSync(d, { recursive: true, mode: 0o700 });
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  chmodSync(join(bin, "claude"), 0o755);
  const seen: Seen[] = [];
  const claims = new Map<string, HeldClaim>();
  const issues = new Map<string, Issue>();
  const refuse = new Map<string, () => Response>();
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  writeFileSync(`${log}.env`, "");
  const world: LoopWorld = {
    home,
    dir,
    repo,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_DIR: dir },
    seen,
    claims,
    issues,
    refuse,
    bundle: BUNDLE,
    liveSha: await computeGatesBundleSha(BUNDLE, SETTINGS),
    setBundle: async (b) => {
      world.bundle = b;
      world.liveSha = await computeGatesBundleSha(b, SETTINGS);
    },
    childEnvs: () =>
      readFileSync(`${log}.env`, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as Record<string, string | null>),
    calls: () =>
      readFileSync(log, "utf8")
        .split("\x1e")
        .filter((r) => r !== "")
        .map((r) => r.split("\x1f")),
    job: (id) => JSON.parse(readFileSync(join(home, ".claude", "jobs", id, "state.json"), "utf8")) as Record<string, unknown>,
    setJob: (id, patch) => {
      const f = join(home, ".claude", "jobs", id, "state.json");
      writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), ...patch }));
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
  current = world;
  server ??= Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => answer(req) });
  writeFileSync(join(home, ".eris", "yaks.json"), JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token: LOGIN }), { mode: 0o600 });
  return world;
}

export function stopServer(): void {
  server?.stop(true);
  server = null;
}

const issueNode = (w: LoopWorld, key: string) => {
  const i = w.issues.get(key)!;
  const parent = i.parent !== undefined ? { identifier: i.parent, state: w.issues.get(i.parent)?.state ?? { name: "Todo", type: "unstarted" } } : null;
  return { identifier: key, state: i.state, parent };
};

async function answer(req: Request): Promise<Response> {
  const w = current!;
  const url = new URL(req.url);
  const text = await req.text();
  const body: unknown = text === "" ? undefined : JSON.parse(text);
  w.seen.push({ method: req.method, path: url.pathname, body, auth: req.headers.get("authorization") });
  const refused = w.refuse.get(`${req.method} ${url.pathname}`);
  if (refused !== undefined) return refused();
  if (req.method === "GET" && url.pathname === "/v1/gates/policy") return Response.json({ contract: "gates-contract/v1.5", bundle: w.bundle, bundle_sha: w.liveSha });
  if (req.method === "GET" && url.pathname === "/v1/gates/settings") return Response.json({ contract: "gates-contract/v1.5", settings: SETTINGS, bundle_sha: w.liveSha });
  const m = /^\/v1\/linear\/issues\/([A-Z]+-\d+)(?:\/(claim|release|comments|transition))?$/.exec(url.pathname);
  if (m === null) return problem(404, "not_found");
  const key = m[1]!;
  const b = (body ?? {}) as Record<string, string | undefined>;
  if (!w.issues.has(key)) return problem(404, "issue_not_found");
  switch (m[2]) {
    case undefined:
      return Response.json({ issue: issueNode(w, key), contract_version: V1 });
    case "claim": {
      const held = w.claims.get(key);
      if (held !== undefined && held.claimId !== b.claim_id) {
        return problem(409, "issue_already_claimed", { fields: { holder: { loop: held.loop, runtime: held.runtime, session_id: held.session_id, claimed_at: "2026-11-17T11:00:00Z", expires_at: "2026-11-17T15:00:00Z" } } });
      }
      const claim: HeldClaim = { claimId: b.claim_id!, loop: b.loop!, runtime: b.runtime!, session_id: b.session_id ?? held?.session_id ?? null, agent_session_id: b.session_id !== undefined ? `agent-${b.session_id}` : null };
      w.claims.set(key, claim);
      const { claimId: _guard, ...pub } = claim;
      return Response.json({ claim: { issue: key, ...pub, pr_url: null, claimed_at: "2026-11-17T12:00:00Z", expires_at: "2026-11-17T16:00:00Z" }, delegate_status: "pending", bundle_sha: w.liveSha, contract_version: V1 }, { status: held === undefined ? 201 : 200 });
    }
    case "release": {
      const held = w.claims.get(key);
      if (held === undefined) return Response.json({ released: false, reason: "not_claimed", contract_version: V1 });
      if (held.claimId !== b.claim_id) return Response.json({ released: false, reason: "superseded", contract_version: V1 });
      w.claims.delete(key);
      return Response.json({ released: true, response_posted: b.body !== undefined, contract_version: V1 });
    }
    case "comments":
      return Response.json({ comment: { id: `comment-${w.seen.length}`, createdAt: "2026-11-17T12:00:00Z", body: b.body }, contract_version: V1 }, { status: 201 });
    case "transition": {
      const i = w.issues.get(key)!;
      i.state = { name: b.state ?? b.state_type!, type: b.state_type! };
      return Response.json({ issue: issueNode(w, key), contract_version: V1 });
    }
  }
  return problem(404, "not_found");
}

export interface Ran {
  rc: number;
  stdout: string;
  stderr: string;
}

/** Drive `eris loop <args>` through the build's own loop wiring (or `o.defaults`), in `cwd` (the world's repo by default). */
export async function loop(
  w: LoopWorld,
  args: string[],
  o: { format?: "text" | "json"; stdin?: string; cwd?: string; deps?: Partial<LoopDeps>; env?: Record<string, string | undefined>; defaults?: LoopDefaults } = {},
): Promise<Ran> {
  let stdout = "";
  let stderr = "";
  let rc: number;
  try {
    rc = await loopHandler(o.defaults ?? LOOP_DEFAULTS, {
      home: w.home,
      cwd: o.cwd ?? w.repo,
      sleep: async () => undefined,
      now: () => Date.parse("2026-11-17T12:00:00Z"),
      ...(o.stdin !== undefined ? { stdin: o.stdin } : {}),
      ...o.deps,
    })(args, {
      erisDir: REPO,
      env: { ...w.env, ...o.env },
      format: o.format ?? "text",
      stdout: { write: (s: string) => ((stdout += s), true) },
      stderr: { write: (s: string) => ((stderr += s), true) },
    });
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    rc = e.code;
  }
  return { rc, stdout, stderr };
}

export const slugOf = (stderr: string): string | undefined => /^slug: (\S+)$/m.exec(stderr)?.[1];
