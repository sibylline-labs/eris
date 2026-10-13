# yaml-parity fixtures

- `oracle-goldens.json`: the frozen answers of the oracles the TS output pre-pass and
  failure block were diffed against. It holds the `bashRepo` and `errorsReport` entries
  the suite reads.

## oracle-goldens.json is FROZEN

eris was first written in Bash, and the TypeScript port had to reproduce that
implementation's output byte for byte. The Bash implementation and the yq it ran on are
not part of this repository, so the bun tests that used them as an oracle read this file
through `tests/helpers/frozen-oracle.ts`, which answers from it alone: a call with no
entry throws, so it never skips and never falls back to a live tool.

**Provenance.** The answers were recorded from the Bash implementation's output pre-pass
(`output::parse_global`) and failure block (`eris::report`), the last version before the
port replaced them. The tools were:

- yq `v4.53.2` (mikefarah).
- The `bash` first on PATH on macOS, which was Homebrew bash 5.
- `LC_ALL=C` wherever the live oracle set it.

The answers cannot be regenerated from this repository. They are the reference the
TypeScript output is held to, so a change to that output is a change to the contract
(`docs/OUTPUT-CONTRACT.md`), never a reason to re-record.

**The programs, verbatim.** Each entry's `op` names one:

| op | what ran |
|---|---|
| `bashRepo` | `bash -c <script> bash <args…>` from the Bash checkout, with only `PATH` and `ERIS_DIR` set (the script sources the output pre-pass and calls `output::parse_global`) |
| `errorsReport` | `eris::report "$@" 1>/dev/null` with the failure-block library sourced (stderr and status) |

**Keys are content-addressed.** Each key is the sha256 of the op and its inputs, so
changing an input yields "no golden", never a stale answer. `<ERIS>` in an answer
stands for the checkout and is substituted back on read.
