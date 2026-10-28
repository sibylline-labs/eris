#!/usr/bin/env bun
/**
 * yak.ts — the `eris yak` CLI core.
 *
 * `plugins/yak/handlers.ts` is the thin dispatcher in front of it (group
 * usage, the unknown-verb block, the per-call env). Every actual
 * behaviour — argv parsing, input resolution, identity/provenance,
 * redaction, submission, and the receipt/failure/warn rendering — lives
 * here and in the modules this file composes
 * (`plugins/yak/yak-identity.ts`, `plugins/yak/yak-context.ts`,
 * `plugins/yak/yak-submit.ts`, `ts/lib/eris-fail.ts`).
 *
 * The whole orchestration is `runYak()`, a PURE function of its inputs
 * (argv, env, and a handful of injectable I/O dependencies) that returns
 * `{stdout, stderr, exitCode}` as plain strings rather than writing to the
 * real streams or calling `process.exit` itself. That is what makes the
 * full outcome table (fresh 200 / replay / 400 / 401 / 404 / timeout /
 * connection-refused / every misuse case) testable in `bun:test` with an
 * injected `fetchImpl`, without spawning a real `bun` subprocess per case
 * — and it is what lets a test assert directly that stdout carries only
 * the payload (`docs/OUTPUT-CONTRACT.md` §1), because the two streams are
 * genuinely separate strings here, not shared process fds a test would
 * have to intercept. The `import.meta.main` guard below is the only place
 * that touches the real world.
 *
 * The misuse-vs-environment exit split is enforced entirely in this file's outcome
 * mapping: an agent-misuse outcome (bad argv, unreadable/missing
 * input, a stdin TTY with no pipe, an over-bound field) renders the
 * `eris-fail.ts` four-line block and exits 1; every environment/config/
 * transport outcome (unresolved token/url/device-id, an unreachable or
 * non-2xx endpoint, a timeout) renders one concise `WARN` and exits 0 — the
 * operator's problem, never the task's.
 */

import { homedir } from "node:os";
import {
  readYaksFileConfig,
  resolveToken,
  resolveUrl,
  resolveDeviceId,
  resolveExecutionId,
} from "./yak-identity";
import { erisHome, groupArgs, readArgs, renderFailureBlock, renderWarnLines } from "../../src/cli/plugin";
import plugin from "./index";
import { gatherProvenance } from "./yak-context";
import {
  resolveTextInputs,
  submitYak,
  toOutputRecord,
  type RawTextInputs,
  type RedactionSummary,
  type SubmitResult,
  type TextInputDeps,
  type YakOutputRecord,
} from "./yak-submit";
import { formatRedactionSummary } from "eris/outbound-scan";
import type { YakVerb } from "eris/yak-contract";

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

const VERBS: readonly YakVerb[] = ["issue", "suggest", "fatal"];

/** The manifest's subs are exactly the contract's verbs; this narrows one. */
const isVerb = (s: string): s is YakVerb => (VERBS as readonly string[]).includes(s);

/** A refusal `readArgs` hands to `refuse`: `parseArgv` returns it as an
 *  outcome instead of writing it, and `runYak` renders it (block or record). */
class Refused {
  constructor(readonly outcome: ArgvOutcome) {}
}

/** Where `readArgs` writes the help it prints: `runYak` writes yak's own. */
const DISCARD = { erisDir: "", stdout: { write: () => true }, stderr: { write: () => true } };


// A `…Slug`-named union: `tests/errors-doc.test.ts` harvests its members and
// fails when a member has no docs/ERRORS.md heading. Keep the type's name
// ending in `Slug`; a union named otherwise is invisible to it.
export type ArgvMisuseSlug =
  | "yak-unknown-verb"
  | "yak-unknown-flag"
  | "yak-positional-arg"
  | "yak-flag-missing-value";

export interface ParsedFlags {
  summary?: string;
  bodyInline?: string;
  bodyFile?: string;
  evidenceInline?: string;
  evidenceFile?: string;
  /** a repro command to attach to this yak, stored with the
   *  cluster it lands on (`provenance.repro.command` on the wire — see
   *  `plugins/yak/yak-submit.ts`'s `SubmitParams.repro`). Inline text only, like
   *  `--summary` — no `--repro-file`/stdin variant, since a repro is a
   *  command, not a document. Parsed uniformly across all three verbs
   *  (like every other flag here) rather than gated to `issue` alone: the
   *  parser has no per-verb flag sets today, and an improvement
   *  `suggest` or a harness `fatal` can just as usefully carry one. */
  repro?: string;
  /** zero or more `--repo <owner/name>` target-repo hints, in the
   *  order given — repeatable, unlike every other flag here, so a report
   *  that spans repos can name each one (`provenance.repo.target_repos` on
   *  the wire — see `plugins/yak/yak-submit.ts`'s `SubmitParams.repoHints`).
   *  `undefined` (never `[]`) when `--repo` was never passed at all — that
   *  absence is what lets `submitYak` fall back to auto-deriving a hint
   *  from the invoking process's own git remote instead. */
  repoHints?: string[];
  noRedact: boolean;
  /** `--vendor`: file into the vendor's tenant, a report about eris itself. */
  vendor: boolean;
}

export type ArgvOutcome =
  | { kind: "help" }
  // `verb` is OPTIONAL, not absent-by-design —
  // it's populated on every misuse this parser can produce AFTER `verbArg`
  // has already been matched against the registry's yak subs (an unknown flag, a flag missing its
  // value), so `runYak` can still emit the documented `--output json`
  // record on those outcomes. It stays undefined for the one misuse this
  // parser produces BEFORE that point (`yak-unknown-verb` itself) — a case
  // the dispatcher (`plugins/yak/handlers.ts`) never actually forwards to
  // this file in production (it answers an unknown verb itself),
  // so there is no real verb to report there.
  | { kind: "misuse"; reason: string; slug: ArgvMisuseSlug; verb?: YakVerb; fix?: string }
  | { kind: "ok"; verb: YakVerb; flags: ParsedFlags };

/**
 * `--output` is deliberately NOT a flag this parser knows: it is the
 * global `--output json|text` selector, parsed once and STRIPPED before
 * dispatch by `src/cli/output.ts` in the real `eris` entrypoint
 * (`docs/OUTPUT-CONTRACT.md` §2) — by the time `plugins/yak/handlers.ts`
 * calls `runYak`, it is already gone from argv. The resolved format instead
 * reaches the core as `ERIS_OUTPUT` in THIS SINGLE invocation's environment
 * (never a persistent exported var — `docs/OUTPUT-CONTRACT.md` §2 is
 * explicit that there is deliberately no such env var for a user's shell
 * to set; the dispatcher sets it per call). Passing `--output` here would
 * therefore either shadow a flag with no local meaning or silently do
 * nothing on the one path that matters (through `eris`) while working only
 * when yak.ts is invoked directly — worse than refusing it as unknown.
 */
export function parseArgv(argv: string[]): ArgvOutcome {
  const g = groupArgs(plugin.rows, "yak", argv);
  if (g.kind === "bare" || g.kind === "help") return { kind: "help" };
  if (g.kind === "unknown" || !isVerb(g.sub)) {
    return {
      kind: "misuse",
      reason: `unknown verb '${g.sub}' — expected one of: ${VERBS.join(", ")}`,
      slug: "yak-unknown-verb",
    };
  }
  const verbArg = g.sub;
  let p;
  try {
    p = readArgs(plugin.rows, `yak ${verbArg}`, g.rest, DISCARD, {
      refuse: (e, what) => {
        // A bare word is the most common first guess (`eris yak issue "text"`), so it names
        // the two flags the text has to ride on rather than reading as an unknown flag.
        if (e.kind === "unexpected-arg") {
          throw new Refused({
            kind: "misuse",
            reason: `${what}; eris yak takes its text through flags: --summary and --body (or --body-file)`,
            slug: "yak-positional-arg",
            verb: verbArg,
            fix: `eris yak ${verbArg} --summary "<one line>" --body "<what happened>"`,
          });
        }
        const slug = e.kind === "missing-value" ? "yak-flag-missing-value" : "yak-unknown-flag";
        throw new Refused({ kind: "misuse", reason: what, slug, verb: verbArg });
      },
    });
  } catch (e) {
    if (e instanceof Refused) return e.outcome;
    throw e;
  }
  if (p === null) return { kind: "help" };
  const f = p.flags;
  const flags: ParsedFlags = { noRedact: f["--no-redact"], vendor: f["--vendor"] };
  if (f["--summary"] !== undefined) flags.summary = f["--summary"];
  if (f["--body"] !== undefined) flags.bodyInline = f["--body"];
  if (f["--body-file"] !== undefined) flags.bodyFile = f["--body-file"];
  if (f["--evidence"] !== undefined) flags.evidenceInline = f["--evidence"];
  if (f["--evidence-file"] !== undefined) flags.evidenceFile = f["--evidence-file"];
  if (f["--repro"] !== undefined) flags.repro = f["--repro"];
  if (f["--repo"].length > 0) flags.repoHints = [...f["--repo"]];
  return { kind: "ok", verb: verbArg, flags };
}

const USAGE = `usage: eris yak <issue|suggest|fatal> [flags]

Land a durable, deduplicated observation with the Yaks endpoint. For a
harness/tooling problem hit mid-task — never for the task's own outcome.

verbs:
  issue     a harness/tooling defect, confirmed or suspected
  suggest   an improvement to the harness: a missing capability or a better way of working
  fatal     the harness itself is broken

flags:
  --summary <text>             required, <= 200 chars
  --body <text>                required (mutually exclusive with --body-file)
  --body-file <path|->         required (mutually exclusive with --body); - reads stdin
  --evidence <text>            optional, <= 20000 chars
  --evidence-file <path|->     optional (mutually exclusive with --evidence); - reads stdin
  --repro <command>            optional, <= 2000 chars — a command that reproduces this,
                               stored with the cluster
  --repo <owner/name>          optional, repeatable, <= 200 chars each, <= 20 total — a
                               target repo this report concerns; auto-derived from this
                               process's own git remote when omitted
  --no-redact                  skip the secret-scrub pass (loud warning)
  --vendor                     file a report about eris itself into the vendor's tracker,
                               not your workspace
  --help, -h                   show this message

Setup: 'eris login' writes ~/.eris/yaks.json ({"url", "token"}, mode 0600;
the url defaults to https://api.sibylline.group); or export ERIS_YAKS_URL /
ERIS_YAKS_TOKEN.
`;

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface RunYakOptions {
  argv: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  ppid?: number;
  /** Home directory identity/config files resolve under — defaults to the
   *  real `homedir()`. Overridden in tests so nothing ever touches this
   *  machine's real `~/.eris`. */
  home?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  isStdinTTY?: TextInputDeps["isStdinTTY"];
  readStdin?: TextInputDeps["readStdin"];
  readFile?: TextInputDeps["readFile"];
}

export interface RunYakResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// `skipped` mirrors `flags.noRedact` for the warns raised BEFORE `submitYak`
// is ever called (config/token/url/device-id resolution) — those never
// build a `RedactionSummary` of their own, so this is the only way the
// record can say whether `--no-redact` was set (stderr's `yak-no-redact` WARN is unconditionally suppressed under
// `--output json` now, same as every other diagnostic — see `runYak`).
function warnOutputRecord(verb: YakVerb, slug: string, reason: string, skipped: boolean): YakOutputRecord {
  return { verb, delivered: false, redactions: { count: 0, classes: [], skipped }, error: { slug, reason } };
}

// output-contract fix: under `--output json`, `eris yak` writes
// EXACTLY one JSON record to stdout and NOTHING to stderr — `prefix`
// (the `--no-redact` WARN, when set) used to reach stderr unconditionally
// here, even in json mode, which is the exact leak this fix closes. Text
// mode is byte-identical to before.
function warnResult(
  verb: YakVerb,
  slug: string,
  reason: string,
  jsonOutput: boolean,
  prefix: string,
  skipped: boolean,
): RunYakResult {
  const stdout = jsonOutput ? `${JSON.stringify(warnOutputRecord(verb, slug, reason, skipped))}\n` : "";
  const stderr = jsonOutput ? "" : prefix + renderWarnLines(reason, slug);
  return { stdout, stderr, exitCode: 0 };
}

// A misuse outcome used to leave stdout
// empty UNCONDITIONALLY — docs/YAK.md and docs/OUTPUT-CONTRACT.md both
// promise "one bare record on stdout regardless of outcome" and tell a
// consumer to branch on `delivered`, never `id == null`, so a `--output
// json` caller got nothing to parse on the one outcome class (agent
// misuse) it's most likely to need to detect programmatically.
//
// `verb` is optional because ONE of this function's three call sites
// (`parseArgv`'s own `yak-unknown-verb`) can fire before a verb is known
// at all — and that specific case is unreachable through the real `eris`
// entrypoint (`plugins/yak/handlers.ts` only ever forwards `issue|suggest|fatal`),
// so there's nothing dishonest about `stdout` staying empty there: no
// `verb` value would be true. Every OTHER misuse this file produces has a
// real verb by the time it reaches here (threaded through `ArgvOutcome`'s
// `verb?` field, or already destructured from `parsed.verb`) and gets the
// documented record.
//
// `redaction` mirrors `formatRedactionSummary`'s wiring on the warn/
// delivered paths: when it's present and non-empty, the count/class
// breakdown prints on stderr in text mode (ahead of the failure block, same
// order as `--no-redact`'s warning) and rides along in the JSON record's
// `redactions` field either way — never silently dropped just because the
// outcome was a failure rather than a success.
//
// `skipped` is the fallback used ONLY when `redaction` itself is absent
// (the argv-level and resolveTextInputs misuses, which never build a
// `RedactionSummary` of their own) — when `redaction` IS present (the
// submitYak-derived misuses), it already carries the correct `skipped`
// value from `params.noRedact` and this parameter is ignored.
//
// output-contract fix: under `--output json`, stderr is now
// EMPTY on every misuse — the four-line failure block used to reach
// stderr unconditionally, even in json mode, which is the exact leak
// this fix closes (`ERROR .../slug:.../fix:.../docs:...` alongside a
// stdout JSON record the caller was told to parse instead). Text mode is
// byte-identical to before.
function misuseResult(
  slug: string,
  reason: string,
  erisHomeDir: string,
  prefix: string,
  jsonOutput: boolean,
  verb?: YakVerb,
  redaction?: RedactionSummary,
  skipped = false,
  fix?: string,
): RunYakResult {
  const redactions = redaction ?? { count: 0, classes: [], skipped };
  const redactionLine = !jsonOutput && redactions.count > 0 ? formatRedactionSummary(redactions) : "";
  const stdout =
    jsonOutput && verb !== undefined
      ? `${JSON.stringify({ verb, delivered: false, redactions, error: { slug, reason } } satisfies YakOutputRecord)}\n`
      : "";
  const stderr = jsonOutput ? "" : prefix + redactionLine + renderFailureBlock({ slug, what: reason, ...(fix ? { fix } : {}) }, erisHomeDir);
  return { stdout, stderr, exitCode: 1 };
}

/**
 * Run the full `eris yak` pipeline and return `{stdout, stderr, exitCode}`
 * — never writes to a real stream, never calls `process.exit`. Every
 * dependency that touches the outside world (env, fs, stdin, network,
 * `~/.eris`) is injectable via `opts`, defaulting to the real thing.
 */
export async function runYak(opts: RunYakOptions): Promise<RunYakResult> {
  const env = opts.env ?? process.env;
  const jsonOutput = env.ERIS_OUTPUT === "json";
  const erisHomeDir = erisHome(env);
  const home = opts.home ?? homedir();

  const parsed = parseArgv(opts.argv);

  if (parsed.kind === "help") {
    return { stdout: USAGE, stderr: "", exitCode: 0 };
  }
  if (parsed.kind === "misuse") {
    return misuseResult(parsed.slug, parsed.reason, erisHomeDir, "", jsonOutput, parsed.verb, undefined, false, parsed.fix);
  }

  const { verb, flags } = parsed;
  const noRedactWarning = flags.noRedact
    ? renderWarnLines(
        "--no-redact is set — the secret-scrub pass will NOT run on this submission",
        "yak-no-redact",
      )
    : "";

  const rawInputs: RawTextInputs = {
    summary: flags.summary,
    bodyInline: flags.bodyInline,
    bodyFile: flags.bodyFile,
    evidenceInline: flags.evidenceInline,
    evidenceFile: flags.evidenceFile,
  };
  const textDeps: Partial<TextInputDeps> = {};
  if (opts.readFile) textDeps.readFile = opts.readFile;
  if (opts.readStdin) textDeps.readStdin = opts.readStdin;
  if (opts.isStdinTTY) textDeps.isStdinTTY = opts.isStdinTTY;

  const inputsOutcome = await resolveTextInputs(rawInputs, textDeps);
  if ("reason" in inputsOutcome) {
    return misuseResult(
      inputsOutcome.slug,
      inputsOutcome.reason,
      erisHomeDir,
      noRedactWarning,
      jsonOutput,
      verb,
      undefined,
      flags.noRedact,
    );
  }
  const { summary, body, evidence } = inputsOutcome.value;

  // --- identity: config file, token, url, device id ------------------------
  const fileConfigOutcome = await readYaksFileConfig(home);
  if ("reason" in fileConfigOutcome) {
    return warnResult(verb, fileConfigOutcome.slug, fileConfigOutcome.reason, jsonOutput, noRedactWarning, flags.noRedact);
  }
  const fileConfig = fileConfigOutcome.value;

  const tokenOutcome = resolveToken(fileConfig, env);
  if ("reason" in tokenOutcome) {
    return warnResult(verb, tokenOutcome.slug, tokenOutcome.reason, jsonOutput, noRedactWarning, flags.noRedact);
  }

  const urlOutcome = resolveUrl(fileConfig, env);

  const deviceIdOutcome = await resolveDeviceId(home);
  if ("reason" in deviceIdOutcome) {
    return warnResult(verb, deviceIdOutcome.slug, deviceIdOutcome.reason, jsonOutput, noRedactWarning, flags.noRedact);
  }

  const executionId = resolveExecutionId(env, opts.ppid ?? process.ppid).value;
  const provenance = await gatherProvenance({ env, cwd: opts.cwd, ppid: opts.ppid });

  // --- submit ---------------------------------------------------------------
  const result: SubmitResult = await submitYak({
    verb,
    summary,
    body,
    evidence,
    repro: flags.repro,
    repoHints: flags.repoHints,
    noRedact: flags.noRedact,
    ...(flags.vendor ? { route: "vendor" as const } : {}),
    deviceId: deviceIdOutcome.value,
    executionId,
    provenance,
    url: urlOutcome.value,
    token: tokenOutcome.value,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });

  if (result.status === "misuse") {
    return misuseResult(result.slug, result.reason, erisHomeDir, noRedactWarning, jsonOutput, verb, result.redaction);
  }

  if (result.status === "warn") {
    const stdout = jsonOutput ? `${JSON.stringify(toOutputRecord(verb, result))}\n` : "";
    // The count/class breakdown belongs on stderr in text mode too, not
    // only inside `--output json`'s `redactions` field (docs/YAK.md) —
    // `result.redaction` is only present once redaction has
    // actually run (a network-outcome warn, not an earlier config warn).
    //
    // output-contract fix: `stderr` is now EMPTY under
    // `--output json` — `noRedactWarning`/`redactionLine`/the WARN line
    // used to reach stderr unconditionally, even in json mode. Every one
    // of those facts is already recoverable from `stdout`'s record: the
    // WARN's own slug/reason are `error.{slug,reason}`, the redaction
    // count/classes/skip are `redactions`.
    const redactionLine =
      !jsonOutput && result.redaction && result.redaction.count > 0 ? formatRedactionSummary(result.redaction) : "";
    const stderr = jsonOutput ? "" : noRedactWarning + redactionLine + renderWarnLines(result.reason, result.slug);
    return { stdout, stderr, exitCode: 0 };
  }

  // delivered
  let stdout: string;
  if (jsonOutput) {
    stdout = `${JSON.stringify(toOutputRecord(verb, result))}\n`;
  } else {
    stdout = `${result.receipt.replay ? "already recorded" : "recorded"}: ${result.receipt.id}\n`;
  }
  // output-contract fix: `stderr` is EMPTY under `--output json`.
  // The `--no-redact` WARN is recoverable from `redactions.skipped`, the
  // redaction count/class breakdown from `redactions.{count,classes}`, and
  // the key-mismatch WARN from `key_mismatch` — all on the one stdout
  // record (`toOutputRecord`) rather than a second, silently-dropped
  // stream.
  let stderr = "";
  if (!jsonOutput) {
    stderr = noRedactWarning;
    // Same rule (see above) on the successful-delivery path.
    if (result.redaction.count > 0) {
      stderr += formatRedactionSummary(result.redaction);
    }
    if (result.keyMismatch) {
      stderr += renderWarnLines(
        "locally-derived idempotency key does not match the receipt's — possible canonicalization drift between this CLI and the Yaks endpoint",
        "yak-key-mismatch",
      );
    }
  }
  return { stdout, stderr, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Real entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const result = await runYak({ argv: process.argv.slice(2) });
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
