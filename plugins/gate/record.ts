/**
 * record.ts — `eris gate record` and `eris gate skip`: hash the artifact, snapshot the active doctrine
 * posture, upload each media file, and append the receipt under a comment id this run chose.
 *
 * Invariants:
 *  - Every evidence file is read and checked before the first upload, so a bad flag sends nothing.
 *  - An upload the store recorded with other bytes posts no receipt.
 *  - A PASS/AMENDED receipt carries a gzip copy of its artifact (check re-hashes it once the file is
 *    gone), unless the bytes are not UTF-8 text, the secret scan matches, or it encodes past the cap:
 *    a match drops the copy, never the receipt.
 *  - `skipGate` is the only writer of SKIPPED. A doctrine-shaped grant holds only as
 *    `doctrine:<posture>` that `--doctrine` bears out; a repo-shaped one only as `repo:no-eris-yaml` on
 *    `define-future` in a repo with no root `eris.yaml`. A human grant is prose, recorded as given.
 *  - The write is retried on a 429 with the same comment id, which the gateway dedupes on.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type * as Redacted from "effect/Redacted";
import {
  activePosture,
  appendReceipt,
  ASSET_MAX_BYTES,
  COPY_MAX_BYTES,
  DEFINE_FUTURE_GATE,
  DOCTRINE_GRANT,
  decodePayload,
  deriveReviewPass,
  doctrineGrantPosture,
  doctrineShaped,
  doctrineSkipBlocker,
  type DoctrineRead,
  type EndorsedFinding,
  GATE_NAME,
  GATE_RECEIPT_SCHEMA,
  GATE_RECEIPT_SCHEMA_V3,
  type GateActor,
  type GateArtifactCopy,
  type GateDoctrine,
  type GateEvidence,
  type GateInlineKind,
  type GateMediaKind,
  type GateReceipt,
  type GateReceiptV2,
  type GateReviewFinding,
  type GateReviewReport,
  type GatesEndpoint,
  type GateUserImpact,
  type GateVerdict,
  INLINE_MAX_BYTES,
  ISSUE_KEY,
  isGateReviewReportEvidence,
  isBlankGrant,
  isHumanGrant,
  type KnownActors,
  listReceipts,
  type MandateHandle,
  NO_ERIS_YAML_GRANT,
  noErisYamlSkipBlocker,
  type ParsedGateReviewReport,
  parseReviewReport,
  policyHash,
  readDoctrine,
  repoGrantShaped,
  reviewEndorseScope,
  reviewReportDigest,
  sameActor,
  sha256Hex,
  uploadAsset,
  type RetryOpts,
  retryRateLimited,
} from "eris/gates-contract";
import { scanStrings } from "eris/outbound-scan";
import { locateArtifact, rebuildEvidence } from "./artifact";
import { precondition, stop, unwrap, usage } from "./failure";
import { type Git, repoRoot } from "./git";
import type { ReceiptLink } from "./index";
import { renderProse } from "./render";

/** What a write needs from its run: the store, git, where relative paths resolve from, the clock and the 429 policy. */
export interface WriteRun {
  readonly ep: GatesEndpoint;
  readonly g: Git;
  readonly cwd: string;
  readonly now: Date;
  readonly retry: RetryOpts;
}

/** Gate names and issue keys are checked before anything is hashed or sent. */
export function validateTarget(gates: ReadonlyArray<string>, issue: string): void {
  if (!ISSUE_KEY.test(issue)) usage(`--issue ${issue}: not an issue key`, "Pass a key like ABC-123.");
  const bad = gates.filter((g) => !GATE_NAME.test(g));
  if (gates.length === 0 || bad.length > 0) usage(`gate name(s) not kebab-case: ${bad.join(", ") || "(none given)"}`, "Name gates like plan-review or posture-check.");
}

/** A file's bytes, or `gate-file-unreadable` naming the path (never its bytes). */
export function readFileFor(cwd: string, path: string, flag: string): Buffer {
  try {
    return readFileSync(isAbsolute(path) ? path : resolve(cwd, path));
  } catch {
    return precondition("gate-file-unreadable", `${flag} ${path}: cannot read the file`, `Pass the path of an existing file to ${flag} (relative paths resolve from the current directory).`);
  }
}

/** One `--evidence`/`--log`/... value: inline text, or a file of a kind. */
export type EvidenceInput =
  | { readonly kind: "text"; readonly content: string; readonly name?: string | undefined }
  | { readonly kind: Exclude<GateInlineKind, "text"> | GateMediaKind | "review-report"; readonly path: string };

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

function tooLarge(flag: string, path: string, bytes: number, max = INLINE_MAX_BYTES): never {
  return usage(
    `${flag} ${path}: ${bytes} bytes; ${max === INLINE_MAX_BYTES ? "inline evidence" : "a media file"} is at most ${max}`,
    "Record the part of the file the gate relied on (a failure summary, the last lines of a log).",
    "gate-evidence-too-large",
  );
}

type ReadEvidence =
  | { readonly kind: "text"; readonly content: string; readonly name?: string | undefined }
  | { readonly kind: Exclude<GateInlineKind, "text">; readonly name: string; readonly content: string }
  | { readonly kind: GateMediaKind; readonly name: string; readonly path: string; readonly contentType: string; readonly bytes: Buffer }
  | { readonly kind: "review-report"; readonly name: string; readonly report: GateReviewReport; readonly body: string };

/** Reads and strictly parses one `--review-report` file, failing with `gate-file-unreadable` or `gate-review-report-invalid`. */
export function readReviewReportFile(cwd: string, path: string): ParsedGateReviewReport {
  const bytes = readFileFor(cwd, path, "--review-report");
  const parsed = parseReviewReport(bytes.toString("utf8"), `--review-report ${path}`);
  if (!parsed.ok) stop(parsed.failure);
  return parsed.value;
}

function readEvidence(cwd: string, inputs: ReadonlyArray<EvidenceInput>, parsedReports?: ReadonlyMap<string, ParsedGateReviewReport>): ReadEvidence[] {
  const read: ReadEvidence[] = [];
  for (const e of inputs) {
    if (e.kind === "text") {
      const n = Buffer.byteLength(e.content);
      if (n > INLINE_MAX_BYTES) tooLarge("--evidence", "(text)", n);
      read.push({ kind: "text", content: e.content, ...(e.name !== undefined ? { name: e.name } : {}) });
      continue;
    }
    const flag = `--${e.kind}`;
    if (e.kind === "review-report") {
      const parsed = parsedReports?.get(e.path) ?? readReviewReportFile(cwd, e.path);
      read.push({ kind: "review-report", name: basename(e.path), report: parsed.report, body: parsed.body });
      continue;
    }
    if (e.kind === "screenshot" || e.kind === "video") {
      const contentType = MEDIA_TYPES[extname(e.path).toLowerCase()];
      if (contentType === undefined || !contentType.startsWith(e.kind === "video" ? "video/" : "image/")) {
        usage(`${flag} ${e.path}: not a recognised ${e.kind} file`, `Pass ${e.kind === "video" ? ".mp4, .webm or .mov" : ".png, .jpg, .jpeg, .gif or .webp"}.`);
      }
      const bytes = readFileFor(cwd, e.path, flag);
      if (bytes.byteLength > ASSET_MAX_BYTES) tooLarge(flag, e.path, bytes.byteLength, ASSET_MAX_BYTES);
      read.push({ kind: e.kind, name: basename(e.path), path: e.path, contentType: contentType!, bytes });
      continue;
    }
    const bytes = readFileFor(cwd, e.path, flag);
    if (bytes.byteLength > INLINE_MAX_BYTES) tooLarge(flag, e.path, bytes.byteLength);
    read.push({ kind: e.kind, name: basename(e.path), content: bytes.toString("utf8") });
  }
  return read;
}

/** What one receipt by `actor` vouches for: itself as a human on a human grant, and each report it reviewed itself. */
export function vouchedBy(actor: string, authorized: string | undefined, reports: ReadonlyArray<GateReviewReport>): KnownActors {
  return {
    reviewed: reports.flatMap((report) => (sameActor(report.reviewer.actor, actor) ? [{ actor: report.reviewer.actor, findings: report.findings }] : [])),
    humans: isHumanGrant(authorized) ? [actor] : [],
  };
}

/**
 * The actors `issue`'s receipts vouch for on `gate`: each review-report's reviewer, with its
 * findings, on a receipt for `gate` that reviewer recorded; each human-grant receipt's actor; and
 * each refuted blocking/major finding backed by a server-stamped direct-root (`id === root_id`)
 * `review:endorse` `MandateStamp` on a passing `gate-receipt@v3` for `(issue, gate)`.
 */
export function knownActors(issue: string, gate: string, receipts: ReadonlyArray<GateReceipt>, also: KnownActors = { reviewed: [], humans: [] }): KnownActors {
  const reviewed = [...also.reviewed];
  const humans = [...also.humans];
  const endorsed: EndorsedFinding[] = [...(also.endorsed ?? [])];
  for (const r of receipts) {
    if (r.issue !== issue) continue;
    const gateReports = r.gate === gate ? r.evidence.flatMap((e) => (isGateReviewReportEvidence(e) ? [e.report] : [])) : [];
    const v = vouchedBy(r.actor, r.authorized, gateReports);
    reviewed.push(...v.reviewed);
    humans.push(...v.humans);
    if (
      r.gate === gate &&
      r.schema === GATE_RECEIPT_SCHEMA_V3 &&
      (r.verdict === "PASS" || r.verdict === "AMENDED") &&
      r.mandate !== undefined &&
      r.mandate.id === r.mandate.root_id
    ) {
      for (const report of gateReports) {
        for (const f of report.findings) {
          if (f.status === "refuted" && reviewEndorseScope(f.id, issue) === r.mandate.scope) {
            endorsed.push({ finding: f, issue, stamp: r.mandate });
          }
        }
      }
    }
  }
  return { reviewed, humans, ...(endorsed.length > 0 ? { endorsed } : {}) };
}

/** The verdicts whose artifact `check` re-reads, so the only ones that carry a copy. */
const COPIED: ReadonlySet<GateVerdict> = new Set(["PASS", "AMENDED"]);

/** What became of a PASS/AMENDED artifact's copy. */
export type CopyOutcome = "carried" | "not-copied" | "empty" | "not-text" | "secret" | "too-large";

/** The bytes as text the secret scan can read, or null: not valid UTF-8, or holding a NUL. */
function scannable(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

function copyOfBytes(bytes: Uint8Array, copyable = true): { readonly copy?: GateArtifactCopy; readonly copied: CopyOutcome; readonly secretRules: string[] } {
  const wanted = copyable && bytes.byteLength > 0;
  const text = wanted ? scannable(bytes) : null;
  const secretRules = text === null ? [] : [...new Set(scanStrings(text).map((h) => h.rule))];
  const encoded = text !== null && secretRules.length === 0 ? { encoding: "gzip+base64" as const, content: gzipSync(bytes).toString("base64"), bytes: bytes.byteLength } : undefined;
  const copied: CopyOutcome = !copyable
    ? "not-copied"
    : !wanted
      ? "empty"
      : text === null
        ? "not-text"
        : secretRules.length > 0
          ? "secret"
          : encoded!.content.length > COPY_MAX_BYTES
            ? "too-large"
            : "carried";
  return { ...(copied === "carried" ? { copy: encoded! } : {}), copied, secretRules };
}

/** The active posture's snapshot a receipt carries. */
function snapshotDoctrine(path: string, bytes: Buffer): GateDoctrine {
  const posture = activePosture(readDoctrine(bytes.toString("utf8")));
  if (posture === undefined) return { path, sha256: sha256Hex(bytes) };
  const sectionBytes = Buffer.from(posture.section, "utf8");
  const { copy } = copyOfBytes(sectionBytes);
  const hash = policyHash(posture);
  return {
    path,
    name: posture.name,
    posture: posture.slug,
    ...(hash !== null ? { policy_hash: hash } : {}),
    sha256: sha256Hex(sectionBytes),
    ...(copy !== undefined ? { copy } : {}),
  };
}

interface PriorListing {
  readonly receipts: GateReceipt[];
  readonly mandateActive?: boolean | undefined;
}

/** The issue's prior decoded receipts, oldest first, plus whether Mandate is active on the org. */
async function priorReceipts(run: WriteRun, issue: string): Promise<PriorListing> {
  const listing = unwrap(await retryRateLimited(() => listReceipts(run.ep, issue), run.retry));
  const dated: { readonly receipt: GateReceipt; readonly at: string }[] = [];
  for (const c of listing.receipts) {
    const parsed = decodePayload(c.version, c.payload);
    if (parsed.kind === "receipt" && parsed.receipt.issue === issue) dated.push({ receipt: parsed.receipt, at: c.createdAt });
  }
  dated.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { receipts: dated.map((d) => d.receipt), mandateActive: listing.mandateActive };
}

/** Local metadata for a `review:endorse` mandate accompanying `gate record --review-report`. */
export type MandateRecordEndorsement =
  | {
      readonly mode: "explicit";
      readonly finding: GateReviewFinding;
      readonly findingId: string;
      readonly scope: string;
    }
  | {
      readonly mode: "env";
      readonly resolveMandate: () => Redacted.Redacted<MandateHandle>;
      readonly finding: GateReviewFinding;
      readonly findingId: string;
      readonly scope: string;
    };

export interface RecordInput {
  readonly gate: string;
  readonly issue: string;
  /** Optional when `--review-report` is given (derived from the report's findings and actor binding). */
  readonly verdict?: GateVerdict | undefined;
  readonly artifact: string;
  readonly rubrics?: ReadonlyArray<string> | undefined;
  readonly doctrine?: string | undefined;
  /** The `--doctrine` bytes a grant check already judged, so the snapshot is of the same read. */
  readonly doctrineBytes?: Buffer | undefined;
  readonly impact?: GateUserImpact | undefined;
  readonly authorized?: string | undefined;
  readonly reason?: string | undefined;
  readonly evidence: ReadonlyArray<EvidenceInput>;
  /** Pre-parsed `--review-report` files already validated by `resolveMandateRecord` (eliminates TOCTOU). */
  readonly parsedReports?: ReadonlyMap<string, ParsedGateReviewReport> | undefined;
  readonly actor: string;
  readonly actorInfo?: GateActor | undefined;
  /** The comment id, when the caller keys the receipt itself (default: a fresh UUID). */
  readonly commentId?: string | undefined;
  /** Validated, redacted mandate handle for the store to spend one use and stamp Receipt v3. */
  readonly mandate?: Redacted.Redacted<MandateHandle> | undefined;
  /** Extracted `review:endorse` finding context when `mandate` accompanies `gate record --review-report`. */
  readonly mandateEndorsement?: MandateRecordEndorsement | undefined;
  /** Optional permalink rendered inside the receipt prose (`{link}` template slot). */
  readonly receiptLink?: ReceiptLink | null | undefined;
  /** Internal only: permits recording `unlocked-<action>` announcements from the unlock engine. */
  readonly allowReservedGate?: boolean | undefined;
}

export interface Recorded {
  readonly receipt: GateReceiptV2;
  readonly commentId: string;
  readonly recordSha256?: string | undefined;
  /** True when the receipt was sent with a mandate handle and stamped by the store as v3. */
  readonly mandateStamped?: true | undefined;
  readonly copied: CopyOutcome;
  readonly secretRules: ReadonlyArray<string>;
  readonly linkUrl?: string | undefined;
  readonly linkMismatch?: true | undefined;
}

/** The `unlocked-<action>` announcements are written by the unlock decision only, never by hand. */
const RESERVED_GATE = /^unlocked-/;

const PENDING_MANDATE_ULID = "00000000000000000000000000";

function pendingEndorsementOf(issue: string, endorsement: MandateRecordEndorsement): EndorsedFinding {
  return {
    finding: endorsement.finding,
    issue,
    stamp: {
      id: PENDING_MANDATE_ULID,
      use_id: PENDING_MANDATE_ULID,
      root_id: PENDING_MANDATE_ULID,
      scope: endorsement.scope,
      chain_digest: "A".repeat(43),
      attestation: "pending.pending.pending",
    },
  };
}

/** Hash, snapshot, upload, and append one receipt. */
export async function recordGate(run: WriteRun, input: RecordInput): Promise<Recorded> {
  validateTarget([input.gate], input.issue);
  if (RESERVED_GATE.test(input.gate) && input.allowReservedGate !== true) {
    usage(
      `gate ${input.gate} is reserved: only the unlock decision records an unlocked-<action> announcement`,
      "Record the gate the bar names instead; the announcement is written when the unlock is decided.",
    );
  }
  // A grant is stored as written once trimmed; a blank one is no grant.
  const authorized = input.authorized?.trim();
  if (authorized !== undefined && isBlankGrant(authorized)) usage("--authorized is blank", "Name the grant: '<name> asked: <request>', or doctrine:<posture>.");
  const artifactBytes = readFileFor(run.cwd, input.artifact, "--artifact");
  const artifactSha = sha256Hex(artifactBytes);
  const located = await locateArtifact(run.g, run.cwd, input.artifact, artifactSha);
  const doctrine = input.doctrine === undefined ? undefined : snapshotDoctrine(input.doctrine, input.doctrineBytes ?? readFileFor(run.cwd, input.doctrine, "--doctrine"));
  const read = readEvidence(run.cwd, input.evidence, input.parsedReports);
  const reports = read.filter((e): e is Extract<ReadEvidence, { readonly kind: "review-report" }> => e.kind === "review-report");
  // A derived verdict judges each report as check will: bound to this record's actor, with the issue's known actors.
  const derive = reports.length > 0 && input.verdict === undefined;
  // One listing serves the derived verdict's known actors and the prose's unchanged-field omission.
  let priorMemo: PriorListing | undefined;
  const loadPrior = async (): Promise<PriorListing> => (priorMemo ??= await priorReceipts(run, input.issue));
  let activeMandate = input.mandate;
  const endorsement = input.mandateEndorsement;
  let verdict: GateVerdict | undefined = input.verdict;
  if (derive || endorsement !== undefined) {
    const prior = await loadPrior();
    const baseKnown = knownActors(
      input.issue,
      input.gate,
      prior.receipts,
      vouchedBy(
        input.actor,
        authorized,
        reports.map((e) => e.report),
      ),
    );
    if (endorsement !== undefined && endorsement.mode === "env") {
      // Do not validate or spend an ambient ERIS_MANDATE when the refutation already holds under the
      // gateway's mandate_active posture (e.g. second independent reviewer, prior direct-root stamp,
      // or a human-grant receipt when mandate_active is false/omitted).
      const alreadyEndorsed = reports.every((e) => deriveReviewPass(e.report, { issue: input.issue, known: baseKnown, mandateActive: prior.mandateActive }).pass);
      if (!alreadyEndorsed) {
        const pendingKnown: KnownActors = { ...baseKnown, endorsed: [...(baseKnown.endorsed ?? []), pendingEndorsementOf(input.issue, endorsement)] };
        const wouldPass = reports.every(
          (e) => sameActor(e.report.reviewer.actor, input.actor) && deriveReviewPass(e.report, { issue: input.issue, known: pendingKnown, mandateActive: prior.mandateActive }).pass,
        );
        if (wouldPass) activeMandate = endorsement.resolveMandate();
      }
    }
    const deriveKnown: KnownActors =
      activeMandate !== undefined && endorsement !== undefined
        ? { ...baseKnown, endorsed: [...(baseKnown.endorsed ?? []), pendingEndorsementOf(input.issue, endorsement)] }
        : baseKnown;
    const reportsPass = reports.every(
      (e) => sameActor(e.report.reviewer.actor, input.actor) && deriveReviewPass(e.report, { issue: input.issue, known: deriveKnown, mandateActive: prior.mandateActive }).pass,
    );
    if (derive) verdict = reportsPass ? "PASS" : "BLOCKING";
    if (activeMandate !== undefined && endorsement !== undefined && (verdict === "BLOCKING" || !reportsPass)) {
      if (endorsement.mode === "explicit") {
        precondition(
          "mandate-act-unsupported",
          "review:endorse requires a passing review-report (independent reviewer in a fresh context matching the recording actor)",
          "Record as the independent reviewer session that produced the report, or record without --mandate.",
        );
      }
      activeMandate = undefined;
    }
  }
  if (verdict === undefined) {
    usage("gate record: missing --verdict", "Pass --verdict PASS|AMENDED|BLOCKING, or pass --review-report <file> to derive it.");
  }

  const evidence: GateEvidence[] = [];
  for (const e of read) {
    if (e.kind === "review-report") {
      evidence.push({
        kind: "review-report",
        name: e.name,
        report: e.report,
        ...(e.body !== "" ? { body: e.body } : {}),
        sha256: reviewReportDigest(e.report, e.body),
      });
      continue;
    }
    if ("content" in e) {
      evidence.push({ ...e, sha256: sha256Hex(e.content) });
      continue;
    }
    const stored = unwrap(await uploadAsset(run.ep, { name: e.name, contentType: e.contentType, bytes: e.bytes }));
    const sha256 = sha256Hex(e.bytes);
    if (stored.sha256 !== sha256 || stored.bytes !== e.bytes.byteLength) {
      stop({
        slug: "gate-contract-mismatch",
        what: `--${e.kind} ${e.path}: the store recorded ${stored.bytes} bytes (sha256 ${stored.sha256.slice(0, 12)}), not the file's ${e.bytes.byteLength} (sha256 ${sha256.slice(0, 12)}); no comment was posted`,
        fix: "Update eris ('eris update'); if it persists, the gateway and this client disagree on the gates contract.",
        docs: "docs/ERRORS.md#gate-contract-mismatch",
        exit: 3,
      });
    }
    evidence.push({ kind: e.kind, name: e.name, content_type: e.contentType, bytes: e.bytes.byteLength, sha256, asset_url: stored.assetUrl });
  }

  const { copy: encoded, copied, secretRules } = copyOfBytes(artifactBytes, COPIED.has(verdict));
  const artifact = encoded !== undefined ? { ...located, copy: encoded } : located;
  // A diff too large to carry is bound to git instead: check re-derives it from the recorded base and head.
  const rebuild = copied === "too-large" && located._tag === "file" ? await rebuildEvidence(run.g, run.cwd, input.artifact, artifactSha) : null;
  if (rebuild !== null) evidence.push({ kind: "text", content: rebuild, sha256: sha256Hex(rebuild) });
  const [firstRubric, ...moreRubrics] = input.rubrics ?? [];
  const receipt: GateReceiptV2 = {
    schema: GATE_RECEIPT_SCHEMA,
    gate: input.gate,
    issue: input.issue,
    verdict,
    artifact,
    ...(firstRubric !== undefined ? { rubrics: [firstRubric, ...moreRubrics] as const } : {}),
    ...(doctrine !== undefined ? { doctrine } : {}),
    ...(input.impact !== undefined ? { user_impact: input.impact } : {}),
    ...(authorized !== undefined ? { authorized } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    actor: input.actor,
    ...(input.actorInfo !== undefined ? { actor_info: input.actorInfo } : {}),
    evidence,
    recorded_at: run.now.toISOString(),
  };
  const sha = sha256Hex(JSON.stringify(receipt));
  const linkUrl = input.receiptLink != null ? input.receiptLink.url(sha) : undefined;
  const linkLine = input.receiptLink != null && linkUrl !== undefined ? input.receiptLink.line(sha, linkUrl) : "";
  const prose = renderProse(receipt, (await loadPrior()).receipts, linkLine);
  const commentId = input.commentId ?? randomUUID();
  const comment = unwrap(
    await retryRateLimited(
      () => appendReceipt(run.ep, { commentId, issue: input.issue, receipt, prose, ...(activeMandate !== undefined ? { mandateHandle: activeMandate } : {}) }),
      run.retry,
    ),
  );
  // The store stamps a mandate use into a v3 record whose hash differs from the v2 sent; the same
  // hash (or none) means it kept the v2 unstamped, which grants nothing.
  if (activeMandate !== undefined && (comment.recordSha256 === undefined || comment.recordSha256 === sha)) {
    mandateNotStamped(comment.id, authorized !== undefined, verdict);
  }
  const linkMismatch = activeMandate === undefined && linkUrl !== undefined && comment.recordSha256 !== undefined && comment.recordSha256 !== sha ? (true as const) : undefined;
  return {
    receipt,
    commentId: comment.id,
    recordSha256: comment.recordSha256,
    ...(activeMandate !== undefined ? { mandateStamped: true as const } : {}),
    copied,
    secretRules,
    ...(linkUrl !== undefined ? { linkUrl } : {}),
    ...(linkMismatch !== undefined ? { linkMismatch } : {}),
  };
}

/** A mandate receipt the store kept as an unstamped v2: the mandate granted nothing. */
function mandateNotStamped(commentId: string, proseGrant: boolean, verdict: GateVerdict): never {
  if (verdict === "SKIPPED") {
    const judged = proseGrant
      ? "'eris gate check' judges it by its --authorized grant alone"
      : "it carries no grant, and 'eris gate check' reads it unauthorized-skip";
    return precondition(
      "mandate-not-stamped",
      `the gate receipt store kept comment ${commentId} without a mandate stamp, so the mandate granted nothing: ${judged}`,
      "The gateway does not stamp Receipt v3 yet: record the skip with --authorized, or re-run once the gateway stamps mandates.",
    );
  }
  return precondition(
    "mandate-not-stamped",
    `the gate receipt store kept comment ${commentId} without a mandate stamp, so the review:endorse mandate granted nothing: 'eris gate check' judges its review-report without a mandate endorsement`,
    "The gateway does not stamp Receipt v3 for review:endorse yet: re-run once the gateway stamps mandates.",
  );
}

export interface SkipInput {
  readonly gate: string;
  readonly issue: string;
  readonly artifact: string;
  readonly reason: string;
  /** A human grant (`'<name> asked: <request>'`), `doctrine:<posture>`, or `repo:no-eris-yaml`. */
  readonly authorized?: string | undefined;
  readonly doctrine?: string | undefined;
  readonly impact?: GateUserImpact | undefined;
  readonly actor: string;
  readonly actorInfo?: GateActor | undefined;
  /** Validated, redacted mandate handle: the store spends one use and stamps v3, so `authorized` becomes optional context. */
  readonly mandate?: Redacted.Redacted<MandateHandle> | undefined;
  /** Optional permalink rendered inside the receipt prose (`{link}` template slot). */
  readonly receiptLink?: ReceiptLink | null | undefined;
}

function unauthorized(what: string, fix: string): never {
  return precondition("gate-skip-unauthorized", what, fix);
}

const HUMAN_GRANT = "--authorized '<name> asked: <request>'";

/** A `--reason` shorter than this names nothing a reviewer can check (`x`, `doctrine`). */
const MIN_REASON = 12;

/** The fix for a refused doctrine grant: the exact flags the active posture accepts for `gate`, else run it or ask a human. */
function grantFix(read: DoctrineRead, file: string, gate: string): string {
  const active = read.active;
  if (active !== null && doctrineSkipBlocker(read, active, gate) === null) {
    const quoted = /^[A-Za-z0-9_./:~-]+$/.test(file) ? file : `'${file.replaceAll("'", "'\\''")}'`;
    return `The active posture turns ${gate} off; skip on its grant: --authorized ${DOCTRINE_GRANT}${active} --doctrine ${quoted}.`;
  }
  return `Run the gate, or skip it on a human grant (${HUMAN_GRANT}).`;
}

/** A doctrine-shaped grant, judged against the `--doctrine` bytes; returns those bytes so the snapshot is of the same read. */
function checkDoctrineGrant(run: WriteRun, input: SkipInput, grant: string): Buffer {
  const posture = doctrineGrantPosture(grant);
  if (input.doctrine === undefined) {
    return unauthorized(
      `--authorized ${grant}: a doctrine grant needs --doctrine <file>`,
      posture === null ? `Spell it --authorized doctrine:<posture> --doctrine <file>, or use a human grant (${HUMAN_GRANT}).` : "Pass the doctrine file whose posture turns the gate off.",
    );
  }
  const bytes = readFileFor(run.cwd, input.doctrine, "--doctrine");
  const read = readDoctrine(bytes.toString("utf8"));
  const judged = `(doctrine sha256 ${sha256Hex(bytes).slice(0, 12)})`;
  if (posture === null) unauthorized(`--authorized ${grant}: reads as a doctrine grant but is not doctrine:<posture> ${judged}`, grantFix(read, input.doctrine, input.gate));
  const why = doctrineSkipBlocker(read, posture!, input.gate);
  if (why !== null) unauthorized(`--authorized ${grant}: ${input.doctrine} does not pre-authorize skipping ${input.gate}: ${why} ${judged}`, grantFix(read, input.doctrine, input.gate));
  return bytes;
}

/** A repo-shaped grant holds only as `repo:no-eris-yaml` on `define-future` in a checkout with no root `eris.yaml`. */
async function checkRepoGrant(run: WriteRun, input: SkipInput, grant: string): Promise<void> {
  if (grant !== NO_ERIS_YAML_GRANT) {
    unauthorized(
      `--authorized ${grant}: reads as a repo grant but is not ${NO_ERIS_YAML_GRANT}`,
      `Spell it --authorized ${NO_ERIS_YAML_GRANT} (for ${DEFINE_FUTURE_GATE} when the repo root has no eris.yaml), or use a human grant (${HUMAN_GRANT}).`,
    );
  }
  const top = await repoRoot(run.g, run.cwd);
  const why = noErisYamlSkipBlocker(top !== null ? [top] : [], input.gate);
  if (why !== null) unauthorized(`--authorized ${grant}: does not pre-authorize skipping ${input.gate}: ${why}`, `Run ${input.gate}, or skip it on a human grant (${HUMAN_GRANT}).`);
}

/** Writes a SKIPPED receipt carrying why, on whose grant, and who recorded it. */
export async function skipGate(run: WriteRun, input: SkipInput): Promise<Recorded> {
  validateTarget([input.gate], input.issue);
  const reason = input.reason.trim();
  if (reason === "") usage("--reason is blank", "Say why the gate is not run.");
  if (reason.length < MIN_REASON) usage(`--reason ${JSON.stringify(reason)}: under ${MIN_REASON} characters`, "Say why the gate is not run, in words a reviewer can check.");
  if (input.authorized === undefined && input.mandate === undefined) {
    usage("gate skip: missing --authorized", "A skip names the grant behind it: --authorized '<name> asked: <request>', doctrine:<posture>, or --mandate <mnd_ handle>.");
  }
  const grant = input.authorized?.trim();
  if (grant !== undefined && isBlankGrant(grant)) usage("--authorized is blank", "Name the grant: '<name> asked: <request>', or doctrine:<posture>.");
  // Beside a mandate, a prose grant is context: the stamp authorizes, so it is not judged here.
  const judged = input.mandate === undefined ? grant : undefined;
  const doctrineBytes = judged !== undefined && doctrineShaped(judged) ? checkDoctrineGrant(run, input, judged) : undefined;
  if (judged !== undefined && repoGrantShaped(judged)) await checkRepoGrant(run, input, judged);
  return recordGate(run, {
    gate: input.gate,
    issue: input.issue,
    verdict: "SKIPPED",
    artifact: input.artifact,
    doctrine: input.doctrine,
    ...(doctrineBytes !== undefined ? { doctrineBytes } : {}),
    impact: input.impact,
    authorized: grant,
    reason: input.reason,
    evidence: [],
    actor: input.actor,
    ...(input.actorInfo !== undefined ? { actorInfo: input.actorInfo } : {}),
    ...(input.mandate !== undefined ? { mandate: input.mandate } : {}),
    ...(input.receiptLink !== undefined ? { receiptLink: input.receiptLink } : {}),
  });
}
