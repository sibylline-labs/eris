#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * eris.ts — the `eris` command an install of this package links (package.json
 * `bin`): `npm i -g`, `bun add -g`, `npx`, `bunx`.
 *
 * A checkout starts through the POSIX shim, `eris`. An installed package has no
 * shell to run, so this file's shebang is the entrypoint, and it keeps the
 * shim's invariants (the shim's header says why each exists):
 *
 *   - bun never reads the caller's cwd: `--no-env-file` stops it loading a
 *     service dir's generated `.env`, and `--config=/dev/null` stops a cwd
 *     `bunfig.toml` preload from running. A bare `#!/usr/bin/env bun` does
 *     neither. `env -S` is what splits the flags out of one shebang line.
 *   - BUN_CONFIG_VERBOSE_FETCH never reaches a fetch. The shim removes it
 *     before bun starts; this file refuses to run under it
 *     (`eris-verbose-fetch-set`) rather than print a bearer token.
 *   - The install root is the package: src/runtime/home.ts resolves it from its
 *     own location, so the symlink an install links this file under changes
 *     nothing.
 *
 * `src/main.ts` runs itself only when it is the entry, so this calls
 * `runProgram`. The refusal comes first and `src/main` is imported after it:
 * nothing of the program is evaluated under the variable.
 *
 * tests/bin.test.ts pins each of these.
 */

import { reportFailure } from "../ts/lib/eris-fail";

if (process.env.BUN_CONFIG_VERBOSE_FETCH !== undefined) {
  // Not `process.exit`: the exit code is set and the stream left to drain, as src/main.ts does.
  process.exitCode = reportFailure({
    slug: "eris-verbose-fetch-set",
    what: "BUN_CONFIG_VERBOSE_FETCH is set — under it bun prints every fetch, Authorization bearer and body included, to stderr",
    fix: "unset BUN_CONFIG_VERBOSE_FETCH, or run: env -u BUN_CONFIG_VERBOSE_FETCH eris <command>",
  });
} else {
  const { runProgram } = await import("../src/main");
  runProgram();
}
