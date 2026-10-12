/**
 * logging.ts — the four diagnostics, as the earlier Bash implementation
 * printed them:
 *
 *   eris::die()  { printf 'ERROR %s\n' "$1" >&2; exit 1; }
 *   eris::warn() { printf 'WARN %s\n'  "$1" >&2; }
 *   eris::info() { printf 'INFO %s\n'  "$1" >&2; }
 *   eris::ok()   { printf 'INFO ✓ %s\n' "$1" >&2; }
 *
 * Byte-identical, stderr only, unconditional (no TTY or colour branch): this
 * is the `LEVEL<space>message` shape docs/OUTPUT-CONTRACT.md §1/§4 pins and
 * consumers line-prefix-parse. `tests/runtime-logging.test.ts` holds every
 * function to those bytes. The sink is injectable for tests; it defaults to
 * process.stderr and is NEVER stdout.
 */

export interface LogSink {
  write(chunk: string): unknown;
}

export type ExitFn = (code: number) => never;

const defaultExit: ExitFn = (code) => process.exit(code);

export function warn(msg: string, sink: LogSink = process.stderr): void {
  sink.write(`WARN ${msg}\n`);
}

export function info(msg: string, sink: LogSink = process.stderr): void {
  sink.write(`INFO ${msg}\n`);
}

export function ok(msg: string, sink: LogSink = process.stderr): void {
  sink.write(`INFO ✓ ${msg}\n`);
}

/** `eris::die` — the ERROR line, then exit 1. Prefer `emitFailureAndExit`
 *  (ts/lib/eris-fail.ts) for anything an operator must act on: an unslugged
 *  die carries no `slug:`/`docs:` pointer. */
export function die(msg: string, sink: LogSink = process.stderr, exit: ExitFn = defaultExit): never {
  sink.write(`ERROR ${msg}\n`);
  return exit(1);
}
