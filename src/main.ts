/**
 * main.ts — the eris program, reached through the `eris` shim.
 *
 * One decision per command line (src/cli/router.ts): a TS-routed command runs
 * in this process behind the global `--output` pre-pass; anything else is
 * refused as an unknown command, behind the same pre-pass.
 *
 * The shim hands over its logical directory through a private variable,
 * removed before anything is spawned. The shim has already removed
 * BUN_CONFIG_VERBOSE_FETCH (see its header): it cannot be removed from here,
 * because bun reads it from its own environment at fetch time and
 * `delete process.env.X` does not reach that. Before any of that,
 * `~/.eris/settings.json` fills unset variables in this process's environment
 * (src/runtime/settings.ts). Everything past the router is imported lazily.
 *
 * The commands are core's registry composed with the build's plugin list,
 * plugins/index.ts (src/cli/compose.ts). Another distribution composes its own
 * list and calls `runProgram({ cli })` from its entry; a test hands `main` a
 * composition directly.
 *
 * `erisDir` is the shim's directory when the shim ran, else the install root
 * (src/runtime/home.ts): the checkout, a distribution's own root when its entry
 * named one (`runProgram({ installRoot })`), or a compiled binary's asset home. A
 * binary never reads `_ERIS_SHIM_DIR`: only the shim sets it, and a stray value
 * in a caller's environment must not move the files the binary reads.
 */

import { PLUGINS } from "../plugins";
import { asksForHelp, locateVerb } from "./cli/args";
import { type Cli, composeCli, NO_ENTITLEMENTS, type Session } from "./cli/compose";
import { sanitizeDisplay } from "./cli/output";
import { ARGV_SHAPES_NO_ASSETS, REGISTRY } from "./cli/registry";
import { route, type Impl } from "./cli/router";
import { adoptSourceIdentity, adoptSourceRoot, adoptUnwrittenHome, type DistributionIdentity, HomeUnwritableError, isCompiled, resolveInstallRoot } from "./runtime/home";
import { warn } from "./runtime/logging";
import { applySettings } from "./runtime/settings";

export const SHIM_ENV = ["_ERIS_SHIM_DIR"] as const;

export interface Sink {
  write(chunk: string): unknown;
}

export interface CliContext {
  /** The logical install root: the shim's directory, a distribution's declared root, or a binary's asset home. */
  erisDir: string;
  /** The caller's environment, shim variables removed. */
  env: Record<string, string | undefined>;
  stdout: Sink;
  stderr: Sink;
}

/** What a handler is called with: the command line's context, its output
 *  format, and the session it runs in (absent when a test calls a handler directly). */
export type VerbContext = CliContext & { format: "text" | "json"; session?: Session };

export type VerbHandler = (args: string[], ctx: VerbContext) => Promise<number>;

/** The TS implementation of each `ts` row in src/cli/registry.ts, plus the
 *  argv shapes: the bare program and `-h`/`--help` print the top-level usage. */
export const HANDLERS: Readonly<Record<string, () => Promise<VerbHandler>>> = {
  "": async () => (await import("./cli/commands/usage")).runUsage,
  "-h": async () => (await import("./cli/commands/usage")).runUsage,
  "--help": async () => (await import("./cli/commands/usage")).runUsage,
  "--version": async () => (await import("./cli/commands/version")).runVersion,
  completion: async () => (await import("./cli/commands/completion")).runCompletion,
  update: async () => (await import("./cli/commands/update")).runUpdate,
};

/** Core composed with the build's plugin list. */
export const CLI: Cli = composeCli(REGISTRY, HANDLERS, PLUGINS);

/** The handler an unknown verb reaches, after the global pre-pass. */
export const UNKNOWN_VERB = "\0unknown";

const unknownCommand =
  (verb: string): VerbHandler =>
  async (_args, ctx) => {
    ctx.stderr.write(`ERROR Unknown command: ${sanitizeDisplay(verb)}. Run 'eris --help'\n`);
    return 1;
  };

export interface MainOptions {
  /** The composed commands; `CLI` when absent. */
  cli?: Cli;
  /** The products this workspace has bought; `NO_ENTITLEMENTS` when absent. */
  entitlements?: ReadonlySet<string>;
  /** Overrides the composition's router table. */
  table?: Readonly<Record<string, Impl>>;
  stdout?: Sink;
  stderr?: Sink;
}

/**
 * A command line that reads nothing from the install root: usage, a `--help`
 * ahead of any `--`, `--version`, and `completion`. A binary whose asset home cannot be
 * written still runs these, because they are what an operator reaches for to
 * find out how to fix it (and `completion` runs on every shell start). Every
 * other command line is refused with `eris-cache-unwritable`. Only consulted
 * after the write failed, so a mistake here never reaches a writable cache: a
 * command wrongly left out gets the block, and one wrongly put in fails on its
 * own missing file instead of the block.
 */
export function readsNoAssets(argv: readonly string[]): boolean {
  const verb = locateVerb(argv)[0];
  return verb === "completion" || (verb !== undefined && ARGV_SHAPES_NO_ASSETS.includes(verb)) || asksForHelp(argv);
}

/**
 * The command's `erisDir`, or null once `eris-cache-unwritable` has been
 * written to `stderr` for a command line that needs the asset home.
 */
async function resolveErisDir(argv: readonly string[], rawEnv: Record<string, string | undefined>, stderr: Sink): Promise<string | null> {
  if (!isCompiled && rawEnv._ERIS_SHIM_DIR) return rawEnv._ERIS_SHIM_DIR;
  try {
    return await resolveInstallRoot(rawEnv);
  } catch (e) {
    if (!(e instanceof HomeUnwritableError)) throw e;
    if (readsNoAssets(argv)) {
      adoptUnwrittenHome(e.home);
      return e.home;
    }
    const { renderFailureBlock } = await import("../ts/lib/eris-fail");
    stderr.write(
      renderFailureBlock(
        {
          slug: "eris-cache-unwritable",
          what: `eris cannot write its asset cache under ${sanitizeDisplay(e.base)}: ${sanitizeDisplay(e.reason)}`,
          fix:
            "set ERIS_CACHE_DIR to a directory eris can write (it keeps one copy of the files compiled into the binary there, per build)\n" +
            "or set XDG_CACHE_HOME: eris uses $XDG_CACHE_HOME/eris, default ~/.cache/eris",
        },
        null,
      ),
    );
    return null;
  }
}

export async function main(
  argv: readonly string[],
  rawEnv: Record<string, string | undefined> = process.env,
  opts: MainOptions = {},
): Promise<number> {
  const env: Record<string, string | undefined> = { ...rawEnv };
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const erisDir = await resolveErisDir(argv, rawEnv, stderr);
  if (erisDir === null) return 1;
  for (const k of SHIM_ENV) delete env[k];

  const cli = opts.cli ?? CLI;
  const session: Session = { cli, entitled: opts.entitlements ?? NO_ENTITLEMENTS };
  const r = route(argv, opts.table ?? cli.table);

  const { runTsVerb } = await import("./cli/ts-verb");
  if (r.kind === "unknown") {
    return runTsVerb(UNKNOWN_VERB, argv, { erisDir, env, stdout, stderr }, { [UNKNOWN_VERB]: async () => unknownCommand(r.verb) }, session);
  }
  return runTsVerb(r.verb, argv, { erisDir, env, stdout, stderr }, cli.handlers, session);
}

/**
 * End with `code` once both streams have drained, so a pipe reader gets every
 * byte. The process is left to exit on its own: bun writes to a pipe
 * asynchronously, and an explicit `process.exit` — even from an empty write's
 * callback — dropped the tail of a large stdout under load (measured: 12
 * concurrent `migrate pragma` dry runs, 38 KB each, cut at 21–37 KB).
 * The unref'd timer only fires if something else is keeping the loop alive.
 */
function exitAfterFlush(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 10_000).unref();
}

export interface ProgramOptions extends Pick<MainOptions, "cli" | "entitlements"> {
  /**
   * The distribution's root, an absolute path: what a run from source reads its
   * files from and names its docs under (`ctx.erisDir`, a failure block's local
   * `docs:` line), in place of this package's directory. Pass the directory
   * `build()` takes as `root`, so a run from source and the binary read the
   * same relative paths. A compiled binary ignores it (its asset home is its
   * root), and the shim's `_ERIS_SHIM_DIR` wins over it.
   */
  installRoot?: string;
  /**
   * Who the distribution is (`releaseRepo`, `versionExtra`, `docsBase`), for a
   * run from source: what `eris --version` prints, the repository `eris update`
   * and `releaseRepo()` name, and the base of a failure block's second `docs:`
   * line, in place of this repository's. Pass the values `build()` is given, so a
   * run from source and the binary say the same. Checked as `build()` checks
   * them. A compiled binary keeps the identity its build baked, whatever is
   * passed here; no environment variable moves either.
   */
  identity?: DistributionIdentity;
}

/** The process entry: this file's own when run, and a distribution's. */
export function runProgram(opts: ProgramOptions = {}): void {
  const { installRoot: root, identity, ...mainOpts } = opts;
  if (root !== undefined) adoptSourceRoot(root);
  if (identity !== undefined) adoptSourceIdentity(identity);
  // A compiled binary has no shim to unset BUN_CONFIG_VERBOSE_FETCH before bun
  // starts, and `delete` does not reach bun's reader — but an assignment does:
  // "0" turns verbose fetch off for this process (measured, bun 1.3.13).
  // Pinned against the binary by tests/compiled-binary.test.ts under ERIS_BIN.
  if (process.env.BUN_CONFIG_VERBOSE_FETCH !== undefined) process.env.BUN_CONFIG_VERBOSE_FETCH = "0";
  // Into process.env itself, before routing: TS verbs and their spawns read it
  // directly.
  applySettings(process.env, (msg) => warn(msg));
  // Held until `main` settles. Bun does not count every pending native
  // operation as keeping the loop alive — an awaited `crypto.subtle.digest`
  // is one (observed: `eris yak` under load ended at exit 0 with nothing
  // written, mid idempotency-key digest) — and a loop that drains
  // with `main` still pending ends the process as a silent success.
  const hold = setInterval(() => {}, 1 << 30);
  main(process.argv.slice(2), process.env, mainOpts).finally(() => clearInterval(hold)).then(exitAfterFlush, (e) => {
    process.stderr.write(`ERROR ${e instanceof Error ? e.message : String(e)}\n`);
    exitAfterFlush(1);
  });
}

if (import.meta.main) runProgram();
