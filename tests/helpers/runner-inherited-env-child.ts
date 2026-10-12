/**
 * One `nodeRunner.run(["env"])` with the INHERITED environment, for
 * tests/runtime-process.test.ts: `bun runner-inherited-env-child.ts`.
 *
 * It runs in its own process because the case needs BUN_CONFIG_VERBOSE_FETCH in
 * the parent's environment, and bun keeps that setting once its process has seen
 * it (a `delete process.env.X` does not reach it): set inside `bun test`, every
 * later fetch in the run dumps its request headers, bearer tokens included.
 *
 * Prints one JSON line: the child's `env` output and this process's own value
 * of the variable after the run.
 */

import { nodeRunner } from "../../src/runtime/process";

const r = await nodeRunner.run(["env"], { timeoutMs: 5000 });
process.stdout.write(`${JSON.stringify({ kind: r.kind, env: r.stdout.toString(), own: process.env.BUN_CONFIG_VERBOSE_FETCH ?? null })}\n`);
