/**
 * The gate plugin's manifest: `eris gate record`, `skip`, `check` and `ci`, and `eris surface lock`, `unlock` and
 * `digest`, as registry rows plus a lazy handler thunk (docs/dev/PLUGINS.md, docs/GATE.md). The verbs write and read gate receipts through the
 * gates client (docs/dev/GATES-CLIENT.md) on the `eris login` bearer; `ci` only reads.
 *
 * `gatePlugin(defaults)` is the same plugin with what a build supplies: the door-class ladder file
 * `check` reads (none: U0/U1 at R2, U2/U3 at R1), the org's pulled, verified policy tree, whose doctrine
 * and profiles are read when `--doctrine` and `--profiles` are absent and whose bundle sha the receipt
 * routes send, `reviews` (review-skill registry and freshness reader), `resolveActor` (custom actor
 * attribution), `burdenSurfaces` (whole-estate surface crossing resolver), `receiptLink` (optional
 * permalink rendered in receipt comments), and `subcommands` (distribution-only `eris gate <sub>`
 * verbs). The default export has none of them.
 *
 * Invariants:
 *  - `gateRows(defaults)` is the one place the rows are built: the manifest composes them and the
 *    handler parses with them, so every subcommand a distribution adds is parsed by the same row;
 *  - no distribution subcommand shadows a built-in gate subcommand (`record`, `skip`, `check`, `ci`).
 */

import type { ContractFailure, GateActor, GateReviewReport, ReviewMainState } from "eris/gates-contract";
import { definePlugin, type Row, type VerbContext, type VerbHandler } from "../../src/cli/plugin";

/** The org's pulled tree, verified: its doctrine and profiles files, and the bundle sha they hash to. */
export interface PulledTree {
  readonly doctrineFile: string;
  readonly profilesFile: string;
  readonly bundleSha: string;
}

/** Optional directory and home overrides handed to `GateDefaults.pulled`. */
export interface PulledTreeRequest {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
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
   * merge-base `review_skills` (during `gate ci` / `--unlock`) restricts the skill name.
   */
  readonly skills?:
    | ReadonlyArray<string>
    | ((ctx: { readonly cwd: string; readonly env: Readonly<Record<string, string | undefined>> }) => ReadonlyArray<string> | Promise<ReadonlyArray<string>>);
  /** Read `main`'s digest and class list for the report's skill and vocabulary. */
  readonly freshness: (req: ReviewFreshnessRequest) => ReviewFreshness | Promise<ReviewFreshness>;
}

/** Actor resolution result for a gate or surface receipt. */
export interface ResolvedGateActor {
  readonly actor: string;
  readonly actorInfo?: GateActor | undefined;
}

/** What a distribution's actor resolver receives. */
export interface GateActorRequest {
  readonly flag?: string | undefined;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Surfaces crossed by a diff since `base`, for `gate check --burden`. */
export interface BurdenCrossed {
  readonly changed: ReadonlyArray<string>;
  readonly surfaces: ReadonlyArray<string>;
  readonly known: ReadonlyArray<string>;
}

/** What a distribution's burden surface resolver receives. */
export interface BurdenSurfacesRequest {
  readonly cwd: string;
  readonly base: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Optional permalink rendered inside a receipt comment (`{link}` template slot) and noted on stderr. */
export interface ReceiptLink {
  /** Builds the link URL for the receipt's record sha256. */
  readonly url: (recordSha256: string) => string;
  /** Renders the markdown line inserted at the `{link}` template slot. */
  readonly line: (recordSha256: string, url: string) => string;
  /** Optional stderr INFO suffix (for example `, View <url>`). */
  readonly note?: ((url: string) => string) | undefined;
  /** Called when the store replied with a different `recordSha256` than predicted. */
  readonly onMismatch?: ((url: string, storeSha256: string | undefined) => void) | undefined;
}

/** One extra `eris gate <sub>` subcommand a distribution composes under `eris gate`. */
export interface GateSubcommand {
  /** The registry row for `gate <sub>`. */
  readonly row: Row;
  /** Optional usage-list line printed under `Commands:` in `eris gate --help`. */
  readonly usageLine?: string | undefined;
  /** The subcommand's handler, receiving the args after `<sub>`. */
  readonly run: VerbHandler;
}

/** What a build supplies the gate verbs. */
export interface GateDefaults {
  /** The door-class ladder `check` reads with no `--ladder` (static path or per-context resolver); absent, U0/U1 read R2 and U2/U3 read R1. */
  readonly ladderFile?: string | ((ctx: VerbContext) => string | undefined);
  /** The org's pulled tree (null: none pulled), or the failure that refuses an edited one. */
  readonly pulled?: (ctx: VerbContext, req?: PulledTreeRequest) => Promise<{ readonly ok: true; readonly value: PulledTree | null } | { readonly ok: false; readonly failure: ContractFailure }>;
  /** Review-report judging (registered review skills + `main` freshness reader); absent, reports read `blocking`. */
  readonly reviews?: GateReviews;
  /** Custom actor resolution; absent uses public `resolveActor`. */
  readonly resolveActor?: (req: GateActorRequest) => Promise<ResolvedGateActor>;
  /** Whole-estate surface resolver for `gate check --burden`; absent reads root `eris.yaml` only. */
  readonly burdenSurfaces?: (req: BurdenSurfacesRequest) => Promise<BurdenCrossed>;
  /** Optional receipt permalink renderer; absent omits the `{link}` template line. */
  readonly receiptLink?: (ctx: VerbContext) => ReceiptLink | null;
  /** Extra `gate <sub>` verbs composed under `eris gate`; keys are bare subcommand names (`demote`, `remediate`, ...). */
  readonly subcommands?: Readonly<Record<string, GateSubcommand>>;
  /** Optional override for the `gate` group row summary (for example, listing distribution subcommands). */
  readonly gateSummary?: string;
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
    summary: "Append a gate-receipt@v2 comment to an issue (or gate-receipt@v3 when stamped with --mandate)",
    flags: [
      v("--issue"),
      v("--verdict"),
      f("--artifact"),
      r("--rubric"),
      f("--doctrine"),
      v("--impact"),
      v("--authorized"),
      v("--mandate"),
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
      "<gate> --issue <KEY> [--verdict PASS|AMENDED|BLOCKING] [--artifact <path>] [--rubric <name@version>]... [--doctrine <path>] [--impact U0|U1|U2|U3] [--authorized <grant>] [--mandate <handle>] [--evidence <text>]... [--log|--test-run|--e2e|--review-report|--screenshot|--video <file>]... [--actor <who>]",
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
    summary: "Exit non-zero unless every named gate's latest receipt passes, or (--unlock) a one-way action is unlocked or human-signed",
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
      v("--unlock"),
      v("--registry"),
      v("--target"),
      v("--effect-kind"),
      b("--announce"),
    ],
    usage:
      "--issue <KEY> (--gates <a,b,...> | --profile <name> [--profiles <file>] | --unlock merge|deploy|effect [--base <ref>] [--head-sha <sha>] [--registry <file>] [--target <owner/repo>] [--effect-kind <kind>] [--announce]) [--doctrine <file>] [--ladder <file>] [--expect <comment-id,...>] [--burden <rubric.yaml> --base <ref>] [--pr <N>] [--asks] [--dry-run] [--effort low|medium|high|max] [--head-sha <sha>] [--diff-sha256 <sha256>]",
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

export type GateRows = typeof ROWS;

/** Built-in `eris gate` subcommands that no distribution subcommand may shadow. */
const BUILT_IN_GATE_SUBS: ReadonlySet<string> = new Set(["record", "skip", "check", "ci"]);

/**
 * The plugin's rows for what the build supplies: public rows plus any distribution subcommands and
 * optional group summary override. Throws on a subcommand colliding with a built-in gate verb.
 */
export function gateRows(defaults: Pick<GateDefaults, "subcommands" | "gateSummary"> = {}): GateRows {
  const subs = Object.entries(defaults.subcommands ?? {});
  if (subs.length === 0 && defaults.gateSummary === undefined) return ROWS;
  const rows: Record<string, Row> = { ...ROWS };
  if (defaults.gateSummary !== undefined) rows.gate = { ...ROWS.gate, summary: defaults.gateSummary };
  for (const [sub, def] of subs) {
    if (BUILT_IN_GATE_SUBS.has(sub)) throw new Error(`gate subcommand '${sub}' is built in and cannot be replaced`);
    if (!/^[a-z][a-z0-9-]*$/.test(sub)) throw new Error(`gate subcommand '${sub}' must be kebab-case`);
    rows[`gate ${sub}`] = def.row;
  }
  return rows as unknown as GateRows;
}

/** The gate plugin, with what the build supplies. */
export function gatePlugin(defaults: GateDefaults = {}) {
  return definePlugin({
    name: "gate",
    rows: gateRows(defaults),
    handlers: {
      gate: async () => (await import("./gate")).gateHandler(defaults),
      surface: async () => (await import("./surface-verb")).surfaceHandler(defaults),
    },
  });
}

export default gatePlugin();
