/**
 * actor.ts — who recorded a receipt: the stable key kept in `receipt.actor` (`session:<id>`, a
 * `doctrine:` actor, or a human's email or handle) and the display metadata frozen beside it in
 * `actor_info` (a name, the runtime, the session's link).
 *
 * The default, with no `--actor`: the Claude Code session (`CLAUDE_CODE_SESSION_ID`), named from
 * `~/.claude` (its sessions and jobs records, else the transcript's last title); else the OpenCode
 * session (`OPENCODE_SESSION_ID`), named from its local database; else git's `user.email` and
 * `user.name`, then `$USER`. Every read is best effort: a name it cannot find falls back to a prefix of
 * the session id, never to a failure.
 */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GateActor } from "eris/gates-contract";
import { type Git, ok } from "./git";

export interface ResolvedActor {
  readonly actor: string;
  readonly actorInfo?: GateActor;
}

const nonEmpty = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t !== "" ? t : undefined;
};

/** A Claude bridge session id (`cse_…` or `session_…`) as its `claude.ai/code/session_…` URL. */
function bridgeUrl(bridgeId: unknown): string | undefined {
  const raw = nonEmpty(bridgeId);
  if (raw === undefined) return undefined;
  if (raw.startsWith("https://claude.ai/code/")) return raw;
  return `https://claude.ai/code/${raw.replace(/^cse_/, "session_")}`;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const listDir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** The transcript's latest title and bridge session, read from its last lines. */
function scanTranscript(path: string): { name?: string; bridgeId?: string } {
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n");
  } catch {
    return {};
  }
  let name: string | undefined;
  let bridgeId: string | undefined;
  for (let i = lines.length - 1; i >= 0 && (name === undefined || bridgeId === undefined); i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (name === undefined) {
        if (row.type === "custom-title") name = nonEmpty(row.customTitle);
        else if (row.type === "agent-name") name = nonEmpty(row.agentName);
        else if (row.type === "ai-title") name = nonEmpty(row.aiTitle);
      }
      if (bridgeId === undefined && row.type === "bridge-session") bridgeId = nonEmpty(row.bridgeSessionId) ?? nonEmpty(row.url);
    } catch {
      // A line that is not JSON names nothing.
    }
  }
  return { ...(name !== undefined ? { name } : {}), ...(bridgeId !== undefined ? { bridgeId } : {}) };
}

/** A Claude Code session's display metadata, from `~/.claude`. */
function claudeSession(home: string, sessionId: string, bridgeEnv: string | undefined): GateActor {
  const claudeDir = join(home, ".claude");
  let name: string | undefined;
  let jobId: string | undefined;
  let bridgeId = nonEmpty(bridgeEnv);
  let transcript: string | undefined;
  for (const f of listDir(join(claudeDir, "sessions"))) {
    if (!f.endsWith(".json")) continue;
    const rec = readJson(join(claudeDir, "sessions", f));
    if (rec?.sessionId === sessionId) {
      name ??= nonEmpty(rec.name);
      jobId ??= nonEmpty(rec.jobId);
      bridgeId ??= nonEmpty(rec.bridgeSessionId);
      break;
    }
  }
  for (const d of listDir(join(claudeDir, "jobs"))) {
    const st = readJson(join(claudeDir, "jobs", d, "state.json"));
    if (st === null) continue;
    if (st.sessionId === sessionId || st.resumeSessionId === sessionId || (jobId !== undefined && d === jobId)) {
      name ??= nonEmpty(st.name);
      bridgeId ??= nonEmpty(st.bridgeSessionId);
      transcript ??= nonEmpty(st.linkScanPath);
      break;
    }
  }
  if (name === undefined || bridgeId === undefined) {
    if (transcript === undefined || !existsSync(transcript)) {
      transcript = undefined;
      for (const proj of listDir(join(claudeDir, "projects"))) {
        const candidate = join(claudeDir, "projects", proj, `${sessionId}.jsonl`);
        if (existsSync(candidate)) {
          transcript = candidate;
          break;
        }
      }
    }
    if (transcript !== undefined) {
      const scanned = scanTranscript(transcript);
      name ??= scanned.name;
      bridgeId ??= scanned.bridgeId;
    }
  }
  const url = bridgeUrl(bridgeId);
  return { kind: "session", name: name ?? sessionId.slice(0, 8), runtime: "claude", ...(url !== undefined ? { url } : {}) };
}

/** An OpenCode session's title, from its local database. */
function openCodeName(home: string, sessionId: string): string | undefined {
  const dbPath = join(home, ".local", "share", "opencode", "opencode.db");
  if (!existsSync(dbPath)) return undefined;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT title, slug FROM session_v2 WHERE id = ?").get(sessionId) as { title?: string; slug?: string } | null;
    return nonEmpty(row?.title) ?? nonEmpty(row?.slug);
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a read-only handle has nothing to undo.
    }
  }
}

const openCodeSession = (home: string, id: string): GateActor => ({ kind: "session", name: openCodeName(home, id) ?? id.slice(0, 12), runtime: "opencode" });

async function gitConfig(g: Git, cwd: string, key: string): Promise<string> {
  const r = await g.run(["git", "-C", cwd, "config", key], { timeoutMs: 30_000 });
  return ok(r) ? r.stdout.toString("utf8").trim() : "";
}

/** The receipt's actor key and display metadata, from `--actor` or the environment. */
export async function resolveActor(input: { readonly flag?: string | undefined; readonly g: Git; readonly cwd: string }): Promise<ResolvedActor> {
  const env = input.g.env;
  const home = nonEmpty(env.HOME) ?? homedir();
  const flag = nonEmpty(input.flag);
  if (flag !== undefined) {
    if (flag.startsWith("doctrine:")) return { actor: flag };
    if (flag.startsWith("session:")) {
      const sid = flag.slice("session:".length).trim();
      return { actor: flag, actorInfo: sid.startsWith("ses_") ? openCodeSession(home, sid) : claudeSession(home, sid, env.CLAUDE_CODE_BRIDGE_SESSION_ID) };
    }
    return { actor: flag, actorInfo: { kind: "human", name: flag.replace(/^@+/, "").trim() || flag } };
  }
  const claudeId = nonEmpty(env.CLAUDE_CODE_SESSION_ID);
  if (claudeId !== undefined) return { actor: `session:${claudeId}`, actorInfo: claudeSession(home, claudeId, env.CLAUDE_CODE_BRIDGE_SESSION_ID) };
  const openCodeId = nonEmpty(env.OPENCODE_SESSION_ID);
  if (openCodeId !== undefined) return { actor: `session:${openCodeId}`, actorInfo: openCodeSession(home, openCodeId) };
  const email = await gitConfig(input.g, input.cwd, "user.email");
  const gitName = await gitConfig(input.g, input.cwd, "user.name");
  const actor = email || nonEmpty(env.USER) || "unknown";
  return { actor, actorInfo: { kind: "human", name: (gitName || actor).replace(/^@+/, "").trim() || actor } };
}
