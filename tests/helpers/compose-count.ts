/**
 * Prints how many times `composeCli` ran after the example distribution was imported: the
 * distribution's own composition, plus any core composes at import. Run in a fresh process
 * by tests/distribution.test.ts, because a test process has already imported core.
 */
import { spyOn } from "bun:test";
import * as compose from "../../src/cli/compose";

const spy = spyOn(compose, "composeCli");
await import("../../examples/distribution/main");
process.stdout.write(`${spy.mock.calls.length}\n`);
