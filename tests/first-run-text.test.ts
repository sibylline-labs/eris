/**
 * The first-run texts a newcomer or an agent reads, BLACK-BOX through the real `eris` entrypoint.
 * Red when `events list --help` stops naming the products the gateway accepts (the 400 then says
 * nothing a caller can act on), or when Start here says login pulled a policy it may not have.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type Sandbox, sandbox } from "./helpers/blackbox";

setDefaultTimeout(60_000);

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox("eris-first-run-text-");
});
afterEach(() => {
  sb.cleanup();
});

describe("first-run text", () => {
  // admits: a caller guessing a product name (logfire) and getting a bare 400; the rendered --help bytes
  test("events list --help names every product", async () => {
    const r = await sb.run(["events", "list", "--help"]);
    expect(r.status).toBe(0);
    for (const product of ["accounts", "yak", "graph", "socrates", "linear-proxy", "gates", "bus", "mandate"]) {
      expect(r.stdout).toContain(product);
    }
  });

  // admits: Start here promising a pulled policy after a login whose pull warned; the rendered --help bytes
  test("Start here does not claim login already pulled the policy", async () => {
    const r = await sb.run(["--help"]);
    expect(r.stdout).toContain("Start here");
    expect(r.stdout).not.toContain("login already pulled");
    expect(r.stdout).toContain("eris doctrine pull");
  });
});
