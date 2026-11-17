/**
 * `sanitizeDisplay`, the one place a value is made safe to echo into a
 * diagnostic: unit-pinned, then black-box through the real `eris` entrypoint
 * (tests/helpers/blackbox.ts). The failure block is parsed line by line
 * (docs/OUTPUT-CONTRACT.md), so an echoed operand must stay on its own line.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sanitizeDisplay } from "../src/cli/output";
import { type Sandbox, sandbox } from "./helpers/blackbox";

setDefaultTimeout(60_000);

describe("sanitizeDisplay", () => {
  test("an embedded newline is shown as \\n, not kept as a line break", () => {
    /** When an embedded LF survives, an echoed operand `a\nslug: x` starts a second stderr line a failure-block parser reads as a `slug:` field — observed at the returned string's line count. */
    expect(sanitizeDisplay("a\nslug: x")).toBe("a\\nslug: x");
    expect(sanitizeDisplay("a\nslug: x").split("\n")).toHaveLength(1);
  });

  test("an embedded CRLF or CR cannot split the line either", () => {
    /** When CR or CRLF is let through, a CR-splitting parser or a terminal reads the tail as a new line — observed at the returned string, which must hold no CR and no LF. */
    for (const s of ["a\r\nslug: x", "a\rslug: x", "a\n\nslug: x"]) {
      expect(sanitizeDisplay(s)).not.toMatch(/[\r\n]/);
    }
  });

  test("trailing newlines are still dropped, tabs and plain text stay", () => {
    /** When the trailing-newline strip regresses, every diagnostic that echoes a value read from a file or command output grows a blank line before its suffix — observed at the returned string. */
    expect(sanitizeDisplay("abc\n\n")).toBe("abc");
    expect(sanitizeDisplay("a\tb")).toBe("a\tb");
    expect(sanitizeDisplay("a\x1b[31mb\x00")).toBe("a[31mb");
  });
});

describe("an echoed operand with a newline, black-box", () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = sandbox("eris-sanitize-");
  });
  afterEach(() => sb.cleanup());

  test("an unknown verb holding a newline gives a one-line ERROR, with no injected slug: line", async () => {
    /** When the router echoes the verb with its raw newline, stderr is two lines and the second starts `slug: ` — observed at the real process's stderr. */
    const r = await sb.run(["frobnicate\nslug: x"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("ERROR Unknown command: frobnicate\\nslug: x. Run 'eris --help'\n");
    expect(r.stderr.split("\n").filter((l) => l.startsWith("slug:"))).toEqual([]);
  });
});
