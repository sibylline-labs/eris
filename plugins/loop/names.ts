/**
 * names.ts — `eris loop`'s operand caps, patterns and normalisers. Every operand is normalised before
 * any claim, request or spawn; a refusal is `loop-usage` (exit 2).
 *
 * Invariants:
 *  - a slug never holds `/`, `\` or `..` (checked before anything is stripped), so it is one safe path
 *    segment and one session-name word;
 *  - `sessionName` is the name `SESSION_RE` reads back, so stop, status and the live check find a
 *    loop by its issue.
 */

import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { usage } from "./failure";

/** A loop body's cap. The prompt is one argv word; macOS caps argv plus environ at 1 MiB. */
export const BODY_MAX_BYTES = 256 * 1024;
export const CONTEXT_MAX = 1024;
export const CALLER_MAX = 128;
export const SLUG_MAX = 64;
/** A hand-back's cap: what the tracker's comment route takes. */
export const HAND_BACK_MAX = 65536;

export const ISSUE_RE = /^[A-Za-z]+-[0-9]+$/;
export const CLAIM_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
/** A `claude --model` value: an alias or a full model name, never starting with `-` (claude would read a flag). */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;
/** A loop's session name, `eris-loop-<slug>-<issue>`: captures the slug and the issue. */
export const SESSION_RE = /^eris-loop-([a-z0-9_-]+)-([a-z]+-[0-9]+)$/i;

export const DEFAULT_RESUME_PROMPT = "Continue from where you left off in your worktree without repeating completed work.";

const chars = (s: string): number => [...s].length;
/** Collapse every whitespace run to one space and trim: one line. */
export const oneLine = (raw: string): string => raw.split(/\s+/).filter((w) => w !== "").join(" ");

export function normaliseSlug(raw: string): string {
  if (raw.includes("/") || raw.includes("\\") || raw.includes("..")) usage(`loop name ${JSON.stringify(raw)} must not contain '/', '\\' or '..'`);
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
  if (slug === "") usage(`loop name ${JSON.stringify(raw)} has no usable characters (keeps a-z, 0-9, '_', '-')`);
  if (slug.length > SLUG_MAX) usage(`loop name ${JSON.stringify(raw)} is over ${SLUG_MAX} characters`);
  return slug;
}

export function normaliseIssue(raw: string): string {
  const issue = raw.trim();
  if (!ISSUE_RE.test(issue)) usage(`issue ${JSON.stringify(raw)} must be an issue key like ABC-123 (or a yak id)`);
  return issue.toUpperCase();
}

export function normaliseContext(raw: string | undefined): string | undefined {
  const context = oneLine(raw ?? "");
  if (chars(context) > CONTEXT_MAX) usage(`--context is over ${CONTEXT_MAX} characters; keep it to one line`);
  return context === "" ? undefined : context;
}

export function normaliseReportTo(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const key = raw.trim();
  if (!ISSUE_RE.test(key)) usage(`--report-to ${JSON.stringify(raw)} must be an issue key (ABC-123); a session name goes stale`);
  return key.toUpperCase();
}

export function normaliseCaller(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (raw.includes("\0")) usage("--caller must not contain a NUL byte");
  const caller = oneLine(raw);
  if (chars(caller) > CALLER_MAX) usage(`--caller is over ${CALLER_MAX} characters; pass the bare session name`);
  return caller === "" ? undefined : caller;
}

/** `--model` is required: without it the session would inherit whatever model the machine's settings name. */
export function normaliseModel(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") usage("--model is required (an alias such as sonnet or opus, or a full model name)");
  const model = raw.trim();
  if (!MODEL_RE.test(model)) usage(`--model ${JSON.stringify(raw)} must be a model alias (sonnet, opus) or a full model name`);
  return model;
}

export function normaliseResumePrompt(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_RESUME_PROMPT;
  if (raw.includes("\0")) usage("--prompt must not contain a NUL byte");
  const prompt = oneLine(raw);
  if (prompt === "") usage("--prompt must not be empty");
  if (chars(prompt) > CONTEXT_MAX) usage(`--prompt is over ${CONTEXT_MAX} characters; keep it to one line`);
  return prompt;
}

/** `--cwd`: an absolute, existing directory that is not `$HOME` (an untrusted workspace there fails the session). */
export function checkCwd(raw: string, home: string): string {
  if (!isAbsolute(raw)) usage(`--cwd ${JSON.stringify(raw)} must be an absolute path`);
  let dir = false;
  try {
    dir = statSync(raw).isDirectory();
  } catch {
    dir = false;
  }
  if (!dir) usage(`--cwd ${JSON.stringify(raw)} is not an existing directory`);
  let same: boolean;
  try {
    same = realpathSync(raw) === realpathSync(home);
  } catch (e) {
    return usage(`--cwd ${JSON.stringify(raw)} cannot be resolved: ${(e as Error).message}`);
  }
  if (same) usage("--cwd must be the target repo, never $HOME (an untrusted workspace there fails the session)");
  return raw;
}

/** The loop's session name: `eris-loop-<slug>-<issue lower>`. */
export const sessionName = (slug: string, issue: string): string => `eris-loop-${slug}-${issue.toLowerCase()}`;

/** The slug and issue (upper-case) a session name carries, or null for a session that is not a loop's. */
export function loopOf(name: string): { readonly slug: string; readonly issue: string } | null {
  const m = SESSION_RE.exec(name.trim());
  return m === null ? null : { slug: m[1]!.toLowerCase(), issue: m[2]!.toUpperCase() };
}
