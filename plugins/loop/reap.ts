/**
 * reap.ts — `eris loop reap [--dry-run] [--repo <abs>]...`: stop finished loop sessions, release their
 * claims and orphaned reservations, then remove finished worktrees (reap-worktrees.ts). The last stdout
 * line is the `reap:` summary.
 *
 * Invariants:
 *  - only a background loop session (`eris-loop-<slug>-<issue>`, or a build's legacy prefix) in `done`
 *    or `blocked` is stopped; a working one is kept, and a session that is not a loop's is never touched;
 *  - a session-bound claim is released only when `claude agents` was read and its session is done,
 *    blocked or absent: a listing that could not be read releases nothing; an unbound reservation is
 *    released once its ledger `claimed_at` is `ORPHAN_RESERVATION_MS` old, so a launch between its
 *    reserve and its bind keeps its claim;
 *  - every ledger directory is walked (the primary, then a build's legacy ones) and each file is its
 *    own record, so a stale legacy record beside a fresh primary one is reaped on its own merits;
 *  - a `--repo` that is not an absolute directory refuses (`loop-usage`) before any child runs;
 *  - `--dry-run` runs no stop, release, remove or prune: it prints and counts what it would do.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GatesEndpoint } from "eris/gates-contract";
import { readClaimIn, recordPath, releaseClaim, RUNTIME } from "./claims";
import { type AgentRow, claudeAgents, jobsDir, trimmed } from "./claude";
import { endpoint, type Run, runChild, which } from "./deps";
import { checkCwd, loopOf } from "./names";
import { busyProcessCwds, discoverRepoRoots, realpathOr, reapWorktrees } from "./reap-worktrees";
import { COMMAND_BUDGET_MS, inFlightCalls } from "./status";

/** A reservation older than this whose launch never bound a session is orphaned. */
export const ORPHAN_RESERVATION_MS = 15 * 60 * 1000;
const REAPED_AGENT_STATES: ReadonlySet<string> = new Set(["done", "blocked"]);

interface SessionReap {
  stopped: number;
  failed: number;
  kept_working: number;
  stalled: number;
  readonly working_cwds: string[];
  rows: ReadonlyArray<AgentRow>;
  /** False when `claude agents --json` could not be read: no row then proves nothing. */
  listed: boolean;
}

async function reapSessions(run: Run, dryRun: boolean, out: string[]): Promise<SessionReap> {
  const n: SessionReap = { stopped: 0, failed: 0, kept_working: 0, stalled: 0, working_cwds: [], rows: [], listed: false };
  const claude = which("claude", run.env);
  const agents = await claudeAgents(run);
  if (!agents.listed || claude === null) return n;
  n.rows = agents.rows;
  n.listed = true;
  const budgetM = COMMAND_BUDGET_MS / 60_000;
  for (const row of agents.rows) {
    const [sid, name, state, kind, cwd] = [trimmed(row.id), trimmed(row.name), trimmed(row.state), trimmed(row.kind) || "background", trimmed(row.cwd)];
    if (state === "working") {
      n.kept_working += 1;
      if (cwd !== "") n.working_cwds.push(realpathOr(cwd));
      const stalled = sid === "" ? undefined : inFlightCalls(join(jobsDir(run.home), sid), run.now()).find((c) => c.stalled);
      if (stalled !== undefined) {
        n.stalled += 1;
        out.push(`stalled session ${sid} (${name || "(unnamed)"}): ${stalled.kind} running ${Math.floor(stalled.elapsedS / 60)}m (exceeds ${budgetM}m budget): ${stalled.label}`);
      }
      continue;
    }
    if (kind !== "background" || sid === "" || !REAPED_AGENT_STATES.has(state) || loopOf(name, run.legacyPrefixes) === null) continue;
    if (dryRun) {
      out.push(`dry-run: stop session ${sid} (${name}, ${state})`);
      n.stopped += 1;
      continue;
    }
    const stop = await runChild(run, [claude, "stop", sid]);
    if (stop.kind === "exited" && stop.code === 0) {
      out.push(`stopped session ${sid} (${name}, ${state})`);
      n.stopped += 1;
    } else {
      n.failed += 1;
      run.warn(`eris loop: could not stop session ${sid}: ${(stop.kind === "exited" ? stop.stderr.trim() : stop.why).slice(0, 200)}`);
    }
  }
  return n;
}

/** The `claude agents` row for a ledger session id: its id or its full `sessionId`. */
const agentRowFor = (session: string, rows: ReadonlyArray<AgentRow>): AgentRow | undefined => rows.find((row) => session === row.id || session === (row.sessionId ?? ""));

/** When the ledger says the claim was taken: its `claimed_at`, else the file's mtime. */
function claimedAt(dir: string, issue: string, raw: string): number | null {
  const at = Date.parse(raw);
  if (!Number.isNaN(at)) return at;
  try {
    return statSync(recordPath(dir, issue)).mtimeMs;
  } catch {
    return null;
  }
}

/** Each ledger file, directory by directory (primary first), each its own record. */
function ledgerFiles(run: Run): ReadonlyArray<{ readonly dir: string; readonly issue: string }> {
  return run.ledger.dirs.flatMap((dir) => {
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".json") && !f.startsWith("."))
        .sort()
        .map((f) => ({ dir, issue: f.slice(0, -".json".length) }));
    } catch {
      return [];
    }
  });
}

async function reapClaims(run: Run, sess: SessionReap, dryRun: boolean, out: string[]): Promise<[number, number]> {
  let [released, failed] = [0, 0];
  let ep: GatesEndpoint | undefined;
  for (const { dir, issue } of ledgerFiles(run)) {
    const record = readClaimIn(dir, issue);
    if (record === null || record.runtime !== RUNTIME) continue;
    let why: string;
    if (record.session_id === null || record.session_id === "") {
      const at = claimedAt(dir, issue, record.claimed_at);
      if (at === null || run.now() - at < ORPHAN_RESERVATION_MS) continue;
      why = "its launch never bound a session";
    } else {
      if (!sess.listed) continue;
      const row = agentRowFor(record.session_id, sess.rows);
      const state = trimmed(row?.state);
      if (row !== undefined && !REAPED_AGENT_STATES.has(state)) continue;
      why = `its session ${record.session_id} is ${state || "gone"}`;
    }
    const short = record.claim_id.slice(0, 8);
    if (dryRun) {
      out.push(`dry-run: release claim ${short} on ${issue} (${why})`);
      released += 1;
      continue;
    }
    ep ??= await endpoint(run);
    if (await releaseClaim(ep, { ledger: run.ledger, issue, claimId: record.claim_id, outcome: "aborted", body: `eris loop reap released this claim: ${why}.`, warn: run.warn })) {
      out.push(`released claim ${short} on ${issue} (${why})`);
      released += 1;
    } else failed += 1;
  }
  return [released, failed];
}

/** Reap sessions, claims and worktrees; the stdout lines, the `reap:` summary last. */
export async function reapLoops(run: Run, opts: { readonly dryRun: boolean; readonly repos: ReadonlyArray<string> }): Promise<ReadonlyArray<string>> {
  const repos = opts.repos.map((raw) => checkCwd(raw, run.home));
  const out: string[] = [];
  const sess = await reapSessions(run, opts.dryRun, out);
  const [claimsReleased, claimsFailed] = await reapClaims(run, sess, opts.dryRun, out);
  const roots = discoverRepoRoots(run, repos, sess.rows);
  const busy = await busyProcessCwds(run);
  const w = await reapWorktrees(run, { roots, busy, working: sess.working_cwds, dryRun: opts.dryRun, out });
  out.push(
    `reap: sessions stopped=${sess.stopped} failed=${sess.failed} kept_working=${sess.kept_working}` +
      ` · worktrees removed=${w.removed} failed=${w.failed} pruned_missing=${w.pruned_missing} kept_dirty=${w.kept_dirty} kept_open_pr=${w.kept_open_pr}` +
      ` kept_busy=${w.kept_busy} kept_working_loop=${w.kept_working_loop} kept_unmerged=${w.kept_unmerged}` +
      ` · claims released=${claimsReleased} failed=${claimsFailed}${sess.stalled > 0 ? ` · stalled=${sess.stalled}` : ""}`,
  );
  return out;
}
