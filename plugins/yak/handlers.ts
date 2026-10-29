/**
 * handlers.ts — `eris yak issue|suggest|fatal`,
 * loaded only when `eris yak` dispatches (the manifest is ./index.ts).
 *
 * A thin dispatcher over the yak core (./yak.ts, `runYak`): this file
 * owns the group usage, the unknown-verb block, and the per-call environment
 * the core reads; the core owns each verb's grammar, its `--help`, and every
 * receipt / warn / failure rendering. The three verbs share one body, so they
 * share this one file rather than one file per sub.
 *
 * Invariants:
 *   - `ERIS_OUTPUT` carries the global `--output` (already stripped from argv)
 *     into the core, which reads it from its env.
 *   - `ERIS_YAK_SHELL_ID` is the pid of the caller's shell: the shim `exec`s
 *     bun, so this process's parent IS that shell. It is the
 *     `shell:<pid>` execution_id rung (plugins/yak/yak-identity.ts), constant across
 *     every call from one terminal so idempotency converges outside Claude Code.
 *   - A dependency the checkout cannot resolve WARNS and exits 0
 *     (`yak-deps-not-installed`), as a missing token does: the command that
 *     reports a broken harness must not become one more thing that stops the
 *     agent. Under `--output json` it is the bare record on stdout, stderr empty.
 */

import { homedir } from "node:os";
import { CliExit, groupArgs, renderFailureBlock, type VerbContext } from "../../src/cli/plugin";
import plugin from "./index";

type RunYak = typeof import("./yak").runYak;

export interface YakVerbDeps {
  /** The caller's shell pid. Defaults to this process's parent. */
  ppid?: number;
  cwd?: string;
  /** Loads the core. Injected to exercise an uninstalled dependency. */
  load?: () => Promise<RunYak>;
}

/** The group usage's flag block: each spelling, then its description lines. */
const USAGE_FLAGS: readonly (readonly [string, ...string[]])[] = [
  ["--summary <text>", "required, <= 200 chars"],
  ["--body <text> | --body-file <path|->", "required (- reads stdin)"],
  ["--evidence <text> | --evidence-file <path|->", "optional, <= 20000 chars"],
  ["--repro <command>", "optional, <= 2000 chars — a repro command", "stored with the cluster"],
  ["--repo <owner/name>", "optional, repeatable — a target repo this", "report concerns; auto-derived from this", "process's own git remote when omitted"],
  ["--no-redact", "skip the secret-scrub pass (loud warning)"],
];

/** Every description starts two columns past the longest spelling. */
const USAGE_COLUMN = Math.max(...USAGE_FLAGS.map(([flag]) => flag.length)) + 2;
const USAGE_FLAG_BLOCK = USAGE_FLAGS.flatMap(([flag, ...lines]) => lines.map((line, i) => `  ${(i === 0 ? flag : "").padEnd(USAGE_COLUMN)}${line}\n`)).join("");

export const YAK_USAGE = `Usage: eris yak <command>

Commands:
  issue     A harness/tooling defect, confirmed or suspected
  suggest   An improvement to the harness: a missing capability or a better way of working
  fatal     The harness itself is broken

  status    Whether this org has a destination for its yaks
  discover  The Linear teams, projects, states and labels it can file into
  config    Read or set that destination (get, set)

${USAGE_FLAG_BLOCK}
Setup: 'eris login' writes ~/.eris/yaks.json ({"url", "token"}, mode 0600;
the url defaults to https://api.sibylline.group); or export ERIS_YAKS_URL /
ERIS_YAKS_TOKEN. Until an admin sets a destination ('eris yak config set
--team <key>'), the org's yaks are accepted and parked.

Run 'eris yak <command> --help' for the full flag reference.
`;

/** The admin verbs (./yak-admin.ts): `status`, `discover`, `config get|set`.
 *  Null for a filing verb. A bare or unknown `config` word answers here. */
async function adminHandler(verb: string, rest: string[], ctx: VerbContext): Promise<((deps: YakVerbDeps) => Promise<number>) | null> {
  if (verb !== "status" && verb !== "discover" && verb !== "config") return null;
  let admin: typeof import("./yak-admin");
  try {
    admin = await import("./yak-admin");
  } catch (e) {
    if (isMissingPackage(e)) return async () => depsMissing(verb, ctx);
    throw e;
  }
  if (verb === "status") return async () => admin.runStatus(rest, ctx);
  if (verb === "discover") return async () => admin.runDiscover(rest, ctx);
  const c = groupArgs(plugin.rows, "yak config", rest);
  if ((c.kind === "bare" || c.kind === "help") && ctx.format === "json") {
    // The allow-list admits `config` for its json subs; the group itself has no rendering.
    return async () => {
      ctx.stderr.write(renderFailureBlock({ slug: "output-json-unsupported", what: "eris yak config has no JSON rendering", fix: "use: eris --output json yak config get" }, ctx.erisDir));
      throw new CliExit(1);
    };
  }
  if (c.kind === "bare" || c.kind === "help") {
    return async () => {
      ctx.stdout.write(CONFIG_USAGE);
      return 0;
    };
  }
  if (c.kind === "unknown") {
    return async () => {
      ctx.stderr.write(renderFailureBlock({ slug: "yak-unknown-verb", what: `unknown yak config command '${c.sub}'`, fix: "use one of: get, set" }, ctx.erisDir));
      throw new CliExit(1);
    };
  }
  return async () => (c.sub === "get" ? admin.runConfigGet(c.rest, ctx) : admin.runConfigSet(c.rest, ctx));
}

const CONFIG_USAGE = `Usage: eris yak config <command>

Commands:
  get     Show where this org's yaks are filed
  set     Set where this org's yaks are filed (an org admin's):
          --team <id|key|name> [--project <id|name|none>] [--state <id|name|none>]
          [--labels <id|name,...>]

Names resolve against 'eris yak discover'. An org's first set needs --team.
`;

/** A bun "cannot resolve a package" error, read from its structured fields. */
function isMissingPackage(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const { code, specifier } = e as Record<string, unknown>;
  return (
    (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") &&
    typeof specifier === "string" &&
    !/^(\.|\/|[a-z][a-z0-9+.-]*:)/i.test(specifier)
  );
}

function depsMissing(verb: string, ctx: VerbContext): number {
  const what = "eris's node_modules is missing (or incomplete) — 'eris yak' cannot run its TypeScript core without it";
  if (ctx.format === "json") {
    const record = { verb, delivered: false, redactions: { count: 0, classes: [], skipped: false }, error: { slug: "yak-deps-not-installed", reason: what } };
    ctx.stdout.write(`${JSON.stringify(record)}\n`);
  } else {
    ctx.stderr.write(renderFailureBlock({ slug: "yak-deps-not-installed", what, fix: `from ${ctx.erisDir}, run: bun install` }, ctx.erisDir));
  }
  return 0;
}

export async function runYakVerb(args: string[], ctx: VerbContext, deps: YakVerbDeps = {}): Promise<number> {
  const g = groupArgs(plugin.rows, "yak", args);
  if (g.kind === "bare" || g.kind === "help") {
    ctx.stdout.write(YAK_USAGE);
    return 0;
  }
  if (g.kind === "unknown") {
    ctx.stderr.write(
      renderFailureBlock(
        { slug: "yak-unknown-verb", what: `unknown yak command '${g.sub}'`, fix: "use one of: issue, suggest, fatal, status, discover, config\nrun 'eris yak --help' for the full command list" },
        ctx.erisDir,
      ),
    );
    throw new CliExit(1);
  }
  const verb = g.sub;
  const admin = await adminHandler(verb, g.rest, ctx);
  if (admin !== null) return admin(deps);

  let runYak: RunYak;
  try {
    runYak = await (deps.load ?? (async () => (await import("./yak")).runYak))();
  } catch (e) {
    if (isMissingPackage(e)) return depsMissing(verb, ctx);
    throw e;
  }

  const result = await runYak({
    argv: [verb, ...g.rest],
    env: {
      ...ctx.env,
      ERIS_DIR: ctx.erisDir,
      ERIS_OUTPUT: ctx.format,
      ERIS_YAK_SHELL_ID: String(deps.ppid ?? process.ppid),
    },
    home: ctx.env.HOME ?? homedir(),
    cwd: deps.cwd,
  });
  if (result.stdout.length > 0) ctx.stdout.write(result.stdout);
  if (result.stderr.length > 0) ctx.stderr.write(result.stderr);
  return result.exitCode;
}
