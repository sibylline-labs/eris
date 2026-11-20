/**
 * The gate plugin's manifest: `eris gate record`, `skip`, `check` and `ci`, and `eris surface lock`, `unlock` and
 * `digest`, as registry rows plus a lazy handler thunk (docs/dev/PLUGINS.md, docs/GATE.md). The verbs write and read gate receipts through the
 * gates client (docs/dev/GATES-CLIENT.md) on the `eris login` bearer; `ci` only reads.
 *
 * `gatePlugin(defaults)` is the same plugin with what a build supplies: the door-class ladder file
 * `check` reads (none: every class at R1), the org's pulled, verified policy tree, whose doctrine
 * and profiles are read when `--doctrine` and `--profiles` are absent and whose bundle sha the receipt
 * routes send, and `reviews`, the review-skill registry and skill/vocabulary freshness reader
 * `check` and `ci` use to judge `review-report@1` evidence (none: reports read as `blocking`). The
 * default export has none of the three.
 */

import type { ContractFailure, GateReviewReport, ReviewMainState } from "eris/gates-contract";
import { definePlugin, type VerbContext } from "../../src/cli/plugin";

/** The org's pulled tree, verified: its doctrine and profiles files, and the bundle sha they hash to. */
export interface PulledTree {
  readonly doctrineFile: string;
  readonly profilesFile: string;
  readonly bundleSha: string;
}

/** What `main` holds for one review report, as a distribution's freshness reader answers it. */
export interface ReviewFreshness {
  readonly main: ReviewMainState;
  /** The vocabulary's class ids at `main`, when it was read. */
  readonly classes?: readonly string[] | undefined;
  /** Diagnostics for stderr (for example, a failed fetch). */
  readonly notes?: readonly string[] | undefined;
}

/** What a distribution's review-freshness reader receives for one report during `check` or `ci`. */
export interface ReviewFreshnessRequest {
  readonly report: GateReviewReport;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The primary local checkout of `report.target.repo`, or null when none is found. */
  readonly targetRoot: () => Promise<string | null>;
  /** Per-check cache shared across every report judged in one run. */
  readonly cache: Map<string, unknown>;
}

/**
 * What a build supplies to judge `review-report@1` evidence. Absent (the public default),
 * `eris gate check` reads any receipt carrying a review report as `blocking` and says why.
 */
export interface GateReviews {
  /**
   * The review skill names this distribution registers. When supplied, a review report naming any
   * other skill reads `blocking` (an empty list qualifies none). When omitted, only a bar's
   * merge-base `review_skills` (during `gate ci` unlock) restricts the skill name.
   */
  readonly skills?:
    | ReadonlyArray<string>
    | ((ctx: { readonly cwd: string; readonly env: Readonly<Record<string, string | undefined>> }) => ReadonlyArray<string> | Promise<ReadonlyArray<string>>);
  /** Read `main`'s digest and class list for the report's skill and vocabulary. */
  readonly freshness: (req: ReviewFreshnessRequest) => ReviewFreshness | Promise<ReviewFreshness>;
}

/** What a build supplies the gate verbs. */
export interface GateDefaults {
  /** The door-class ladder `check` reads with no `--ladder`; absent, every class reads R1. */
  readonly ladderFile?: string;
  /** The org's pulled tree (null: none pulled), or the failure that refuses an edited one. */
  readonly pulled?: (ctx: VerbContext) => Promise<{ readonly ok: true; readonly value: PulledTree | null } | { readonly ok: false; readonly failure: ContractFailure }>;
  /** Review-report judging (registered review skills + `main` freshness reader); absent, reports read `blocking`. */
  readonly reviews?: GateReviews;
}

const v = <const N extends `--${string}`>(name: N) => ({ name, takesValue: true }) as const;
const f = <const N extends `--${string}`>(name: N) => ({ name, takesValue: true, file: true }) as const;
const r = <const N extends `--${string}`>(name: N) => ({ name, takesValue: true, repeatable: true }) as const;
const rf = <const N extends `--${string}`>(name: N) => ({ name, takesValue: true, repeatable: true, file: true }) as const;
const b = <const N extends `--${string}`>(name: N) => ({ name, takesValue: false }) as const;

const ROWS = {
  gate: { impl: "ts", summary: "Gate receipts on tracker issues (record, skip, check, ci); not feature flags" },
  surface: { impl: "ts", summary: "The per-surface kill switch and the unlock roll-up (lock, unlock, digest)" },
  "gate record": {
    summary: "Append a gate-receipt@v2 comment to an issue",
    flags: [
      v("--issue"),
      v("--verdict"),
      f("--artifact"),
      r("--rubric"),
      f("--doctrine"),
      v("--impact"),
      v("--authorized"),
      r("--evidence"),
      rf("--log"),
      rf("--test-run"),
      rf("--e2e"),
      rf("--review-report"),
      rf("--screenshot"),
      rf("--video"),
      v("--actor"),
    ],
    pos: ["gate?"],
    usage:
      "<gate> --issue <KEY> [--verdict PASS|AMENDED|BLOCKING] [--artifact <path>] [--rubric <name@version>]... [--doctrine <path>] [--impact U0|U1|U2|U3] [--authorized <grant>] [--evidence <text>]... [--log|--test-run|--e2e|--review-report|--screenshot|--video <file>]... [--actor <who>]",
  },
  "gate skip": {
    summary: "Append a SKIPPED gate receipt that names its reason and the grant (human, doctrine, repo, or signed mandate) behind it",
    flags: [v("--issue"), v("--reason"), v("--authorized"), v("--mandate"), f("--artifact"), f("--doctrine"), v("--impact"), v("--actor")],
    pos: ["gate?"],
    usage: "<gate> --issue <KEY> --reason <why> (--authorized <grant> | --mandate <handle>) --artifact <path> [--doctrine <path>] [--impact U0|U1|U2|U3] [--actor <who>]",
  },
  "gate ci": {
    summary: "The required PR check: route a pull_request event by issue key and run the gate legs under the org's hosted policy, GET-only",
    flags: [f("--event"), v("--registry")],
    usage: "[--event <file>] [--registry <path>]",
  },
  "gate check": {
    summary: "Exit non-zero unless every named gate's latest receipt passes",
    flags: [
      v("--issue"),
      v("--gates"),
      v("--profile"),
      f("--profiles"),
      f("--doctrine"),
      f("--ladder"),
      v("--expect"),
      f("--burden"),
      v("--base"),
      v("--pr"),
      b("--asks"),
      b("--dry-run"),
      v("--effort"),
      v("--head-sha"),
      v("--diff-sha256"),
    ],
    usage:
      "--issue <KEY> (--gates <a,b,...> | --profile <name> [--profiles <file>]) [--doctrine <file>] [--ladder <file>] [--expect <comment-id,...>] [--burden <rubric.yaml> --base <ref>] [--pr <N>] [--asks] [--dry-run] [--effort low|medium|high|max] [--head-sha <sha>] [--diff-sha256 <sha256>]",
  },
  "surface lock": {
    summary: "Stop a surface from unlocking any one-way action: a human write, recorded on the surface's ledger issue",
    flags: [v("--reason"), v("--authorized"), f("--registry"), v("--actor")],
    pos: ["name?"],
    usage: "<name> --reason <why> --authorized <grant> [--registry <path>] [--actor <who>]",
  },
  "surface unlock": {
    summary: "Lift a surface lock: a human write, recorded on the surface's ledger issue",
    flags: [v("--reason"), v("--authorized"), f("--registry"), v("--actor")],
    pos: ["name?"],
    usage: "<name> --authorized <grant> [--reason <why>] [--registry <path>] [--actor <who>]",
  },
  "surface digest": {
    summary: "One row per registry surface of the unlocked one-way actions in a window, then one '@digest' line",
    flags: [v("--since"), f("--registry")],
    usage: "[--since <n>h|<n>d] [--registry <path>]",
  },
} as const;

/** The gate plugin, with what the build supplies. */
export function gatePlugin(defaults: GateDefaults = {}) {
  return definePlugin({
    name: "gate",
    rows: ROWS,
    handlers: {
      gate: async () => (await import("./gate")).gateHandler(defaults),
      surface: async () => (await import("./surface-verb")).surfaceHandler(defaults),
    },
  });
}

export default gatePlugin();
