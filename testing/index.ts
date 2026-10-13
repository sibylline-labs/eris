/**
 * `eris/sdk/testing`: the test helpers a distribution's own suites reuse
 * instead of copying (docs/dev/PLUGINS.md#testing-a-distribution).
 *
 *   - `createFakeRunner`, `FakeRunner`: a `Runner` (eris/sdk) that records its
 *     calls and answers from a function;
 *   - `buildInChild`: `build()` in a child bun, one process per compile.
 *
 * Separate from `eris/sdk` and outside src/ so a binary never carries it: the
 * `runtime-imports-no-testing` rule keeps src/, ts/ and plugins/ from importing
 * it, and `distribution-imports-sdk-only` does the same for a distribution's
 * source in this repository.
 */

export { buildInChild, type ChildBuild } from "./build-child";
export { createFakeRunner, type FakeRunner } from "./fake-runner";
