/**
 * build-child.ts — `build()` in a child bun process, for a suite that needs a
 * compiled binary.
 *
 * A compile in the test process is not repeatable across test files: on Linux
 * (bun 1.3.13, linux-x64 runner and a linux container) a later file's
 * `Bun.build` fails with `EBADF` / `Unexpected reading file` on a module an
 * earlier file's compile read, while each file alone passes. One process per
 * build shares no bundler state with the suite or with another build.
 *
 *   buildInChild({ module: join(root, "build.ts"), outfile, tag: "v0.0.1" })
 *
 * `module` is the file of a build, an absolute path to a module that exports
 * `BUILD`, the `BuildOptions` to build with (examples/distribution/build.ts and
 * scripts/build.ts are two). The rest of the spec is passed to `build()` over
 * those. Refusals that throw before bundling still run in-process: they never
 * reach `Bun.build`.
 *
 * Like `bun test` itself this is for a checkout: the child runs the build
 * module under the bun that runs the tests. Never import it from the program.
 */

import { spawnSync } from "node:child_process";
import { dirname, isAbsolute } from "node:path";
import { build, type BuildOptions, type BuildResult } from "../src/build";

export interface ChildBuild {
  /** Absolute path of a module exporting `BUILD: BuildOptions`. */
  readonly module: string;
  readonly outfile: string;
  readonly tag?: string;
  readonly releaseRepo?: string;
  readonly versionExtra?: string;
  readonly docsBase?: string;
}

/** Run one build in a fresh bun; its result, or the child's stderr as the error. */
export function buildInChild(spec: ChildBuild): BuildResult {
  if (!isAbsolute(spec.module)) throw new Error(`buildInChild: module must be an absolute path: ${JSON.stringify(spec.module)}`);
  const r = spawnSync(process.execPath, ["--no-env-file", "--config=/dev/null", import.meta.path, JSON.stringify(spec)], {
    cwd: dirname(spec.module),
    encoding: "utf8",
    timeout: 170_000,
  });
  if (r.status !== 0) throw new Error(`build in a child bun failed (status ${r.status}, signal ${r.signal}):\n${r.stderr}`);
  return JSON.parse(r.stdout) as BuildResult;
}

if (import.meta.main) {
  const { module, ...rest } = JSON.parse(process.argv[2] ?? "{}") as ChildBuild;
  const { BUILD } = (await import(module)) as { BUILD?: BuildOptions };
  if (BUILD === undefined) throw new Error(`${module} does not export BUILD`);
  const r = await build({ ...BUILD, ...rest });
  process.stdout.write(`${JSON.stringify(r)}\n`);
}
