/**
 * classify.ts — `eris socrates classify`, loaded only when `eris socrates
 * classify` dispatches (./submit.ts routes the group).
 *
 * Scores one candidate's enum answers locally with the current rubric and
 * prints the verdict. A rejection says which gate fired and why, and carries
 * one typed HAL override link for that gate in `meta._links.override`.
 *
 * Invariants:
 *   - Nothing leaves the machine: no request, no yak. The link's href is the
 *     endpoint's classify route, which takes the same request with the
 *     override added; following it locally is `--override <gate>=<reason>`.
 *   - The verdict is `score`'s, a pure function of the answers and the
 *     statement's features, so the same input always prints the same output.
 *   - The candidate is the contract's `SocratesCandidate`, the answers are the
 *     rubric's own enums (`answersSchema`), and each override is the
 *     contract's `SocratesOverride` (a one-line reason). Input that fails any
 *     of them is refused before scoring.
 *   - An override names a reject-routed gate that fires on these answers, at
 *     most once, and bypasses only that gate. A reroute (a practice, an
 *     inferred premise) is not a rejection and offers no override.
 *   - stdout is the verdict and nothing else; the JSON record is parsed
 *     through `ClassifyReport` before it is written.
 *   - A `prd` or `conflict` candidate is never scored: it files as one review
 *     issue, so its verdict is its kind once socrates-core's `issueEntryOf`
 *     accepts the statement, and it takes no answers and no overrides.
 */

import { homedir } from "node:os";
import { answersSchema, type Answers, CURRENT_RUBRIC, extractFeatures, type Features, type GateId, gateFiring, issueEntryOf, type RejectGateId, rubricFor, score, type Verdict } from "eris/socrates-core";
import { z } from "zod";
import { readArgs, readYaksFileConfig, resolveUrl, type VerbContext } from "../../src/cli/plugin";
import plugin from "./index";
import { SocratesCandidate } from "./socrates-contract.v1";
import { SOCRATES_ROUTES, SocratesOverride, SocratesOverrideLink } from "./socrates-contract.v1.verbs";
import { fail, printable } from "./submit";

export const CLASSIFY_USAGE = `Usage: eris socrates classify --title <text> --statement <text> --source <url> [--kind <kind>] [--project <name>]
                              --answer <question>=<answer>... [--override <gate>=<reason>]...
       eris socrates classify --request <json>

Score one candidate's rubric answers locally (${CURRENT_RUBRIC.version}) and print the verdict:
load-bearing, not-load-bearing, rejected, rerouted (to a key assumption) or
practice (to the Practices doc). A --kind prd or conflict candidate is not
scored: its statement is checked against the grammar below and the verdict is
prd or conflict, one review issue. Nothing is sent. The same answers always give
the same verdict. --output json prints {verdict, rubric_version, score?,
threshold?, breakdown?, gate?, answer?, feature?, route?, reason?, overrides,
meta: {_links: {override?}}}.

A rejection names the gate, the answer or statement wording that fired it, and
why, plus an override link for that gate. An override needs a one-line reason
and bypasses only the gate it names.

  --title, --statement, --source, --kind, --project
                       the candidate, as 'eris socrates submit' takes it
  --answer <question>=<answer>
                       repeatable, one per rubric question:
${Object.entries(CURRENT_RUBRIC.questions)
  .map(([id, q]) => `                         ${id}: ${q.answers.join(" | ")}`)
  .join("\n")}
  --override <gate>=<reason>
                       repeatable: bypass this rejecting gate, with a one-line
                       reason (<= 200 chars). Files no yak.
  --request <json>     instead of the flags above: {candidate, answers,
                       overrides?, rubric_version?}

A prd statement (the PRD is --title linked to --source), one line each:
  Decisions: \`ACME-K1\`–\`ACME-K57\`        the range the PRD locked
  Confirmed by: <name>
  Decisions that touch other projects:     optional, then one per line:
  - \`ACME-K4\`: [Project](https://...)

A conflict statement:
  <summary>

  Authoritative sites:                     two or more, one per line:
  - [Label](https://...)
  - \`ACME-K11\`, \`ACME-K12\` in [Doc](https://...)

  Proposed resolution:                     optional, then its text
`;

type Rubric = typeof CURRENT_RUBRIC;
type Override = z.infer<typeof SocratesOverride>;

const RubricVersion = z.string().regex(/^rubric@v[1-9][0-9]*$/);

/** The JSON record this verb prints. */
const ClassifyReport = z
  .object({
    verdict: z.enum(["load-bearing", "not-load-bearing", "rejected", "rerouted", "practice", "prd", "conflict"]),
    rubric_version: RubricVersion,
    score: z.number().optional(),
    threshold: z.number().optional(),
    breakdown: z.record(z.string(), z.number()).optional(),
    gate: z.string().optional(),
    answer: z.string().optional(),
    feature: z.string().optional(),
    route: z.enum(["key-assumption", "practices-doc", "review-issue"]).optional(),
    reason: z.string().optional(),
    overrides: z.array(SocratesOverride),
    meta: z.object({ _links: z.object({ override: z.array(SocratesOverrideLink).min(1).optional() }) }),
  })
  .strict();
type ClassifyReport = z.infer<typeof ClassifyReport>;

interface ClassifyInput {
  readonly rubricVersion: unknown;
  readonly candidate: unknown;
  readonly answers: unknown;
  readonly overrides: unknown;
}

function issues(error: z.ZodError, root: string): string {
  return error.issues.map((i) => `${[root, ...i.path].join(".")}: ${i.message}`).join("; ");
}

/** `<key>=<value>` pairs into a record; a pair without `=`, or a repeated key, is refused. */
function pairs(ctx: VerbContext, flag: string, words: readonly string[], slug: "socrates-answers-invalid" | "socrates-override-invalid", fix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const w of words) {
    const at = w.indexOf("=");
    if (at <= 0) fail(ctx, slug, `${flag} ${printable(w)} is not <key>=<value>`, fix);
    const key = w.slice(0, at);
    if (Object.hasOwn(out, key)) fail(ctx, slug, `${flag} names ${printable(key)} twice`, fix);
    out[key] = w.slice(at + 1);
  }
  return out;
}

function fromFlags(ctx: VerbContext, flags: Record<string, string | readonly string[] | undefined>): ClassifyInput {
  const { "--title": title, "--statement": statement, "--source": source, "--kind": kind, "--project": project } = flags as Record<string, string | undefined>;
  const missing = (["--title", "--statement", "--source"] as const).filter((f) => flags[f] === undefined);
  if (missing.length > 0) fail(ctx, "socrates-flag-required", `missing ${missing.join(", ")}`, "eris socrates classify --title <text> --statement <text> --source <url> --answer <question>=<answer>...");
  const answerFix = "pass one --answer <question>=<answer> per rubric question; run 'eris socrates classify --help' for the answers";
  const overrides = Object.entries(pairs(ctx, "--override", flags["--override"] as readonly string[], "socrates-override-invalid", "use --override <gate>=<one-line reason>")).map(([gate, reason]) => ({ gate, reason }));
  return {
    rubricVersion: CURRENT_RUBRIC.version,
    candidate: { kind: kind ?? "decision", title, statement, source, ...(project !== undefined ? { project } : {}) },
    answers: pairs(ctx, "--answer", flags["--answer"] as readonly string[], "socrates-answers-invalid", answerFix),
    overrides,
  };
}

function fromRequest(ctx: VerbContext, text: string): ClassifyInput {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail(ctx, "socrates-candidate-invalid", "--request is not JSON", "pass one JSON object: {candidate, answers, overrides?, rubric_version?}");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(ctx, "socrates-candidate-invalid", "--request is not a JSON object", "pass one JSON object: {candidate, answers, overrides?, rubric_version?}");
  const r = raw as Record<string, unknown>;
  return { rubricVersion: r.rubric_version ?? CURRENT_RUBRIC.version, candidate: r.candidate, answers: r.answers, overrides: r.overrides ?? [] };
}

function rubricOf(ctx: VerbContext, version: unknown): Rubric {
  const parsed = RubricVersion.safeParse(version);
  const rubric = parsed.success ? rubricFor(parsed.data as Rubric["version"]) : undefined;
  if (rubric === undefined) fail(ctx, "socrates-candidate-invalid", `rubric_version ${printable(String(version))} is not one this build scores`, `use ${CURRENT_RUBRIC.version}, or leave rubric_version out`);
  return rubric as unknown as Rubric;
}

function answersOf(ctx: VerbContext, rubric: Rubric, raw: unknown): Answers<Rubric> {
  const parsed = answersSchema(rubric).safeParse(raw);
  if (parsed.success) return parsed.data;
  const expected = Object.entries(rubric.questions)
    .map(([id, q]) => `${id}=${q.answers.join("|")}`)
    .join("\n");
  fail(ctx, "socrates-answers-invalid", `the answers do not fit ${rubric.version} (${printable(issues(parsed.error, "answers"))})`, `answer every question with one of its answers:\n${expected}`);
}

/** Each override is a one-line reason on a reject-routed gate that fires here, once. */
function overridesOf(ctx: VerbContext, rubric: Rubric, raw: unknown, answers: Answers<Rubric>, features: Features<Rubric>): Override[] {
  const fix = "override only the gate a rejection named, as --override <gate>=<one-line reason>";
  const parsed = z.array(SocratesOverride).safeParse(raw);
  if (!parsed.success) fail(ctx, "socrates-override-invalid", `the override is not a gate with a one-line reason (${printable(issues(parsed.error, "overrides"))})`, fix);
  const seen = new Set<string>();
  for (const { gate } of parsed.data) {
    const q = (rubric.questions as Readonly<Record<string, { kind: string; route?: string }>>)[gate];
    if (q === undefined || q.kind !== "gate") fail(ctx, "socrates-override-invalid", `${gate} is not a gate of ${rubric.version}`, fix);
    if (q.route !== "reject") fail(ctx, "socrates-override-invalid", `${gate} routes the candidate (${q.route}) rather than rejecting it, so it cannot be overridden`, "answer the gate as it is; a reroute is not a rejection");
    if (seen.has(gate)) fail(ctx, "socrates-override-invalid", `${gate} is overridden twice`, fix);
    if (gateFiring(rubric, gate as GateId<Rubric>, answers, features) === undefined) fail(ctx, "socrates-override-invalid", `${gate} does not reject these answers, so there is nothing to override`, fix);
    seen.add(gate);
  }
  return parsed.data;
}

/** Why a gate fired: its feature's description when wording fired it, else its question and the answer. */
function why(rubric: Rubric, gate: string, answer: string, feature: string | undefined): string {
  if (feature !== undefined) return `the statement fired ${feature}: ${(rubric.features as Readonly<Record<string, { description: string }>>)[feature]!.description}`;
  return `${(rubric.questions as Readonly<Record<string, { prompt: string }>>)[gate]!.prompt} Answered ${answer}.`;
}

function report(rubric: Rubric, verdict: Verdict<Rubric>, overrides: Override[], href: string): ClassifyReport {
  const base = { rubric_version: verdict.rubric, overrides };
  switch (verdict.kind) {
    case "load-bearing":
    case "not-load-bearing":
      return { verdict: verdict.kind, ...base, score: verdict.score, threshold: verdict.threshold, breakdown: { ...verdict.breakdown } as Record<string, number>, meta: { _links: {} } };
    case "rejected": {
      const gate: RejectGateId<Rubric> = verdict.gate as RejectGateId<Rubric>;
      const link = { href, method: "POST" as const, gate, title: `eris socrates classify … --override ${gate}=<one-line reason>` };
      return { verdict: "rejected", ...base, ...firing(rubric, verdict), meta: { _links: { override: [link] } } };
    }
    case "rerouted":
      return { verdict: "rerouted", ...base, ...firing(rubric, verdict), route: verdict.to, meta: { _links: {} } };
    case "practice":
      return { verdict: "practice", ...base, ...firing(rubric, verdict), route: verdict.to, meta: { _links: {} } };
  }
}

function firing(rubric: Rubric, v: { gate: string; answer: string; feature?: string }) {
  return { gate: v.gate, answer: v.answer, ...(v.feature !== undefined ? { feature: v.feature } : {}), reason: why(rubric, v.gate, v.answer, v.feature) };
}

function text(r: ClassifyReport): string {
  const lines: string[] = [];
  if (r.verdict === "prd" || r.verdict === "conflict") lines.push(`${r.verdict}: one review issue (${r.rubric_version}) -> ${r.route}`, `  why: ${r.reason}`);
  else if (r.score !== undefined) lines.push(`${r.verdict}: score ${r.score} of ${r.threshold} (${r.rubric_version})`);
  else lines.push(`${r.verdict}: ${r.gate} (${r.rubric_version})${r.route !== undefined ? ` -> ${r.route}` : ""}`, `  why: ${r.reason}`);
  for (const o of r.overrides) lines.push(`  overrode ${o.gate}: ${printable(o.reason)}`);
  for (const l of r.meta._links.override ?? []) lines.push(`  override: re-run with --override ${l.gate}=<one-line reason> (or ${l.method} ${l.href} with overrides)`);
  return `${lines.join("\n")}\n`;
}

/** A `prd` or `conflict` candidate: the statement must file, and nothing is scored or overridden. */
function issueVerdict(ctx: VerbContext, rubric: Rubric, candidate: { kind: "prd" | "conflict"; title: string; statement: string; source: string }, input: ClassifyInput): number {
  const given = (v: unknown) => v !== undefined && (Array.isArray(v) ? v.length > 0 : typeof v !== "object" || v === null || Object.keys(v).length > 0);
  if (given(input.answers)) fail(ctx, "socrates-answers-invalid", `a ${candidate.kind} entry is not scored, so it takes no rubric answers`, "drop --answer");
  if (given(input.overrides)) fail(ctx, "socrates-override-invalid", `a ${candidate.kind} entry has no gate to override`, "drop --override");
  const entry = issueEntryOf(candidate);
  if (!entry.ok) fail(ctx, "socrates-candidate-invalid", `the ${candidate.kind} statement cannot be filed (${printable(entry.reason)})`, "run 'eris socrates classify --help' for the statement grammar");
  const out = ClassifyReport.parse({
    verdict: candidate.kind,
    rubric_version: rubric.version,
    route: "review-issue",
    reason: `files as one review issue: ${entry.value.title}`,
    overrides: [],
    meta: { _links: {} },
  });
  ctx.stdout.write(ctx.format === "json" ? `${JSON.stringify(out)}\n` : text(out));
  return 0;
}

export async function runClassify(args: string[], ctx: VerbContext): Promise<number> {
  const a = readArgs(plugin.rows, "socrates classify", args, ctx, { help: CLASSIFY_USAGE });
  if (a === null) return 0;
  const { "--request": request, ...rest } = a.flags;
  let input: ClassifyInput;
  if (request !== undefined) {
    const extra = Object.entries(rest).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== undefined)).map(([f]) => f);
    if (extra.length > 0) fail(ctx, "socrates-flag-required", `--request carries the whole candidate, so ${extra.join(", ")} cannot be given with it`, "put the candidate, answers and overrides in --request, or drop --request");
    input = fromRequest(ctx, request);
  } else {
    input = fromFlags(ctx, rest);
  }

  const rubric = rubricOf(ctx, input.rubricVersion);
  const candidate = SocratesCandidate.safeParse(input.candidate);
  if (!candidate.success) fail(ctx, "socrates-candidate-invalid", `the candidate does not match the contract (${printable(issues(candidate.error, "candidate"))})`, "run 'eris socrates classify --help' for each flag's bounds");
  const { kind } = candidate.data;
  if (kind === "prd" || kind === "conflict") return issueVerdict(ctx, rubric, { ...candidate.data, kind }, input);
  const answers = answersOf(ctx, rubric, input.answers);
  // No living-doc entries are read locally, so `already_recorded` fires only on its answer here; the server reclassifies.
  const features = extractFeatures(rubric, candidate.data.statement, { recorded: [] });
  const overrides = overridesOf(ctx, rubric, input.overrides, answers, features);

  const home = ctx.env.HOME ?? homedir();
  const file = await readYaksFileConfig(home);
  if ("reason" in file) fail(ctx, file.slug, file.reason, "fix or remove the file, then run 'eris login'");
  const href = `${resolveUrl(file.value, ctx.env).value.replace(/\/+$/, "")}${SOCRATES_ROUTES.classify.path}`;

  const verdict = score(rubric, answers, features, { bypass: overrides.map((o) => o.gate as GateId<Rubric>) });
  const out = ClassifyReport.parse(report(rubric, verdict, overrides, href));
  ctx.stdout.write(ctx.format === "json" ? `${JSON.stringify(out)}\n` : text(out));
  return 0;
}
