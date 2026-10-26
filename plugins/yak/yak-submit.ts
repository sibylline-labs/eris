/**
 * yak-submit.ts — input resolution + the submission core for `eris yak`.
 *
 * Two independently-testable halves:
 *
 *   `resolveTextInputs` — turns the parsed `--summary`/`--body`/
 *   `--body-file`/`--evidence`/`--evidence-file` flags into three raw
 *   strings, reading file/stdin BYTES DIRECTLY (never through a bash
 *   variable — the `$(cmd)`-strips-trailing-newlines trap would silently
 *   change the idempotency key derived from those bytes). Catches every
 *   "agent misuse" input shape: missing required fields, mutually-exclusive
 *   sources, an unreadable file, and `--body-file -` with no pipe, which
 *   must fail immediately rather than hang forever on a read that will
 *   never return.
 *
 *   `submitYak` — the pipeline in this EXACT order, which is load-bearing,
 *   not incidental:
 *
 *     1. (caller) resolve inputs — done by `resolveTextInputs`, above
 *     2. redact summary/body/evidence/provenance (BEFORE key
 *        derivation, so the Actor's re-derived key agrees with ours —
 *        deriving from unredacted text guarantees a mismatch on every
 *        report)
 *     3. derive the idempotency key from the REDACTED payload
 *     4. omit `evidence` entirely when the (redacted) bytes are empty —
 *        `evidence: ""` and `evidence` absent derive DIFFERENT keys
 *        under `JSON.stringify` (frozen as a key vector in
 *        `tests/yak-contract-v2.test.ts`, and held at this seam by the
 *        "evidence '' ... SAME key" test in `tests/yak-submit.test.ts`),
 *        so treating an empty upload the same as no upload at all is what
 *        keeps two submissions of "no evidence" deduping against each
 *        other
 *     5. validate locally against the contract package's zod schema BEFORE the
 *        request (an over-bound field is a local, actionable
 *        exit-1 error naming the field/length/max — never a silent
 *        server-side truncation, which would desync the stored payload
 *        from the key we already derived from it)
 *     6. one bounded `fetch` POST (30s), no retry — a retry loop is
 *        latency an agent pays mid-task
 *     7. compare our derived key against the receipt's `idempotency_key`
 *        and flag a mismatch — the ONLY drift signal available, since the
 *        contract has no mismatch field on the receipt itself
 *
 * Every failure this module can produce is typed and NEVER throws or
 * exits — same `{ value } | { reason, slug }` discriminant
 * `plugins/yak/yak-identity.ts` already established
 * (`IdentityOutcome`/`IdentityOk`/`IdentityFailure`, reused here rather
 * than re-invented), plus a third `SubmitResult` branch (`"delivered"`)
 * for the one case that isn't a failure at all. Mapping a result to an
 * exit code, stdout/stderr, and `--output json`'s bare record is
 * `yak.ts`'s job (the agent-misuse-vs-environment split) — this
 * module only classifies.
 */

import { z, type ZodIssue } from "zod";
import {
  YakSubmission,
  YakReceipt,
  YAKS_CONTRACT_VERSION,
  YAK_REPO_HINT_MAX_LENGTH,
  YAK_REPO_HINTS_MAX_COUNT,
  deriveIdempotencyKey,
  type YakVerb,
  type YakProvenance,
} from "eris/yak-contract";
import { redact, redactDeep, type RedactionClass } from "./yak-redact";
import type { IdentityOutcome } from "./yak-identity";

/**
 * A permissive twin of the contract package's `YakReceipt`
 * (`@sibylline-labs/yak-contract`, `packages/yak-contract/src/v2.ts`) that
 * accepts ANY `contract_version` string, not only the exact literal this CLI
 * currently emits.
 *
 * `YakReceipt.contract_version` is
 * `z.literal(YAKS_CONTRACT_VERSION)`. The REQUEST side already avoids this
 * trap — `ACCEPTED_YAKS_VERSIONS` is a tuple specifically so a version bump
 * is additive, per that file's own comment. The RESPONSE side has
 * no such tuple, because a receipt "carries the one version that produced
 * it" (same file) — that's a true statement about the SERVER's write, but
 * this CLIENT re-parses that same literal on READ. The moment an Actor ships
 * 2.1.0, every successful, DURABLY-STORED delivery would fail
 * `YakReceipt.safeParse` here and report `delivered: false` — turning a
 * contract_version bump into a false failure for every observation already
 * accepted server-side. Leniency belongs on the reader, not the contract:
 * this widens only the one field a version bump changes, and
 * changes nothing else `YakReceipt` already validates (`id`,
 * `idempotency_key`, `replay` all stay exactly as strict).
 */
const LenientYakReceipt = YakReceipt.extend({ contract_version: z.string() });

/** The shape `submitYak` actually returns on delivery — `YakReceipt` with
 *  `contract_version` widened to `string` (see `LenientYakReceipt` above).
 *  Structurally compatible with the package's `YakReceipt` everywhere a
 *  `string` is expected, which is everywhere this repo reads the field. */
export type YakReceiptResponse = z.infer<typeof LenientYakReceipt>;

// ---------------------------------------------------------------------------
// Input resolution
// ---------------------------------------------------------------------------

export type InputMisuseSlug =
  | "yak-summary-required"
  | "yak-body-required"
  | "yak-body-conflicting-source"
  | "yak-evidence-conflicting-source"
  | "yak-body-file-unreadable"
  | "yak-evidence-file-unreadable"
  | "yak-stdin-is-a-tty"
  | "yak-stdin-conflict";

export interface RawTextInputs {
  summary?: string;
  bodyInline?: string;
  bodyFile?: string;
  evidenceInline?: string;
  evidenceFile?: string;
}

export interface ResolvedTextInputs {
  summary: string;
  body: string;
  /** Absent when no `--evidence`/`--evidence-file` was given AT ALL. An
   *  `--evidence-file` that resolves to zero bytes is normalized to
   *  absent too, one level up in `submitYak` (step 4, post-redaction) —
   *  not here, because redaction never turns empty into non-empty or vice
   *  versa (a class marker only ever replaces a MATCH), so doing the
   *  empty-check on raw vs. redacted bytes is equivalent; the actual
   *  normalization runs after redaction. */
  evidence?: string;
}

export interface TextInputDeps {
  /** Reads a file's bytes as UTF-8 text, unmodified — no trim, no
   *  newline normalization. Default: `Bun.file(path).text()`. */
  readFile: (path: string) => Promise<string>;
  /** Reads all of stdin as UTF-8 text, unmodified. Default: drains
   *  `process.stdin` via async iteration. It does not `.trim()` —
   *  trimming would change the bytes the idempotency key is derived from. */
  readStdin: () => Promise<string>;
  /** Whether stdin is a terminal — checked before ever attempting to
   *  read it for `--body-file -`/`--evidence-file -`, so a forgotten pipe
   *  fails immediately instead of hanging. Default:
   *  `Boolean(process.stdin.isTTY)`. */
  isStdinTTY: () => boolean;
}

async function defaultReadFile(path: string): Promise<string> {
  return Bun.file(path).text();
}

async function defaultReadStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function defaultIsStdinTTY(): boolean {
  return Boolean(process.stdin.isTTY);
}

function defaultTextInputDeps(overrides: Partial<TextInputDeps> = {}): TextInputDeps {
  return {
    readFile: overrides.readFile ?? defaultReadFile,
    readStdin: overrides.readStdin ?? defaultReadStdin,
    isStdinTTY: overrides.isStdinTTY ?? defaultIsStdinTTY,
  };
}

async function resolveOneField(
  label: "body" | "evidence",
  inline: string | undefined,
  filePath: string | undefined,
  deps: TextInputDeps,
): Promise<IdentityOutcome<string | undefined, InputMisuseSlug>> {
  if (inline !== undefined && filePath !== undefined) {
    return {
      reason: `--${label} and --${label}-file are mutually exclusive — pass exactly one`,
      slug: `yak-${label}-conflicting-source` as InputMisuseSlug,
    };
  }
  if (inline !== undefined) return { value: inline };
  if (filePath === undefined) return { value: undefined };

  if (filePath === "-") {
    if (deps.isStdinTTY()) {
      return {
        reason: `--${label}-file - reads stdin, but stdin is a terminal — pipe input instead, e.g. cat report.txt | eris yak issue --summary "…" --${label}-file -`,
        slug: "yak-stdin-is-a-tty",
      };
    }
    try {
      return { value: await deps.readStdin() };
    } catch (err) {
      return {
        reason: `cannot read stdin for --${label}-file -: ${(err as Error).message}`,
        slug: `yak-${label}-file-unreadable` as InputMisuseSlug,
      };
    }
  }

  try {
    return { value: await deps.readFile(filePath) };
  } catch (err) {
    return {
      reason: `cannot read --${label}-file ${filePath}: ${(err as Error).message}`,
      slug: `yak-${label}-file-unreadable` as InputMisuseSlug,
    };
  }
}

/**
 * Resolve `summary`/`body`/`evidence` from the parsed flags. Required-field
 * and mutual-exclusion checks run BEFORE any file/stdin I/O so a doomed
 * call never blocks on a read it was always going to reject — in
 * particular, the `--body-file - && --evidence-file -` conflict is
 * checked first so neither read is ever attempted (only one stdin
 * exists to give either of them).
 */
export async function resolveTextInputs(
  raw: RawTextInputs,
  depsOverrides: Partial<TextInputDeps> = {},
): Promise<IdentityOutcome<ResolvedTextInputs, InputMisuseSlug>> {
  const deps = defaultTextInputDeps(depsOverrides);

  if (raw.bodyFile === "-" && raw.evidenceFile === "-") {
    return {
      reason: "--body-file - and --evidence-file - both read stdin — only one stdin exists; pass the other as --evidence <text> or a real file path",
      slug: "yak-stdin-conflict",
    };
  }

  if (raw.summary === undefined || raw.summary.length === 0) {
    return { reason: "missing required --summary", slug: "yak-summary-required" };
  }

  const bodyOutcome = await resolveOneField("body", raw.bodyInline, raw.bodyFile, deps);
  if ("reason" in bodyOutcome) return bodyOutcome;
  if (bodyOutcome.value === undefined || bodyOutcome.value.length === 0) {
    return { reason: "missing required --body or --body-file", slug: "yak-body-required" };
  }

  const evidenceOutcome = await resolveOneField("evidence", raw.evidenceInline, raw.evidenceFile, deps);
  if ("reason" in evidenceOutcome) return evidenceOutcome;

  return {
    value: {
      summary: raw.summary,
      body: bodyOutcome.value,
      evidence: evidenceOutcome.value,
    },
  };
}

// ---------------------------------------------------------------------------
// Redaction summary — shared shape for the delivered/warn/misuse outcomes
// and the `--output json` record's `redactions: {count, classes}` field.
// ---------------------------------------------------------------------------

export interface RedactionSummary {
  count: number;
  classes: RedactionClass[];
  /** True when `--no-redact` was set for THIS submission — the scrub pass
   *  never ran at all. Always present, never inferred from `count === 0`:
   *  a skipped pass and a pass that ran and found nothing both leave
   *  `count` at zero, and without this field the two are indistinguishable
   *  on the wire (output-contract fix — `--output json` used to
   *  print the `--no-redact` WARN on stderr as the only record of the
   *  skip; suppressing that line unconditionally would have silently lost
   *  the fact for every `--output json` caller). */
  skipped: boolean;
}

function zeroRedactionSummary(skipped = false): RedactionSummary {
  return { count: 0, classes: [], skipped };
}

/** The canonical zero-filled `Record<RedactionClass, number>` — derived
 *  from `redact("")` rather than re-declaring the class list here, so
 *  this file has exactly one dependency on `yak-redact.ts`'s class set
 *  (its own export) instead of a second, driftable copy. */
function zeroRedactionCounts(): Record<RedactionClass, number> {
  return redact("").counts;
}

function mergeRedactionCounts(
  parts: Array<Record<RedactionClass, number> | undefined>,
): Record<RedactionClass, number> {
  const merged = zeroRedactionCounts();
  for (const part of parts) {
    if (!part) continue;
    for (const cls of Object.keys(merged) as RedactionClass[]) {
      merged[cls] += part[cls];
    }
  }
  return merged;
}

function summarizeRedactionCounts(
  counts: Record<RedactionClass, number> | undefined,
  skipped: boolean,
): RedactionSummary {
  if (!counts) return zeroRedactionSummary(skipped);
  const classes = (Object.keys(counts) as RedactionClass[]).filter((c) => counts[c] > 0);
  const count = classes.reduce((acc, c) => acc + counts[c], 0);
  return { count, classes, skipped };
}

// ---------------------------------------------------------------------------
// Submission core
// ---------------------------------------------------------------------------

/** One bounded request, no retry: 30s, the same bound as a
 *  `curl --max-time 30` call to the endpoint. */
export const DEFAULT_SUBMIT_TIMEOUT_MS = 30_000;

const YAKS_INGRESS_PATH = "/v1/yaks";

/** Warn-class slugs (environment/config/transport — never the
 *  agent's fault, so `yak.ts` maps every one of these to `WARN` + exit 0,
 *  never the exit-1 failure block). The network-outcome ones come from a fetch outcome this module
 *  observes directly. `yak-identity-id-too-long` and `yak-redaction-overflow`
 *  are both `too_big` zod failures on
 *  step 5, and both were previously misclassified as agent misuse even
 *  though neither is caused by anything the `eris yak` invocation itself
 *  controls — `device_id`/`execution_id` are resolved from an env var or a
 *  state file the caller never sees, and a redaction-caused overflow means
 *  the caller's ORIGINAL text was in bounds until our own scrub pass grew
 *  it past the limit. */
export type SubmitWarnSlug =
  | "yak-unreachable"
  | "yak-timeout"
  | "yak-unauthorized"
  | "yak-not-entitled"
  | "yak-payload-too-large"
  | "yak-transport-error"
  | "yak-identity-id-too-long"
  | "yak-redaction-overflow";

/**
 * The endpoint's refusals that no retry fixes and the operator can act on:
 * its HTTP status -> the warn slug plus the local remedy the reason ends with.
 * Every other non-2xx stays `yak-transport-error` (an outage, a missing route,
 * a proxy page), because no local remedy is known for it. All are WARN + exit
 * 0 like the rest of this union.
 *
 * The remedies are local ones only. The reasons do not point at the vendor
 * route; `docs/ERRORS.md` carries that pointer.
 */
const REFUSAL_BY_STATUS: ReadonlyMap<number, { slug: SubmitWarnSlug; remedy: string }> = new Map([
  [
    401,
    {
      slug: "yak-unauthorized",
      remedy:
        "the endpoint rejected the bearer token; check the token in ~/.eris/yaks.json or ERIS_YAKS_TOKEN, and that it is registered with the endpoint",
    },
  ],
  [
    402,
    {
      slug: "yak-not-entitled",
      remedy: "this workspace is not entitled to Yaks (its plan or seat does not include it)",
    },
  ],
  [
    413,
    {
      slug: "yak-payload-too-large",
      remedy: "the submission exceeded the endpoint's whole-body size cap; trim --evidence, --repro or the --repo hints",
    },
  ],
]);

export type SubmitMisuseSlug =
  | "yak-summary-too-long"
  | "yak-body-too-long"
  | "yak-evidence-too-long"
  | "yak-repro-too-long"
  | "yak-repo-too-long"
  | "yak-repo-hints-too-many"
  | "yak-payload-invalid";

/**
 * Local length ceiling for `--repro <command>`. `repro` rides
 * inside `provenance` (see `SubmitParams.repro`), which the contract
 * validates only for its two typed keys (`repo.target_repos`,
 * `execution.rung`) — "never validated as a gate" is `YakProvenance`'s own
 * documented posture for the rest, because it's enrichment, not payload. A
 * repro command is agent-authored free text
 * like `summary`/`body`/`evidence`, though, so it gets the same local
 * courtesy bound those three get (`docs/YAK.md`: "over-length fields fail
 * locally... rather than letting the server truncate silently") even though
 * nothing server-side would ever truncate it — this is about keeping a
 * pasted multi-command script or a stray heredoc out of the server storage this
 * repo doesn't control, not about the wire contract. Sized well above any
 * real repro invocation (a shell one-liner, a short pytest/vitest selector,
 * an `eris`/`curl` repro command) while still well under `YAK_BODY_MAX_LENGTH`
 * (4,000) — a repro is a command, not a narrative.
 */
export const YAK_REPRO_MAX_LENGTH = 2_000;

/**
 * Bounds for `--repo <owner/name>` target-repo hints (repeatable —
 * see `SubmitParams.repoHints`). A hint rides inside
 * `provenance.repo.target_repos`, which the contract package types and
 * bounds (`YakRepoProvenance`): the same constants are re-exported here so
 * this file's local check and the contract's wire check are one number, not
 * two that can drift. The local check still runs first so an over-bound hint
 * fails with an actionable `--repo` message rather than a generic
 * `yak-payload-invalid`. A hint is a short `owner/name` identifier (this CLI
 * never validates it against a live repo list — see that field's own
 * docstring), so 200 chars is generous headroom over any real one, and 20
 * hints is generous headroom over any single report that genuinely spans
 * that many repos.
 */
export { YAK_REPO_HINT_MAX_LENGTH, YAK_REPO_HINTS_MAX_COUNT };

export type SubmitResult =
  | {
      status: "delivered";
      receipt: YakReceiptResponse;
      idempotencyKey: string;
      /** True when our LOCALLY-derived key disagrees with the receipt's
       *  authoritative one — the only canonicalization-drift signal this
       *  contract exposes. Still a successful delivery; `yak.ts` surfaces this
       *  as an additional warning, not a different exit code. */
      keyMismatch: boolean;
      redaction: RedactionSummary;
    }
  | {
      status: "warn";
      slug: SubmitWarnSlug;
      reason: string;
      redaction?: RedactionSummary;
      /** Present whenever the key was already derived before the warn
       *  fired (every network-outcome warn below) — absent for warns
       *  raised earlier in the pipeline (token/url unresolved), where no
       *  payload was ever built. */
      idempotencyKey?: string;
    }
  | {
      status: "misuse";
      slug: SubmitMisuseSlug;
      reason: string;
      /** Always present: every `SubmitMisuseSlug` this module raises is a
       *  zod validation failure on step 5, which runs AFTER key
       *  derivation (step 3) — the key exists, it just describes a
       *  payload the schema rejected. */
      idempotencyKey: string;
      /** Also always present, for the same reason: step 5 runs AFTER step
       *  2 (redact). `yak-summary-too-long` /
       *  `yak-body-too-long` / `yak-evidence-too-long`'s own `reason` text
       *  says "redaction may have grown it; check with --no-redact" — that
       *  claim needs the actual count/classes sitting beside it, on the
       *  SAME outcome, or the message tells the reader to check evidence
       *  the misuse result never carried. */
      redaction: RedactionSummary;
    };

export interface SubmitParams {
  verb: YakVerb;
  summary: string;
  body: string;
  /** Raw (pre-redaction) evidence text, or absent for "no evidence was
   *  given at all". An empty string here (an `--evidence-file` that
   *  resolved to zero bytes) is normalized to absent AFTER redaction —
   *  see step 4 in the file header. */
  evidence?: string;
  /** Raw (pre-redaction) `--repro <command>` text, or absent when
   *  no repro was given — a yak is not required to carry one. Redacted the
   *  same as `evidence` (a repro command can itself embed a credential, e.g.
   *  `curl -H "Authorization: Bearer …"`), bounded the same way (see
   *  `YAK_REPRO_MAX_LENGTH` below) and normalized empty-after-redaction to
   *  absent (the same rule `evidence` already follows). It is NOT part of
   *  the `YakSubmission` shape — the wire contract is the workspace package
   *  `@sibylline-labs/yak-contract`, which this CLI consumes and does not
   *  extend on its own — so it rides inside `provenance`
   *  instead, which `YakProvenance.catchall(z.unknown())` was built to carry
   *  exactly this kind of forward-compatible, not-yet-contracted field (see
   *  that type's own docstring: "a CLI that learns an unforeseen provenance
   *  category does not have to wait on a contract bump to send it"). Lands on
   *  the wire as `provenance.repro.command`. This CLI never executes it —
   *  submission is the whole of this module's contract with the string; any
   *  rerun is the Yaks endpoint's concern, sandboxed on that side
   *  (docs/YAK.md#repro). */
  repro?: string;
  /** Raw (pre-redaction) `--repo <owner/name>` hints, repeatable
   *  — zero or more target-repo hints naming the repo(s) this report
   *  concerns, so a dispatch/triage flow can read a target repo directly
   *  off the rendered issue instead of running a code search across the
   *  whole org. Redacted the same as
   *  `repro` and bounded the same way (see `YAK_REPO_HINT_MAX_LENGTH` /
   *  `YAK_REPO_HINTS_MAX_COUNT` below). NOT validated against a live repo
   *  list — an opaque hint, exactly like `repro` is an opaque command: this
   *  CLI never confirms the named repo actually exists.
   *
   *  When absent or empty (no `--repo` given at all), `submitYak`
   *  auto-derives a single hint from `provenance.git.origin_url` — the same
   *  git remote `plugins/yak/yak-context.ts::gatherGit` already probes for every
   *  submission — so an agent filing from inside a repo checkout gets a
   *  hint without passing anything. Explicit `--repo` always wins over that
   *  derivation; the two are never merged together. It is NOT part of the
   *  `YakSubmission` top-level shape — like `repro`, it rides inside
   *  `provenance`, but unlike `repro` it lands in the ALREADY-typed `repo`
   *  category (`YakProvenance.repo`, which `yak-context.ts::gatherRepo`
   *  already populates with `service`) rather than a new catchall key — a
   *  target-repo hint is repo-scoped provenance, not a new kind of fact. Lands on the wire as
   *  `provenance.repo.target_repos` (an array, even for one hint: a report
   *  that spans repos carries more than one).
   *  This CLI never validates any of it beyond the local length/count
   *  bounds; a dispatch/triage flow reads it off the rendered issue, which
   *  the Actor owns (docs/YAK.md's own "everything after the receipt...
   *  belongs to the Actor, not this CLI"). */
  repoHints?: string[];
  /** `--no-redact` skips the scrub entirely, with a loud
   *  warning — printing that warning is `yak.ts`'s job; this module just
   *  honours the flag. */
  noRedact: boolean;
  deviceId: string;
  executionId: string;
  provenance?: YakProvenance;
  /** The resolved Yaks endpoint base URL (no trailing slash required — this
   *  module strips one if present) and bearer token. Both are ALREADY
   *  resolved by the time this is called: `yak.ts` maps a token/url
   *  resolution failure to a warn outcome itself, using
   *  `plugins/yak/yak-identity.ts`'s own typed failures, before this function
   *  is ever invoked. */
  url: string;
  token: string;
  /** Injectable for tests — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The pre-redaction raw values a `too_big` validation failure might name —
 *  needed to tell "the caller's own text was already too long" (misuse)
 *  apart from "our own resolution/redaction grew an in-bounds value past
 *  the limit" (warn). `device_id`/`execution_id` are never redacted, so
 *  their raw and post-redaction values are the same value either way. */
interface ValidationRawInputs {
  summary: string;
  body: string;
  evidence: string | undefined;
  deviceId: string;
  executionId: string;
}

type ValidationFailureOutcome =
  | { status: "misuse"; slug: SubmitMisuseSlug; reason: string }
  | { status: "warn"; slug: SubmitWarnSlug; reason: string };

function classifyValidationFailure(
  issues: ZodIssue[],
  raw: ValidationRawInputs,
  redactedSummary: string,
  redactedBody: string,
  redactedEvidence: string | undefined,
): ValidationFailureOutcome {
  const issue = issues[0]!;
  const field = String(issue.path[0] ?? "(root)");

  if (issue.code === "too_big") {
    const max = typeof issue.maximum === "number" ? issue.maximum : Number(issue.maximum);

    // device_id/execution_id: resolved from `~/.eris/device-id` or
    // CLAUDE_CODE_SESSION_ID/CLAUDE_CODE_HOST_SESSION_ID/the shell ppid
    // (plugins/yak/yak-identity.ts) — not a flag the `eris yak` caller passed,
    // so an over-length value here is an identity-resolution problem, not
    // agent misuse (a >200-char CLAUDE_CODE_SESSION_ID, or a corrupt
    // device-id file).
    if (field === "device_id" || field === "execution_id") {
      const actualLength = field === "device_id" ? raw.deviceId.length : raw.executionId.length;
      const source = field === "device_id" ? "~/.eris/device-id" : "CLAUDE_CODE_SESSION_ID/CLAUDE_CODE_HOST_SESSION_ID (or the shell ppid)";
      return {
        status: "warn",
        slug: "yak-identity-id-too-long",
        reason: `${field} is ${actualLength} chars, exceeds the max of ${max} — this comes from ${source}, not from anything this call passed; check that value, not the report`,
      };
    }

    const isSummary = field === "summary";
    const isEvidence = field === "evidence";
    const rawLength = isSummary ? raw.summary.length : isEvidence ? (raw.evidence?.length ?? 0) : raw.body.length;
    const redactedLength = isSummary
      ? redactedSummary.length
      : isEvidence
        ? (redactedEvidence?.length ?? 0)
        : redactedBody.length;

    // The caller's ORIGINAL text was in bounds; the secret-scrub pass (a
    // marker like «redacted:aws-key» is longer than most matches it
    // replaces) is what pushed it over — our processing, not agent misuse.
    if (rawLength <= max && redactedLength > max) {
      return {
        status: "warn",
        slug: "yak-redaction-overflow",
        reason: `${field} was ${rawLength} chars (within the ${max} max) before redaction, but the secret-scrub pass grew it to ${redactedLength} chars — the original text is fine; retry with --no-redact if it contains no real secret`,
      };
    }

    const slug: SubmitMisuseSlug = isSummary ? "yak-summary-too-long" : isEvidence ? "yak-evidence-too-long" : "yak-body-too-long";
    return {
      status: "misuse",
      slug,
      reason: `${field} is ${redactedLength} chars, exceeds the max of ${max} — shorten it (redaction may have grown it; check with --no-redact) rather than relying on the server to truncate`,
    };
  }

  return { status: "misuse", slug: "yak-payload-invalid", reason: `${field}: ${issue.message}` };
}

// ---------------------------------------------------------------------------
// Target-repo hints — `--repo <owner/name>`, repeatable
// ---------------------------------------------------------------------------

type RepoHintsCheckResult =
  | { hints: string[] }
  | { status: "warn"; slug: SubmitWarnSlug; reason: string }
  | { status: "misuse"; slug: SubmitMisuseSlug; reason: string };

/**
 * Bound-check + normalize the explicit `--repo` hints (already redacted,
 * 1:1 with the raw array so a redaction-overflow can still be traced back to
 * the original length — same pairing `classifyValidationFailure` uses for
 * summary/body/evidence). Empty/whitespace-only hints are dropped rather
 * than counted or rejected (an agent passing `--repo ""` gets the same
 * outcome as not passing `--repo` at all — see `resolveTargetRepoHints`,
 * which is what decides whether that's "explicit, deliberately empty" or
 * "fall back to auto-derivation"). Dedupes CASE-INSENSITIVELY on the final
 * (redacted, trimmed) text: `--repo
 * owner/repo --repo Owner/Repo` names the same repo on every host that
 * matters (GitHub/GitLab/git remotes are not case-sensitive identity for
 * this purpose) — preserving first-seen ORIGINAL casing and first-seen
 * order, so a `--repo` typo'd (or re-cased) twice does not land as a
 * two-element array with two entries for the same repo.
 */
function checkRepoHints(rawHints: string[] | undefined, redactedHints: string[] | undefined): RepoHintsCheckResult {
  const redactedList = redactedHints ?? [];
  const pairs = redactedList
    .map((redactedText, i) => ({ raw: (rawHints?.[i] ?? redactedText).trim(), redacted: redactedText.trim() }))
    .filter((p) => p.redacted.length > 0);

  if (pairs.length > YAK_REPO_HINTS_MAX_COUNT) {
    return {
      status: "misuse",
      slug: "yak-repo-hints-too-many",
      reason: `${pairs.length} --repo hints given, exceeds the max of ${YAK_REPO_HINTS_MAX_COUNT} — narrow to the repos this report actually concerns`,
    };
  }

  for (const { raw, redacted } of pairs) {
    if (redacted.length <= YAK_REPO_HINT_MAX_LENGTH) continue;
    if (raw.length <= YAK_REPO_HINT_MAX_LENGTH) {
      return {
        status: "warn",
        slug: "yak-redaction-overflow",
        reason: `a --repo hint was ${raw.length} chars (within the ${YAK_REPO_HINT_MAX_LENGTH} max) before redaction, but the secret-scrub pass grew it to ${redacted.length} chars — the original text is fine; retry with --no-redact if it contains no real secret`,
      };
    }
    return {
      status: "misuse",
      slug: "yak-repo-too-long",
      reason: `a --repo hint is ${redacted.length} chars, exceeds the max of ${YAK_REPO_HINT_MAX_LENGTH} — shorten it (redaction may have grown it; check with --no-redact) rather than relying on the server to truncate`,
    };
  }

  const seen = new Set<string>();
  const hints: string[] = [];
  for (const { redacted } of pairs) {
    const key = redacted.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      hints.push(redacted); // preserve the first-seen occurrence's casing
    }
  }
  return { hints };
}

/**
 * Best-effort `owner[/group.../]name` extraction from a git remote origin
 * URL — for auto-populating a target-repo hint when no `--repo` was given at
 * all. Structurally parses the shapes `git remote -v` actually
 * produces — `scheme://[user@]host/path(.git)?` (https, ssh, git, …),
 * `user@host:path(.git)?` (scp-like syntax) — via `new URL()` for the former
 * (verified: WHATWG's parser splits host from path correctly for `ssh://`
 * and `git://` too, not only the "special" schemes) and a literal split for
 * the latter, rather than a single scheme-agnostic pattern. A
 * scheme-agnostic pattern is silently WRONG on two real shapes, not merely
 * conservative:
 *
 *   1. It kept only the LAST TWO path segments, so a GitLab-style nested
 *      group truncates: `https://gitlab.example.com/group/subgroup/project`
 *      derived `"subgroup/project"`, silently dropping `group` — and
 *      nothing on the wire marks an auto-derived hint as auto-derived, so
 *      this wrong-but-plausible value would have reached
 *      `provenance.repo.target_repos` looking exactly as authoritative as a
 *      hand-typed one. Fixed by taking the FULL path (every segment) once a
 *      real host is structurally identified, never just a trailing two.
 *   2. It could not tell a remote from a local checkout: `/home/user/repos/
 *      myproject` and `file:///home/user/repos/myproject` both derived
 *      `"repos/myproject"` — a fabricated, plausible-looking owner that is
 *      really just two path components of a local filesystem path. Fixed by
 *      refusing `file://` and any local-filesystem-shaped string (absolute,
 *      `./`/`../`-relative, or a Windows drive path) outright, rather than
 *      guessing from ANY 2+-segment string.
 *
 * Still degrades gracefully (returns `undefined`, never throws) on a shape
 * with no reliable host at all: a bare relative local path, a hostname with
 * no path, or a genuinely unparseable string. The one deliberate exception
 * is a URL a redaction pass has already partly replaced with a
 * `«redacted:…»` marker (`conn-string`'s pass replaces embedded
 * `scheme://user:pass@host` credentials, leaving e.g.
 * `«redacted:conn-string»/owner/name.git` as `origin_url`) — recovered
 * conservatively, the LAST TWO segments only, because there is no
 * structural signal for how many leading segments are real namespace vs.
 * redaction residue in that one case.
 *
 * This hint is never validated against a live repo list (see
 * `SubmitParams.repoHints`'s own docstring) — a wrong guess here is exactly
 * as harmless as an agent typing the wrong `--repo` value, not a
 * correctness bug to chase. The length bound is enforced by this function's
 * one caller, `resolveTargetRepoHints`, not here.
 */
function deriveRepoHintFromGitUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const trimmed = url.trim();
  if (trimmed.length === 0) return undefined;

  // Refuse anything that IS (or looks like) a local filesystem path rather
  // than a remote. None of these have an "owner" at
  // all; guessing one from trailing path components fabricates a
  // plausible-looking but bogus hint.
  if (/^file:\/\//i.test(trimmed)) return undefined;
  if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) return undefined;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return undefined; // a Windows drive path, e.g. C:\ or C:/

  let pathPart: string | undefined;

  // scp-like syntax: user@host:path — git@github.com:group/name(.git)
  const scpMatch = /^[\w.-]+@[\w.-]+:(.+)$/.exec(trimmed);
  if (scpMatch) {
    pathPart = scpMatch[1];
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    // A real scheme://host/path URL (https, ssh, git, …).
    try {
      pathPart = new URL(trimmed).pathname;
    } catch {
      return undefined;
    }
  } else if (trimmed.includes("«redacted:")) {
    // See the file header's "one deliberate exception" — a redacted-remnant
    // URL, recovered conservatively (last two segments only).
    const m = /([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)(?:\.git)?\/?$/.exec(trimmed);
    return m ? `${m[1]}/${m[2]}` : undefined;
  } else {
    // No scheme, no scp syntax, no redaction marker — no structural signal
    // this was ever a remote at all (e.g. a bare relative local path like
    // `repos/myproject`). Refuse rather than guess.
    return undefined;
  }

  if (pathPart === undefined) return undefined;
  const segments = pathPart
    .replace(/\.git\/?$/, "")
    .split("/")
    .filter((s) => s.length > 0);
  // The FULL path once a real host is identified, not
  // just the trailing two segments — a GitLab-style nested group must not
  // be silently truncated.
  if (segments.length < 2) return undefined;
  return segments.join("/");
}

/**
 * Resolve the final target-repo hint list for this submission: explicit
 * `--repo` hints always win when ANY were given (even if every one of them
 * turns out empty/whitespace-only after trimming — an agent that passed
 * `--repo` at all made a deliberate choice not to rely on auto-derivation),
 * falling back to a single git-remote-derived hint only when `--repo` was
 * never passed. Returns `undefined` — never `[]` — when there is nothing to
 * report either way (absent, not empty: nobody looked and found none,
 * derivation just never had anything to go on).
 *
 * The auto-derived branch
 * must clear the SAME `YAK_REPO_HINT_MAX_LENGTH` bound an explicit `--repo`
 * hint is checked against in `checkRepoHints` — confirmed live, a crafted
 * `origin_url` with a 50,000-char path segment reached the transport with
 * no bound check firing at all, because `checkRepoHints` only ever runs
 * over `params.repoHints` (explicit) and this branch bypassed it entirely.
 * An auto-derived hint isn't agent-authored text, so an over-length one is
 * not misuse and must not fail the whole submission (the same reasoning
 * `device_id`/`execution_id` get for `yak-identity-id-too-long`) — but "not
 * agent-authored" is not "exempt from the bound". Silently DROPPED rather
 * than truncated: truncating an `owner/name` string is at least as likely
 * to produce a different real repo's name as it is to produce something
 * useful, and this is best-effort enrichment with an already-defined
 * absent state (`undefined`) to fall back to — the same "nothing to report"
 * outcome as an unparseable `origin_url`.
 */
function resolveTargetRepoHints(
  rawHints: string[] | undefined,
  checked: RepoHintsCheckResult,
  originUrl: unknown,
): string[] | undefined {
  if (rawHints !== undefined && rawHints.length > 0) {
    // Explicit was given — "hints" is the only reachable branch of
    // `checked` here (a warn/misuse always returns before this function is
    // ever called; see the call site in `submitYak`).
    const hints = "hints" in checked ? checked.hints : [];
    return hints.length > 0 ? hints : undefined;
  }
  const derived = deriveRepoHintFromGitUrl(typeof originUrl === "string" ? originUrl : undefined);
  if (derived === undefined || derived.length > YAK_REPO_HINT_MAX_LENGTH) return undefined;
  return [derived];
}

/**
 * The submission pipeline (see file header for the exact, load-bearing
 * step order). Never throws — every failure mode, local or remote, comes
 * back as a typed `SubmitResult`.
 */
export async function submitYak(params: SubmitParams): Promise<SubmitResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const timeoutMs = params.timeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS;

  // --- step 2: redact (BEFORE key derivation) ------------------------------
  let redactedSummary = params.summary;
  let redactedBody = params.body;
  let redactedEvidence = params.evidence;
  let redactedRepro = params.repro;
  // redacted 1:1 with `params.repoHints` — same array shape and
  // order, just each element passed through `redact()`. `undefined` when no
  // `--repo` was given at all, the same absent-vs-empty posture `repro`
  // already follows.
  let redactedRepoHints = params.repoHints;
  let redactedProvenance = params.provenance;
  let redactionCounts: Record<RedactionClass, number> | undefined;

  if (!params.noRedact) {
    const summaryR = redact(params.summary);
    const bodyR = redact(params.body);
    const evidenceR = params.evidence !== undefined ? redact(params.evidence) : undefined;
    const reproR = params.repro !== undefined ? redact(params.repro) : undefined;
    const repoHintsR = params.repoHints !== undefined ? params.repoHints.map((h) => redact(h)) : undefined;
    const provenanceR = params.provenance !== undefined ? redactDeep(params.provenance) : undefined;

    redactedSummary = summaryR.text;
    redactedBody = bodyR.text;
    redactedEvidence = evidenceR?.text;
    redactedRepro = reproR?.text;
    redactedRepoHints = repoHintsR?.map((r) => r.text);
    redactedProvenance = provenanceR?.value;

    redactionCounts = mergeRedactionCounts([
      summaryR.counts,
      bodyR.counts,
      evidenceR?.counts,
      reproR?.counts,
      ...(repoHintsR?.map((r) => r.counts) ?? []),
      provenanceR?.counts,
    ]);
  }

  const redaction = summarizeRedactionCounts(redactionCounts, params.noRedact);

  // --- step 4: omit `evidence`/`repro` entirely when the (redacted) bytes
  // are empty — applied here, before derivation, so step 3 below already
  // sees the normalized value. Redaction can only ever replace a MATCH
  // with a marker; it cannot turn empty text non-empty or vice versa, so
  // checking "empty" on the redacted string is equivalent to checking the
  // raw one and there is exactly one normalization point, not two.
  const finalEvidence = redactedEvidence !== undefined && redactedEvidence.length > 0 ? redactedEvidence : undefined;
  const finalRepro = redactedRepro !== undefined && redactedRepro.length > 0 ? redactedRepro : undefined;

  // --- step 3: derive the idempotency key from the REDACTED, normalized
  // payload — the Actor re-derives from what it actually received, so
  // this must be the same text we're about to send, not the original.
  // `repro` never participates: it isn't part of `canonicalPayload`
  // (`@sibylline-labs/yak-contract`) — it rides inside `provenance`, which the
  // key derivation deliberately excludes (only summary/body/evidence do,
  // per that file's own docstring) — so attaching or changing a repro
  // command never changes an observation's dedup identity.
  const idempotencyKey = await deriveIdempotencyKey({
    device_id: params.deviceId,
    execution_id: params.executionId,
    verb: params.verb,
    summary: redactedSummary,
    body: redactedBody,
    evidence: finalEvidence,
  });

  // a repro command is agent-authored free text, like
  // summary/body/evidence, so it gets the same local courtesy length bound
  // those three get — see `YAK_REPRO_MAX_LENGTH`'s own docstring for why this
  // is a courtesy (provenance isn't schema-bounded) rather than a wire-
  // contract requirement. Checked here, after the key is derivable (every
  // other misuse/warn this pipeline raises past this point carries one), and
  // before `provenance` is built, so an over-bound repro never reaches the
  // request at all — same "never let the server silently truncate it"
  // posture as summary/body/evidence.
  if (finalRepro !== undefined && finalRepro.length > YAK_REPRO_MAX_LENGTH) {
    const rawReproLength = params.repro?.length ?? 0;
    if (rawReproLength <= YAK_REPRO_MAX_LENGTH) {
      return {
        status: "warn",
        slug: "yak-redaction-overflow",
        reason: `repro was ${rawReproLength} chars (within the ${YAK_REPRO_MAX_LENGTH} max) before redaction, but the secret-scrub pass grew it to ${finalRepro.length} chars — the original text is fine; retry with --no-redact if it contains no real secret`,
        redaction,
        idempotencyKey,
      };
    }
    return {
      status: "misuse",
      slug: "yak-repro-too-long",
      reason: `repro is ${finalRepro.length} chars, exceeds the max of ${YAK_REPRO_MAX_LENGTH} — shorten it (redaction may have grown it; check with --no-redact) rather than relying on the server to truncate`,
      idempotencyKey,
      redaction,
    };
  }

  // bound-check the explicit `--repo` hints the SAME way repro was
  // just bound-checked above — an over-long or over-many hint never reaches
  // the request at all (same posture). Auto-derivation from the
  // git remote (`resolveTargetRepoHints`, below) is NEVER subject to these
  // bounds — it isn't agent-authored text, same reasoning `device_id`/
  // `execution_id` get for `yak-identity-id-too-long` above.
  const repoHintsCheck = checkRepoHints(params.repoHints, redactedRepoHints);
  if ("status" in repoHintsCheck) {
    return { ...repoHintsCheck, idempotencyKey, redaction };
  }
  const finalRepoHints = resolveTargetRepoHints(params.repoHints, repoHintsCheck, redactedProvenance?.git?.origin_url);

  // `repro` is not a field the contract's `YakSubmission` (or
  // `YakProvenance`'s own typed categories) knows about — it rides in as an
  // extra top-level provenance key, preserved on the wire by
  // `YakProvenance.catchall(z.unknown())` (see `SubmitParams.repro`'s
  // docstring). Merged in AFTER `redactedProvenance` is computed, using the
  // ALREADY-redacted `finalRepro` from above — not a second `redactDeep`
  // pass over it, which would be redundant (a marker never re-matches any
  // class, `plugins/yak/yak-redact.ts`'s own idempotence guarantee) and would
  // double-count it in `redactionCounts` if it weren't idempotent.
  const provenanceWithRepro: YakProvenance | undefined =
    finalRepro !== undefined
      ? { ...(redactedProvenance ?? {}), repro: { command: finalRepro } }
      : redactedProvenance;
  // unlike `repro`, a target-repo hint lands in the ALREADY-typed
  // `repo` category (`YakProvenance.repo`) rather than a new catchall key —
  // see `SubmitParams.repoHints`'s docstring for why. Merged in the same
  // post-redaction style, preserving any sibling field that category
  // already carries (`repo.service`, from `yak-context.ts::gatherRepo`).
  const existingRepoCategory = provenanceWithRepro?.repo;
  const provenanceWithRepoHints: YakProvenance | undefined =
    finalRepoHints !== undefined && finalRepoHints.length > 0
      ? { ...(provenanceWithRepro ?? {}), repo: { ...(existingRepoCategory ?? {}), target_repos: finalRepoHints } }
      : provenanceWithRepro;
  const provenance =
    provenanceWithRepoHints && Object.keys(provenanceWithRepoHints).length > 0 ? provenanceWithRepoHints : undefined;

  // The reporter is never sent: the ingress derives the tracker user from the
  // bearer token, so the contract has no field for one. `route: "workspace"`
  // files the report into the caller's own tenant; it is not an input to the
  // idempotency key.
  const submission: YakSubmission = {
    schema_version: YAKS_CONTRACT_VERSION,
    verb: params.verb,
    route: "workspace",
    summary: redactedSummary,
    body: redactedBody,
    ...(finalEvidence !== undefined ? { evidence: finalEvidence } : {}),
    device_id: params.deviceId,
    execution_id: params.executionId,
    idempotency_key: idempotencyKey,
    ...(provenance ? { provenance } : {}),
  };

  // --- step 5: validate locally BEFORE the request ------------------------
  const parsed = YakSubmission.safeParse(submission);
  if (!parsed.success) {
    const failure = classifyValidationFailure(
      parsed.error.issues,
      { summary: params.summary, body: params.body, evidence: params.evidence, deviceId: params.deviceId, executionId: params.executionId },
      redactedSummary,
      redactedBody,
      finalEvidence,
    );
    if (failure.status === "warn") {
      return { status: "warn", slug: failure.slug, reason: failure.reason, redaction, idempotencyKey };
    }
    return { status: "misuse", slug: failure.slug, reason: failure.reason, idempotencyKey, redaction };
  }

  // --- step 6: one bounded POST, no retry -----------------------------------
  //
  // The deadline covers the WHOLE exchange — connect, headers, AND body — not
  // just the `fetchImpl()` call. `fetch()` in Bun/undici/browsers resolves as
  // soon as headers arrive; `response.json()` then does a SEPARATE, unbounded
  // read of the body stream. A `finally` that cleared the timer right after
  // `fetchImpl()` (the original shape here) stopped covering the exchange the
  // instant headers landed — a server that sends headers with a
  // `content-length` and then never finishes the body would hang forever
  // past `timeoutMs`, the exact shape ("a command that never returns
  // mid-task") this file's own header promises `docs/YAK.md` does
  // not happen. `clearTimeout` now lives in a `finally` that wraps BOTH
  // awaits, so the same abort that would have covered only the headers phase
  // now also fires mid-`response.json()` and is caught by the second
  // try/catch below.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${params.url.replace(/\/+$/, "")}${YAKS_INGRESS_PATH}`;

  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${params.token}`,
        },
        body: JSON.stringify(parsed.data),
        signal: controller.signal,
      });
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === "AbortError" || name === "TimeoutError") {
        return {
          status: "warn",
          slug: "yak-timeout",
          reason: `yaks endpoint did not respond within ${timeoutMs}ms (${url})`,
          redaction,
          idempotencyKey,
        };
      }
      return {
        status: "warn",
        slug: "yak-unreachable",
        reason: `cannot reach yaks endpoint at ${url}: ${(err as Error).message}`,
        redaction,
        idempotencyKey,
      };
    }

    if (!response.ok) {
      const refusal = REFUSAL_BY_STATUS.get(response.status);
      return {
        status: "warn",
        slug: refusal?.slug ?? "yak-transport-error",
        reason: `yaks endpoint responded ${response.status}${response.statusText ? ` ${response.statusText}` : ""} for ${url}${refusal ? ` — ${refusal.remedy}` : ""}`,
        redaction,
        idempotencyKey,
      };
    }

    let receiptJson: unknown;
    try {
      receiptJson = await response.json();
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === "AbortError" || name === "TimeoutError") {
        return {
          status: "warn",
          slug: "yak-timeout",
          reason: `yaks endpoint did not finish sending its response body within ${timeoutMs}ms (${url})`,
          redaction,
          idempotencyKey,
        };
      }
      return {
        status: "warn",
        slug: "yak-transport-error",
        reason: `yaks endpoint returned an unparseable ${response.status}: ${(err as Error).message}`,
        redaction,
        idempotencyKey,
      };
    }

    // LenientYakReceipt, not the package's YakReceipt directly — a
    // contract_version the package's literal doesn't know about (a bump the
    // server shipped before this CLI's package caught up) must not turn an
    // accepted, durably-stored delivery into a reported failure.
    const receiptParsed = LenientYakReceipt.safeParse(receiptJson);
    if (!receiptParsed.success) {
      return {
        status: "warn",
        slug: "yak-transport-error",
        reason: `yaks endpoint returned a ${response.status} that does not match the receipt contract`,
        redaction,
        idempotencyKey,
      };
    }

    // --- step 7: compare our derived key against the receipt's -------------
    const keyMismatch = receiptParsed.data.idempotency_key !== idempotencyKey;

    return {
      status: "delivered",
      receipt: receiptParsed.data,
      idempotencyKey,
      keyMismatch,
      redaction,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// `--output json` record
// ---------------------------------------------------------------------------

export interface YakOutputRecord {
  verb: YakVerb;
  /** The field to branch on — NEVER `id == null` (same absent-vs-empty
   *  discipline as `config show`'s tri-state `state` field). */
  delivered: boolean;
  id?: string;
  idempotency_key?: string;
  replay?: boolean;
  contract_version?: string;
  /** Present only when `delivered: true` — mirrors `SubmitResult`'s own
   *  `keyMismatch` (output-contract fix). Before this field
   *  existed, the only place the mismatch showed up was a `yak-key-mismatch`
   *  WARN on stderr; suppressing every diagnostic under `--output json`
   *  (this fix's whole point) would have made a canonicalization-drift
   *  signal undetectable by a machine caller, since `idempotency_key` here
   *  is the RECEIPT's key, never the locally-derived one the mismatch is
   *  measured against. */
  key_mismatch?: boolean;
  redactions: RedactionSummary;
  error?: { slug: string; reason: string };
}

export function toOutputRecord(verb: YakVerb, result: SubmitResult): YakOutputRecord {
  if (result.status === "delivered") {
    return {
      verb,
      delivered: true,
      id: result.receipt.id,
      idempotency_key: result.receipt.idempotency_key,
      replay: result.receipt.replay,
      contract_version: result.receipt.contract_version,
      key_mismatch: result.keyMismatch,
      redactions: result.redaction,
    };
  }

  // "misuse" carries `redaction` same as
  // "warn" does (always present there — see the SubmitResult type) rather
  // than a silently-zeroed placeholder that would desync the JSON record's
  // `redactions` from the `reason` text a too-long slug prints ("redaction
  // may have grown it").
  const redactions =
    result.status === "warn" || result.status === "misuse"
      ? (result.redaction ?? zeroRedactionSummary())
      : zeroRedactionSummary();
  return {
    verb,
    delivered: false,
    ...(result.idempotencyKey !== undefined ? { idempotency_key: result.idempotencyKey } : {}),
    redactions,
    error: { slug: result.slug, reason: result.reason },
  };
}
