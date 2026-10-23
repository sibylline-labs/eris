/**
 * ts-verb.ts — the steps between argv and a verb's dispatcher, for a verb the
 * router runs in TypeScript:
 *
 *   1. the global `--output` parse
 *   2. the machine-surface allow-list
 *   3. the entitlement lock, for a plugin group whose product is not bought
 *   4. the verb, with the flag stripped
 *
 * A verb stops early by throwing `CliExit` after writing its diagnostic, the
 * TS counterpart of `eris::die` / `eris::fail` exiting the shell.
 *
 * A `session` (src/cli/compose.ts) supplies the composed allow-list, its fix
 * text and the locks, and is handed on to the verb; without one, steps 2 and 3
 * read core's registry alone.
 *
 * Everything past step 3 is imported lazily, so a package the checkout's
 * node_modules cannot resolve surfaces from inside step 4. It ends the command
 * as the `eris-deps-not-installed` block, never a bare resolution
 * error. Nothing on this path or above it may import a third-party package, or
 * the block could not be reached.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, join, relative, sep } from "node:path";
import { ErisError, renderFailureBlock } from "../../ts/lib/eris-fail";
import type { CliContext, VerbHandler } from "../main";
import { asksForHelp, CliExit, GlobalFlagError, parseGlobal } from "./args";
import { lockedOutcome, lockedProduct, type Session } from "./compose";
import { sanitizeDisplay, unsupportedJsonBlock } from "./output";

export { CliExit };

/** `command -v <name>` over PATH, for an executable file. */
export function onPath(name: string, env: Record<string, string | undefined>): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** What bun sets on the error for a module it could not find: `import` and
 *  `require` use different codes, and neither error is an `Error` subclass. */
const NOT_FOUND_CODES = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

/** A bare package name, as opposed to a path (`./x`, `/x`) or a scheme (`node:x`). */
const NOT_A_PACKAGE = /^(\.|\/|[a-z][a-z0-9+.-]*:)/i;

/**
 * The failure block for a thrown value that is bun failing to resolve a
 * PACKAGE, else null. A missing relative module is a defect in the checkout's
 * own source and stays a crash: telling an operator to `bun install` for it
 * would send them away from the bug. It reads the error's structured fields,
 * never its message text.
 *
 * It names the fix and does not run it: an inline `bun install` is unbounded
 * and reaches the network mid-command, the same reason `eris yak` refuses to
 * run one.
 */
export function missingDependencyBlock(e: unknown, erisDir: string): string | null {
  if (typeof e !== "object" || e === null) return null;
  const { code, specifier, referrer } = e as Record<string, unknown>;
  if (typeof code !== "string" || !NOT_FOUND_CODES.has(code)) return null;
  if (typeof specifier !== "string" || NOT_A_PACKAGE.test(specifier)) return null;
  const rel = typeof referrer === "string" && referrer.startsWith(`${erisDir}${sep}`) ? relative(erisDir, referrer) : referrer;
  const by = typeof rel === "string" && rel !== "" ? ` (needed by ${sanitizeDisplay(rel)})` : "";
  return renderFailureBlock(
    {
      slug: "eris-deps-not-installed",
      what: `eris's node_modules is missing or out of date — cannot resolve '${sanitizeDisplay(specifier)}'${by}`,
      fix: `from ${erisDir}, run: bun install --frozen-lockfile`,
    },
    erisDir,
  );
}

export async function runTsVerb(
  verb: string,
  argv: readonly string[],
  ctx: CliContext,
  handlers: Readonly<Record<string, () => Promise<VerbHandler>>>,
  session?: Session,
): Promise<number> {
  try {
    let parsed: ReturnType<typeof parseGlobal>;
    try {
      parsed = parseGlobal(argv, ctx.erisDir, { keepTerminator: true });
    } catch (e) {
      if (e instanceof GlobalFlagError) {
        ctx.stderr.write(e.block);
        return 1;
      }
      throw e;
    }
    const refusal = unsupportedJsonBlock(parsed.argv[0], parsed.argv[1], parsed.format, ctx.erisDir, session?.cli.jsonSurfaces, session?.cli.jsonFix);
    if (refusal !== null) {
      ctx.stderr.write(refusal);
      return 1;
    }
    if (session !== undefined) {
      const product = lockedProduct(session, verb);
      if (product !== undefined) {
        const out = lockedOutcome(session, product, parsed.argv, asksForHelp(parsed.argv), ctx.erisDir);
        ctx[out.stream].write(out.text);
        return out.rc;
      }
    }
    const load = handlers[verb];
    if (!load) throw new Error(`no TypeScript handler for '${verb}'`);
    const handler = await load();
    return await handler(parsed.argv.slice(1), { ...ctx, format: parsed.format, ...(session !== undefined ? { session } : {}) });
  } catch (e) {
    if (e instanceof CliExit) return e.code;
    if (ErisError.isErisError(e)) {
      ctx.stderr.write(e.renderFailureBlock(ctx.erisDir));
      return e.exitCode;
    }
    const block = missingDependencyBlock(e, ctx.erisDir);
    if (block === null) throw e;
    ctx.stderr.write(block);
    return 1;
  }
}
