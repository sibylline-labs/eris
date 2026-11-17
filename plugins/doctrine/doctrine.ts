/**
 * doctrine.ts — `eris doctrine <command>`: the doctrine `policy:` contract's offline verbs.
 * `check` validates a doctrine file and prints each posture's parsed policy, `schema` prints the
 * contract as JSON Schema, `gates` prints the active posture's effective gate map, and `effect`
 * turns a before/after pair into one sentence per changed knob. None of them restates the shape
 * or the user-impact floor: they read it from eris/gates-contract (docs/DOCTRINE.md).
 */

import { readFileSync } from "node:fs";
import {
  activePosture,
  askRows,
  AskPolicy,
  CLOSE_EXPLAINS,
  citePosture,
  type ContractFailure,
  describe,
  effectiveGateMap,
  effectiveLifts,
  effectiveRequirements,
  effectsOfInput,
  explainOf,
  GATE_EXPLAINS,
  GateMode,
  invalidDoctrine,
  meaningsOf,
  policyHash,
  policyJsonSchema,
  readDoctrine,
  readDoctrineFile,
  readProfiles,
  Remediate,
  remediateRows,
  Requirement,
  Rung,
} from "eris/gates-contract";
import { CliExit, groupArgs, readArgs, renderFailureBlock, type VerbContext, type VerbHandler } from "../../src/cli/plugin";
import plugin, { type DoctrineDefaults, type DoctrineDefaultsSource } from "./index";

const ROWS = plugin.rows;

const USAGE = `Usage: eris doctrine <command>

The doctrine policy: contract. Each '## <slug>' posture in a doctrine.md may
carry a fenced \`\`\`yaml block with a policy: key.
No posture can lower the U2/U3 user-impact floor. See docs/DOCTRINE.md.

Commands:
  check [--file <path>]   Validate every posture's policy; print one line each
  schema                  Print the policy: contract as JSON Schema
  gates [--file <path>] [--explain]
                          Print the active posture's effective gate map
  effect                  Read {contract, before, after} on stdin; print each change as a sentence
`;

const CHECK_USAGE = `Usage: eris doctrine check [--file <path>] [--cite] [--output json]

Validate every posture's policy: block in the doctrine file (default: the
build's own doctrine file, when it names one; with neither, exits 3,
doctrine-file-missing). Text: one '<slug>\\t<policy|no-policy>' line per
posture, the active one marked '*'. With --cite: print the active posture's
citation '<Display name> (<slug>@<policy-hash>)'. JSON: { active, policy_hash,
citation, postures: [{ slug, name, line, section, policy, policy_sha256,
policy_hash, citation }] }. Any problem prints '<file>:<line>: <message>' lines
on stderr and exits 3 with nothing on stdout.
`;

const SCHEMA_USAGE = `Usage: eris doctrine schema

Print the policy: contract as a JSON Schema (draft 2020-12) document, generated
from the Schema at run time. Keys and enum values drive completion and
builders; the floor rules are under "x-eris-floor" and are enforced only by
'eris doctrine check'.
`;

const GATES_USAGE = `Usage: eris doctrine gates [--file <path>] [--profiles <file>] [--explain]

Print the active posture's effective gate map, one '<profile>\\t<gate>\\t<mode>'
line per gate of each work profile (the build's own profiles file when it
names one, else the built-in spine and deep; --profiles reads a YAML map of
profile to gate list instead). A gate the policy does not name is 'on'. Then
one '@user-impact\\t<class>\\t<req,...>' line per class that owes any
requirement: the user-impact floor plus the posture's policy.user_impact raise.
Then one '@lift\\t<door class>\\t<rung>' line per policy.lifts entry: the rung a
bleed-reducing fix is raised to before the posture's ceilings and the U3 cap.
Then, when the posture has a policy.remediate block, one
'@remediate\\t<key>\\t<value>' line per setting (on, loop, runtime
'<default>→<escalate>', max_rounds, scope), defaults filled in. Then one
'@ask\\t<key>\\t<value>' line per ask setting (two_way_timeout '<n>h' or none,
digest off|hourly|daily, session_budget), defaults filled, for every posture
with a policy: block.
Prints nothing when there is no doctrine file (no --file, and the build names
none, or the file does not exist) or the active posture has no policy: block,
since nothing is then skipped or deferred. A doctrine that does not parse
exits 3 (doctrine-policy-invalid).

With --explain, each row is followed by indented lines a newcomer can read:
the gate's explanation (what it does, what it guards against, what turning it
up or down costs) and the meaning of its mode; each @user-impact row by one
line per requirement, each @lift row by the rung's meaning. A gate the policy
Schema does not explain prints '(undocumented: ...)' instead.
`;

const EFFECT_USAGE = `Usage: eris doctrine effect [--profiles <file>] < {"contract": "policy"|"surfaces", "before": ..., "after": ...}

Read one JSON object on stdin, {"contract": "policy"|"surfaces", "before": <value|null>,
"after": <value|null>}, and print one plain-English sentence per knob whose
value differs, read from the Schema's own explanations:
  gates.plan-review: lite → on. Plans now get the full review before any code, adding about one review round.
"policy" values are a posture's policy: block and are compared as they take
effect (an unnamed gate is on; a class owes its floor), over --profiles' gates
(default the build's own profiles file, else the built-in spine and deep).
"surfaces" values are a decoded .claude/surfaces.yml, compared with each
surface's defaults filled in. null is the all-defaults value. Nothing is
printed when nothing changes.

JSON (--output json): { effects: [{ path, knob, before, after, direction, sentence }] },
direction one of raise (stricter), lower (looser), change. A side that does not
decode exits 3 (doctrine-policy-invalid, gate-surfaces-invalid); stdin that is
not that object exits 2 (doctrine-usage).
`;

const INDENT = "    ";

/** `eris doctrine effect <usage>`, as its row declares it. */
const EFFECT_LINE = `eris doctrine effect ${ROWS["doctrine effect"].usage}`;

/** Write `f`'s block and end the command with its exit code. */
function stop(ctx: VerbContext, f: ContractFailure): never {
  ctx.stderr.write(renderFailureBlock({ slug: f.slug, what: f.what, fix: f.fix, docs: f.docs }, ctx.erisDir));
  throw new CliExit(f.exit);
}

function runCheck(args: string[], ctx: VerbContext, d: DoctrineDefaults): number {
  const a = readArgs(ROWS, "doctrine check", args, ctx, { help: CHECK_USAGE });
  if (a === null) return 0;
  const file = a.flags["--file"] ?? d.doctrineFile;
  if (file === undefined) {
    stop(ctx, {
      slug: "doctrine-file-missing",
      what: "eris doctrine check: no --file names a doctrine file, and this build names none",
      fix: "Pass --file <path>.",
      docs: "docs/ERRORS.md#doctrine-file-missing",
      exit: 3,
    });
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    stop(ctx, { slug: "doctrine-file-missing", what: `${file}: cannot read the doctrine file`, fix: "Pass --file <path> naming a readable doctrine file.", docs: "docs/ERRORS.md#doctrine-file-missing", exit: 3 });
  }
  const read = readDoctrine(text);
  if (read.problems.length > 0) {
    for (const p of read.problems) ctx.stderr.write(`${file}:${p.line}: ${p.message}\n`);
    stop(ctx, {
      slug: "doctrine-policy-invalid",
      what: `${file}: ${read.problems.length} doctrine problem(s), listed above`,
      fix:
        "Fix each line named above; a U2/U3 requirement list must keep the floor, final-gates / user-impact are never off,\n" +
        "and lifts names only U0/U1 classes (never all, U2 or U3) at R1 or R2.",
      docs: "docs/ERRORS.md#doctrine-policy-invalid",
      exit: 3,
    });
  }
  const active = activePosture(read);
  if (a.flags["--cite"] === true) {
    if (active !== undefined) ctx.stdout.write(`${citePosture(active)}\n`);
    return 0;
  }
  if (ctx.format === "json") {
    const postures = read.postures.map((p) => ({ ...p, policy_hash: policyHash(p), citation: citePosture(p) }));
    ctx.stdout.write(
      `${JSON.stringify({
        active: read.active,
        policy_hash: active !== undefined ? policyHash(active) : null,
        citation: active !== undefined ? citePosture(active) : null,
        postures,
      })}\n`,
    );
    return 0;
  }
  ctx.stdout.write(read.postures.map((p) => `${p.slug === read.active ? "*" : " "}${p.slug}\t${p.policy === null ? "no-policy" : "policy"}\n`).join(""));
  return 0;
}

function runSchema(args: string[], ctx: VerbContext): number {
  const a = readArgs(ROWS, "doctrine schema", args, ctx, { help: SCHEMA_USAGE });
  if (a === null) return 0;
  ctx.stdout.write(`${JSON.stringify(policyJsonSchema(), null, 2)}\n`);
  return 0;
}

/** The explanation lines under one `doctrine gates --explain` row. */
function gateExplanation(gate: string, mode: string): string[] {
  const k = GATE_EXPLAINS[gate] ?? CLOSE_EXPLAINS[gate];
  const meaning = meaningsOf(GateMode.ast)?.values[mode];
  return [k !== undefined ? describe(k) : `(undocumented: the policy Schema has no explanation for gate ${gate})`, `${mode}: ${meaning ?? "(undocumented mode)"}`].map(
    (l) => `${INDENT}${l}\n`,
  );
}

type Fields = Readonly<Record<string, { readonly ast: Parameters<typeof explainOf>[0] } | undefined>>;

/** The summary a struct field's explanation gives, or `(undocumented)`. */
function fieldSummary(fields: Fields, key: string): string {
  const field = fields[key];
  return (field !== undefined ? explainOf(field.ast)?.summary : undefined) ?? "(undocumented)";
}

function runGates(args: string[], ctx: VerbContext, d: DoctrineDefaults): number {
  const a = readArgs(ROWS, "doctrine gates", args, ctx, { help: GATES_USAGE });
  if (a === null) return 0;
  const file = a.flags["--file"] ?? d.doctrineFile;
  if (file === undefined) return 0;
  const read = readDoctrineFile(file);
  if (!read.ok) stop(ctx, read.failure);
  if (read.value === null) return 0;
  const invalid = invalidDoctrine(file, read.value);
  if (invalid !== null) stop(ctx, invalid);
  const policy = activePosture(read.value)?.policy;
  if (policy === undefined || policy === null) return 0;
  const profiles = readProfiles(a.flags["--profiles"] ?? d.profilesFile);
  if (!profiles.ok) stop(ctx, profiles.failure);
  // One write: a reader that closes the pipe early (`| head`) then ends a single write, not a loop of them.
  const out: string[] = [];
  const explain = (lines: string[]) => {
    if (a.flags["--explain"] === true) out.push(...lines);
  };
  for (const row of effectiveGateMap(profiles.value, policy)) {
    out.push(`${row.profile}\t${row.gate}\t${row.mode}\n`);
    explain(gateExplanation(row.gate, row.mode));
  }
  const reqMeaning = meaningsOf(Requirement.ast)?.values ?? {};
  for (const row of effectiveRequirements(policy)) {
    out.push(`@user-impact\t${row.cls}\t${row.reqs.join(",")}\n`);
    explain(row.reqs.map((r) => `${INDENT}${r}: ${reqMeaning[r] ?? "(undocumented)"}\n`));
  }
  const rungMeaning = meaningsOf(Rung.ast)?.values ?? {};
  for (const row of effectiveLifts(policy)) {
    out.push(`@lift\t${row.door}\t${row.rung}\n`);
    explain([`${INDENT}${row.rung}: ${rungMeaning[row.rung] ?? "(undocumented)"}\n`]);
  }
  for (const [key, value] of remediateRows(policy)) {
    out.push(`@remediate\t${key}\t${value}\n`);
    explain([`${INDENT}${fieldSummary(Remediate.fields as Fields, key)}\n`]);
  }
  for (const [key, value] of askRows(policy)) {
    out.push(`@ask\t${key}\t${value}\n`);
    explain([`${INDENT}${fieldSummary(AskPolicy.fields as Fields, key)}\n`]);
  }
  ctx.stdout.write(out.join(""));
  return 0;
}

function runEffect(args: string[], ctx: VerbContext, d: DoctrineDefaults, stdin: () => string): number {
  const a = readArgs(ROWS, "doctrine effect", args, ctx, { help: EFFECT_USAGE });
  if (a === null) return 0;
  let raw: string;
  try {
    raw = stdin();
  } catch {
    stop(ctx, { slug: "doctrine-usage", what: "doctrine effect: stdin could not be read", fix: `usage: ${EFFECT_LINE}`, docs: "docs/DOCTRINE.md#effect", exit: 2 });
  }
  const profiles = readProfiles(a.flags["--profiles"] ?? d.profilesFile);
  if (!profiles.ok) stop(ctx, profiles.failure);
  const out = effectsOfInput(raw, profiles.value, `Pipe one JSON object: ${EFFECT_LINE}`);
  if (!out.ok) stop(ctx, out.failure);
  if (ctx.format === "json") ctx.stdout.write(`${JSON.stringify({ effects: out.value })}\n`);
  else ctx.stdout.write(out.value.map((e) => `${e.sentence}\n`).join(""));
  return 0;
}

/**
 * The `eris doctrine` handler, reading `defaults` when a verb's file flag is absent. `stdin` is
 * what `effect` reads (fd 0 when absent).
 */
export function doctrineHandler(defaults: DoctrineDefaultsSource = {}, stdin: () => string = () => readFileSync(0, "utf8")): VerbHandler {
  return async (args, ctx) => {
    const g = groupArgs(ROWS, "doctrine", args);
    if (g.kind === "bare" || g.kind === "help") {
      ctx.stdout.write(USAGE);
      return 0;
    }
    if (g.kind === "unknown") {
      ctx.stderr.write(
        renderFailureBlock(
          { slug: "doctrine-unknown-verb", what: `unknown doctrine command '${g.sub}'`, fix: "use one of: check, schema, gates, effect\nrun 'eris doctrine --help' for the command list" },
          ctx.erisDir,
        ),
      );
      throw new CliExit(1);
    }
    if (g.sub === "schema") return runSchema(g.rest, ctx);
    const d = typeof defaults === "function" ? await defaults(ctx) : defaults;
    if (g.sub === "check") return runCheck(g.rest, ctx, d);
    if (g.sub === "gates") return runGates(g.rest, ctx, d);
    return runEffect(g.rest, ctx, d, stdin);
  };
}

/** `eris doctrine` with no defaults: `check` needs `--file`, and the gate map uses the built-in profiles. */
export const runDoctrine: VerbHandler = doctrineHandler();
