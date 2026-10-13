/**
 * `build()` in a child bun process, for a suite that needs a compiled binary.
 *
 * A compile in the test process is not repeatable across test files: on Linux
 * (bun 1.3.13, linux-x64 runner and a linux container) a later file's
 * `Bun.build` fails with `EBADF` / `Unexpected reading file` on a module an
 * earlier file's compile read, while each file alone passes. One process per
 * build shares no bundler state with the suite or with another build.
 *
 *   buildInChild({ preset: "core", outfile, tag: "v0.0.1" })
 *
 * `core` is this repository's build (scripts/build.ts's options);
 * `distribution` is examples/distribution's `BUILD`. The rest of the spec is
 * passed to `build()` over it. Refusals that throw before bundling still run
 * in-process: they never reach `Bun.build`.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { BUILD } from "../../examples/distribution/build";
import { PLUGINS } from "../../plugins";
import { build, type BuildOptions, type BuildResult } from "../../src/build";

const REPO = join(import.meta.dir, "..", "..");

export interface ChildBuild {
  readonly preset: "core" | "distribution";
  readonly outfile: string;
  readonly tag?: string;
  readonly releaseRepo?: string;
  readonly versionExtra?: string;
  readonly docsBase?: string;
}

/** Run one build in a fresh bun; its result, or the child's stderr as the error. */
export function buildInChild(spec: ChildBuild): BuildResult {
  const r = spawnSync(process.execPath, ["--no-env-file", "--config=/dev/null", import.meta.path, JSON.stringify(spec)], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 170_000,
  });
  if (r.status !== 0) throw new Error(`build in a child bun failed (status ${r.status}, signal ${r.signal}):\n${r.stderr}`);
  return JSON.parse(r.stdout) as BuildResult;
}

if (import.meta.main) {
  const { preset, ...rest } = JSON.parse(process.argv[2] ?? "{}") as ChildBuild;
  const base: BuildOptions = preset === "distribution" ? BUILD : { entry: join(REPO, "src/main.ts"), root: REPO, plugins: PLUGINS };
  const r = await build({ ...base, ...rest });
  process.stdout.write(`${JSON.stringify(r)}\n`);
}
