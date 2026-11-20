/**
 * The gate plugin's manifest: `eris gate record`, `skip`, `check` and `ci`, and `eris surface lock`, `unlock` and
 * `digest`, as registry rows plus a lazy handler thunk (docs/dev/PLUGINS.md, docs/GATE.md). The verbs write and read gate receipts through the
 * gates client (docs/dev/GATES-CLIENT.md) on the `eris login` bearer; `ci` only reads.
 *
 * `gatePlugin(defaults)` is the same plugin with what a build supplies: the door-class ladder file
 * `check` reads (none: every class at R1), and the org's pulled, verified policy tree, whose doctrine
 * and profiles are read when `--doctrine` and `--profiles` are absent and whose bundle sha the receipt
 * routes send. The default export has neither.
 */

import type { ContractFailure } from "eris/gates-contract";
import { definePlugin, type VerbContext } from "../../src/cli/plugin";

/** The org's pulled tree, verified: its doctrine and profiles files, and the bundle sha they hash to. */
export interface PulledTree {
  readonly doctrineFile: string;
  readonly profilesFile: string;
  readonly bundleSha: string;
}

/** What a build supplies the gate verbs. */
export interface GateDefaults {
  /** The door-class ladder `check` reads with no `--ladder`; absent, every class reads R1. */
  readonly ladderFile?: string;
  /** The org's pulled tree (null: none pulled), or the failure that refuses an edited one. */
  readonly pulled?: (ctx: VerbContext) => Promise<{ readonly ok: true; readonly value: PulledTree | null } | { readonly ok: false; readonly failure: ContractFailure }>;
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
      rf("--screenshot"),
      rf("--video"),
      v("--actor"),
    ],
    pos: ["gate?"],
    usage:
      "<gate> --issue <KEY> --verdict PASS|AMENDED|BLOCKING --artifact <path> [--rubric <name@version>]... [--doctrine <path>] [--impact U0|U1|U2|U3] [--authorized <grant>] [--evidence <text>]... [--log|--test-run|--e2e|--screenshot|--video <file>]... [--actor <who>]",
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
    flags: [v("--issue"), v("--gates"), v("--profile"), f("--profiles"), f("--doctrine"), f("--ladder"), v("--expect"), f("--burden"), v("--base"), v("--pr"), b("--asks"), b("--dry-run")],
    usage:
      "--issue <KEY> (--gates <a,b,...> | --profile <name> [--profiles <file>]) [--doctrine <file>] [--ladder <file>] [--expect <comment-id,...>] [--burden <rubric.yaml> --base <ref>] [--pr <N>] [--asks] [--dry-run]",
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
