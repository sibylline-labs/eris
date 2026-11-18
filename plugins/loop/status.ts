/**
 * status.ts — `eris loop status <ref>`: a session's state, read from its job directory and the claim
 * ledger. The text is `<id> · <name> · <state>`, then `detail:`, `needs:`, `claim:` (the ledger), `also:`
 * (the other sessions the ref names), one `in-flight:` line per running tool call (and a `stalled:` line
 * for one past the budget), then the newest message.
 *
 * A ref resolves over the Claude jobs and every supplied runtime's sessions together (sessions.ts); a
 * supplied runtime's session is rendered by its runtime, handed the `claim:` and `also:` values.
 *
 * Invariants:
 *  - several sessions matching one ref show the single working one, else the newest (`updatedAt`, then
 *    `createdAt`, then the later id), across runtimes; more than one working is `loop-session-ambiguous`;
 *  - elapsed time is the verb's clock against the job's own timestamps;
 *  - the newest message keeps its last `STATUS_TEXT_MAX` characters (a blocked session's question ends it);
 *  - every line read from disk is decoded from `unknown`; one that does not decode is skipped.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { decodeResult } from "eris/gates-contract";
import { heldClaim } from "./claims";
import { type ClaudeJob, readJobState, sessionAmbiguous, trimmed } from "./claude";
import { type Run, runtimeEnv } from "./deps";
import { usage } from "./failure";
import { loopOf, oneLine } from "./names";
import { isWorking, type LoopSession, matchSessions, notFound, sessionIdOf, sessionNameOf, sessionStateOf } from "./sessions";

/** Longest message `status` prints; the tail is kept. */
export const STATUS_TEXT_MAX = 4000;
/** A tool call running this long is stalled. */
export const COMMAND_BUDGET_MS = 25 * 60 * 1000;
const IN_FLIGHT_LABEL_MAX = 160;

const Text = Schema.optionalKey(Schema.NullOr(Schema.String));
const Any = Schema.optionalKey(Schema.Unknown);
const FanItem = Schema.Struct({ kind: Text, label: Text, startedAt: Any, doneAt: Any });
const TranscriptRow = Schema.Struct({ type: Text, timestamp: Text, message: Any });
const MessageBody = Schema.Struct({ content: Any });
const Block = Schema.Struct({ type: Text, text: Text, id: Text, name: Text, tool_use_id: Text, input: Any });
const ToolInput = Schema.Struct({ command: Text, description: Text });
const TimelineRow = Schema.Struct({ text: Text });

/** `raw` decoded through `schema`, or null. */
export function decodeOr<S extends Schema.Top>(schema: S, raw: unknown): S["Type"] | null {
  const d = decodeResult(schema, raw);
  return d._tag === "Success" ? d.success : null;
}

/** The rows of `raw` (when it is an array) that decode through `schema`. */
export const decodeRows = <S extends Schema.Top>(schema: S, raw: unknown): ReadonlyArray<S["Type"]> =>
  Array.isArray(raw) ? raw.flatMap((r: unknown) => {
    const d = decodeOr(schema, r);
    return d === null ? [] : [d];
  }) : [];

const blocks = (raw: unknown): ReadonlyArray<typeof Block.Type> => decodeRows(Block, decodeOr(MessageBody, raw)?.content);

/** Each JSON line of a `.jsonl` file; an unreadable file or line is skipped. */
function readJsonl(path: string): ReadonlyArray<unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}

export interface InFlightCall {
  readonly kind: string;
  readonly label: string;
  readonly elapsedS: number;
  readonly stalled: boolean;
}

function call(kind: string, rawLabel: string, startedMs: number, nowMs: number): InFlightCall {
  const label = oneLine(rawLabel) || kind;
  const elapsedS = Math.max(0, Math.trunc((nowMs - startedMs) / 1000));
  return { kind, label: label.slice(0, IN_FLIGHT_LABEL_MAX), elapsedS, stalled: elapsedS * 1000 >= COMMAND_BUDGET_MS };
}

/** An ISO timestamp as epoch ms; one with no zone reads as UTC. */
function isoMs(raw: string | null | undefined): number | null {
  const v = (raw ?? "").trim();
  if (v === "") return null;
  const ms = Date.parse(/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(v) ? v : `${v}Z`);
  return Number.isNaN(ms) ? null : ms;
}

function unansweredTranscriptCalls(path: string, nowMs: number): ReadonlyArray<InFlightCall> {
  const answered = new Set<string>();
  const pending: Array<{ id: string; name: string; label: string; at: number }> = [];
  for (const raw of readJsonl(path)) {
    const row = decodeOr(TranscriptRow, raw);
    if (row === null) continue;
    if (row.type === "user") {
      for (const b of blocks(row.message)) if (b.type === "tool_result" && trimmed(b.tool_use_id) !== "") answered.add(trimmed(b.tool_use_id));
    } else if (row.type === "assistant") {
      const at = isoMs(row.timestamp);
      if (at === null) continue;
      for (const b of blocks(row.message)) {
        if (b.type !== "tool_use") continue;
        const input = decodeOr(ToolInput, b.input);
        pending.push({ id: trimmed(b.id), name: trimmed(b.name) || "tool", label: input?.command || input?.description || "", at });
      }
    }
  }
  return pending.filter((p) => p.id === "" || !answered.has(p.id)).map((p) => call(p.name, p.label, p.at, nowMs));
}

/** A working job's running tool calls: its unfinished `fan` entries, else its transcript's unanswered `tool_use` blocks. A job in any other state runs nothing. */
export function inFlightCalls(jobDir: string, nowMs: number): ReadonlyArray<InFlightCall> {
  const st = readJobState(jobDir);
  if (st === null || st.state !== "working") return [];
  const calls = decodeRows(FanItem, st.fan).flatMap((item) => {
    if (typeof item.doneAt === "number" && item.doneAt > 0) return [];
    const started = item.startedAt;
    if (typeof started !== "number" || started <= 0) return [];
    return [call(trimmed(item.kind) || "tool", item.label ?? "", started > 1e11 ? started : started * 1000, nowMs)];
  });
  if (calls.length > 0) return calls;
  const transcript = trimmed(st.linkScanPath);
  return transcript === "" ? [] : unansweredTranscriptCalls(transcript, nowMs);
}

/** The newest assistant text: the job's timeline, else its transcript. */
function lastMessage(job: ClaudeJob): string | null {
  for (const raw of [...readJsonl(join(job.dir, "timeline.jsonl"))].reverse()) {
    const text = decodeOr(TimelineRow, raw)?.text;
    if (typeof text === "string" && text.trim() !== "") return text;
  }
  const transcript = trimmed(job.state.linkScanPath);
  if (transcript === "") return null;
  for (const raw of [...readJsonl(transcript)].reverse()) {
    const row = decodeOr(TranscriptRow, raw);
    if (row?.type !== "assistant") continue;
    const text = blocks(row.message)
      .filter((b) => b.type === "text" && trimmed(b.text) !== "")
      .map((b) => b.text!)
      .join("\n");
    if (text !== "") return text;
  }
  return null;
}

const field = (name: string, v: string | null | undefined): ReadonlyArray<string> => (v !== null && v !== undefined && v !== "" ? [`${name}: ${v}`] : []);
const jobTime = (job: ClaudeJob): number => isoMs(job.state.updatedAt) ?? isoMs(job.state.createdAt) ?? 0;
const sessionTime = (s: LoopSession): number => (s.kind === "claude" ? jobTime(s.job) : (s.session.updatedAt ?? 0));

/** The session a read of several matches shows: the single working one, else the newest. */
function pick(ref: string, matches: ReadonlyArray<LoopSession>): LoopSession {
  const working = matches.filter(isWorking);
  if (working.length > 1) sessionAmbiguous(ref, working.map(sessionIdOf));
  return working[0] ?? [...matches].sort((a, b) => sessionTime(b) - sessionTime(a) || (sessionIdOf(a) < sessionIdOf(b) ? 1 : -1))[0]!;
}

/** The status text for the session `ref` names (ends with a newline). */
export async function loopStatus(run: Run, ref: string | undefined): Promise<string> {
  const clean = ref?.trim() ?? "";
  if (clean === "") usage("status requires <session id|name|ISSUE>");
  const matches = await matchSessions(run, clean);
  if (matches.length === 0) notFound(run, clean);
  const s = pick(clean, matches);
  const name = sessionNameOf(s);
  const l = loopOf(name, run.legacyPrefixes);
  const record = l === null ? null : (heldClaim(run.ledger, l.issue)?.record ?? null);
  const claim = record === null ? null : `${record.claim_id.slice(0, 8)} · ${record.issue} · session ${record.session_id || "reserved, no session bound"} · since ${record.claimed_at || "unknown"}`;
  const also = matches.filter((m) => m !== s).map((m) => `${sessionIdOf(m)} ${sessionStateOf(m)}`);
  if (s.kind === "runtime") {
    const text = await s.rt.status(runtimeEnv(run), s.session, { claim, also });
    return text.endsWith("\n") ? text : `${text}\n`;
  }
  const job = s.job;
  const budgetM = COMMAND_BUDGET_MS / 60_000;
  const calls = inFlightCalls(job.dir, run.now()).flatMap((c) => {
    const [mins, secs] = [Math.floor(c.elapsedS / 60), c.elapsedS % 60];
    return [`in-flight: ${c.kind} (${mins}m ${secs}s): ${c.label}`, ...(c.stalled ? [`stalled: ${c.kind} running ${mins}m (exceeds ${budgetM}m budget): ${c.label}`] : [])];
  });
  const text = lastMessage(job);
  const chars = text === null ? [] : [...text];
  const message = text === null || text === "" ? [] : ["", "last message:", chars.length > STATUS_TEXT_MAX ? `…${chars.slice(-STATUS_TEXT_MAX).join("")}` : text];
  const lines = [
    `${job.id} · ${name || "(unnamed)"} · ${job.state.state || "unknown"}`,
    ...field("detail", job.state.detail),
    ...field("needs", job.state.needs),
    ...field("claim", claim),
    ...field("also", also.join(", ")),
    ...calls,
    ...message,
  ];
  return `${lines.join("\n")}\n`;
}
