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
eris [--output text|json | --json] <command> [args…]
```

`--output` is **global**: it is parsed once before dispatch and stripped from
the argv (`src/cli/args.ts`), for every command line: every verb runs behind it
in-process. It may appear anywhere in the command line: before the command,
between a group and its verb, or after the verb. `--` terminates global parsing
and is itself consumed, so a positional that begins with `--output` is still
reachable.

- `text` (default) — the human rendering.
- `json` — the machine rendering.

`--json` is the same flag spelled shorter: `eris --json yak status`, `eris yak
--json status`, `eris yak status --json` and `eris --output json yak status`
are one command line. It is read at the same positions and stops at the same
`--`. Two cases differ:

- A verb whose own row declares a `--json` flag keeps it: the pre-pass leaves
  `--json` in the argv for that verb's parse, and the format stays `text`. With
  a help token (`--help --json`) it is the global flag again, so the verb's help
  prints as JSON ([§3.2](#32-help-as-json)).
- `--json` together with `--output text` asks for two formats and is refused
  ([`output-format-conflict`](ERRORS.md#output-format-conflict)).

`--json=<x>` is not the global flag; a verb that does not declare it refuses it
as an unknown flag.

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
| `eris docs` | text: per command, its usage line, summary and flags. JSON: one bare record `{schema: "eris-docs/1", version, commands}`, `commands` being the top-level help document then one `eris-help/1` document ([§3.2](#32-help-as-json)) per composed command path, in registry order. Reads and fetches nothing; exit `0` | accepted | experimental ([SKILLS.md](SKILLS.md#eris-docs)) |
| `eris skills install` | text: per skill, `<installed\|updated\|unchanged> <name> -> <path>`, then `  claude-code: <path> (<linked\|replaced\|unchanged>)` when `~/.claude` exists. JSON: one bare record `{skills: [{name, path, state, links: [{agent, path, state}]}]}`. Exit `0`; every failure (an unknown skill, an occupied target, a failed write) is the §4 block with nothing on stdout | accepted; a bare `eris skills` prints its help document ([§3.2](#32-help-as-json)) | experimental ([SKILLS.md](SKILLS.md)) |
| `eris skills lint` | text: one `<skill>: <rule>: <message>` line per finding, in a fixed order; the count, `<n> finding(s) over <m> skills`, on stderr. JSON: one bare record `{skills, findings: [{skill, rule, message}]}`, stderr empty. Exit `1` when there is any finding, `0` when there is none; a path that is not a directory is the §4 block with nothing on stdout | accepted | experimental ([SKILLS.md](SKILLS.md#eris-skills-lint-dir)) |
| `eris yak issue\|suggest\|fatal` | text: `recorded: <id>` on a fresh delivery, `already recorded: <id>` on a dedup replay, or nothing at all on a warn-class outcome (unresolved token/URL, unreachable Actor, timeout, non-2xx — see [YAK.md](YAK.md#exit-codes)); every one of those still exits `0`. JSON: one bare record — `{verb, delivered, id?, idempotency_key?, replay?, contract_version?, key_mismatch?, configured?, redactions: {count, classes, skipped}, error?}` — where **`delivered` is the field to branch on, never `id == null`**. **`--output json` on this surface additionally writes NOTHING to stderr** — a scoped exception to §1's general "stderr carries every diagnostic": `redactions.skipped` and `key_mismatch` exist specifically so the `--no-redact`/`yak-key-mismatch` WARNs that text mode prints on stderr are still recoverable from the record ([YAK.md §--output json](YAK.md#--output-json)) | accepted for all three verbs; a bare `eris yak` (no verb) prints its help document ([§3.2](#32-help-as-json)) | stable ([YAK.md](YAK.md)) |
| `eris yak ready` | text: one readiness line, then the filing guide when the machine can file. JSON: `{ready, signed_in, endpoint, configured, last_filed_issue_identifier, fix}` ([YAK.md](YAK.md#eris-yak-ready-the-session-start-report)). Every state, signed out and unreachable included, is stdout with stderr empty and exit `0`: a session-start hook runs it | accepted | experimental |
| `eris yak status\|discover\|config get\|config set` | text: a human rendering. JSON: the endpoint's body, bare (status, discovery, config read, stored config; shapes in [YAK.md](YAK.md#the-destination-status-discover-config)). Every failure is the §4 block with nothing on stdout, exit `1` | accepted; a bare `eris yak config` prints its help document ([§3.2](#32-help-as-json)) | experimental |
| `eris socrates submit` | text: `submitted: <id>`, or `already submitted: <id>` when the endpoint deduped the candidate; both exit `0`. When the review Epic's verbosity cap holds the candidate, a line `  held by the verbosity cap until <Mon-DD HH:MMZ>` follows (UTC). With `--answer`, a further line `  verdict: <verdict> (<rubric>, policy <hash12>)`, the server's verdict on the stamp. With `--unfit` (a decision only), a second line from the receipt's `unfit` echo: `  filed for an answer: needs-input` when the state is `needs_input`; `  not stored: an equal candidate is already <state>; the hypothesis and evidence were not kept` when the receipt is `already submitted` in any other state; `  state: <state>` for a fresh submit in any other state. A receipt without the echo is a failure ([ERRORS.md](ERRORS.md#socrates-unfit-unsupported)). Without `--unfit`, each `--fragment` is posted after the receipt and prints `  evidence: <fragment id> <provenance>`; a refused fragment is the §4 block naming the candidate already submitted. A `decision` or `practice` with neither `--answer` nor `--unfit` (a practice takes `--answer` only) is refused ([ERRORS.md](ERRORS.md#socrates-stamp-required)). JSON: one bare record `{candidate_id, deduped, contract_version, classification?: {verdict, rubric_version, policy_hash, reclassified, stamped_policy_hash?}, unfit?: {state}, evidence?: [{fragment_id, provenance, expires_at}], held_until?, held_reason?, redactions: {count, classes}, overrides: [class]}`. A redaction, an override or a reclassified stamp prints a `WARN` on stderr in both formats. Every failure, an endpoint refusal included, is the §4 block with nothing on stdout; a not-entitled refusal's `fix:` line is the subscribe link ([ERRORS.md](ERRORS.md#socrates-not-entitled)) | accepted; a bare `eris socrates` prints its help document ([§3.2](#32-help-as-json)) | experimental |
| `eris socrates classify` | text: `<verdict>: score <n> of <threshold> (<rubric>)` for a scored verdict, or `<verdict>: <gate> (<rubric>)` then a `why:` line and an `override:` line for a gate that decided. A scored or gate verdict adds a `  policy: <org <hash12> | rubric defaults>[ + repo layer]` line. JSON: one bare record `{verdict, rubric_version, score?, threshold?, breakdown?, gate?, answer?, feature?, route?, reason?, overrides: [{gate, reason}], policy_hash?, repo_policy?, meta: {_links: {override?: [{href, method, gate, title}]}}}`; `policy_hash` (the cached org policy's, or `null` for the rubric's defaults) and `repo_policy` (the `eris.yaml` layer applied, or `null`) are on every verdict but `prd` and `conflict`. `verdict` is `load-bearing`, `not-load-bearing`, `rejected`, `rerouted`, `practice`, `prd` or `conflict`; only `rejected` carries an override link. A `prd` or `conflict` candidate is never scored: text `<kind>: one review issue (<rubric>) -> review-issue` then a `why:` line, JSON `{verdict, rubric_version, route: "review-issue", reason, overrides: [], meta: {_links: {}}}`, and its statement must follow the grammar in `--help`. Every verdict exits `0`. Nothing is sent; every failure is the §4 block with nothing on stdout | accepted | experimental |
| `eris socrates resolve` | text: `resolved <epic>: <n> applied, <m> carried over[ to <carry-over epic>]`, then `  applied: <ids>`, `  amended: <ids>` and `  carried over: <ids>` lines when non-empty; `queued <epic>: ...` when the server resolves it in the background. A repeat run prints the server's stored receipt. `--amend <child>=<path>` edits a Done child before it is written; a resolved receipt that does not name every amended child fails `socrates-amend-ignored`. JSON: the receipt as one bare record `{epic, outcome, applied, carried_over, carry_over_epic?, amended?, reporting, contract_version}`. Exits `0`; every failure, an endpoint refusal included, is the §4 block with nothing on stdout | accepted | experimental |
| `eris socrates settings policy` | text: the served policy (`policy v<n> (<source>, <rubric>) hash <12 hex>`, then threshold, verbosity, escalation, auto_resolve, reporting and the gates); with a change flag, the change lines (`<field>: <from> -> <to>`) then `saved policy v<n>, hash <12 hex>`; with `--preview`, the change lines then a line saying nothing was sent. JSON: the read model's policy as `{policy: {rubric_version, version, source, policy_hash, policy, updated_at}, contract_version}`; with a change, the receipt `{rubric_version, policy_version, policy_hash, policy, canon_doc_id, contract_version}`; with `--preview`, `{preview: true, version, policy_hash, policy, draft, changes: [{field, from, to}], contract_version}`. Exits `0`; the team is a key, name or id, sent as typed. An ambiguous name prints a `WARN` listing its candidates on stderr and exits `0` with nothing on stdout (JSON: `{ambiguous: {kind, candidates: [{id, name}]}}`); every other failure, an endpoint refusal included, is the §4 block with nothing on stdout | accepted (the bare `settings` group prints its help document, [§3.2](#32-help-as-json)) | experimental |
| `eris socrates settings enrolment` | text: one line per project, `<name or id> (<source>) <Linear url or ->`. JSON: `{projects: [{id, name, source, url}], contract_version}`. Exits `0`; every failure, an endpoint refusal included, is the §4 block with nothing on stdout | accepted (the bare `settings` group prints its help document, [§3.2](#32-help-as-json)) | experimental |
| `eris socrates settings health` | text: the install, webhook, reconcile and stuck lines. JSON: `{health: {install, webhook, reconcile, stuck}, contract_version}`. Exits `0`; every failure, an endpoint refusal included, is the §4 block with nothing on stdout | accepted (the bare `settings` group prints its help document, [§3.2](#32-help-as-json)) | experimental |
| `eris socrates settings usage` | text: the window, entries by state, accept and reject rates, and classifications. JSON: `{usage: {window_days, entries, accept_rate, reject_rate, classifications}, contract_version}`. Exits `0`; every failure, an endpoint refusal included, is the §4 block with nothing on stdout | accepted (the bare `settings` group prints its help document, [§3.2](#32-help-as-json)) | experimental |
| `eris socrates settings canon` | text: `canon: <doc id>` or `no Canon doc is chosen`; with `--doc` or `--clear`, `canon: <doc id>` or `canon cleared`. JSON: `{canon: {doc_id}, contract_version}`; with `--doc` or `--clear`, the receipt as for `settings policy`. Exits `0`; every failure, an endpoint refusal included, is the §4 block with nothing on stdout | accepted (the bare `settings` group prints its help document, [§3.2](#32-help-as-json)) | experimental |
| `eris socrates settings team` | text: `files on <key> (<source>): <team id>`, where `<source>` is `override`, `lead` or `first`. JSON: the receipt as one bare record `{project, override, filing_team: {id, key, source}, contract_version}`, `override` being `{id, key}` or `null`. Exits `0`; every failure, an endpoint refusal included, is the §4 block with nothing on stdout | accepted (the bare `settings` group prints its help document, [§3.2](#32-help-as-json)) | experimental |
| `eris socrates discover` | text: one line per source, `<sha12> <YYYY-MM-DD> <subject>`, oldest first; nothing new prints nothing. JSON: one bare record `{repo, cursor, head, sources: [{kind, sha, committed_at, subject}], truncated}`. Over `--limit`, a `WARN` on stderr in both formats. `--advance <rev>`: text `cursor: <sha>`, JSON `{repo, cursor}`. Listing never writes; every failure is the §4 block with nothing on stdout | accepted | experimental |
| `eris socrates consult` | text: the doc's markdown, terminal control characters removed (newlines and tabs kept); `--brief` (also a bare `consult`) prints Canon, 1-Pager, Load-Bearing Decisions, Key Assumptions, Retro Findings and Practices, each under a `<!-- eris socrates consult: <doc> <url> -->` line. JSON: one bare record `{docs: [{doc, title, url, markdown, fetched_at, contract_version}], unavailable: [{doc, status, code, detail, settings?}], contract_version}`; `markdown` is the server's text unmodified. A brief skips a doc the org does not have (HTTP 404 or 409) with a `WARN` on stderr in both formats and lists it under `unavailable`; exits `0` while at least one doc was read. Every other failure, a brief that read nothing and `--canon` with no Canon doc included (its `fix:` line is the settings link), is the §4 block with nothing on stdout | accepted | experimental |
| `eris socrates status` | text: `pending candidates: <n>`, `open review Epics: <n>` and one `  <epic>  <project>  <n> open  <url>` line per Epic; with `--candidate <id>`, then `candidate <id>: <state>` and `  issue: <url>` when the candidate has one. A candidate the review Epic's verbosity cap holds also prints `  held by the verbosity cap until <Mon-DD HH:MMZ>` (UTC). Server text has terminal control characters removed. JSON: the endpoint's status as one bare record `{rubric_version, policy_hash, pending_candidates, open_epics: [{epic, project, url, open_children}], candidate?: {candidate_id, state, issue_url?, held_until?, held_reason?}, contract_version}`. Exits `0`; every failure, an endpoint refusal included, is the §4 block with nothing on stdout | accepted | experimental |
| `eris socrates policy` | text: `org policy: <hash12> (<rubric>)`, then `changed: <old12> -> <new12>` when the refresh moved the hash, `threshold: <n>` (with `(org <n>)` when the repo layer raised it), `enabled gates: <questions>` and `repo layer: none`, or the `eris.yaml` and what it sets. Fetches the policy and refreshes `~/.eris/socrates-policy.json`; `--cached` prints the cache with no request and fails with [`socrates-policy-not-cached`](ERRORS.md#socrates-policy-not-cached) when there is none. JSON: one bare record `{rubric_version, policy_hash, cached, fetched_at, org_policy, policy, repo_policy, repo_policy_path, changed?: {from, to}, contract_version}`, `policy` being the effective policy and `repo_policy` `null` when no layer applies. Exits `0`; every failure, a repo layer that loosens the org policy included, is the §4 block with nothing on stdout | accepted | experimental |
| `eris socrates evidence <id>` | text: `fragment: <id>`, `kind: <kind>`, `provenance: <provenance>`, `expires: <time>`, then `candidate: <id>` when linked, a blank line and the content, terminal control characters removed (newlines and tabs kept). JSON: the fragment as one bare record `{fragment_id, candidate_id?, kind, provenance, content, created_at, expires_at, contract_version}`; `content` is the server's text unmodified. A reply for another id is [`socrates-bad-response`](ERRORS.md#socrates-bad-response). Exits `0`; every failure, an endpoint refusal included, is the §4 block with nothing on stdout | accepted | experimental |

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

### 3.2 Help as JSON

Every command path describes itself as JSON, verbs without a JSON rendering
included. Under `--json` (or `--output json`), each of these prints **one help
document** on stdout, stderr empty, exit `0`:

- a help token before `--`: `eris <path> --help --json`, `eris <path> -h --json`;
- a group named with nothing after it: `eris --json socrates`, `eris socrates --json`;
- the bare program: `eris --json`, and `eris --help --json`.

Core renders it from the composed rows (`helpJson`, `src/cli/args.ts`) before
the allow-list in §2 and before the verb's handler runs, so a verb that refuses
`--output json` (`eris completion bash`, `eris login`) still serves
`--help --json`. A word that names no command (an unknown group, or an unknown
sub of a group) asks for no help document: it is refused as it is without
`--json`. In text, a verb prints its own help, as before.

One schema across the tree, `eris-help/1`; the type is `HelpJson`, exported by
`eris/sdk`:

| Field | Type | Meaning |
|---|---|---|
| `schema` | `"eris-help/1"` | the document's schema; a breaking change gets a new name |
| `path` | string | the command path, `"yak issue"`; `""` for the top level |
| `usage` | string | the usage line, starting `eris <path>`; a group with subs reads `eris <path> <command>` |
| `summary` | string | the row's summary |
| `commands` | `[{name, summary}]` | the path's direct subs, in registry order; at the top level, every composed group; `[]` for a leaf |
| `flags` | `[{name, arg?, summary?, repeatable?, alias?}]` | the row's flags then `--help` (alias `-h`); `arg` is present on a flag that takes a value, `repeatable` (`true`) on one that may be given more than once. At the top level, the global flags |
| `output_schema` | string, optional | where the verb's `--output json` shape is documented, present only when its row names one |

The document is one bare record, like every machine surface (§3.1).

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
| 5 | `--json` is the global flag's alias, and help is a machine surface (§3.2) | Agents reach for `--json`; spelled as an alias of the one global selector it adds no per-command flag. A help document served by core from the rows has one shape on every path, so a caller can discover a verb's grammar without parsing prose. |

Known gap, deliberately not fixed here: shell tab-completion
([COMPLETION.md](COMPLETION.md)) offers each command path's own flags from the
composed registry and does not yet offer the global `--output` or `--json`.

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
