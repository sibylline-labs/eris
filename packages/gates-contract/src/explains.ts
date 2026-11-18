/**
 * explains.ts — the explanation and meaning constants of the doctrine `policy:` contract, and the
 * floor constants they describe: the text `eris doctrine schema`, `gates --explain` and
 * `effect` print. Every string here is user-visible output.
 */

import { described, explained, meant, type KeyExplain } from "./explain";

export const GATE_U_CLASSES = ["U0", "U1", "U2", "U3"] as const;
export type GateUClass = (typeof GATE_U_CLASSES)[number];

/** What a user-impact class must prove before it closes. */
export const GATE_REQUIREMENTS = ["revert-path", "zero-downtime", "e2e", "rollback-rehearsal"] as const;
export type GateRequirementLiteral = (typeof GATE_REQUIREMENTS)[number];

/** The floor, per class: U1 revert-path; U2 + zero-downtime, e2e; U3 + rollback-rehearsal. */
export const GATE_USER_IMPACT_FLOOR: Readonly<Record<GateUClass, readonly GateRequirementLiteral[]>> = {
  U0: [],
  U1: ["revert-path"],
  U2: ["revert-path", "zero-downtime", "e2e"],
  U3: ["revert-path", "zero-downtime", "e2e", "rollback-rehearsal"],
};

/** The classes whose floor no posture may lower: no downtime, no customer losses. */
export const GATE_GUARDED_CLASSES = ["U2", "U3"] as const satisfies readonly GateUClass[];
/** Gates that enforce the floor: a posture may run them `lite` or `once-at-end`, never `off`. */
export const GATE_FLOOR_GATES = ["final-gates", "user-impact"] as const;
/** The most rounds a posture may allow before the human hand-off: the loop stays bounded. */
export const GATE_MAX_ROUNDS_CAP = 5;

export const gateModeMeanings = meant({
  summary: "How strictly a gate runs.",
  values: {
    on: "Runs in full on every issue.",
    lite: "Runs with a lighter rubric: the same receipt, fewer checks.",
    "once-at-end": "Is judged once, at the final gates, instead of when its stage runs.",
    off: "Is skipped: eris records a doctrine SKIPPED receipt in its place.",
  },
  rank: ["off", "once-at-end", "lite", "on"],
});
export const closeModeMeanings = meant({
  summary: "How a close stage runs after an issue lands.",
  values: {
    on: "Runs and acts on its result: files suggestions and hands them on to be built.",
    "file-only": "Runs and files its result, but nothing builds it.",
    off: "Is skipped.",
  },
  rank: ["off", "file-only", "on"],
});
export const signoffMeanings = meant({
  summary: "Who approves a change before it closes.",
  values: { human: "A human approves it before it closes.", self: "The agent closes it on its own passing receipts." },
  rank: ["self", "human"],
});
export const rungMeanings = meant({
  summary: "How much human review a door class gets: the autonomy rung.",
  values: {
    R0: "A human signs off before the change closes.",
    R1: "A human reviews after the run (the pull request review).",
    R2: "Closes automatically on passing receipts.",
  },
  rank: ["R2", "R1", "R0"],
});
export const escalationMeanings = meant({
  summary: "A kind of change that moves an issue up to the deep profile.",
  values: {
    "one-way-door": "A change that is hard to undo: a migration, a deletion, a contract change.",
    "cross-repo-seam": "A change to a call or contract between two repositories.",
    U1: "A user-visible change that can be reverted.",
    U2: "A change that risks availability.",
    U3: "A change that could lose user data or money for good.",
  },
});
export const requirementMeanings = meant({
  summary: "Evidence a change must show before it closes.",
  values: {
    "revert-path": "A proven way back: the revert command run, or a flag flipped off.",
    "zero-downtime": "A rollout shape proven to keep the service up while it deploys.",
    e2e: "An end-to-end run against the real stack.",
    "rollback-rehearsal": "The rollback actually rehearsed before release.",
  },
});
export const liftRungMeanings = meant({
  summary: "The rung a bleed-reducing fix is raised to.",
  values: { R1: "A human reviews after the run (the pull request review).", R2: "Closes automatically on passing receipts." },
  rank: ["R2", "R1"],
});
export const liftsExplained = explained({
  summary: "The rung a bleed-reducing fix of a low-risk class (U0, U1) is raised to, so a fix that stops an ongoing problem is not held in a review queue.",
  protects: "an urgent fix waiting on review while the problem it stops keeps hurting.",
  raise: "Bleed fixes stay under normal review: no lift, or only to R1.",
  lower: "Low-risk bleed fixes close with review after the fact (R1) or automatically (R2); never U2 or U3.",
  unset: "strictest",
});

/** The work gates a posture can tune, by name: what each one does and what turning it up or down costs. */
export const GATE_EXPLAINS: Readonly<Record<string, KeyExplain>> = {
  "understand-scope": {
    summary: "Reads the issue, restates it, classifies its user impact and picks the review profile before any work starts.",
    protects: "work starting on a misread issue, or a risky change running on the light profile.",
    raise: "Every issue gets a written scope note and a recorded impact class first, a few minutes per issue.",
    lower: "Scoping is lighter, later or skipped, so a misread issue or an understated risk class is caught later, or not at all.",
  },
  "premise-gate": {
    summary: "Checks each assumption a plan rests on against the real system before that plan is built.",
    protects: "a plan built on an assumption that turns out to be false, which costs a rewrite or a bad release.",
    raise: "Each load-bearing assumption gets a direct check (a probe, a query, a diff), about one extra research pass before planning.",
    lower: "Fewer assumptions are checked directly (none when off): faster, but a wrong assumption can reach code.",
  },
  "define-future": {
    summary: "States, before any code, how the service graph should change (config keys, calls between services, queues, events), so the final check can hold the code to it.",
    protects: "a change quietly adding or removing a dependency between services that nobody reviewed.",
    raise: "Each issue writes down its intended graph change up front, and one that alters or removes something existing waits for a human.",
    lower: "The graph change is stated more lightly, later or not at all, so an unreviewed new dependency can ship.",
  },
  "sdk-check": {
    summary: "Looks up the shared-library building blocks a plan needs and routes any missing one to the shared SDK instead of hand-rolling it.",
    protects: "the same plumbing (retries, HTTP, config reading) being rewritten slightly differently in every repo.",
    raise: "Each plan gets a catalogue lookup and gaps are filed against the SDK, a short pass before code.",
    lower: "A lighter, later or skipped lookup saves time, but local copies of shared plumbing pile up and drift apart.",
  },
  "state-machine-gate": {
    summary: "Checks, before a pull request is marked ready, that a change touching a state machine declares its states and transitions, that every status write on a governed object goes through them, and that interleavings of awaited steps (step-k faults) leave the object in a valid state.",
    protects: "a status write that skips a declared transition, or a crash or interleaving between two awaited steps that leaves an object half-moved.",
    raise: "Each change that writes a governed status gets its transitions declared and its step-by-step fault cases run, a few extra minutes per such change.",
    lower: "Declared transitions and fault runs are lighter, later or skipped, so an undeclared status write or a half-applied transition can ship.",
  },
  "plan-review": {
    summary: "Reviews the written plan against the design rules and the codebase's own patterns before any code is written.",
    protects: "a design flaw that is cheap to fix in a plan reaching code, where it costs a rewrite or a review round.",
    raise: "Plans now get the full review before any code, adding about one review round.",
    lower: "Plans get a lighter, later or no review: faster, but design flaws surface in code review or in production instead.",
  },
  "final-gates": {
    summary: "Runs the closing checks before a pull request is marked ready: regressions against the starting baseline, the target graph, the code conventions and the user-impact evidence.",
    protects: "a change merging with a new failure, an unreviewed dependency, or no proof it can be rolled back.",
    raise: "Every pull request waits for the full closing checks, a few extra minutes per issue.",
    lower: "The checks run more lightly or once at the end; never off, because this gate enforces the no-downtime, no-customer-loss floor.",
  },
  "user-impact": {
    summary: "Checks that a change proves what its user-impact class requires: a way back, zero downtime, an end-to-end run, a rehearsed rollback.",
    protects: "a user-visible change closing with no proven way back, or a risky one with no proof it stays up.",
    raise: "The evidence is checked as the work goes, and a change cannot close without it.",
    lower: "The evidence is checked more lightly or once at the end; never off, because this gate is the floor.",
  },
  research: {
    summary: "Caches the docs of a library the model cannot know (new, unpinned, or newer than its training) and runs one real call before a plan relies on it.",
    protects: "a plan built on a library API that has changed or never existed.",
    raise: "Each such library gets a pinned docs cache and one executed call, a short research pass.",
    lower: "A lighter, later or skipped research pass: a plan may trust memory of the library, which may be out of date.",
  },
};

/** The close stages a posture can tune, by name: the steps that run after an issue lands. */
export const GATE_CLOSE_EXPLAINS: Readonly<Record<string, KeyExplain>> = {
  "improvement-loop": {
    summary: "After an issue closes, proposes up to five suggestions a day per project that make the code smaller or simpler.",
    protects: "code only ever growing, with nobody looking for what can be removed.",
    raise: "Suggestions are filed and handed on to be built automatically, which uses agent time.",
    lower: "Fewer or no simplification suggestions: the code shrinks only when someone asks.",
  },
  "lift-to-sdk": {
    summary: "Files each piece of shared plumbing built locally in more than one place as a suggestion against the SDK that should own it.",
    protects: "duplicated local copies of shared plumbing living on forever.",
    raise: "Suggestions are filed and handed to background agents to build.",
    lower: "Suggestions are only filed (file-only), or not looked for at all (off).",
  },
  "loop-dispatch": {
    summary: "Hands the follow-up issues a close filed to background agent loops to work.",
    protects: "follow-ups piling up untouched after a close.",
    raise: "Follow-ups start automatically after a close, using agent time.",
    lower: "Follow-ups wait for a human to pick them up.",
  },
  "tpm-report": {
    summary: "Writes a short project-management report on the affected Linear projects after a close.",
    protects: "project boards drifting out of date after work lands.",
    raise: "Each close ends with a refreshed project report.",
    lower: "Boards are refreshed only when someone runs a pass by hand.",
  },
  "close-ledger": {
    summary: "Records what the close did (landed, deployed, filed, torn down) as an audit log.",
    protects: "a close nobody can audit afterwards.",
    raise: "Every close leaves a full audit entry.",
    lower: "Closes leave less record of what they did.",
  },
};

export const gatesExplained = explained({
  summary: "How strictly each work gate runs, by gate name; a gate the posture does not name runs in full (on).",
  protects: "a review step being skipped without anyone deciding to skip it.",
  raise: "Gates run more fully, each adding its own review time to every issue.",
  lower: "Gates run lighter, later or not at all: issues move faster with less checked.",
  keys: GATE_EXPLAINS,
});
export const remediateTriggerMeanings = meant({
  summary: "A failing gate that launches a remediation round.",
  values: { "final-gates-fail": "The closing checks failed on the pull request.", "unlock-gate-fail": "A gate a surface's one-way unlock requires failed." },
});
export const remediateScopeMeanings = meant({
  summary: "What a remediation round may change.",
  values: { "findings-only": "Fixes the open review findings and nothing else." },
});
export const remediateOnExplained = explained({
  summary: "Which failing gates launch a remediation round: final-gates-fail, unlock-gate-fail.",
  protects: "a fixable review failure waiting on a human when an agent could clear its findings.",
  raise: "Fewer triggers: more failures go straight to a human.",
  lower: "More triggers: more failures are first handed to an agent loop to fix.",
  stricter: "less",
});
export const maxRoundsExplained = explained({
  summary: `Rounds a remediation loop may run before it stops and a human signs off with every round's report (default 2, at most ${GATE_MAX_ROUNDS_CAP}).`,
  protects: "an agent loop retrying a failure without end.",
  raise: "Fewer rounds: a human sees a stuck failure sooner.",
  lower: "More rounds: the loop keeps trying longer, using agent time, before a human looks.",
  stricter: "less",
});
export const remediateLoopExplained = explained({
  summary: "The agent loop each remediation round runs (default follow-up).",
  protects: "a round running under a loop with the wrong instructions.",
  raise: "A stricter loop holds each round to more checks.",
  lower: "A lighter loop makes each round faster and less checked.",
});
export const runtimeDefaultExplained = explained({
  summary: "The runtime of round 1 (default opencode/vertex).",
  protects: "spending the most capable runtime on a failure a cheaper one could fix.",
  raise: "A more capable runtime for round 1: costlier, more likely to fix it first time.",
  lower: "A cheaper runtime for round 1: costs less, may need the escalation round.",
});
export const runtimeEscalateExplained = explained({
  summary: "The runtime of round 2 and later (default claude).",
  protects: "a hard failure being retried on a runtime that already could not fix it.",
  raise: "A more capable runtime for the later rounds.",
  lower: "A cheaper runtime for the later rounds, which may not get further than round 1.",
});
export const remediateRuntimeExplained = explained({
  summary: "Which runtime each remediation round runs on: the first round, then the escalation.",
  protects: "remediation cost running away, or a weak runtime stuck on a hard failure.",
  raise: "More capable runtimes: costlier rounds that fix more.",
  lower: "Cheaper runtimes: rounds cost less and may fix less.",
});
export const remediateScopeExplained = explained({
  summary: "What a remediation round may change (findings-only: the open review findings and nothing else).",
  protects: "a remediation round widening the change beyond what review asked for.",
  raise: "Rounds stay within the open findings.",
  lower: "Rounds may change more than the findings (no wider scope exists today).",
});
export const remediateExplained = explained({
  summary: "Hands a failing review to a bounded agent remediation loop; with no block, a failure goes straight to a human.",
  protects: "a fixable review failure sitting idle until a human gets to it.",
  raise: "Remove the block: every failure waits for a human.",
  lower: "Add the block: failures are first worked by an agent loop, within its round cap.",
});
const uClassRaise = (u: GateUClass, label: string) =>
  explained({
    summary: `Evidence a ${u} change (${label}) owes on top of the floor${GATE_USER_IMPACT_FLOOR[u].length > 0 ? ` (${GATE_USER_IMPACT_FLOOR[u].join(", ")})` : " (none)"}; it can only add.`,
    protects: `a ${u} change closing without enough proof it is safe.`,
    raise: `Each ${u} change owes more evidence before it closes, each item a real run or rehearsal.`,
    lower: `${u} changes owe less evidence above the floor${(GATE_GUARDED_CLASSES as readonly GateUClass[]).includes(u) ? "; the floor itself can never be lowered" : ""}.`,
  });
export const profileDefaultExplained = explained({
  summary: "The review profile an issue starts on: spine (lighter) or deep (adds the target-graph and SDK checks).",
  protects: "risky work starting on too light a review.",
  raise: "Starting every issue on deep adds the target-graph and SDK checks, about two more short passes per issue.",
  lower: "Starting on spine skips those passes unless an escalation trigger fires.",
  order: ["spine", "deep"],
});
export const escalateOnExplained = explained({
  summary: "The kinds of change that move an issue up to the deep profile.",
  protects: "a risky change (hard to undo, cross-repo, user-facing) getting only the light review.",
  raise: "More kinds of change get the deep review, each costing its extra passes.",
  lower: "Fewer kinds escalate, so more risky changes run on the light profile.",
});
export const oneWayExplained = explained({ summary: "Who approves a one-way door: a change that is hard to undo.", protects: "an irreversible change shipping without a human looking at it.", raise: "A human approves each one before it closes.", lower: "The agent closes it on its own receipts." });
export const twoWayExplained = explained({ summary: "Who approves a two-way door: a change that is easy to undo.", protects: "a quick mistake reaching users unnoticed.", raise: "A human approves every reversible change too, which slows every close.", lower: "The agent closes reversible changes itself: the fast path." });
export const signoffExplained = explained({ summary: "Who must approve a change before it closes, by door kind.", protects: "changes closing with less human oversight than the operator intends.", raise: "More changes wait for a human.", lower: "More changes close on the agent's own receipts." });
export const closeExplained = explained({ summary: "How each close stage runs after an issue lands, by stage name; a stage the posture does not name runs in full (on).", protects: "follow-up work (simplifications, SDK lifts, reports) being silently dropped.", raise: "More close stages run and act, using agent time after each close.", lower: "Close stages file less or are skipped, saving agent time.", keys: GATE_CLOSE_EXPLAINS });
export const ceilingsExplained = explained({ summary: "The highest autonomy rung a kind of change may reach, by door class (all, U0-U3, U<n>:<crossing>); a ceiling only ever lowers a rung.", protects: "a class of change closing with less human review than the operator wants right now.", raise: "A lower ceiling (toward R0) makes more changes wait for a human sign-off before they close.", lower: "A higher ceiling (toward R2) lets more changes close on review after the fact, or automatically.", unset: "loosest" });
export const ladderClassesExplained = explained({ summary: "The autonomy rung each door class sits on (all, U0-U3, or U<n>:<crossing>); a class the ladder does not list takes its U-class entry, then the all entry, else R1.", protects: "a class of change getting less human review than it needs.", raise: "Moving a class toward R0 makes its changes wait for a human sign-off before they close.", lower: "Moving a class toward R2 lets its changes close automatically on passing receipts." });
export const u0Explained = uClassRaise("U0", "internal only");
export const u1Explained = uClassRaise("U1", "user-visible, reversible");
export const u2Explained = uClassRaise("U2", "availability risk");
export const u3Explained = uClassRaise("U3", "irreversible user loss");
export const userImpactExplained = explained({ summary: "Extra evidence each user-impact class must show before it closes, on top of the floor; a posture can only add.", protects: "a user-facing change closing without enough proof it is safe.", raise: "Changes owe more evidence, for example an end-to-end run for every U1 change.", lower: "Changes owe less evidence above the floor; the U2 and U3 floor can never be lowered." });
export const policyDescribed = described("A doctrine posture's policy: which gates run and how, who signs off, and what each class of change must prove.");
