/**
 * surface-verb.ts — `eris surface lock | unlock | digest`: the command line, read from the plugin's rows,
 * handed to the engines (surface-lock.ts, surface-digest.ts) over the gates client. One thrown
 * `GateFailure` is caught once here and written as its slugged block, as `eris gate` does.
 *
 *   surface lock <name> --reason <why> --authorized <grant>   stdout: the receipt's comment id, or '-' (already locked)
 *   surface unlock <name> --authorized <grant> [--reason]     the same, lifting the lock
 *   surface digest [--since 24h]                              one row per surface, then one '@digest' line
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ContractFailure } from "eris/gates-contract";
import { CliExit, groupArgs, readArgs, renderFailureBlock, type VerbContext, type VerbHandler } from "../../src/cli/plugin";
import { resolveActor } from "./actor";
import { CHECK_RATE_LIMIT_DELAYS_MS, CHECK_RATE_LIMIT_MAX_WAIT_MS, type GateDeps, verbFor, writeRun } from "./gate";
import { GateFailure, precondition, usage } from "./failure";
import { issuesText, validateSurfacesYaml } from "./registry";
import plugin, { type GateDefaults } from "./index";
import { surfaceDigest } from "./surface-digest";
import { setLock } from "./surface-lock";
import { ttlMs } from "./unlock";

const ROWS = plugin.rows;
const DEFAULT_REGISTRY = ".claude/surfaces.yml";

type Sub = "surface lock" | "surface unlock" | "surface digest";
const line = (path: Sub) => `eris ${path} ${ROWS[path].usage}`;

const USAGE = `Usage: eris surface <command>

The per-surface kill switch and the unlock roll-up.

Commands:
  lock   <name> --reason <why> --authorized <grant>
                 Stop <name> from unlocking any one-way action: the next
                 'eris gate ci' unlock leg reads human (a human door-signoff
                 still passes). Immediate, no PR
  unlock <name> --authorized <grant> [--reason <why>]
                 Lift the lock; the surface's normal bar applies again
  digest [--since <n>h|<n>d]
                 One row per registry surface, then one '@digest' line for the
                 TPM pulse

A lock and its lift are human writes: --authorized 'Dan asked: <request>'; a
doctrine: grant is refused (surface-lock-unauthorized). The lock is a
surface-lock receipt on the surface's ledger issue ('ledger:' in the registry);
a surface with no ledger already stays human-signed. Receipts are written
through the gateway's gate-receipt routes, signed in with 'eris login'.
`;

const LOCK_USAGE = `Usage: ${line("surface lock")}

Stop <name> from unlocking any one-way action: the next 'eris gate ci' unlock leg
reads human (a human door-signoff still passes). Records a surface-lock PASS on the
surface's ledger issue. Immediate, no PR. A registry inside a git checkout must be
committed and pushed first, as for 'eris gate record --artifact'.

  <name>         A surface in the registry that has a ledger
  --reason       Why, in words the next reader can check (required)
  --authorized   A human grant: 'Dan asked: <request>'; a doctrine: grant is refused
  --registry     The surfaces registry (default ${DEFAULT_REGISTRY})
  --actor        Who recorded it (default: as for 'gate record')

stdout: the receipt's comment id, or '-' when the surface is already locked.
`;

const UNLOCK_USAGE = `Usage: ${line("surface unlock")}

Lift a surface lock; the surface's normal bar applies again. Records a surface-lock
AMENDED on the surface's ledger issue. Immediate, no PR.

  <name>         A surface in the registry that has a ledger
  --authorized   A human grant: 'Dan asked: <request>'; a doctrine: grant is refused
  --reason       Why (default: lifted by operator)
  --registry     The surfaces registry (default ${DEFAULT_REGISTRY})
  --actor        Who recorded it (default: as for 'gate record')

stdout: the receipt's comment id, or '-' when the surface is not locked.
`;

const DIGEST_USAGE = `Usage: ${line("surface digest")}

One row per registry surface, '<surface>\\t<ledger|->\\t<merge>\\t<deploy>\\t<effect>\\t<locked|open|->'
(the unlocked-<action> receipts on its ledger inside the window), then one '@digest'
line for the TPM pulse.

  --since        The window: <n>h or <n>d (default 24h)
  --registry     The surfaces registry (default ${DEFAULT_REGISTRY})
`;

/** Refuse the command line before anything is read: the block, exit 1. */
function refuse(ctx: VerbContext, what: string, path: Sub): never {
  ctx.stderr.write(renderFailureBlock({ slug: "gate-usage", what, fix: `usage: ${line(path)}`, docs: "docs/ERRORS.md#gate-usage" }, ctx.erisDir));
  throw new CliExit(1);
}

async function runSet(to: "locked" | "open", args: string[], ctx: VerbContext, defaults: GateDefaults, deps: GateDeps): Promise<number> {
  const path: Sub = to === "locked" ? "surface lock" : "surface unlock";
  const a = readArgs(ROWS, path, args, ctx, { help: to === "locked" ? LOCK_USAGE : UNLOCK_USAGE });
  if (a === null) return 0;
  const [name = ""] = a.pos;
  const fl = a.flags;
  const missing = [...(name === "" ? ["<name>"] : []), ...(to === "locked" && fl["--reason"] === undefined ? ["--reason"] : [])];
  if (missing.length > 0) refuse(ctx, `${path}: missing ${missing.join(", ")}`, path);
  const v = await verbFor(ctx, defaults, deps);
  const who = await resolveActor({ flag: fl["--actor"], g: v.g, cwd: v.cwd });
  const r = await setLock(await writeRun(v), {
    name,
    to,
    reason: fl["--reason"] ?? "lifted by operator",
    authorized: fl["--authorized"],
    registry: fl["--registry"] ?? DEFAULT_REGISTRY,
    actor: who.actor,
    actorInfo: who.actorInfo,
  });
  if (r.kind === "noop") {
    ctx.stdout.write("-\n");
    ctx.stderr.write(`INFO ✓ ${name} is already ${to}; nothing recorded\n`);
    return 0;
  }
  ctx.stdout.write(`${r.commentId}\n`);
  ctx.stderr.write(`INFO ✓ ${to === "locked" ? "locked" : "unlocked"} ${name} (ledger ${r.ledger})\n`);
  return 0;
}

async function runDigest(args: string[], ctx: VerbContext, defaults: GateDefaults, deps: GateDeps): Promise<number> {
  const a = readArgs(ROWS, "surface digest", args, ctx, { help: DIGEST_USAGE });
  if (a === null) return 0;
  const fl = a.flags;
  const since = fl["--since"] ?? "24h";
  if (!/^[1-9]\d*[dh]$/.test(since)) refuse(ctx, `surface digest: --since ${since}: not <n>h or <n>d`, "surface digest");
  const v = await verbFor(ctx, defaults, deps);
  const registry = fl["--registry"] ?? DEFAULT_REGISTRY;
  const file = resolve(v.cwd, registry);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return usage(`--registry ${registry}: cannot read ${file}`, "Run from a checkout whose registry exists, or pass --registry <file>.");
  }
  const parsed = validateSurfacesYaml(text);
  if (!parsed.ok) return precondition("gate-surfaces-invalid", `${registry}: ${issuesText(parsed.issues)}`, "Fix each violation the line names; the registry is strict about unknown keys.");
  const retry = v.retry(CHECK_RATE_LIMIT_DELAYS_MS, CHECK_RATE_LIMIT_MAX_WAIT_MS, (waitMs, attempt) =>
    ctx.stderr.write(`WARN the store rate-limited the receipt read; retry ${attempt}/${CHECK_RATE_LIMIT_DELAYS_MS.length} in ${Math.round(waitMs / 1000)}s\n`),
  );
  const d = await surfaceDigest(await v.endpoint(), retry, parsed.value, ttlMs(since), v.now);
  for (const r of d.rows) ctx.stdout.write(`${r.name}\t${r.ledger ?? "-"}\t${r.counts.merge}\t${r.counts.deploy}\t${r.counts.effect}\t${r.lock}\n`);
  ctx.stdout.write(`@digest\t${d.line}\n`);
  return 0;
}

/** The `eris surface` group: dispatch, then one place that renders a failure. */
export function surfaceHandler(defaults: GateDefaults = {}, deps: GateDeps = {}): VerbHandler {
  return async (args, ctx) => {
    const g = groupArgs(ROWS, "surface", args);
    if (g.kind === "bare" || g.kind === "help") {
      ctx.stdout.write(USAGE);
      return 0;
    }
    if (g.kind === "unknown") {
      ctx.stderr.write(`ERROR Unknown surface command: ${g.sub}\n`);
      return 1;
    }
    try {
      if (g.sub === "digest") return await runDigest(g.rest, ctx, defaults, deps);
      return await runSet(g.sub === "lock" ? "locked" : "open", g.rest, ctx, defaults, deps);
    } catch (e) {
      if (!(e instanceof GateFailure)) throw e;
      const f: ContractFailure = e.failure;
      ctx.stderr.write(renderFailureBlock({ slug: f.slug, what: f.what, fix: f.fix, docs: f.docs }, ctx.erisDir));
      return f.exit;
    }
  };
}
