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
 *   - The verdict is `scoreUnderPolicy`'s, a pure function of the answers, the
 *     statement's features and the policy, so the same input always prints the
 *     same output. The policy is the org's as `eris socrates submit` last
 *     cached it (for this rubric; else the rubric's defaults) merged with the
 *     repo's `eris.yaml` `socrates.policy` layer (./policy.ts). Reading the
 *     cache never fetches it.
 *   - The candidate is the contract's `SocratesCandidate`, the answers are the
 *     rubric's own enums (`answersSchema`), and each override is the
 *     contract's `SocratesOverride` (a one-line reason). Input that fails any
 *     of them is refused before scoring.
 *   - An override names a reject-routed gate the policy runs and that fires on
 *     these answers, at most once, and bypasses only that gate. A reroute (a practice, an
 *     inferred premise) is not a rejection and offers no override.
 *   - stdout is the verdict and nothing else; the JSON record is parsed
 *     through `ClassifyReport` before it is written.
 *   - A `prd` or `conflict` candidate is never scored: it files as one review
 *     issue, so its verdict is its kind once socrates-core's `issueEntryOf`
 *     accepts the statement, and it takes no answers and no overrides.
 *   - Every verdict carries `next`, the one step an agent takes after it
 *     (`nextStep`, exhaustive over the verdicts), so the published skills
 *     name no rubric logic of their own. The help states every question's
 *     prompt from the rubric itself, so an answer is never chosen blind.
 */

import { homedir } from "node:os";
import { CURRENT_RUBRIC, extractFeatures, issueEntryOf, type RejectGateId, rubricFor, scoreUnderPolicy, type Title, type Verdict } from "eris/socrates-core";
import { z } from "zod";
import { readArgs, readYaksFileConfig, resolveOrgSelection, resolveUrl, selectOrgConfig, type VerbContext } from "../../src/cli/plugin";
import { ANSWER_FIX, answersOf, checkCandidateStatement, checkCandidateTitle, issues, OVERRIDE_FIX, type Override, overridesOf, pairs, type Rubric } from "./answers";
import plugin from "./index";
import { type LocalPolicy, localPolicy, policyLine, readPolicyCache, readRepoPolicy } from "./policy";
import { SocratesCandidate, SocratesPolicyHash, SocratesRepoPolicy } from "./socrates-contract.v1";
import { SOCRATES_ROUTES, SocratesOverride, SocratesOverrideLink } from "./socrates-contract.v1.verbs";
import { fail, printable, type SocratesDeps } from "./client";

export const CLASSIFY_USAGE = `Usage: eris socrates classify --title <text> --statement <text> --source <url> [--kind <kind>] [--project <name>]
                              --answer <question>=<answer>... [--override <gate>=<reason>]...
       eris socrates classify --request <json>

Score one candidate's rubric answers locally (${CURRENT_RUBRIC.version}) and print the verdict:
load-bearing, not-load-bearing, rejected, rerouted (to a key assumption) or
practice (to the Practices doc). A --kind prd or conflict candidate is not
scored: its statement is checked against the grammar below and the verdict is
prd or conflict, one review issue. Nothing is sent. The same answers always give
the same verdict, and its last line, 'next:', says what to do with it: submit
it, submit it as a practice, or leave it unfiled. --output json prints {verdict,
rubric_version, score?, threshold?, breakdown?, gate?, answer?, feature?, route?,
reason?, overrides, policy_hash?, repo_policy?, next, meta: {_links: {override?}}}.

A scored verdict names the policy it was scored under: the org's, as 'eris
socrates submit' last cached it in ~/.eris/socrates-policy.json (policy_hash),
or the rubric's defaults (policy_hash null) when none is cached for this
rubric; plus the repo layer (repo_policy) when the nearest eris.yaml sets one.
That layer can only make the policy stricter, and anything else is refused:

  socrates:
    policy:
      threshold: 5            # at least the org's threshold
      gates:
        end_condition:
          enabled: true       # turn a hard gate on; never off
      auto_resolve: false     # never true

A rejection names the gate, the answer or statement wording that fired it, and
why, plus an override link for that gate. An override needs a one-line reason
and bypasses only the gate it names.

  --title <text>       required, single line <= 80 chars (<= 66 for --kind
                       prd); wrap file names, domains and dotted identifiers
                       in backticks so Linear does not autolink them
  --statement, --source, --kind, --project
                       the rest of the candidate, as 'eris socrates submit'
                       takes it (a decision or practice statement is a
                       single line; a prd or conflict statement is not)
  --answer <question>=<answer>
                       repeatable, one per rubric question; answer each from
                       what you observed:
${Object.entries(CURRENT_RUBRIC.questions)
  .map(([id, q]) => `                         ${id}: ${q.prompt}\n                           ${q.answers.join(" | ")}`)
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
  - \`<8 lowercase hex>\` in [Doc](https://...)   (a legacy entry hash)

  Proposed resolution:                     optional, then its text
`;

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
    policy_hash: SocratesPolicyHash.nullable().optional(),
    repo_policy: SocratesRepoPolicy.nullable().optional(),
    next: z.string().min(1),
    meta: z.object({ _links: z.object({ override: z.array(SocratesOverrideLink).min(1).optional() }) }),
  })
  .strict();
type ClassifyReport = z.infer<typeof ClassifyReport>;
type Unsteered = Omit<ClassifyReport, "next">;

const SAME = "with the same flags and answers";

/** The one step an agent takes after this verdict. A rejected or not-load-bearing candidate is not filed unless the user asked for it to be logged. */
function nextStep(r: Unsteered): string {
  switch (r.verdict) {
    case "load-bearing":
    case "rerouted":
      return `submit it: eris socrates submit ${SAME}`;
    case "practice":
      return `submit it as a practice: eris socrates submit --kind practice ${SAME}`;
    case "prd":
    case "conflict":
      return `submit it: eris socrates submit --kind ${r.verdict} with the same flags`;
    case "not-load-bearing":
      return "not filed: submit it only if your user asked for it to be logged";
    case "rejected":
      return `not filed: override ${r.gate ?? "the gate"} only when your user explicitly asked for this to be logged, quoting them as the reason`;
    default: {
      const unreachable: never = r.verdict;
      return unreachable;
    }
  }
}

const steered = (r: Unsteered): ClassifyReport => ClassifyReport.parse({ ...r, next: nextStep(r) });

interface ClassifyInput {
  readonly rubricVersion: unknown;
  readonly candidate: unknown;
  readonly answers: unknown;
  readonly overrides: unknown;
}

function fromFlags(ctx: VerbContext, flags: Record<string, string | readonly string[] | undefined>): ClassifyInput {
  const { "--title": title, "--statement": statement, "--source": source, "--kind": kind, "--project": project } = flags as Record<string, string | undefined>;
  const missing = (["--title", "--statement", "--source"] as const).filter((f) => flags[f] === undefined);
  if (missing.length > 0) fail(ctx, "socrates-flag-required", `missing ${missing.join(", ")}`, "eris socrates classify --title <text> --statement <text> --source <url> --answer <question>=<answer>...");
  const overrides = Object.entries(pairs(ctx, "--override", flags["--override"] as readonly string[], "socrates-override-invalid", OVERRIDE_FIX)).map(([gate, reason]) => ({ gate, reason }));
  return {
    rubricVersion: CURRENT_RUBRIC.version,
    candidate: { kind: kind ?? "decision", title, statement, source, ...(project !== undefined ? { project } : {}) },
    answers: pairs(ctx, "--answer", flags["--answer"] as readonly string[], "socrates-answers-invalid", ANSWER_FIX),
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

/** Why a gate fired: its feature's description when wording fired it, else its question and the answer. */
function why(rubric: Rubric, gate: string, answer: string, feature: string | undefined): string {
  if (feature !== undefined) return `the statement fired ${feature}: ${(rubric.features as Readonly<Record<string, { description: string }>>)[feature]!.description}`;
  return `${(rubric.questions as Readonly<Record<string, { prompt: string }>>)[gate]!.prompt} Answered ${answer}.`;
}

function report(rubric: Rubric, verdict: Verdict<Rubric>, overrides: Override[], local: LocalPolicy, href: string): Unsteered {
  const base = { rubric_version: verdict.rubric, overrides, policy_hash: local.policy_hash, repo_policy: local.repo_policy };
  switch (verdict.kind) {
    case "load-bearing":
    case "not-load-bearing":
      return { verdict: verdict.kind, ...base, score: verdict.score, threshold: verdict.threshold, breakdown: { ...verdict.breakdown } as Record<string, number>, meta: { _links: {} } };
    case "rejected": {
      const gate: RejectGateId<Rubric> = verdict.gate as RejectGateId<Rubric>;
      const body = local.repo_policy === null ? "" : " (the request carries repo_policy)";
      const link = { href, method: "POST" as const, gate, title: `eris socrates classify … --override ${gate}=<one-line reason>${body}` };
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
  if (r.policy_hash !== undefined && r.repo_policy !== undefined) lines.push(`  ${policyLine({ policy_hash: r.policy_hash, repo_policy: r.repo_policy })}`);
  for (const o of r.overrides) lines.push(`  overrode ${o.gate}: ${printable(o.reason)}`);
  const carries = r.repo_policy ? "overrides and repo_policy" : "overrides";
  for (const l of r.meta._links.override ?? []) lines.push(`  override: re-run with --override ${l.gate}=<one-line reason> (or ${l.method} ${l.href} with ${carries})`);
  lines.push(`  next: ${r.next}`);
  return `${lines.join("\n")}\n`;
}

/** A `prd` or `conflict` candidate: the statement must file, and nothing is scored or overridden. */
function issueVerdict(ctx: VerbContext, rubric: Rubric, candidate: { kind: "prd" | "conflict"; title: Title; statement: string; source: string }, input: ClassifyInput): number {
  const given = (v: unknown) => v !== undefined && (Array.isArray(v) ? v.length > 0 : typeof v !== "object" || v === null || Object.keys(v).length > 0);
  if (given(input.answers)) fail(ctx, "socrates-answers-invalid", `a ${candidate.kind} entry is not scored, so it takes no rubric answers`, "drop --answer");
  if (given(input.overrides)) fail(ctx, "socrates-override-invalid", `a ${candidate.kind} entry has no gate to override`, "drop --override");
  const entry = issueEntryOf(candidate);
  if (!entry.ok) fail(ctx, "socrates-candidate-invalid", `the ${candidate.kind} statement cannot be filed (${printable(entry.reason)})`, "run 'eris socrates classify --help' for the statement grammar");
  const out = steered({
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

export async function runClassify(args: string[], ctx: VerbContext, deps: SocratesDeps = {}): Promise<number> {
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
  const parsedCandidate = SocratesCandidate.safeParse(input.candidate);
  if (!parsedCandidate.success) fail(ctx, "socrates-candidate-invalid", `the candidate does not match the contract (${printable(issues(parsedCandidate.error, "candidate"))})`, "run 'eris socrates classify --help' for each flag's bounds");
  const candidate = checkCandidateTitle(ctx, parsedCandidate.data);
  checkCandidateStatement(ctx, candidate);
  const { kind } = candidate;
  if (kind === "prd" || kind === "conflict") return issueVerdict(ctx, rubric, { ...candidate, kind }, input);
  const answers = answersOf(ctx, rubric, input.answers);
  // No living-doc entries are read locally, so `already_recorded` fires only on its answer here; the server reclassifies.
  const features = extractFeatures(rubric, candidate.statement, { recorded: [] });
  const local = localPolicy(ctx, rubric, await readPolicyCache(ctx, deps), await readRepoPolicy(ctx, deps.cwd ?? process.cwd()));
  const overrides = overridesOf(ctx, rubric, local.policy, input.overrides, answers, features);

  const home = deps.home ?? ctx.env.HOME ?? homedir();
  const file = await readYaksFileConfig(home);
  if ("reason" in file) fail(ctx, file.slug, file.reason, "fix or remove the file, then run 'eris login'");
  const selection = await resolveOrgSelection(ctx.env, deps.cwd ?? process.cwd(), home);
  if ("reason" in selection) fail(ctx, selection.slug, selection.reason, selection.fix);
  const view = selectOrgConfig(file.value, selection.value, ctx.env);
  if ("reason" in view) fail(ctx, view.slug, view.reason, view.fix);
  const href = `${resolveUrl(view.value.config, ctx.env).value.replace(/\/+$/, "")}${SOCRATES_ROUTES.classify.path}`;

  const verdict = scoreUnderPolicy(rubric, local.policy, answers, features, overrides.map((o) => o.gate)) as Verdict<Rubric>;
  const out = steered(report(rubric, verdict, overrides, local, href));
  ctx.stdout.write(ctx.format === "json" ? `${JSON.stringify(out)}\n` : text(out));
  return 0;
}
