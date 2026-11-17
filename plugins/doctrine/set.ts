/**
 * set.ts — `eris doctrine set <posture> --reason <why> --file <path>`: switch the active posture in a
 * doctrine file, append the attributed change to `<doctrine-dir>/doctrine-history.jsonl`, snapshot both
 * postures, and have the gateway write the tracker comment on every impacted open issue
 * (POST /v1/gates/doctrine-comments): `Doctrine changed: A → B · by <actor> · reason: …`, then one
 * `- <sentence>` line per effect. A flip within ten minutes of the last coalesces into that comment.
 *
 * eris holds no tracker credential: the gateway reads the issue and writes the comment, so this file
 * frames the request and decides which issues are impacted.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  activePosture,
  citePosture,
  COPY_MAX_BYTES,
  type ContractFailure,
  type ControlEffect,
  decodePayload,
  type DoctrineCommentWritten,
  type DoctrineRead,
  fail,
  gatesEndpoint,
  invalidDoctrine,
  listOpenIssues,
  listReceipts,
  type Outcome,
  policyEffects,
  policyHash,
  type Posture,
  type PostureSnapshot,
  postDoctrineComment,
  type Profile,
  readDoctrine,
  readProfiles,
  sha256Hex,
  succeed,
} from "eris/gates-contract";
import { scanStrings } from "eris/outbound-scan";
import { CliExit, readArgs, renderFailureBlock, runCommand, type VerbContext } from "../../src/cli/plugin";
import plugin from "./index";
import { inDoctrineStore } from "./org-tree";
import { type PullDeps, resolveOrg } from "./pull";

const ROWS = plugin.rows;
const ACTIVE = /^active:\s*(\S+)\s*$/;
const HEADING = /^##\s+(\S+)\s*$/;
const DOCTRINE_ACTOR_RE = /^doctrine:([a-z0-9-]+)@([0-9a-f]{12})$/;

/** Flips within 10 minutes coalesce into one comment per issue. */
export const DOCTRINE_COALESCE_WINDOW_MS = 10 * 60 * 1000;

export const SET_USAGE = `Usage: eris doctrine set ${ROWS["doctrine set"].usage}

Validate the doctrine file (--file; the org's pulled policy is never edited here), switch 'active:'
to <posture>, append the attributed change to doctrine-history.jsonl beside it, snapshot both
postures, and have the gateway post one comment on every impacted open issue (not Done/Canceled,
latest gate receipt on a different policy_hash):
  Doctrine changed: A → B · by <actor> · reason: …
  - <one sentence per effect, as 'eris doctrine effect' prints it>
Flips within ~10 minutes coalesce into one comment per issue. Prints one
'<issue>\\t<commented|coalesced>\\t<comment id>' line per issue.

  <posture>      The posture slug to activate
  --reason       Why the doctrine is changing (required)
  --file         The doctrine file to change (required)
  --profiles     A YAML map of profile name to gate list (default: the org's pulled
                 profiles.yaml, else the built-in spine and deep)
  --actor        Who changed the doctrine (default: session:<id> in an agent session,
                 else git config user.email, else $USER)
  --issues       Comma-separated issue keys to consider (default: every open issue holding a gate receipt)
`;

/** Replace the `active:` line before the first `## ` heading, or prepend one, leaving every posture section verbatim. */
export function setActiveDoctrineText(text: string, slug: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const headingIdx = lines.findIndex((l) => HEADING.test(l));
  const searchEnd = headingIdx === -1 ? lines.length : headingIdx;
  const activeIdx = lines.slice(0, searchEnd).findIndex((l) => ACTIVE.test(l));
  if (activeIdx !== -1) {
    const out = [...lines];
    out[activeIdx] = `active: ${slug}`;
    return out.join(eol);
  }
  return [`active: ${slug}`, "", ...lines].join(eol);
}

/** A posture's `## <slug>` section as a snapshot the gateway stores; a section holding a credential-shaped string, or over the cap, falls back to its heading and name. */
export function snapshotPosture(p: Posture): PostureSnapshot {
  const raw = Buffer.from(p.section, "utf8");
  const fallback = Buffer.from(`## ${p.slug}\n${p.name}\n`, "utf8");
  const clean = scanStrings(p.section).length === 0 ? raw : fallback;
  const chosen = gzipSync(clean).toString("base64").length <= COPY_MAX_BYTES ? clean : fallback;
  return { sha256: sha256Hex(chosen), encoding: "gzip+base64", content: gzipSync(chosen).toString("base64"), bytes: chosen.byteLength };
}

const cite = (p: Posture, snapshotSha: string): string => `${citePosture(p)} (snapshot \`${snapshotSha.slice(0, 12)}\`)`;

/** The doctrine-change comment: a header line, then one sentence per effect. */
export function renderDoctrineChangeComment(input: {
  readonly from: Posture;
  readonly fromSha: string;
  readonly via?: { readonly posture: Posture; readonly sha: string } | undefined;
  readonly to: Posture;
  readonly toSha: string;
  readonly actor: string;
  readonly reasons: ReadonlyArray<string>;
  readonly effects: ReadonlyArray<ControlEffect>;
}): string {
  const via = input.via !== undefined ? ` → ${cite(input.via.posture, input.via.sha)}` : "";
  const reason = input.reasons.map((r) => r.replace(/\r?\n/g, " ").trim()).join("; ");
  const lines = input.effects.length > 0 ? input.effects.map((e) => `- ${e.sentence}`) : ["- No effective change."];
  return [`Doctrine changed: ${cite(input.from, input.fromSha)}${via} → ${cite(input.to, input.toSha)} · by ${input.actor} · reason: ${reason}`, ...lines].join("\n");
}

/** The policy hash (and posture, when `read` holds it) the latest gate receipt on `issue` was recorded under. */
export function latestReceiptPolicy(
  records: ReadonlyArray<{ readonly createdAt: string; readonly version: "v1" | "v2"; readonly payload: unknown }>,
  issue: string,
  read: DoctrineRead,
): { readonly policyHash: string; readonly posture: Posture | undefined } | null {
  let latestAt = "";
  let latest: ReturnType<typeof receiptOf> = null;
  for (const c of records) {
    const r = receiptOf(c);
    if (r === null || r.issue !== issue || r.gate === "doctrine-change") continue;
    if (latest === null || c.createdAt >= latestAt) {
      latest = r;
      latestAt = c.createdAt;
    }
  }
  if (latest === null) return null;
  const hash = latest.doctrine?.policy_hash;
  if (hash !== undefined && hash !== "") {
    const slug = latest.doctrine?.posture;
    return { policyHash: hash, posture: read.postures.find((p) => p.slug === slug) ?? read.postures.find((p) => policyHash(p) === hash) };
  }
  const m = DOCTRINE_ACTOR_RE.exec(latest.actor);
  if (m !== null) return { policyHash: m[2]!, posture: read.postures.find((p) => p.slug === m[1]) ?? read.postures.find((p) => policyHash(p) === m[2]) };
  if (latest.doctrine !== undefined) {
    const sha = latest.doctrine.sha256;
    const bySection = read.postures.find((p) => sha256Hex(Buffer.from(p.section, "utf8")) === sha);
    const h = bySection !== undefined ? policyHash(bySection) : null;
    if (bySection !== undefined && h !== null) return { policyHash: h, posture: bySection };
    return { policyHash: sha.slice(0, 12), posture: undefined };
  }
  return null;
}

function receiptOf(c: { readonly version: "v1" | "v2"; readonly payload: unknown }) {
  const d = decodePayload(c.version, c.payload);
  return d.kind === "receipt" ? d.receipt : null;
}

interface Window {
  readonly commentId: string;
  readonly fromSlug: string;
  readonly fromHash: string | null;
  readonly toSlug: string;
  readonly toHash: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly reasons: readonly string[];
  readonly actor: string;
}
interface ChangesState {
  windows: Record<string, Window>;
}

const STATE_FILE = "doctrine-changes.json";
const HISTORY_FILE = "doctrine-history.jsonl";

function readState(dir: string): ChangesState {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8")) as { windows?: Record<string, Window> };
    return { windows: typeof parsed.windows === "object" && parsed.windows !== null ? { ...parsed.windows } : {} };
  } catch {
    return { windows: {} };
  }
}

/** Replace `file` by a sibling temp file and a rename, keeping an existing file's mode (0644 for a new one). */
function writeAtomic(file: string, text: string): void {
  let mode = 0o644;
  try {
    mode = statSync(file).mode & 0o777;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const tmp = join(dirname(file), `.eris-doctrine.${randomUUID().slice(0, 8)}`);
  try {
    writeFileSync(tmp, text, { mode, flag: "wx" });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const usageFailure = (what: string): ContractFailure => ({
  slug: "doctrine-usage",
  what,
  fix: `usage: eris doctrine set ${ROWS["doctrine set"].usage}`,
  docs: "docs/ERRORS.md#doctrine-usage",
  exit: 2,
});

/** Who changed the doctrine: the flag, else the agent session, else git's email, else `$USER`. */
async function actorFor(ctx: VerbContext, flag: string | undefined): Promise<string> {
  if (flag !== undefined && flag !== "") return flag;
  const session = ctx.env.CLAUDE_CODE_SESSION_ID ?? ctx.env.OPENCODE_SESSION_ID;
  if (session !== undefined && session !== "") return `session:${session}`;
  const email = await runCommand(["git", "config", "user.email"], { env: ctx.env, timeoutMs: 30_000 });
  return (email.kind === "ok" ? email.stdout.toString("utf8").trim() : "") || ctx.env.USER || "unknown";
}

export interface SetInput {
  readonly file: string;
  readonly posture: string;
  readonly reason: string;
  readonly actor: string;
  readonly profiles: Readonly<Record<string, Profile>>;
  readonly issues: ReadonlyArray<string>;
  readonly now: Date;
}

/** Switch `active:` in `input.file`, record the change, and comment (or coalesce) on every impacted open issue. */
export async function setDoctrine(ctx: VerbContext, deps: PullDeps, input: SetInput): Promise<Outcome<ReadonlyArray<DoctrineCommentWritten>>> {
  const reason = input.reason.trim();
  if (reason === "") return fail(usageFailure("doctrine set: --reason is blank"));
  let rawText: string;
  try {
    rawText = readFileSync(input.file, "utf8");
  } catch {
    return fail({ slug: "doctrine-file-missing", what: `${input.file}: cannot read the doctrine file`, fix: "Pass --file <path> naming a readable doctrine file.", docs: "docs/ERRORS.md#doctrine-file-missing", exit: 3 });
  }
  const read = readDoctrine(rawText);
  const bad = invalidDoctrine(input.file, read);
  if (bad !== null) return fail(bad);
  const to = read.postures.find((p) => p.slug === input.posture);
  if (to === undefined) {
    return fail({
      slug: "doctrine-posture-unknown",
      what: `${input.file}: no ## ${input.posture} posture (${read.postures.map((p) => p.slug).join(", ") || "none"})`,
      fix: "Pass one of the posture slugs in the doctrine file ('eris doctrine check' lists them).",
      docs: "docs/ERRORS.md#doctrine-posture-unknown",
      exit: 3,
    });
  }
  const from = activePosture(read);
  const nextText = setActiveDoctrineText(rawText, to.slug);
  const nextBad = invalidDoctrine(input.file, readDoctrine(nextText));
  if (nextBad !== null) return fail(nextBad);

  const resolved = await resolveOrg(ctx, deps, "there is no org to comment through");
  if (!resolved.ok) return resolved;
  const ep = gatesEndpoint(resolved.value.bearer.url, resolved.value.bearer.token, { fetch: deps.fetch });
  if (!ep.ok) return ep;
  // The gateway is asked first: a refused read leaves the file as it was.
  const open = await listOpenIssues(ep.value, input.issues.length > 0 ? input.issues : undefined);
  if (!open.ok) return open;

  const fromHash = from !== undefined ? policyHash(from) : null;
  const toHash = policyHash(to);
  const dir = dirname(input.file);
  try {
    mkdirSync(dir, { recursive: true });
    writeAtomic(input.file, nextText);
    appendFileSync(join(dir, HISTORY_FILE), `${JSON.stringify({ at: input.now.toISOString(), actor: input.actor, reason, from: from?.slug ?? null, to: to.slug, from_hash: fromHash, to_hash: toHash })}\n`, "utf8");
  } catch {
    return fail({ slug: "doctrine-file-missing", what: `${input.file}: cannot write the doctrine file`, fix: "Check the directory and file permissions, or pass --file <path>.", docs: "docs/ERRORS.md#doctrine-file-missing", exit: 3 });
  }

  const state = readState(dir);
  const toSnap = snapshotPosture(to);
  const comments: DoctrineCommentWritten[] = [];
  const save = (): void => {
    try {
      writeAtomic(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
    } catch {
      // The window state only enables coalescing: a lost write posts a second comment, never a wrong one.
    }
  };
  for (const issue of open.value) {
    const listing = await listReceipts(ep.value, issue);
    if (!listing.ok) return listing;
    const info = latestReceiptPolicy(listing.value.receipts, issue, read);
    if (info === null) continue;
    const win = state.windows[issue];
    const inWindow = win !== undefined && input.now.getTime() - Date.parse(win.startedAt) <= DOCTRINE_COALESCE_WINDOW_MS;
    if (inWindow && win !== undefined) {
      if (win.toHash === toHash) continue;
      const base = read.postures.find((p) => p.slug === win.fromSlug) ?? info.posture ?? from ?? to;
      const baseSnap = snapshotPosture(base);
      const reasons = [...win.reasons, reason];
      const revertedToBase = toHash !== null && toHash === win.fromHash;
      const via = revertedToBase ? read.postures.find((p) => p.slug === win.toSlug) : undefined;
      const body = renderDoctrineChangeComment({
        from: base,
        fromSha: baseSnap.sha256,
        ...(via !== undefined ? { via: { posture: via, sha: snapshotPosture(via).sha256 } } : {}),
        to,
        toSha: toSnap.sha256,
        actor: input.actor,
        reasons,
        effects: revertedToBase ? [] : policyEffects(input.profiles, base.policy, to.policy),
      });
      const written = await postDoctrineComment(ep.value, { issue, commentId: win.commentId, replaceCommentId: win.commentId, body, fromSnapshot: baseSnap, toSnapshot: toSnap });
      if (!written.ok) return written;
      state.windows[issue] = { ...win, commentId: written.value.id, toSlug: to.slug, toHash, updatedAt: input.now.toISOString(), reasons, actor: input.actor };
      save();
      comments.push(written.value);
      continue;
    }
    if (info.policyHash === toHash) continue;
    const base = (win !== undefined ? read.postures.find((p) => p.slug === win.toSlug) : undefined) ?? info.posture ?? from ?? to;
    const baseSnap = snapshotPosture(base);
    const body = renderDoctrineChangeComment({
      from: base,
      fromSha: baseSnap.sha256,
      to,
      toSha: toSnap.sha256,
      actor: input.actor,
      reasons: [reason],
      effects: policyEffects(input.profiles, base.policy, to.policy),
    });
    const written = await postDoctrineComment(ep.value, { issue, commentId: randomUUID(), body, fromSnapshot: baseSnap, toSnapshot: toSnap });
    if (!written.ok) return written;
    state.windows[issue] = {
      commentId: written.value.id,
      fromSlug: base.slug,
      fromHash: policyHash(base),
      toSlug: to.slug,
      toHash,
      startedAt: input.now.toISOString(),
      updatedAt: input.now.toISOString(),
      reasons: [reason],
      actor: input.actor,
    };
    save();
    comments.push(written.value);
  }
  return succeed(comments);
}

/** `eris doctrine set`. */
export async function runSet(args: string[], ctx: VerbContext, deps: PullDeps = {}, profilesDefault?: () => Promise<string | undefined>): Promise<number> {
  const a = readArgs(ROWS, "doctrine set", args, ctx, { help: SET_USAGE });
  if (a === null) return 0;
  const stop = (f: ContractFailure): never => {
    ctx.stderr.write(renderFailureBlock({ slug: f.slug, what: f.what, fix: f.fix, docs: f.docs }, ctx.erisDir));
    throw new CliExit(f.exit);
  };
  const [posture = ""] = a.pos;
  const fl = a.flags;
  const missing = [...(posture === "" ? ["<posture>"] : []), ...(fl["--reason"] === undefined ? ["--reason"] : []), ...(fl["--file"] === undefined ? ["--file"] : [])];
  if (missing.length > 0) stop(usageFailure(`doctrine set: missing ${missing.join(", ")}`));
  const file = fl["--file"]!;
  if (inDoctrineStore(ctx.env.HOME ?? homedir(), file)) {
    stop({
      slug: "doctrine-org-managed",
      what: `doctrine set: ${file} is the org's pulled policy, which this machine never edits in place`,
      fix: "Change the active posture in the org's Gates settings, then run 'eris doctrine pull'; or pass --file <path> to set a local doctrine file.",
      docs: "docs/ERRORS.md#doctrine-org-managed",
      exit: 3,
    });
  }
  const profiles = readProfiles(fl["--profiles"] ?? (await profilesDefault?.()));
  if (!profiles.ok) return stop(profiles.failure);
  const issues = (fl["--issues"] ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  const done = await setDoctrine(ctx, deps, {
    file,
    posture,
    reason: fl["--reason"]!,
    actor: await actorFor(ctx, fl["--actor"]),
    profiles: profiles.value,
    issues,
    now: (deps.now ?? (() => new Date()))(),
  });
  if (!done.ok) return stop(done.failure);
  for (const c of done.value) ctx.stdout.write(`${c.issue}\t${c.coalesced ? "coalesced" : "commented"}\t${c.id}\n`);
  ctx.stderr.write(`INFO ✓ active doctrine: ${posture} (${done.value.length} issue(s) updated)\n`);
  return 0;
}
