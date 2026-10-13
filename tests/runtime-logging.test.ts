/**
 * src/runtime/logging.ts.
 *
 * When the TS diagnostics drift from the line prefixes consumers parse
 * (docs/OUTPUT-CONTRACT.md §1: `ERROR `, `WARN `, `INFO `, `INFO ✓ `, each line
 * on stderr and `\n`-terminated), these go red. The expected bytes are the
 * contract's, the same ones the deleted Bash `eris::die/warn/info/ok`
 * (`printf '<PREFIX> %s\n'`) wrote.
 */

import { describe, it, expect } from "bun:test";
import { die, info, ok, warn, type LogSink } from "../src/runtime/logging";

/** The contract's prefix per logger. */
const PREFIX = { die: "ERROR ", warn: "WARN ", info: "INFO ", ok: "INFO ✓ " } as const;

function sink(): LogSink & { text: string } {
  const s = {
    text: "",
    write(chunk: string) {
      s.text += chunk;
      return true;
    },
  };
  return s;
}

const MESSAGES = ["plain message", "percent %s and \\n backslash", "multi\nline", "", "unicode ✓ → ok"];

describe("logging — the output contract's line prefixes", () => {
  for (const [fn, emit] of [
    ["warn", warn],
    ["info", info],
    ["ok", ok],
  ] as const) {
    for (const msg of MESSAGES) {
      it(`${fn}(${JSON.stringify(msg)}) is one prefixed line, the message verbatim`, () => {
        const s = sink();
        emit(msg, s);
        expect(s.text).toBe(`${PREFIX[fn]}${msg}\n`);
      });
    }
  }

  it("die writes the ERROR line and exits 1", () => {
    const msg = "cannot read 'x': %d";
    const s = sink();
    let code: number | undefined;
    expect(() =>
      die(msg, s, (c) => {
        code = c;
        throw new Error("exited");
      }),
    ).toThrow("exited");
    expect(code).toBe(1);
    expect(s.text).toBe(`ERROR ${msg}\n`);
  });
});
