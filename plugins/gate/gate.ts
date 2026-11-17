/**
 * gate.ts — `eris gate record | skip | check | ci`: the command line, read from the plugin's rows, handed
 * to the engines (record.ts, check.ts, ci-verb.ts) over the gates client.
 *
 * Every failure below the command line is one thrown `GateFailure`, caught once here and written as its
 * slugged block, so the exit code is the failure's own (2 for a wrong command line, 3 for anything the
 * verb needs that is missing or does not hold). A missing required flag, or two flags that exclude
 * each other, is refused before anything is read, exit 1.
 *
 * Auth and host come from `eris login` (the org this directory acts as); no eris.yaml is needed. With
 * the org's policy pulled, `--doctrine` and `--profiles` default to its verified tree, its bundle sha
 * rides every receipt call, and a reply marking it stale prints one WARN naming `eris doctrine pull`.
 * An edited tree fails `doctrine-local-modified` before anything is sent.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  COPY_MAX_BYTES,
  type ContractFailure,
  GATE_USER_IMPACTS,
  GATE_VERDICTS,
  type GateUserImpact,
  type GateVerdict,
  type GatesEndpoint,
  readDoctrineFile,
  readProfiles,
} from "eris/gates-contract";
import { CliExit, groupArgs, readArgs, renderFailureBlock, type VerbContext, type VerbHandler } from "../../src/cli/plugin";
import { resolveActor } from "./actor";
import { readBurdenRubric } from "./burden";
import { checkGates } from "./check";
import { GateFailure, stop, usage } from "./failure";
import { type Git, liveGit, memoReads } from "./git";
import plugin, { type GateDefaults, type PulledTree } from "./index";
import { readLadder } from "./ladder";
import { type EvidenceInput, recordGate, skipGate, type WriteRun } from "./record";
import { type RetryOpts, storeEndpoint } from "./store";
import { discoverPathsSurfaces } from "./surfaces";

const ROWS = plugin.rows;

/** What the network, the clock and the waits are in a test; the process's own when absent. */
export interface GateDeps {
  readonly home?: string;
  readonly cwd?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  /** How a wait is slept (a 429 retry, an `--expect` re-read). */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly jitter?: () => number;
  /** The `--expect` re-read waits (default about 31 s across 8 reads). */
  readonly expectDelaysMs?: ReadonlyArray<number>;
}

const USAGE = `Usage: eris gate <command>

Gate receipts: one gate-receipt@v2 comment per gate run on a tracker issue,
written by 'record' and 'skip' and read back by 'check'.

Commands:
  record <gate> --issue <KEY> --verdict PASS|AMENDED|BLOCKING --artifact <path>
                          Hash the artifact and append the receipt comment
  skip   <gate> --issue <KEY> --reason <why> --authorized <grant> --artifact <path>
                          Append a SKIPPED receipt naming the grant behind it
  check  --issue <KEY> --gates <a,b,...> | --profile <name> [--expect <id,...>]
                          Exit 3 unless every gate's latest receipt passes
  ci     [--event <file>] [--registry <path>]
                          The required PR check under the org's hosted policy
                          (GET-only: it records nothing)

Receipts are written and read through the gateway's gate-receipt routes,
signed in with 'eris login' (run it once per machine; ERIS_YAKS_TOKEN, a sib_
service token, wins when set). Host: ERIS_YAKS_URL, else the login's url, else
the gateway default. No eris.yaml is needed. See docs/GATE.md.
`;

type Sub = "gate record" | "gate skip" | "gate check";
const line = (path: Sub) => `eris ${path} ${ROWS[path].usage}`;

const RECORD_USAGE = `Usage: ${line("gate record")}

Store one gate-receipt@v2 record and append its comment to <KEY>: the
verdict's template, then the store's footer naming the record. 'eris gate
check' reads the record, never the comment. The body is always rendered from
the receipt; no flag takes comment text.

  <gate>         The gate's kebab-case name (plan-review, posture-check, ...)
  --issue        The issue key (ABC-123)
  --verdict      PASS, AMENDED or BLOCKING (a skip is 'eris gate skip')
  --artifact     The file the gate judged; its sha256 is recorded, and 'check'
                 fails a PASS/AMENDED receipt whose artifact has since changed.
                 Inside a git checkout with a hosted origin it is recorded as
                 repo + branch + commit sha + repo-relative path, so 'check'
                 finds it from any directory; an in-repo artifact that is not
                 committed at HEAD and pushed to origin is refused ('commit and
                 push first', exit 3). Other files stay file artifacts.
                 PASS/AMENDED also carry a gzip copy of its bytes in the record
                 (up to 48 KiB encoded; none when the secret scan matches, with
                 a WARN naming the rule), which 'check' re-hashes once the file
                 itself is gone
  --rubric       A rubric the gate applied (name@version); repeat for several
  --doctrine     A doctrine file; its active posture is snapshotted (default:
                 the org's pulled doctrine.md, when one is pulled)
  --impact       The user-impact class: U0, U1, U2 or U3
  --authorized   The human grant behind this receipt ('<name> asked: ...'); the
                 only way a later receipt may lower a U2/U3 class
  --evidence     One text evidence line; repeat for several
  --log, --test-run, --e2e
                 A text file (at most 16 KiB) carried inline with its sha256
  --screenshot, --video
                 An image (.png .jpg .jpeg .gif .webp) or video (.mp4 .webm
                 .mov), at most 25 MiB, uploaded to the store's private asset
                 storage; 'check' re-reads the stored asset's digest
  --actor        Who ran the gate (default: the Claude Code or OpenCode
                 session, else git's user.email)

stdout: the new comment's id.
`;

const SKIP_USAGE = `Usage: ${line("gate skip")}

Append one gate-receipt@v2 SKIPPED comment to <KEY> that records why the gate
is not run, the grant behind the decision, and who recorded it. Without
--authorized nothing is sent (exit 2). 'check' counts the skip as satisfied,
except toward the user-impact floor: a skipped requirement never meets it.

  <gate>         The gate not run (sdk-check, e2e, ...)
  --issue        The issue key (ABC-123)
  --reason       Why the gate is not run (12 characters or more)
  --authorized   The grant: a human one ('<name> asked: <request>'), recorded
                 as given; exactly doctrine:<posture>, which needs --doctrine
                 and holds only when that posture sets gates.<gate>: off; or
                 exactly repo:no-eris-yaml for define-future in a git repo with
                 no root eris.yaml (exit 3 otherwise). A grant starting
                 'doctrine' or 'repo' in any other spelling is refused (exit 3)
  --artifact     The file the skip is about (a plan, say); its sha256 is recorded
  --doctrine     A doctrine file (the 'eris doctrine check' format; default:
                 the org's pulled doctrine.md)
  --impact       The user-impact class: U0, U1, U2 or U3
  --actor        Who recorded the skip (default: as for 'record')

stdout: the new comment's id.
`;

const CHECK_USAGE = `Usage: ${line("gate check")}

Read <KEY>'s receipts and print one line per gate, '<gate>\\t<status>\\t<verdict>'.
The latest receipt per gate (by the store's time) decides: missing,
bad-digest (evidence no longer matches its sha256), blocking (a BLOCKING
verdict, or review-report evidence, which this build does not judge),
unresolved (the artifact's repo has no checkout here or in
~/.eris/clones.json) or drift (artifact changed after PASS/AMENDED; when the
artifact cannot be read at all, a carried copy that still re-hashes passes
instead) or unauthorized-skip (a SKIPPED with no grant) or doctrine-stale (a
doctrine skip the active posture no longer bears out) exit 3; pass, skipped and
deferred exit 0.

Naming final-gates or user-impact also checks the user-impact floor and prints
'@floor\\t<pass|unmet|unclassified>\\t<class>': each requirement of the issue's
class (U1 revert-path; U2 + zero-downtime, e2e; U3 + rollback-rehearsal) needs
a passing receipt for the gate of that name, and prints as its own gate row
before '@floor'. SKIPPED never meets the floor. Then '@door\\t<rung>\\t<class>'.
An issue with a remediate receipt prints '@remediate\\tunsupported\\t-' and exits
3: this build does not judge a remediation loop.

  --gates        The gates to check, comma-separated
  --profile      Check the gates a work profile requires instead (built in:
                 spine, deep; else the org's pulled profiles.yaml); exactly
                 one of --gates and --profile
  --profiles     A YAML map of profile name to gate list, read instead. An
                 entry may be '{ require: [...], forbid: [...] }': a forbidden
                 gate prints '<gate>\\tabsent\\t-', or '<gate>\\tforbidden\\t<verdict>'
                 (exit 3) when any receipt for it is on the issue
  --ladder       The door-class ladder (default: the build's, else none: every
                 class at R1). The class is the U-class crossing each --burden
                 surface, its rung the ladder's, raised by the active posture's
                 lifts when the latest bleed-reducing receipt passes, then
                 capped by its ceilings (and U3 never above R1). R0 exits 3
                 unless a door-signoff receipt passes with a human --authorized
                 grant; R1 (human after) and R2 (auto) pass
  --doctrine     The doctrine file (default: the org's pulled doctrine.md; none
                 pulled: no doctrine, so no gate is skipped). With --profile,
                 each gate's mode comes from its active posture: an 'off' gate
                 with no receipt gets a SKIPPED recorded by
                 doctrine:<posture>@<hash>, a 'once-at-end' gate reads
                 'deferred' until final-gates is checked, and define-future with
                 no receipt in a git repo with no root eris.yaml gets a SKIPPED
                 recorded by repo:no-eris-yaml. Any doctrine or repo:no-eris-yaml
                 skip counts only while that condition still holds (else
                 doctrine-stale, exit 3). With --profile the posture's
                 policy.user_impact[class] also raises the floor
  --expect       Comment ids 'eris gate record' printed. The store's reads lag
                 its writes, so check re-reads (about 30 s) until one listing
                 holds every id, and exits 3 (gate-receipt-unseen) if none does
  --burden       A rubric YAML ('surfaces:' map of surface to evidence kinds).
                 The paths changed since --base resolve to surfaces through the
                 root eris.yaml's discover.paths (most specific claim; an estate
                 with leaf eris.yaml files is refused, gate-burden-unresolved);
                 check prints 'burden\\t<pass|unmet>\\t<kinds>' and exits 3 unless
                 the passing receipts carry every kind those surfaces require
  --base         The ref the change forked from; with --burden
  --pr           With a terminal gate (final-gates): also read the open
                 blocking asks bound to this pull request number
  --asks         Read the asks whatever the gates, and print the result as one
                 JSON line ('{"asks":{...}}') after the rows
  --dry-run      Observe only: with --profile, a gate the posture sets 'off' (or
                 define-future in a repo with no root eris.yaml) prints
                 '<gate>\\tskipped\\t<reason>' and passes, and no SKIPPED receipt
                 is recorded

Naming final-gates also reads the issue's open blocking asks and prints
'@asks\\t<clear|open>\\t<n>' last: any open blocking ask exits 3, named on
stderr. An asks API that cannot be read exits 3 (asks-store-unreachable,
asks-store-forbidden, asks-contract-mismatch, asks-rate-limited,
asks-listing-truncated): it is never read as no asks.
`;

/** Refuse the command line before anything is read: the block, exit 1. */
function refuse(ctx: VerbContext, what: string, path: Sub): never {
  ctx.stderr.write(renderFailureBlock({ slug: "gate-usage", what, fix: `usage: ${line(path)}`, docs: "docs/ERRORS.md#gate-usage" }, ctx.erisDir));
  throw new CliExit(1);
}

function required(ctx: VerbContext, path: "gate record" | "gate skip" | "gate check", missing: readonly string[]): void {
  if (missing.length > 0) refuse(ctx, `${path}: missing ${missing.join(", ")}`, path);
}

/** Everything a sub-verb shares: the context, the pulled tree (or null), and how to reach the store. */
interface Verb {
  readonly ctx: VerbContext;
  readonly deps: GateDeps;
  readonly cwd: string;
  readonly home: string;
  readonly g: Git;
  readonly now: Date;
  readonly pulled: PulledTree | null;
  readonly endpoint: () => Promise<GatesEndpoint>;
  readonly retry: (delaysMs: ReadonlyArray<number>, maxWaitMs: number, onRetry?: (waitMs: number, attempt: number) => void) => RetryOpts;
}

/** Fallback waits (ms) across 3 retries when a 429 on a write carries no `Retry-After`; at most 15 s each. */
const RECORD_RETRY_DELAYS_MS: ReadonlyArray<number> = [1000, 2000, 4000];
const RECORD_RETRY_MAX_WAIT_MS = 15_000;
/** Fallback waits (ms) across 5 retries of a receipt read: about 95 s; at most 60 s each. */
const CHECK_RATE_LIMIT_DELAYS_MS: ReadonlyArray<number> = [5000, 10_000, 20_000, 30_000, 30_000];
const CHECK_RATE_LIMIT_MAX_WAIT_MS = 60_000;

async function verbFor(ctx: VerbContext, defaults: GateDefaults, deps: GateDeps): Promise<Verb> {
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.home ?? ctx.env.HOME ?? homedir();
  let pulled: PulledTree | null = null;
  if (defaults.pulled !== undefined) {
    const p = await defaults.pulled(ctx);
    if (!p.ok) stop(p.failure);
    pulled = p.value;
  }
  let ep: GatesEndpoint | undefined;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const jitter = deps.jitter ?? Math.random;
  return {
    ctx,
    deps,
    cwd,
    home,
    g: liveGit(ctx.env),
    now: (deps.now ?? (() => new Date()))(),
    pulled,
    endpoint: async () =>
      (ep ??= await storeEndpoint({
        home,
        env: ctx.env,
        cwd,
        fetch: deps.fetch,
        policySha: pulled?.bundleSha,
        onStale: (live) =>
          ctx.stderr.write(`WARN this machine's copy of the org's policy is not the live one${live !== null ? ` (live bundle ${live})` : ""}: run 'eris doctrine pull'\n`),
      })),
    retry: (delaysMs, maxWaitMs, onRetry) => ({ delaysMs, maxWaitMs, sleep, jitter, onRetry }),
  };
}

const writeRun = async (v: Verb, g = v.g): Promise<WriteRun> => ({ ep: await v.endpoint(), g, cwd: v.cwd, now: v.now, retry: v.retry(RECORD_RETRY_DELAYS_MS, RECORD_RETRY_MAX_WAIT_MS) });

function verdictOf(raw: string): GateVerdict {
  return (GATE_VERDICTS as readonly string[]).includes(raw) ? (raw as GateVerdict) : usage(`--verdict ${raw}: not PASS, AMENDED or BLOCKING`, "Pass --verdict PASS|AMENDED|BLOCKING.");
}

function impactOf(raw: string | undefined): GateUserImpact | undefined {
  if (raw === undefined) return undefined;
  return (GATE_USER_IMPACTS as readonly string[]).includes(raw) ? (raw as GateUserImpact) : usage(`--impact ${raw}: not a user-impact class`, "Pass --impact U0, U1, U2 or U3.");
}

const FILE_EVIDENCE = ["log", "test-run", "e2e", "screenshot", "video"] as const;

function copyWarn(v: Verb, artifact: string, res: Awaited<ReturnType<typeof recordGate>>): void {
  if (res.copied === "not-text") v.ctx.stderr.write(`WARN ${artifact}: no copy carried: not UTF-8 text (or binary), so the secret scan cannot read it; check needs the live file\n`);
  if (res.copied === "secret") v.ctx.stderr.write(`WARN ${artifact}: no copy carried: the secret scan matched ${res.secretRules.join(", ")}; check needs the live file\n`);
  if (res.copied === "too-large") v.ctx.stderr.write(`WARN ${artifact}: no copy carried (encoded past ${COPY_MAX_BYTES} bytes); check needs the live file\n`);
}

const storedNote = (sha: string | undefined) => (sha !== undefined ? `, stored record ${sha.slice(0, 12)}` : "");

async function runRecord(args: string[], ctx: VerbContext, defaults: GateDefaults, deps: GateDeps): Promise<number> {
  const a = readArgs(ROWS, "gate record", args, ctx, { help: RECORD_USAGE });
  if (a === null) return 0;
  const [gate = ""] = a.pos;
  const fl = a.flags;
  required(ctx, "gate record", [
    ...(gate === "" ? ["<gate>"] : []),
    ...(fl["--issue"] === undefined ? ["--issue"] : []),
    ...(fl["--verdict"] === undefined ? ["--verdict"] : []),
    ...(fl["--artifact"] === undefined ? ["--artifact"] : []),
  ]);
  const v = await verbFor(ctx, defaults, deps);
  const verdict = verdictOf(fl["--verdict"]!);
  if (verdict === "SKIPPED") usage("gate record: --verdict SKIPPED is not recorded here", `A skip names its grant: ${line("gate skip")}`);
  const who = await resolveActor({ flag: fl["--actor"], g: v.g, cwd: v.cwd });
  const evidence: EvidenceInput[] = [
    ...(fl["--evidence"] ?? []).map((content): EvidenceInput => ({ kind: "text", content })),
    ...FILE_EVIDENCE.flatMap((kind) => (fl[`--${kind}`] ?? []).map((path): EvidenceInput => ({ kind, path }))),
  ];
  const res = await recordGate(await writeRun(v), {
    gate,
    issue: fl["--issue"]!,
    verdict,
    artifact: fl["--artifact"]!,
    rubrics: fl["--rubric"] ?? [],
    doctrine: fl["--doctrine"] ?? v.pulled?.doctrineFile,
    impact: impactOf(fl["--impact"]),
    authorized: fl["--authorized"],
    evidence,
    actor: who.actor,
    actorInfo: who.actorInfo,
  });
  ctx.stdout.write(`${res.commentId}\n`);
  copyWarn(v, fl["--artifact"]!, res);
  ctx.stderr.write(`INFO ✓ recorded ${res.receipt.gate} ${res.receipt.verdict} on ${res.receipt.issue} (artifact sha256 ${res.receipt.artifact.sha256.slice(0, 12)}${storedNote(res.recordSha256)})\n`);
  return 0;
}

async function runSkip(args: string[], ctx: VerbContext, defaults: GateDefaults, deps: GateDeps): Promise<number> {
  const a = readArgs(ROWS, "gate skip", args, ctx, { help: SKIP_USAGE });
  if (a === null) return 0;
  const [gate = ""] = a.pos;
  const fl = a.flags;
  required(ctx, "gate skip", [...(gate === "" ? ["<gate>"] : []), ...(["--issue", "--reason", "--artifact"] as const).filter((k) => fl[k] === undefined)]);
  const v = await verbFor(ctx, defaults, deps);
  const who = await resolveActor({ flag: fl["--actor"], g: v.g, cwd: v.cwd });
  const res = await skipGate(await writeRun(v), {
    gate,
    issue: fl["--issue"]!,
    reason: fl["--reason"]!,
    authorized: fl["--authorized"],
    artifact: fl["--artifact"]!,
    doctrine: fl["--doctrine"] ?? v.pulled?.doctrineFile,
    impact: impactOf(fl["--impact"]),
    actor: who.actor,
    actorInfo: who.actorInfo,
  });
  ctx.stdout.write(`${res.commentId}\n`);
  ctx.stderr.write(`INFO ✓ recorded ${res.receipt.gate} SKIPPED on ${res.receipt.issue} (authorized: ${res.receipt.authorized})\n`);
  return 0;
}

/** A profile by name, or `gate-profile-unknown` naming the profiles there are. */
function profileGates(profiles: Readonly<Record<string, { readonly require: readonly string[]; readonly forbid: readonly string[] }>>, name: string) {
  const profile = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
  return profile ?? usage(`--profile ${name}: no such profile`, `Name one of: ${Object.keys(profiles).sort().join(", ") || "(none)"}.`, "gate-profile-unknown");
}

async function runCheck(args: string[], ctx: VerbContext, defaults: GateDefaults, deps: GateDeps): Promise<number> {
  const a = readArgs(ROWS, "gate check", args, ctx, { help: CHECK_USAGE });
  if (a === null) return 0;
  const fl = a.flags;
  required(ctx, "gate check", [...(fl["--issue"] === undefined ? ["--issue"] : []), ...(fl["--gates"] === undefined && fl["--profile"] === undefined ? ["--gates or --profile"] : [])]);
  if (fl["--gates"] !== undefined && fl["--profile"] !== undefined) refuse(ctx, "gate check: --gates and --profile are exclusive", "gate check");
  if ((fl["--burden"] === undefined) !== (fl["--base"] === undefined)) refuse(ctx, "gate check: --burden and --base go together", "gate check");
  const prFlag = fl["--pr"];
  if (prFlag !== undefined && !/^[1-9][0-9]{0,9}$/.test(prFlag)) refuse(ctx, `gate check: --pr takes a pull request number, got '${prFlag}'`, "gate check");
  const v = await verbFor(ctx, defaults, deps);
  const list = (raw: string | undefined) => (raw ?? "").split(",").map((x) => x.trim()).filter((x) => x !== "");
  const profile = fl["--profile"];
  let chosen = { require: list(fl["--gates"]) as readonly string[], forbid: [] as readonly string[] };
  if (profile !== undefined) {
    const profiles = readProfiles(fl["--profiles"] ?? v.pulled?.profilesFile);
    if (!profiles.ok) stop(profiles.failure);
    chosen = profileGates(profiles.value, profile);
  }
  const g = memoReads(v.g);
  const burdenFlag = fl["--burden"];
  const base = fl["--base"];
  const burden = burdenFlag === undefined || base === undefined ? undefined : { rubric: readBurdenRubric(burdenFlag), crossing: () => discoverPathsSurfaces(g, v.cwd, base) };
  const doctrineFile = fl["--doctrine"] ?? v.pulled?.doctrineFile;
  const ladderFile = fl["--ladder"] !== undefined ? resolve(v.cwd, fl["--ladder"]) : defaults.ladderFile;
  const doctrineRead = (file: string) => () => {
    const read = readDoctrineFile(file);
    if (!read.ok) stop({ ...read.failure, fix: "Check the file's permissions, or pass --doctrine <path>." });
    return read.value;
  };
  const ep = await v.endpoint();
  const delays = CHECK_RATE_LIMIT_DELAYS_MS;
  await checkGates({
    ep,
    issue: fl["--issue"]!,
    gates: chosen.require,
    forbid: chosen.forbid,
    cwd: v.cwd,
    g,
    out: (l) => ctx.stdout.write(`${l}\n`),
    warn: (l) => ctx.stderr.write(`${l}\n`),
    expect: list(fl["--expect"]),
    expectDelaysMs: deps.expectDelaysMs,
    sleep: deps.sleep ?? ((ms: number) => Bun.sleep(ms)),
    readRetry: v.retry(delays, CHECK_RATE_LIMIT_MAX_WAIT_MS, (waitMs, attempt) =>
      ctx.stderr.write(`WARN Linear rate-limited the receipt read; retry ${attempt}/${delays.length} in ${Math.round(waitMs / 1000)}s\n`),
    ),
    writeRetry: v.retry(RECORD_RETRY_DELAYS_MS, RECORD_RETRY_MAX_WAIT_MS),
    burden,
    ...(doctrineFile !== undefined ? { doctrine: { file: doctrineFile, read: doctrineRead(doctrineFile) } } : {}),
    ladder: { read: () => (ladderFile === undefined ? null : readLadder(ladderFile)) },
    applyModes: profile !== undefined,
    ...(fl["--dry-run"] === true ? { readOnly: true as const } : {}),
    now: v.now,
    asks: { ...(prFlag !== undefined ? { pr: Number(prFlag) } : {}), json: fl["--asks"] === true },
  });
  return 0;
}

/** The `eris gate` group: dispatch, then one place that renders a failure. */
export function gateHandler(defaults: GateDefaults = {}, deps: GateDeps = {}): VerbHandler {
  return async (args, ctx) => {
    const g = groupArgs(ROWS, "gate", args);
    if (g.kind === "bare" || g.kind === "help") {
      ctx.stdout.write(USAGE);
      return 0;
    }
    if (g.kind === "unknown") {
      ctx.stderr.write(`ERROR Unknown gate command: ${g.sub}\n`);
      return 1;
    }
    try {
      if (g.sub === "record") return await runRecord(g.rest, ctx, defaults, deps);
      if (g.sub === "skip") return await runSkip(g.rest, ctx, defaults, deps);
      if (g.sub === "ci") return await (await import("./ci-verb")).runCi(g.rest, ctx, deps);
      return await runCheck(g.rest, ctx, defaults, deps);
    } catch (e) {
      if (!(e instanceof GateFailure)) throw e;
      const f: ContractFailure = e.failure;
      ctx.stderr.write(renderFailureBlock({ slug: f.slug, what: f.what, fix: f.fix, docs: f.docs }, ctx.erisDir));
      return f.exit;
    }
  };
}
