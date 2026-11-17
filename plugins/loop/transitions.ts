/**
 * transitions.ts — what a loop verb writes to the tracker besides its claim: a launch moves the issue,
 * and its parent, to In Progress while each is unstarted; a stop moves an issue back to Todo only while
 * it is In Progress (state type `started` named "In Progress"); In Review, Blocked and every other state
 * stand. A closed issue is never reopened. Each move only warns on failure: the session already
 * started (or stopped), and that outcome stands.
 */

import { type GatesEndpoint, getIssue, type LinearStateTarget, transitionIssue } from "eris/gates-contract";
import type { Warn } from "./claims";
import { stop } from "./failure";

/** State types of an issue not started yet. */
export const UNSTARTED_STATE_TYPES: ReadonlySet<string> = new Set(["triage", "backlog", "unstarted"]);
/** State types of a closed issue. */
export const CLOSED_STATE_TYPES: ReadonlySet<string> = new Set(["completed", "canceled", "duplicate"]);
export const STARTED: LinearStateTarget = { type: "started", name: "In Progress" };
export const TODO: LinearStateTarget = { type: "unstarted", name: "Todo" };

async function move(ep: GatesEndpoint, key: string, to: LinearStateTarget, warn: Warn): Promise<void> {
  const r = await transitionIssue(ep, key, to);
  if (!r.ok) warn(`eris loop: could not move ${key} to ${to.name ?? to.type}: ${r.failure.slug}: ${r.failure.what}`);
}

/** Move `issue` and its parent to In Progress while each is unstarted; started and closed states stand. */
export async function startIssue(ep: GatesEndpoint, issue: string, warn: Warn): Promise<void> {
  const found = await getIssue(ep, issue);
  if (!found.ok) {
    warn(`eris loop: could not move ${issue} to In Progress: ${found.failure.slug}: ${found.failure.what}`);
    return;
  }
  if (UNSTARTED_STATE_TYPES.has(found.value.state.type)) await move(ep, issue, STARTED, warn);
  const parent = found.value.parent;
  if (parent !== null && UNSTARTED_STATE_TYPES.has(parent.state.type)) await move(ep, parent.identifier, STARTED, warn);
}

/** Move `issue` back to Todo after its session stopped, only while it is In Progress. */
export async function stopIssue(ep: GatesEndpoint, issue: string, warn: Warn): Promise<void> {
  const found = await getIssue(ep, issue);
  if (!found.ok) {
    warn(`eris loop: could not move ${issue} to Todo: ${found.failure.slug}: ${found.failure.what}`);
    return;
  }
  const { type, name } = found.value.state;
  if (type === "started" && name.trim().toLowerCase() === "in progress") await move(ep, issue, TODO, warn);
}

/**
 * Whether `issue` is closed. A gate ahead of a resume, so it fails closed: an auth, transport, rate
 * limit or contract failure stops the verb rather than reading as "open". An issue the gateway does
 * not know warns and counts as closed: there is nothing there to continue.
 */
export async function isClosed(ep: GatesEndpoint, issue: string, warn: Warn): Promise<boolean> {
  const found = await getIssue(ep, issue);
  if (found.ok) return CLOSED_STATE_TYPES.has(found.value.state.type);
  if (found.failure.slug !== "linear-issue-not-found") return stop(found.failure);
  warn(`eris loop: ${issue} is not readable on the tracker (${found.failure.slug}); skipping its session`);
  return true;
}
