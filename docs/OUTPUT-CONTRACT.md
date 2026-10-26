# The eris output contract

What eris writes, where it writes it, and which parts of that a program may
depend on. This is a **contract**, not a description: the shapes below are the
ones consumers parse, and they are pinned black-box by
`tests/output-contract.test.ts`.

---

## 1. The stream split

**stdout is the payload. stderr is everything else. They never merge.**

| Stream | Carries | Who reads it |
|---|---|---|
| **stdout** | the command's output, and nothing else: the rendered view, the JSON document, the emitted completion script | a pipe, a `$( )`, a program |
| **stderr** | every diagnostic: `INFO` / `WARN` lines, success (`INFO ✓ …`) included (`src/runtime/logging.ts`), progress lines, interactive prompts, deprecation warnings, and the whole failure block (§4) | a human, or a log |

Consequences a caller may rely on:

- A command that produces no payload writes **nothing at all** to stdout. A
  failure writes nothing to stdout — the failure is entirely on stderr plus the
  exit code.
- Progress and success chatter never contaminates a captured value. `vid="$(eris
  … )"` gets the value, never the "✓ …" line that accompanied it.
- Nothing on stdout is ever *only* human-readable in a way stderr already said.
  If both a table and a note exist, the table is the payload and the note is a
  diagnostic.

**One scoped exception:** `eris yak issue|suggest|fatal` under `--output
json` writes nothing to stderr at all, on any outcome — a stricter rule than
"stderr carries every diagnostic" above, and deliberately scoped to that one
surface rather than generalized. See [§3's yak row](#3-machine-surfaces) and
[YAK.md](YAK.md#--output-json) for what moved onto the stdout record instead
so nothing is lost.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | hard failure (an unslugged `ERROR` line, or the §4 failure block) |
| `2` | **idempotent no-op** — nothing was written and this is not an error, where a command documents one. The payload is emitted either way |
| `10` | **an update is available**, from `eris update --check` only. Not a failure: the answer a script asked for |

`2` and `10` never mean failure. A consumer that treats "non-zero" as "broken" will
report a successful no-op, or an available update, as an incident.

### ANSI

ANSI escape sequences may be written to stdout **only** when all three hold:

1. stdout is a TTY, and
2. `NO_COLOR` is unset or empty ([no-color.org](https://no-color.org)), and
3. the selected output format is not `json`.

No surface in this build writes colour, so a piped run is escape-free.

stderr is not styled at all. The diagnostic helpers (`src/runtime/logging.ts`)
write plain `LEVEL message` text unconditionally, so the failure block in §4 has
one shape whatever the terminal and whatever is installed.

---

## 2. The flag

```
eris [--output text|json] <command> [args…]
```

`--output` is **global**: it is parsed once before dispatch and stripped from
the argv (`src/cli/args.ts`), for every command line: every verb runs behind it
in-process. It may appear anywhere in the command line. `--`
terminates global parsing and is itself consumed, so a positional that begins
with `--output` is still reachable.

- `text` (default) — the human rendering.
- `json` — the machine rendering.

There is deliberately **no `ERIS_OUTPUT` environment variable**. An exported
format would silently change what every script in a shell gets, including
scripts written before the variable existed; the flag is the only selector.

### `--output json` never silently degrades

A command with no JSON rendering **refuses** the flag
([`output-json-unsupported`](ERRORS.md#output-json-unsupported)) rather than
printing its human rendering. Falling back would hand a parser text and
surface as a JSON syntax error somewhere downstream, in someone else's stack
trace. The refusal names the surfaces that do accept it.

An unrecognised value is refused the same way
([`output-format-unknown`](ERRORS.md#output-format-unknown)).

---

## 3. Machine surfaces

The surfaces a program may parse. "Stable" means: changing the shape is a
breaking change, requires a deprecation path, and must update this table.

A build's plugins can add surfaces (`json: true` on a plugin's sub row,
[dev/PLUGINS.md](dev/PLUGINS.md#--output-json)). The allow-list is derived from
core and plugin rows together and fails closed: a plugin command without a json
row is refused like any other, and the refusal's fix text names each plugin
surface. A plugin's surfaces are documented with that plugin, not here.

| Surface | stdout | `--output json` | Stability |
|---|---|---|---|
| `eris completion bash\|zsh` | a valid shell script | refused | stable |
| `eris --version` | text: `eris <version> (<owner/repo>)`, then a line of the build's own if it adds one. JSON: one bare record `{version, release_repo, build_id, extra}` (`build_id` and `extra` are `null` when absent) | accepted | stable ([UPDATE.md](UPDATE.md)) |
| `eris update` | text: with `--check`, `update available: <current> -> <latest>` or `up to date: <current>`; otherwise nothing (progress and the result are `INFO` lines on stderr). JSON: one bare record `{current, latest, update_available, updated}`. Exit `0` / `10` / `1` for `--check` | accepted | stable ([UPDATE.md](UPDATE.md)) |
| `eris yak issue\|suggest\|fatal` | text: `recorded: <id>` on a fresh delivery, `already recorded: <id>` on a dedup replay, or nothing at all on a warn-class outcome (unresolved token/URL, unreachable Actor, timeout, non-2xx — see [YAK.md](YAK.md#exit-codes)); every one of those still exits `0`. JSON: one bare record — `{verb, delivered, id?, idempotency_key?, replay?, contract_version?, key_mismatch?, redactions: {count, classes, skipped}, error?}` — where **`delivered` is the field to branch on, never `id == null`**. **`--output json` on this surface additionally writes NOTHING to stderr** — a scoped exception to §1's general "stderr carries every diagnostic": `redactions.skipped` and `key_mismatch` exist specifically so the `--no-redact`/`yak-key-mismatch` WARNs that text mode prints on stderr are still recoverable from the record ([YAK.md §--output json](YAK.md#--output-json)) | accepted for all three verbs; refused for a bare `eris yak` (no verb) | stable ([YAK.md](YAK.md)) |

Everything not listed is a **human surface**. Its stdout may change shape in any
release. Parsing it is unsupported — ask for a machine surface instead.

### 3.1 No envelope

There is **no** `{data, meta, errors}` wrapper, and there deliberately will not
be one.

- The error half would duplicate what the exit code and the stderr block (§4)
  already carry, unambiguously and for every command — including the ones with
  no JSON rendering at all.
- The `meta`/version half would duplicate what consumers already pin (eris by
  version or SHA), and a payload that needs a version carries its own
  (`yak`'s `contract_version`).
- Adding one would break every existing consumer at once, to gain a field they
  would each have to learn to unwrap.

So each machine surface emits its own payload, bare. The envelope question is
**closed**, not deferred.

---

## 4. The failure block

Every failure — `renderFailureBlock` (`ts/lib/eris-fail.ts`, re-exported to
plugins by the SDK) — writes this to **stderr**, writes nothing to stdout, and
exits `1`:

```
ERROR <what failed>
slug: <slug>
fix: <line>            ← zero or more, one per line of the fix text
docs: <local path>     ← $ERIS_HOME/<relpath>
docs: <github url>     ← https://github.com/sibylline-labs/eris/blob/main/<relpath>
```

Grammar, stated exactly because consumers line-prefix-parse it:

- Field order is fixed: `ERROR`, then `slug:`, then any `fix:` lines, then the
  two `docs:` lines. The two `docs:` lines are always both present, local first.
  The local line names a file that exists, with one exception:
  [`eris-cache-unwritable`](ERRORS.md#eris-cache-unwritable), from a compiled
  binary whose asset home could not be written, has no home on disk, so its local
  line is the bare repo-relative path and the GitHub line is the readable one.
- Prefixes are **exact and include their single trailing space**: `slug: `,
  `fix: `, `docs: `. The `ERROR` line is `ERROR ` + message, with no colon.
- Exactly **one** block per failure. A failure ends the command, so it never
  produces follow-on `ERROR` lines (`tests/output-contract.test.ts`, "one
  failure yields exactly ONE block — no cascade").
- `<slug>` is a stable machine key matching `^[a-z0-9]+(-[a-z0-9]+)+$`, and is
  the anchor of a heading in [ERRORS.md](ERRORS.md). Every emitted slug has a
  heading — pinned by `tests/errors-doc.test.ts`. Slugs are stable once
  shipped.
- `fix:` lines are literal; multi-line fixes arrive as several `fix:` lines
  whose indentation is part of the content. The last `fix:` line carries text:
  a trailing newline in the fix renders as an empty `fix: ` line.
- The `ERROR` line has exactly one rendering: plain text, emitted
  unconditionally. Its shape does not depend on a terminal or on anything being
  installed.
- No secret value ever appears in the block. Messages name the slot or path
  being resolved, never its contents.

**Match on the `slug:` line**, not on the `ERROR` message: messages are prose
and may be reworded, slugs may not.

`die` (`src/runtime/logging.ts`) is the unslugged failure path. It writes the same `ERROR <message>` line to stderr and
exits `1`, so the stream and exit-code halves of the contract hold, but it
carries no slug. New failures use the block. A consumer must not assume every
failure has a `slug:` line.

---

## 5. Decisions recorded here

| # | Decision | Rationale |
|---|---|---|
| 1 | `--output text\|json`, **global**, parsed in the entrypoint | Per-command format flags drift apart and collide; one selector, parsed in one place. |
| 2 | `--output json` on a surface with no JSON rendering **fails** | A silent fallback to human text is discovered as a parse error in the consumer, at a distance from the cause. |
| 3 | **No envelope** (§3.1) | Its error half duplicates the exit code + stderr block; its version half duplicates version pinning and the payloads' own versions; adopting it breaks every consumer at once. Closed, not deferred. |
| 4 | No `ERIS_OUTPUT` env var | An exported format would silently change the output of scripts written before it existed. |

Known gap, deliberately not fixed here: shell tab-completion
([COMPLETION.md](COMPLETION.md)) offers each command path's own flags from the
composed registry and does not yet offer the global `--output`.

---

## 6. Changing this contract

1. A machine surface's shape (§3) changes only with a deprecation path. Adding a
   field is additive and safe; renaming or removing one is not.
2. A slug is stable once shipped. Add new slugs; do not repurpose old ones.
3. Anything moving between stdout and stderr is a breaking change, full stop.
4. The black-box tests in `tests/output-contract.test.ts` are the oracle: they
   invoke the real `eris` entrypoint through `tests/helpers/blackbox.ts` (PATH
   fakes and loopback fixtures) and assert the properties above. A change that
   requires editing them is a change to the contract, and needs this document
   edited in the same commit.

## See also

- [ERRORS.md](ERRORS.md) — the slug catalogue the `slug:` line indexes
- [YAK.md](YAK.md) — the `eris yak` record
- [dev/PLUGINS.md](dev/PLUGINS.md#--output-json) — how a plugin adds a machine surface
- `src/cli/output.ts` — the allow-list and its refusal
