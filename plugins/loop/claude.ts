/**
 * claude.ts — the Claude Code background-job runtime of `eris loop`. A job is
 * `~/.claude/jobs/<id>/state.json`; `claude --bg` prints `backgrounded · <id> · <name>` once the job is
 * registered, so a launch never backgrounds anything itself.
 *
 * Invariants:
 *  - a ref resolves by id (job id, `sessionId`, `resumeSessionId`), then exact name (any case), then
 *    the issue key in an `eris-loop-<slug>-<issue>` name (or a build's legacy prefix); the first tier
 *    with a match decides (sessions.ts adds a supplied runtime's matches to it);
 *  - every JSON read from disk or from claude is decoded from `unknown`; a state file that does not
 *    decode reads as an empty state (the job is still found by its id);
 *  - every claude child goes through `runChild` (a deadline, `childEnv`).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { decodeResult } from "eris/gates-contract";
import { childDetail, type Run, runChild, which } from "./deps";
import { block, launchFailed, stop, usage } from "./failure";
import { ISSUE_RE, loopOf } from "./names";

/** The receipt line `claude --bg` prints. */
const BACKGROUNDED_RE = /backgrounded · (\S+) · /;

export const jobsDir = (home: string): string => join(home, ".claude", "jobs");

const Text = Schema.optionalKey(Schema.NullOr(Schema.String));

/** The fields of a job's `state.json` eris reads; the rest are ignored. */
export const JobState = Schema.Struct({
  state: Text,
  name: Text,
  sessionId: Text,
  resumeSessionId: Text,
  respawnFlags: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
  cwd: Text,
  detail: Text,
  needs: Text,
  createdAt: Text,
  updatedAt: Text,
  linkScanPath: Text,
  fan: Schema.optionalKey(Schema.Unknown),
});
export type JobState = typeof JobState.Type;

export interface ClaudeJob {
  /** The job directory's name: the id `claude stop` takes. */
  readonly id: string;
  readonly dir: string;
  readonly state: JobState;
}

/** A job state in which the session no longer works its issue. */
export const FINISHED_JOB_STATES: ReadonlySet<string> = new Set(["done", "stopped", "failed"]);

export const trimmed = (v: string | null | undefined): string => (v ?? "").trim();

/** A job's decoded `state.json`, or null when it is absent or does not decode. */
export function readJobState(dir: string): JobState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  } catch {
    return null;
  }
  const decoded = decodeResult(JobState, raw);
  return decoded._tag === "Success" ? decoded.success : null;
}

/** Every job under `~/.claude/jobs` with a `state.json`, sorted by id. */
export function listJobs(home: string): ReadonlyArray<ClaudeJob> {
  let names: string[];
  try {
    names = readdirSync(jobsDir(home)).sort();
  } catch {
    return [];
  }
  return names.flatMap((id) => {
    const dir = join(jobsDir(home), id);
    try {
      statSync(join(dir, "state.json"));
    } catch {
      return [];
    }
    return [{ id, dir, state: readJobState(dir) ?? {} }];
  });
}

/** The jobs `ref` names in the first tier that matches (id, then exact name, then issue key), empty when none. */
export function matchJobs(home: string, ref: string, legacyPrefixes: ReadonlyArray<string>): ReadonlyArray<ClaudeJob> {
  const clean = ref.trim();
  if (clean === "") return [];
  const lower = clean.toLowerCase();
  const isIssue = ISSUE_RE.test(clean);
  const byId: ClaudeJob[] = [];
  const byName: ClaudeJob[] = [];
  const byIssue: ClaudeJob[] = [];
  for (const job of listJobs(home)) {
    const name = trimmed(job.state.name);
    if (clean === job.id || clean === job.state.sessionId || clean === job.state.resumeSessionId) byId.push(job);
    else if (name !== "" && name.toLowerCase() === lower) byName.push(job);
    else if (isIssue && loopOf(name, legacyPrefixes)?.issue === clean.toUpperCase()) byIssue.push(job);
  }
  return byId.length > 0 ? byId : byName.length > 0 ? byName : byIssue;
}

export function sessionAmbiguous(ref: string, ids: ReadonlyArray<string>): never {
  return stop(block("loop-session-ambiguous", `${JSON.stringify(ref)} names ${ids.length} sessions (${ids.join(", ")}); pass a session id`, "Pass one of the listed session ids instead of the name or issue key.", 2));
}

/** No session matched; `runtimes` names the supplied runtimes that were asked too. */
export function sessionNotFound(ref: string, home: string, runtimes: ReadonlyArray<string> = []): never {
  const where = runtimes.length === 0 ? `under ${jobsDir(home)}` : `under ${jobsDir(home)} or in runtime ${runtimes.join(", ")}`;
  return stop(
    block(
      "loop-session-not-found",
      `no background session ${JSON.stringify(ref)} ${where}`,
      "Pass a session id, its exact name or the issue key of a loop session ('claude agents' lists them).",
      2,
    ),
  );
}

/** The `claude` CLI on PATH, or `loop-usage`. */
export function claudeOnPath(run: Run): string {
  const claude = which("claude", run.env);
  if (claude === null) usage("the claude CLI is not on PATH", "Install Claude Code (or put 'claude' on PATH), then re-run.");
  return claude;
}

/** Run a `claude --bg …` and read the new session's id from its receipt line. */
async function spawnBg(run: Run, what: string, argv: readonly string[], cwd: string): Promise<string> {
  const r = await runChild(run, argv, { cwd });
  if (r.kind === "failed") launchFailed(`${what} ${r.why}`);
  const m = BACKGROUNDED_RE.exec(r.stdout);
  if (r.code !== 0 || m === null) launchFailed(`${what} failed (rc=${r.code}): ${childDetail(r)}`);
  return m[1]!;
}

/** `claude --bg <prompt> --name <name> --model <m>` in `cwd`; the new session's id. */
export function spawnClaude(run: Run, input: { claude: string; prompt: string; name: string; cwd: string; model: string }): Promise<string> {
  return spawnBg(run, "claude --bg", [input.claude, "--bg", input.prompt, "--name", input.name, "--model", input.model], input.cwd);
}

/**
 * Resume a finished job with `prompt`: refuse a working job, stop it unless already stopped (best
 * effort), then `claude --bg --resume <session> <prompt> ...respawnFlags` in the job's cwd when it is
 * still a directory, else `fallbackCwd`. The resumed session's id.
 */
export async function resumeClaude(run: Run, job: ClaudeJob, prompt: string, fallbackCwd: string): Promise<string> {
  if (job.state.state === "working") refuseWorking(job);
  const claude = claudeOnPath(run);
  if (job.state.state !== "stopped") await runChild(run, [claude, "stop", job.id]);
  const session = trimmed(job.state.resumeSessionId) || trimmed(job.state.sessionId) || job.id;
  const flags = (job.state.respawnFlags ?? []).filter((f): f is string => typeof f === "string");
  const raw = trimmed(job.state.cwd);
  let cwd = fallbackCwd;
  try {
    if (raw !== "" && statSync(raw).isDirectory()) cwd = raw;
  } catch {
    // the job's directory is gone: the fallback
  }
  return spawnBg(run, "claude --bg --resume", [claude, "--bg", "--resume", session, prompt, ...flags], cwd);
}

export function refuseWorking(job: ClaudeJob): never {
  return usage(`Claude session ${job.id} (${trimmed(job.state.name) || "unnamed"}) is currently working; wait for it to finish`, "Re-run once the session is no longer working.");
}

/** `claude stop <id>`, unless the job is already stopped; a failed stop is `loop-launch-failed`. */
export async function stopClaude(run: Run, job: ClaudeJob): Promise<void> {
  if (job.state.state === "stopped") return;
  const claude = claudeOnPath(run);
  const r = await runChild(run, [claude, "stop", job.id]);
  if (r.kind === "failed") launchFailed(`claude stop ${job.id} ${r.why}`);
  if (r.code !== 0) launchFailed(`claude stop ${job.id} failed (rc=${r.code}): ${childDetail(r)}`);
}

/** A `claude agents --json` row, as far as eris reads it. */
export const AgentRow = Schema.Struct({ id: Schema.String, name: Text, state: Text, kind: Text, cwd: Text, sessionId: Text, status: Text });
export type AgentRow = typeof AgentRow.Type;

export interface ClaudeAgents {
  /** False when claude is absent or its listing could not be read: "no rows" is then unknown, not empty. */
  readonly listed: boolean;
  readonly rows: ReadonlyArray<AgentRow>;
}

/** The background sessions `claude agents --json` lists; rows that do not decode are dropped. */
export async function claudeAgents(run: Run): Promise<ClaudeAgents> {
  const unlisted: ClaudeAgents = { listed: false, rows: [] };
  const claude = which("claude", run.env);
  if (claude === null) return unlisted;
  const r = await runChild(run, [claude, "agents", "--json"]);
  if (r.kind === "failed" || r.code !== 0 || r.stdout.trim() === "") return unlisted;
  let raw: unknown;
  try {
    raw = JSON.parse(r.stdout);
  } catch {
    return unlisted;
  }
  if (!Array.isArray(raw)) return unlisted;
  return {
    listed: true,
    rows: raw.flatMap((row: unknown) => {
      const d = decodeResult(AgentRow, row);
      return d._tag === "Success" ? [d.success] : [];
    }),
  };
}

/** Each local loop session on `issue` still at work, as `<id> · <name> · <state>`; with `slug`, only that loop's. */
export function liveSessions(home: string, legacyPrefixes: ReadonlyArray<string>, issue: string, slug?: string): ReadonlyArray<string> {
  return listJobs(home).flatMap((job) => {
    const name = trimmed(job.state.name);
    const l = loopOf(name, legacyPrefixes);
    const state = job.state.state ?? "unknown";
    return l !== null && l.issue === issue && (slug === undefined || l.slug === slug) && !FINISHED_JOB_STATES.has(state) ? [`${job.id} · ${name} · ${state}`] : [];
  });
}
