# eris failure model

Hard failures go through `renderFailureBlock` / `reportFailure`
(`ts/lib/eris-fail.ts`), which print one
actionable block and exit `1` immediately — a first failure never cascades
into follow-on ERROR lines. Output is one-line-per-field with stable prefixes
(all on stderr; stdout stays clean):

```
ERROR <what failed>        # concrete — names the exact key/env/secret slot
slug: <slug>               # stable machine key; heading in this file
fix: <line>                # the exact command to run / eris.yaml block to add
docs: <local path>         # $ERIS_HOME/docs/... (the checkout, or a binary's asset home)
docs: <github url>         # same doc on github.com/sibylline-labs/eris
```

This block is a **parseable format, not a layout** — consumers line-prefix-parse
it today. Its full grammar (field order, the exact prefixes *including the
single trailing space* after `slug:` / `fix:` / `docs:`, the one-block rule, and
what a consumer may and may not assume) is specified in
[OUTPUT-CONTRACT.md §4](OUTPUT-CONTRACT.md#4-the-failure-block). Change the
grammar there and here in the same commit, never in one alone.

Agents: match on the `slug:` line, apply the `fix:` lines verbatim (yaml blocks
are indented continuation lines), read `docs:` for depth. Error messages name
the slot/path being resolved — never secret contents.

Exit codes: `1` = hard failure (a failure block or a `die`). `2` = idempotent
no-op where a command documents one.
The full stream + exit-code contract is
[OUTPUT-CONTRACT.md §1](OUTPUT-CONTRACT.md#1-the-stream-split).

## Slugs

### flag-value-missing

A value-taking flag was given no value, or was given the NEXT FLAG as its
value. A bare "is it non-empty" guard accepts both: `--owner --yes` would store
`owner: "--yes"` at exit 0 and swallow the `--yes`, which then re-arms the
confirmation gate the caller had already answered, so the parser
(`src/cli/args.ts`) refuses a value flag followed by another flag. The joined form (`--flag=value`) is checked for emptiness
only: an empty `--required=` once registered the opposite of what was asked
for.

### output-format-unknown

`--output` was given something other than `text` or `json` (or was given no
value at all). The flag is global and is parsed once in the entrypoint
(`parseGlobal`, `src/cli/args.ts`); there is no `ERIS_OUTPUT` env var, so
the flag is the only selector. Fix: `eris --output json <command>` for the
machine rendering, `--output text` (the default) for the human one. See
[OUTPUT-CONTRACT.md](OUTPUT-CONTRACT.md#2-the-flag).

### output-format-conflict

`--json` (the alias of `--output json`) and `--output text` were both given, so
the command line asks for two formats. eris refuses rather than picking one: the
caller would get the rendering it did not ask for. Fix: keep one of them, `--json`
(or `--output json`) for the machine rendering, `--output text` for the human
one. See [OUTPUT-CONTRACT.md](OUTPUT-CONTRACT.md#2-the-flag).

### output-json-unsupported

`--output json` was asked of a command that has no JSON rendering. eris refuses
rather than falling back to the human rendering: a silent fallback hands a
parser a table, and the caller discovers it as a JSON syntax error somewhere
downstream instead of as a refusal here.

The refusal's `fix:` lines name the surfaces that accept it, including every
json row a plugin adds. Full table: [OUTPUT-CONTRACT.md](OUTPUT-CONTRACT.md#3-machine-surfaces).

### command-locked

A plugin command belongs to a product this workspace has not bought, so it is
locked (`src/cli/compose.ts`). Plugins compile into the binary, and the
entitlement check runs per command line: the command's help still prints, with a
`Locked:` line, and `eris --help` marks the group `[locked: <product>]`. Nothing
from the plugin's handler runs.

Fix: add the named product to the workspace, then run the command again.
Authoring side: [dev/PLUGINS.md](dev/PLUGINS.md#entitlements).

### eris-bun-missing

> Raised by the `eris` shim, before any command runs.

`bun` is not on `PATH`. The `eris` entrypoint is a POSIX `sh` shim that execs
`src/main.ts` under bun, and that router runs every command, so no command runs
without bun.
The shim renders this block itself, since nothing past it can run.

Fix: install bun (<https://bun.sh>), then run `bun install --frozen-lockfile` in the
eris checkout (the `node_modules` the verbs need). An installed package
(`npx @sibylline-labs/eris`) needs bun too.

### eris-cache-unwritable

> Raised by the entrypoint (`src/main.ts`) in a compiled eris binary, before the
> command runs.

The compiled binary carries the repo files it reads (the docs a failure block
names) and writes one copy per build to
`${ERIS_CACHE_DIR:-${XDG_CACHE_HOME:-~/.cache}/eris}/<build id>/` the first time
it runs. That directory could not be written: the filesystem is read-only or
full, the directory belongs to someone else, or a file sits where a directory
should be. The `ERROR` line names the cache directory and the operating
system's own reason.

`eris --help`, a `--help` on any command, and `eris completion` still run, since
they read none of those files and are how an operator finds this out. Every other
command is refused, because it may read one.

No asset home exists to hold the docs, so this block's first `docs:` line is the
repo-relative path rather than an absolute one. The second is the GitHub URL.

Fix: set `ERIS_CACHE_DIR` to a directory eris can write, or `XDG_CACHE_HOME` (eris
uses `$XDG_CACHE_HOME/eris`). On a read-only root filesystem, point it at a writable
volume. A checkout or an installed package writes no cache.

### eris-deps-not-installed

> Raised by the TypeScript verb runner (`src/cli/ts-verb.ts`), when a verb's
> module graph names a package the checkout's `node_modules` cannot resolve.

A TypeScript verb (every row the registry routes to `ts`, which is every row) is
imported lazily, and one of its packages is
missing: `node_modules` is absent, or is the install from before a pull that
added a dependency. The `ERROR` line names the package and the source file that
asked for it, instead of a bare `ERROR ResolveMessage: Cannot find package '…'`.

Fix: `bun install --frozen-lockfile` from the eris checkout (the `fix:` line names
the directory). eris does not run it for you: an inline install is unbounded and reaches the network mid-command.

Only a missing PACKAGE is reported this way. A missing relative module is a defect
in the checkout's own source and still crashes with bun's message.

### eris-verbose-fetch-set

> Raised by the package's `eris` command (`bin/eris.ts`), before any command runs.

`BUN_CONFIG_VERBOSE_FETCH` is set in the environment of an `eris` started from an
installed package (`npm i -g @sibylline-labs/eris`, `bun add -g`, `npx`, `bunx`).
Under that variable bun prints every fetch to stderr, the `Authorization` bearer
and the request body included, and for a secret write the body is the value. bun
reads it from its own environment when it fetches, and `delete process.env.X`
does not reach that read. The checkout's `eris` shim removes the variable before
bun starts; an installed command is started by its shebang and has no shim, so it
refuses to run rather than depend on an override from inside the process or print
a bearer token. No command runs, `--help` and `--version` included.

Fix: unset the variable, for the shell (`unset BUN_CONFIG_VERBOSE_FETCH`) or for
one command (`env -u BUN_CONFIG_VERBOSE_FETCH eris <command>`). The checkout's
shim and a compiled binary remove it themselves and never raise this.

### update-not-compiled

> Raised by a distribution's release `eris update` ([UPDATE.md](UPDATE.md#the-release-eris-update-distributions)) before any request.

This eris runs from source (a checkout, `./eris`), not from a compiled release
binary. A checkout has no single file to replace: it is a working tree under
version control.

Fix: update the checkout, `git pull && bun install --frozen-lockfile` in the
directory the `fix:` line names.

### update-unsupported-platform

> Raised by a distribution's release `eris update` ([UPDATE.md](UPDATE.md#the-release-eris-update-distributions)) before any request.

Releases publish a binary for `darwin-arm64` and `linux-x64` only, and this eris
was compiled for another platform (built from source on a machine with another
OS or CPU). There is no asset to download for it.

Fix: build eris from source for this platform and run that build; see
"From source" in the README. Updating means pulling and building again.

### update-api-invalid

> Raised by a distribution's release `eris update` ([UPDATE.md](UPDATE.md#the-release-eris-update-distributions)) before any request.

`ERIS_UPDATE_API`, the override for the releases API base (a GitHub Enterprise
host, or a test server), is set to something eris will not use: it is not a URL,
its scheme is neither `https` nor `http`, it is `http` to a host that is not
loopback, or it carries credentials, a query or a fragment. The refusal exists so
a stray variable cannot send a token in clear text to a host nobody chose. The
`ERROR` line shows the scheme and host only.

Fix: set it to an `https://` URL (for example `https://ghe.example.com/api/v3`),
or unset it to use `https://api.github.com`.

### update-token-invalid

> Raised by a distribution's release `eris update` ([UPDATE.md](UPDATE.md#the-release-eris-update-distributions)) before any request.

`GH_TOKEN` (or, when it is unset or blank, `GITHUB_TOKEN`) holds something no
GitHub token contains: a space or line break inside the value, or a non-ASCII
character. Leading and trailing whitespace is ignored, so a token read from a file
with its newline still works. The refusal names the variable and never shows its
value: sending such a value makes the HTTP client report an error that quotes it.

Fix: set the variable to the token alone, or unset it.

### update-unreachable

> Raised by a distribution's release `eris update` ([UPDATE.md](UPDATE.md#the-release-eris-update-distributions)) when the releases API or the download host does not
> answer.

The connection was refused, the name did not resolve, the connection dropped, or
a host went quiet: the API did not answer within 30 seconds, or a download sent
nothing for 60 seconds. Nothing was changed; a download in progress is removed.

Fix: check the network connection (eris update needs https access to
`api.github.com`, and to GitHub's release storage host for the download), then
run `eris update` again.

### update-rate-limited

> Raised by a distribution's release `eris update` ([UPDATE.md](UPDATE.md#the-release-eris-update-distributions)) when GitHub refuses the request for its rate limit.

GitHub answered 429, or 403 with the rate limit spent. An anonymous client gets
60 requests an hour per address; an authenticated one gets far more. `eris
update` makes up to three API requests per run. When GitHub reported when the
limit resets, the `ERROR` line says so.

Fix: set `GH_TOKEN` (or `GITHUB_TOKEN`) to a GitHub token. Any token works for
a public repository, with no scopes. If one is already set, its own limit is
spent: wait for the reset time, then run `eris update` again.

### update-needs-token

> Raised by a distribution's release `eris update` ([UPDATE.md](UPDATE.md#the-release-eris-update-distributions)) when GitHub answers 404 and no token is set.

GitHub answers 404, not 403, to a request that is not allowed to see a private
repository, so an anonymous 404 does not say whether the release is missing or
the repository is private. This refusal is the anonymous case.

Fix: if the repository is private, set `GH_TOKEN` (or `GITHUB_TOKEN`) to a token
that can read it and run `eris update` again. Otherwise the release does not
exist: list them at `https://github.com/<owner>/<repo>/releases`.

### update-release-not-found

> Raised by a distribution's release `eris update` ([UPDATE.md](UPDATE.md#the-release-eris-update-distributions)) when the release is not installable.

Either GitHub answered 404 to a request that carried a token, so the repository
has no such release (or the token cannot see the repository), or the release
found is a draft, or a prerelease that `--to` did not name. `eris update` installs
the latest published release; a prerelease only with `--to <tag>`.

Fix: check the tag against the repository's releases page. With a private
repository, the token must be able to read it.

### update-api-error

> Raised by a distribution's release `eris update` ([UPDATE.md](UPDATE.md#the-release-eris-update-distributions)) for any other answer the API gives.

An answer that is not a release and not one of the cases above: a 500, a 403 that
is not the rate limit, a 401 (the token was rejected, or the API wants one), a
body that is not a release record, a redirect chain that is too long or leaves
for a scheme eris will not follow, or a download larger than eris will accept.
The `ERROR` line names the host and the status.

Fix: for a 401, unset `GH_TOKEN` or replace it with a valid token. For a 403 on a
private repository, the token must be able to read it. Otherwise retry in a few
minutes.

### update-asset-missing

> Raised by a distribution's release `eris update` ([UPDATE.md](UPDATE.md#the-release-eris-update-distributions)) before it downloads the binary.

The release exists but cannot be installed: it lists no `eris-<os>-<arch>` for
this platform, no `SHA256SUMS`, or a `SHA256SUMS` with no line for this
platform's binary. eris never installs a binary it cannot check, so a release
without its checksum is refused. The same slug covers an asset the release lists
but the API answers 404 for.

Fix: choose another release with `eris update --to <tag>`.

### update-checksum-mismatch

> Raised by a distribution's release `eris update` ([UPDATE.md](UPDATE.md#the-release-eris-update-distributions)) after the download, before anything is replaced.

The downloaded binary's sha256 differs from the one in the release's
`SHA256SUMS`. The `ERROR` line gives both. The partial file is removed and the
installed binary is untouched.

Fix: run `eris update` again. If it repeats, the release is corrupt or has been
tampered with: do not install it.

### update-target-unwritable

> Raised by a distribution's release `eris update` ([UPDATE.md](UPDATE.md#the-release-eris-update-distributions)), before any request when it can tell.

The directory that holds the eris binary cannot be written, or a file there could
not be created: a read-only filesystem, a directory owned by another user (a
system-wide install), a full disk. `eris update` stages the new binary beside the
old one, so it needs write access to that directory, not only to the binary.

Fix: run `eris update` as a user who owns the directory, or reinstall eris into a
directory you own.

### update-smoke-failed

> Raised by a distribution's release `eris update` ([UPDATE.md](UPDATE.md#the-release-eris-update-distributions)) after the replacement.

The new binary was renamed into place and then run once (`eris --output json
--version`); it did not start, exited non-zero, did not answer within 20 seconds,
or reported a version other than the release's tag. The previous binary is put
back from `<binary>.old` and the `ERROR` line says so. If it could not be put
back, the `ERROR` line says that and the `fix:` line gives the `mv` that does it.

Fix: the release may be broken. Retry later, or install another with `eris update
--to <tag>`.

### yak-unknown-verb

`eris yak <verb>` was called with a verb other than `issue`, `suggest`, or
`fatal`. Fix: use one of those three.

### yak-unknown-flag

`eris yak` was given a flag it does not recognise. The full flag set is
`--summary`, `--body`/`--body-file`, `--evidence`/`--evidence-file`,
`--repro`, `--no-redact`, `--help`. Fix: `eris yak <verb> --help`.

### yak-positional-arg

`eris yak <verb>` was given a bare word, usually the report text itself
(`eris yak issue "the hook blocked a legal edit"`). The text rides on flags,
not positionals. Fix: `eris yak <verb> --summary "<one line>" --body "<what
happened>"`, or `--body-file <path|->` for a longer body.

### yak-flag-missing-value

A value-taking flag (`--summary`, `--body`, `--body-file`, `--evidence`,
`--evidence-file`, `--repro`) was the last token on the command line, with
nothing after it. Fix: pass the value, or drop the flag.

### yak-summary-required

`--summary` is required and was missing or empty. Fix: pass `--summary
"<text>"`, ≤200 chars.

### yak-body-required

Neither `--body` nor `--body-file` resolved to a non-empty string. Fix: pass
one of them.

### yak-body-conflicting-source

Both `--body` and `--body-file` were given. They are mutually exclusive — pass
exactly one.

### yak-evidence-conflicting-source

Both `--evidence` and `--evidence-file` were given. They are mutually
exclusive — pass exactly one, or neither (evidence is optional).

### yak-body-file-unreadable

`--body-file <path>` (or `--evidence-file <path>`, which raises the same slug
under the `evidence` label) could not be read — the path does not exist, or
the process lacks permission. Fix: check the path, or read stdin with `-`.

### yak-evidence-file-unreadable

The `--evidence-file` counterpart of
[`yak-body-file-unreadable`](#yak-body-file-unreadable) — same cause, same
fix, raised for the evidence field.

### yak-stdin-is-a-tty

`--body-file -` (or `--evidence-file -`) reads stdin, but stdin is a terminal
with nothing piped into it. Refused immediately rather than hanging forever on
a read that would never return. Fix: pipe the body in, e.g. `cat report.txt |
eris yak issue --summary "…" --body-file -`.

### yak-stdin-conflict

`--body-file -` and `--evidence-file -` were both given — only one stdin
exists to satisfy either. Fix: pass the other as inline text (`--evidence
"…"`) or a real file path.

### yak-summary-too-long

The (redacted) `summary` exceeds 200 chars. This is caught locally, before the
request, so the endpoint can never silently truncate it out of sync with the
idempotency key already derived from it. Fix: shorten it — redaction can grow
text, so check the real length with `--no-redact` if the count is surprising.

### yak-body-too-long

The `--body-file`/`--evidence-file` counterpart of
[`yak-summary-too-long`](#yak-summary-too-long) for the `body` field
(≤4000 chars). Same cause, same fix.

### yak-evidence-too-long

The `evidence` field exceeds 20000 chars. Same cause and fix as
[`yak-summary-too-long`](#yak-summary-too-long).

### yak-repro-too-long

The (redacted) `--repro <command>` exceeds 2000 chars — a local
courtesy bound, not a wire-contract one: `repro` rides inside `provenance`
(`provenance.repro.command`), which the contract package never
length-validates. Caught locally anyway, same reasoning as
[`yak-summary-too-long`](#yak-summary-too-long) — a repro is a command, not a
narrative, so 2000 chars is generous headroom over any real invocation. Fix:
shorten it — redaction can grow text, so check the real length with
`--no-redact` if the count is surprising.

### yak-repo-too-long

A (redacted) `--repo <owner/name>` hint exceeds 200 chars — a target-repo hint rides
inside `provenance` (`provenance.repo.target_repos`), which the contract
package types and bounds at the same 200 chars. Caught here first, so the
error names `--repo` rather than a generic payload failure, same reasoning as
[`yak-repro-too-long`](#yak-repro-too-long) — a hint is a short `owner/name`
identifier, so 200 chars is generous headroom over any real one. Fix:
shorten it — redaction can grow text, so check the real length with
`--no-redact` if the count is surprising.

### yak-repo-hints-too-many

More than 20 `--repo` hints were given on one submission. A
courtesy bound for the same DO-storage-hygiene reason as
[`yak-repo-too-long`](#yak-repo-too-long) — no single report genuinely spans
that many repos. Fix: narrow `--repo` to the repos this report actually
concerns.

### yak-payload-invalid

Local validation against the Yaks contract package
(`@sibylline-labs/yak-contract`) failed for a reason other than a length bound
(e.g. an empty required field after redaction). The `ERROR` line names the
field and the schema's message.

### yak-identity-id-too-long

`device_id` or `execution_id` exceeded the contract's 200-char bound. Unlike
[`yak-summary-too-long`](#yak-summary-too-long)/`yak-body-too-long`, this is
**never the caller's fault** — neither field is something an `eris yak`
invocation passes. `device_id` is resolved from `~/.eris/device-id` (a
corrupt or hand-edited file); `execution_id` from
`CLAUDE_CODE_SESSION_ID`/`CLAUDE_CODE_HOST_SESSION_ID` (an unusually long
value from the harness) or the shell ppid. Warn + exit 0 — the `WARN` line
names the real field and its real length; fix the identity source it names,
not the report.

### yak-redaction-overflow

The caller's ORIGINAL `summary`/`body`/`evidence`/`repro` was within its
length bound, but the secret-scrub pass (a marker like `«redacted:aws-key»`
can be longer than the text it replaces) grew it past the limit. Warn + exit
0, not misuse — the reported text is fine as authored. Retry with
`--no-redact` if the flagged text contains no real secret, or shorten it so
redaction has room to grow.

### yak-deps-not-installed

`eris`'s own `node_modules` is missing, or present but missing a package
`eris yak`'s TypeScript core imports (an interrupted `bun install`, a stale
checkout). `eris yak` refuses rather than running an unbounded `bun install`
inline mid-task, or letting `bun` crash with a raw, unslugged `Cannot find
package '…'` (`plugins/yak/handlers.ts`). Fix: `cd` to the eris checkout and run
`bun install` yourself. It warns and exits 0, like
[`yak-token-unresolved`](#yak-token-unresolved): the command that reports a
broken harness must not become one more thing that stops the agent. Under
`--output json` it is the bare record on stdout (`delivered: false`, `error.slug`)
with stderr empty.

### yak-url-unresolved

`ERIS_YAKS_TOKEN` is set, but no Yaks URL is: no `ERIS_YAKS_URL` and no `"url"`
in `~/.eris/yaks.json`. eris refuses to send that token to the default
`https://api.sibylline.group`, because a token in the environment usually
belongs to another endpoint (a self-hosted one, a CI service token for a
named host), and sending it there by omission hands a bearer to a host nobody
named for it. Nothing is sent. Only the token `eris login` writes to
`~/.eris/yaks.json` falls back to the default URL.

Fix: set `ERIS_YAKS_URL` to the endpoint that token belongs to, or unset
`ERIS_YAKS_TOKEN` and run `eris login`. Like
[`yak-token-unresolved`](#yak-token-unresolved), `eris yak issue|suggest|fatal`
warns and exits 0, and `eris yak status`, `discover`, `config get|set` and
`eris socrates` print the failure block and exit 1.

### yak-unreachable

The Yaks endpoint could not be reached at all (connection refused, DNS failure,
etc.) within the request's bound. Warn + exit 0 — the report was dropped, not
delivered; the agent's task is unaffected.

### yak-timeout

The Yaks endpoint did not respond within the bounded request window (30s
default). No retry — matches the registry transport's own posture. Warn + exit 0.

### yak-unauthorized

The Yaks endpoint answered `401`: it rejected the bearer token. Check the
`"token"` in `~/.eris/yaks.json` or `ERIS_YAKS_TOKEN`, and that the token is
registered with the endpoint. Retrying the same call changes nothing. Warn +
exit 0; the report was dropped, not delivered, and the agent's task is
unaffected. A problem with eris itself is reported on the vendor route, the eris
project's own tracker, rather than into the workspace.

From `eris yak status`, `discover` or `config get|set` the same refusal is the
failure block and exit 1: run `eris login` again.

### yak-not-entitled

The Yaks endpoint answered `402`: the workspace is not entitled to Yaks (its
plan or seat does not include it). Ask whoever administers the workspace;
nothing on this machine fixes it. Warn + exit 0; the report was dropped, not
delivered, and the agent's task is unaffected. A problem with eris itself is
reported on the vendor route, the eris project's own tracker, rather than into the
workspace.

### yak-payload-too-large

The submission exceeded the whole-body size cap: 256 KiB of UTF-8, the
contract's `YAK_REQUEST_MAX_BYTES`. eris measures the serialised body before it
sends and stops there, with nothing sent; an endpoint `413` is the same rung.
The per-field length checks pass first, so the sum is what overflowed: trim
`--evidence` (the largest field), `--repro` or the `--repo` hints, or a very
large environment value eris copies into provenance. Warn + exit 0; the
report was dropped, not delivered, and the agent's task is unaffected. A problem
with eris itself is reported on the vendor route, the eris project's own tracker,
rather than into the workspace.

### yak-transport-error

The Yaks endpoint responded, but not usably: a non-2xx status other than the
`401`, `402` and `413` that have their own slugs
([`yak-unauthorized`](#yak-unauthorized), [`yak-not-entitled`](#yak-not-entitled),
[`yak-payload-too-large`](#yak-payload-too-large)), an unparseable 2xx body, or a
2xx that does not match the receipt contract (`YakReceipt` in
`@sibylline-labs/yak-contract`). Warn + exit 0; the `WARN` line names the HTTP
status or the parse failure.

### yak-config-permissive

`~/.eris/yaks.json` is readable by users other than its owner (not mode
`0600`). Refused, never read — a credential file with group/world read is a
leak surface. Fix: `chmod 0600 ~/.eris/yaks.json`.

### yak-config-malformed

`~/.eris/yaks.json` exists but is not valid JSON, or is not a JSON object.
Fix: recreate it as `{"url": "...", "token": "..."}`.

### yak-config-unwritable

`eris login` or `eris logout` could not write `~/.eris/yaks.json` (the `ERROR`
line names the path and the errno). The previous file is untouched: the new
one is written to a temp file beside it and renamed into place. Fix: make
`~/.eris` writable by you, then run the command again.

### yak-token-unresolved

No bearer token resolved for the Yaks endpoint — neither `ERIS_YAKS_TOKEN` nor a
`"token"` field in a readable `~/.eris/yaks.json`. Environment/config, warn +
exit 0. Fix: run `eris login` and approve the code it shows in your browser; it
writes the token to `~/.eris/yaks.json`. Approving is a human step, not
something an agent can do mid-task. From `eris yak status`, `discover` or
`config get|set` it is the failure block and exit 1, since those verbs have
nothing to do without a token.

### yak-device-id-unwritable

`~/.eris/device-id` does not exist and could not be minted (directory not
writable, disk full, etc.). Warn + exit 0 — the report still attempts to send
with whatever identity resolved.

### yak-key-mismatch

Informational only — not a failure, not a warn-and-drop. The submission WAS
delivered (`delivered: true`), but the idempotency key this CLI derived
locally does not match the one the endpoint's receipt reports back, which is the
only canonicalization-drift signal the contract exposes (the schema and the
endpoint must derive identically from the same redacted payload). Printed as a
`WARN` line alongside a successful receipt in text mode; worth reporting
upstream if seen. Under `--output json` this WARN is suppressed like every
other diagnostic — the record's `key_mismatch` field carries the
same fact instead.

### yak-no-redact

Informational only — printed whenever `--no-redact` is passed, regardless of
the outcome, so the operator knows the secret-scrub pass did not run on this
submission. Not a failure. Under `--output json` this WARN is suppressed like
every other diagnostic — `redactions.skipped: true` on the record
carries the same fact instead, which matters because a skipped scrub and a
scrub that ran and found nothing otherwise look identical (`count: 0,
classes: []`).

### yak-parked-unconfigured

Informational, on a delivered yak: the endpoint accepted it (`recorded: <id>`),
but this org has no destination for its yaks, so it is parked and nothing files
to Linear until an admin sets one. Parked yaks file once a config exists. Fix:
`eris yak discover teams`, then `eris yak config set --team <key>` (an org
admin's), or set it on the dashboard's `/yak/config` page.
Exit 0. eris reads `GET /v1/yaks/status` once after the submit to know; when that
read does not answer, nothing is printed. Under `--output json` the record's
`configured: false` carries the same fact, and stderr stays empty.

### yak-admin-required

`eris yak discover` or `eris yak config set` was refused with `403
admin_required`: only an admin member of the org can list its Linear choices
or change where its yaks are filed. A service token, or a member's login, is
not enough. Fix: run `eris login` and have a person who is a Linear admin of the
workspace approve it, or have an admin set the destination on the dashboard's
`/yak/config` page. Exit 1.

### yak-admin-unavailable

`eris yak status`, `discover` or `config get|set` could not complete: the endpoint
did not answer within 15 seconds, could not be reached, answered a status eris
has no remedy for (a `5xx`, `502 linear_unavailable`, `503
accounts_unavailable`), or answered a body that does not match the contract. Retry.
If the body does not match, update eris (`eris update`). Exit 1.

### org-unauthorized

`eris org members` or `eris org members deactivate` was refused with `401`: the
endpoint rejected the bearer token of the org this directory acts as (revoked,
expired, or a session cookie instead of a CLI token). Run `eris login`, or check
`ERIS_YAKS_TOKEN` when it is set. Exit 1.

### org-scope-denied

`eris org members` or `deactivate` was refused with `403 scope_denied`: the token
does not carry the accounts scope (a service token minted without it). Run `eris
login`: a CLI login carries it. `eris org github`, `connect-github` and `disconnect-github` meet the
same refusal for the bus scope; a login carries every product the org has, so there the org lacks the
bus product and a second login cannot help: get it with `eris org billing checkout`, or, where billing
is off on the platform, ask its operator. Exit 1.

### org-admin-required

`eris org members deactivate`, `eris org delete` or `eris org connect-linear` was refused with `403
admin_required`: only an admin of the org can deactivate a member, delete the org or connect its
Linear workspace, and a member's login stays a member's. Ask an org admin to run it (for a member,
to deactivate them on the dashboard's Members page). `connect-linear` is refused before any
browser is opened. The role is never checked by the CLI; the server decides. Exit 1.

### org-member-not-found

`eris org members deactivate <id>` named an id the org does not list (`404
member_not_found`; another org's member is the same answer). Run `eris org
members` and use an id from its ID column. An id that is not a 26-character ULID
is refused with this slug before anything is sent. Exit 1.

### org-cannot-deactivate-self

`eris org members deactivate <id>` named the caller's own member (`400
cannot_deactivate_self`). Have another admin do it. Exit 1.

### org-last-admin

`eris org members admin revoke <id>` was refused (`409 last_admin`): the demotion would leave the org no
other active admin, and nothing changed. Grant admin to another member first (`eris org members admin
grant <member-id>`). Exit 1.

### org-admin-action-invalid

`eris org members admin` was given no action, or one other than `grant` or `revoke`. Run `eris org members
admin grant <member-id>` or `eris org members admin revoke <member-id>`. Exit 1.

### org-member-id-missing

`eris org members deactivate` was given no member id. Run `eris org members deactivate
<member-id>`. Exit 1.

### org-delete-flags

`eris org delete` was given neither `--confirm <workspace>` nor `--cancel`, was
given both, or `--confirm` named a blank workspace (an empty value is the
parser's [`flag-value-missing`](#flag-value-missing)). Nothing was sent.
Run `eris org delete --confirm <workspace>` to schedule the org's deletion or
`eris org delete --cancel` to cancel it. Exit 1.

### org-confirmation-mismatch

`eris org delete --confirm <workspace>` was refused with `400
confirmation_mismatch`: the name is not the org's stored workspace name (the
server compares it, trimmed). Nothing was scheduled. Give the name exactly as the
dashboard shows it. Exit 1.

### org-workspace-name-unknown

`eris org delete --confirm <workspace>` was refused with `409
workspace_name_unknown`: the org has no stored workspace name to confirm against,
so no name can match. Nothing was scheduled. Connect or reconnect the org's Linear
workspace in the dashboard, then run it again. Exit 1.

### org-connect-unconfigured

`eris org connect-linear`, `eris org billing checkout` or `eris org billing portal` was refused with `503
connect_unconfigured`: the platform has no dashboard address to build the install link or Stripe's return
links on, so nothing was minted or opened. This is the
platform's setup, not this machine's: tell the platform's operator. Exit 1.

### org-connect-timeout

`eris org connect-linear` opened (or printed) the install link and waited, but the org never
reported Linear as connected before the link expired (10 minutes after it was minted). The install
was abandoned, was not finished in the browser, or was finished for another workspace. Run `eris org
connect-linear` again for a new link (each link works once; a new one replaces the old); `eris whoami`
shows the connection's state. Exit 1.

### org-billing-unavailable

`eris org billing checkout` or `portal` was refused because billing is not available on this
platform: the org endpoint answered `404` (billing is not turned on, so the route does not exist) or
`503 billing_unconfigured` (billing is on but Stripe is not configured). Nothing was opened and no URL
was printed. This is the platform's setup, not this machine's: tell the platform's operator. Exit 1.

### org-billing-nothing-to-bill

`eris org billing checkout` was refused with `409 nothing_to_bill`: none of the org's products needs a
new subscription (each is free, or already billed on a live subscription), so no Checkout Session was
created and no URL was printed. To manage an existing subscription run `eris org billing portal`. Exit 1.

### org-github-account-invalid

`eris org connect-github` was given no `--account`, or one that is not a GitHub organization name
(1-39 letters, digits or single hyphens). Nothing was sent to `gh` or the server. Run
`eris org connect-github --account <github-org>`. Exit 1.

### org-gh-unavailable

`eris org connect-github` needs the GitHub CLI: `gh` could not be started, or `gh auth token` printed
no token. Nothing was bound. Install it (https://cli.github.com) and run `gh auth login`. Exit 1.

### org-github-not-owner

`gh api orgs/<account>/installations` failed: only an owner of a GitHub organization can list its App
installations, and a personal account has no such list. Nothing was opened or bound. Check
`gh auth status` (signed in as an owner of the org) and that `--account` names an organization. Exit 1.

### org-github-timeout

`eris org connect-github` opened (or printed) the App's install page and asked `gh` every few seconds,
but the App did not appear on the GitHub organization within 10 minutes. Nothing was bound. Install it
on that organization, then run the command again: an installed App is bound without the browser. Exit 1.

### org-github-unproven

`eris org connect-github` was refused with `403 installation_unproven`: the server listed the GitHub
organization's installations with your `gh` token and did not find that installation of the platform's
App. The token's user is not an owner of the organization, `--account` names another organization, or
the token is invalid. Nothing was bound. Sign `gh` in as an owner (`gh auth status`) and run it again.
Exit 1.

### org-github-unconfigured

`eris org connect-github` found no GitHub App configured on the platform (`GET /v1/github` answered
`app: null`, or a bind answered `503 github_app_unconfigured`). Nothing was opened or bound. This is the
platform's setup, not this machine's: tell the platform's operator. Exit 1.

### org-github-bound-elsewhere

The bind was refused with `409 installation_already_bound`: that installation is bound to another org,
or was and stays held by it after an unbind. Nothing was bound. Moving an installation between orgs is
the platform operator's act. Exit 1.

### org-github-org-bound

This org already has a different installation bound than the platform App's installation on
`--account` (seen before any bind, or refused by the server with `409 org_already_bound`). Nothing was
bound. Run `eris org disconnect-github`, then connect the other. Exit 1.

### org-bus-lapsed

An `eris org` command that needs the org's bus product was refused with `402 entitlement_lapsed`: the
bus product is not active. That is `eris org webhooks logfire revoke` (no new Logfire webhook URL is
issued) and `eris org github`, `connect-github` and `disconnect-github`. Nothing changed. Get the bus
product for the org with `eris org billing checkout`; where billing is off on the platform, ask its
operator to grant it. Then run it again. Exit 1.

### org-tokens-revoked

An `eris org` command was refused with `401 revoked`: the token is revoked. While
an org's deletion is scheduled the gateway revokes every token the org holds, this
machine's included, so `eris org delete --cancel` and `eris whoami` cannot reach it
with a CLI token. Cancel from the dashboard's Danger zone after signing in again;
if no deletion is scheduled, run `eris login`. Exit 1.

### org-unknown-verb

`eris org` or `eris org members` was given a word that is not one of its
commands. `eris org --help` lists them (`members`, `delete`, `connect-linear`, `github`,
`connect-github`, `disconnect-github`, `webhooks logfire [revoke]`). Exit 1.

### org-unavailable

`eris org members` or `eris org members deactivate` could not complete: the
endpoint did not answer within 15 seconds, could not be reached, answered a
status eris has no remedy for, or answered a body that does not match the
contract. Retry. If the body does not match, update eris (`eris update`). Exit 1.

### yak-team-not-found

`eris yak discover --team` or `eris yak config set --team` named a Linear team
id the workspace does not list (`404 team_not_found`). Run `eris yak discover
teams` and use one of its ids or keys. Exit 1.

### tokens-admin-required

`eris tokens create` was refused with `403 admin_required`: only an admin member
of the org can mint a service token. A member can list the tokens they own and
revoke them. Fix: have an org admin run it, or mint it on the dashboard's
Settings > API Tokens page. Exit 1.

### tokens-forbidden

`eris tokens` was refused with a `403` that is not `admin_required`: the
credential cannot manage tokens. A service token (`ERIS_YAKS_TOKEN`) carries no
account scope, so only a person's login can. Fix: unset `ERIS_YAKS_TOKEN` and
run `eris login`. Exit 1.

### tokens-service-limit

`eris tokens create` was refused with `409 service_token_limit`: the org already
holds the most live service tokens its tier allows (3 on the free tier). Fix:
`eris tokens ls` shows the live ones and the cap; `eris tokens revoke <id>`
frees a slot. Exit 1.

### tokens-invalid-spec

`eris tokens create` was refused with `400`: the server rejected the spec, for
example a scope on a product the org is not entitled to or on `accounts`. The
`entitled` list in `eris --output json tokens ls` names the products. Exit 1.

### tokens-not-found

`eris tokens revoke <id>` named no token in this org (`404`). A token of another
org reads the same. Fix: `eris tokens ls` prints the ids. Exit 1.

### tokens-unavailable

`eris tokens` could not complete: the endpoint did not answer within 15
seconds, could not be reached, answered a status eris has no remedy for, or
answered a body that does not match the contract. The block names the status and
the server's error code, never the response body. Retry; if the body does not
match, `eris update`. Exit 1.

### tokens-name-required

`eris tokens create` was given no `--name`. Nothing was sent. Exit 1.

### tokens-name-invalid

`eris tokens create` was given a `--name` over 128 characters. Nothing was sent.
Exit 1.

### tokens-scope-required

`eris tokens create` was given no `--scope`; a token with no scope is refused.
Nothing was sent. Exit 1.

### tokens-scope-invalid

A `--scope` is not `product:access` with access `read`, `write` or `admin`
(for example `yak:write`), or more than 16 were given. Nothing was sent. Exit 1.

### tokens-id-required

`eris tokens revoke` was given no token id. Nothing was sent. Fix: `eris tokens
ls` prints the ids. Exit 1.

### tokens-unknown-command

`eris tokens <word>` where the word is not `ls`, `create` or `revoke`. Nothing
was sent. Exit 1.

### yak-linear-disconnected

The org's Linear connection is missing or revoked (`409 linear_disconnected`),
so there is nothing to discover and no labels to ensure. A Linear admin
reconnects it: sign in to the dashboard with Linear and install the Yaks
app. Exit 1.

### yak-config-invalid

The endpoint refused the config (`422 invalid_config`), or `eris yak config set`
was given names to resolve on an org with no config and no `--team`. An org's
first set must carry `--team`, and every id must be one `eris yak discover`
lists. Exit 1.

### yak-config-set-empty

`eris yak config set` was given no flag, so there was nothing to set. Pass
`--team`, and optionally `--project`, `--state` and `--labels`. Exit 1.

### yak-config-no-match

A name given to `eris yak config set` (or `eris yak discover --team`) matched no
entry, or more than one. Teams match by id, key or name; projects, states and
labels by id or name, ignoring case. The fix lines list the candidates. Pass an id or
a unique name. Exit 1.

### yak-discover-unknown-kind

`eris yak discover` was given a section it does not have. Use one of `teams`,
`projects`, `states` and `labels`, or none for all four. Exit 1.

### login-unreachable

The endpoint could not be reached when the device login started, or stopped
answering (a dropped connection or a 5xx, more than three polls in a row) while
waiting for approval. Nothing was written. Fix: check the url and your
connection, then run `eris login` again.

### login-refused

The endpoint answered, but not with a device login: it refused to start one
(the `ERROR` line carries its error code, from either the RFC `{"error": …}`
or the `{"error": {"code", "message"}}` shape, e.g. `invalid_device`,
`device_unconfigured`), sent a malformed response, or refused the device code
with a code other than the four RFC 8628 ones. Nothing was written. Fix: check
the url points at an endpoint that offers device login.

### login-denied

The sign-in was denied on the approval page (`access_denied`). Nothing was
written, and an existing `~/.eris/yaks.json` is left as it was. Fix: run
`eris login` again if the denial was not intended.

### login-expired

The device code expired before it was approved: the endpoint answered
`expired_token`, or the code's `expires_in` ran out locally. Nothing was
written. Fix: run `eris login` again and approve the new code in time.

### login-env-token-overrides

A `WARN`, exit 0: `ERIS_YAKS_TOKEN` is set, and it wins over the token in
`~/.eris/yaks.json`, so `eris yak` keeps using the environment's token after
`eris login` (or still has one after `eris logout`). Fix: unset
`ERIS_YAKS_TOKEN` to use the file's token.

### login-org-differs

A `WARN`, exit 0. The token `eris login` just wrote is for a different org
from the one this directory acts as (`ERIS_ORG`, or `repo.org` in the repo's
`eris.yaml`). The token was still stored, under its own org. The device code
was approved while the browser was signed in to the other org. Fix: sign the
browser in to the org this directory selects, then run `eris login` again.

### org-not-signed-in

This directory selects an org (`ERIS_ORG`, or `repo.org` in the nearest
`eris.yaml` that names one), but `~/.eris/yaks.json` holds no token for it.
Nothing was sent: the default org's token is never used in its place. Fix:
run `eris login`, and approve the code while the browser is signed in to that
org. `eris whoami` shows which org is selected and why.

### org-selector-invalid

The org this directory acts as cannot be determined, so nothing was sent.
Either `ERIS_ORG`, or `repo.org` in an `eris.yaml`, is not an org id (26
uppercase Crockford base32 characters, the id `eris whoami` prints), or an
`eris.yaml` between this directory and the checkout root cannot be read or
parsed, or a `.git` on that walk cannot be inspected (so whether the checkout
root was reached is unknown). A broken manifest might be the one that selects an
org, so it is never skipped. Fix: correct the id or the manifest, make the named
`.git` readable, or remove the selector.

### org-token-mismatch

`ERIS_YAKS_TOKEN` is set while this directory selects an org, and the token is
not a token for that org: its org id names another org, or cannot be read.
Nothing was sent. Fix: unset `ERIS_YAKS_TOKEN` so the machine's stored token
for the selected org is used, or set it to a token for that org.

### socrates-unknown-verb

`eris socrates` was given a command it does not have. Fix: use `classify`,
`consult`, `discover`, `policy`, `resolve`, `settings`, `status` or `submit`, or
run `eris socrates --help`. For `eris socrates settings`, use `policy`,
`enrolment`, `health`, `usage`, `canon` or `team`.

### socrates-flag-required

`eris socrates submit` or `eris socrates classify` was run without `--title`,
`--statement` or `--source`, which every candidate needs. Nothing was sent. Fix:
pass all three. Also raised when `submit`'s `--allow-redaction` and
`--override-reason` are not given together, and when `classify --request` is
given with another flag: the request carries the whole candidate, so pass
everything inside it or drop it, and when `submit --override` is given without
`--answer`. `submit` also raises it for the unfit flags: `--unfit` without
`--hypothesis`, and `--hypothesis` or `--evidence-file` without `--unfit`.
`eris socrates status` raises it when `--candidate` is blank or over 200
characters. `eris socrates resolve` raises it when the
Epic is missing or is not an identifier (blank, or over 200 characters);
nothing was sent. Fix: pass the Epic's identifier, as the Epic's Socrates
comment prints the command.

### socrates-amend-invalid

`eris socrates resolve --amend <child>=<path>` could not build an amendment:
the value is not `<child>=<path>`, the same child is amended twice, the file
cannot be read or is not JSON, or it is not an amendment. The file must be one
JSON object with at least one of `title` (one line, up to 80 characters, with
file names, domains and dotted identifiers in backticks so Linear does not
autolink them), `statement` (one line, up to 4000), `target` (`lbd`, `ka` or `practices`),
and optionally `source_comment`; any other key is refused. At most 250 children
can be amended in one resolve. Nothing was sent. Fix: correct the named
`--amend`, or drop it.

### socrates-amend-ignored

`eris socrates resolve --amend` reached an endpoint that resolved the Epic
without applying every amendment: its receipt does not name the amended
children. An endpoint from before amendments ignores the field and writes the
filed text; a current one leaves an entry out when its write was refused for
good (a frozen doc), and says why on the entry's sub-issue. The Epic is now
resolved, so running the command again changes nothing. Fix: update the server
if it predates amendments, then correct the named entries in the living doc by
hand.

### socrates-candidate-invalid

The candidate does not match the contract or entry-title rules: a field is
blank or over its bound (`--title` is a single line of at most 80 characters, or
at most 66 characters for `--kind prd` where `'PRD authored: <title>'` must fit
in 80 characters; `--statement` 4000, and a single line for `--kind decision` or `practice`;
`--project` 200 characters), `--title`
contains an unbackticked dotted token Linear autolinks, `--source` is not an
absolute `http(s)` URL, `--kind` is not one of `decision`, `practice`, `prd` or
`conflict`, or a `prd` or `conflict` statement does not fit its grammar. The
`ERROR` line names the problem. Nothing was sent. `classify` also raises it
when `--request` is not a JSON object, or names a `rubric_version` this build
does not score. Fix: correct the named fields (wrap file names, domains and
dotted identifiers in backticks in `--title`, and keep it single-line within the
character limit).

### socrates-answers-invalid

`eris socrates classify` (or `submit --answer`) was given answers that do not
fit the rubric: a question has no answer, an answer is not one of its
question's enum values, a key is not one of the rubric's questions, a question
is answered twice, or an `--answer` is not `<question>=<answer>`. Nothing was
scored or sent. The `fix:` lines list every question with its answers. Fix:
answer every question once, with one of its answers. Also raised when a `prd`
or `conflict` candidate is given `--answer`: it is never scored. Fix: drop
`--answer`.

### socrates-secret-detected

A field holds a secret: a vendored gitleaks rule (gitleaks v8.30.1,
`packages/outbound-scan`) matched the title, statement, source, project,
`--override-reason`, the `--hypothesis` (named `hypothesis`), an evidence
entry's content or provenance (named `evidence.<n>` and `evidence.<n>.provenance`),
or a string in the request body just before it was sent (for `resolve`, the
Epic; for `status`, `--candidate`).
The `ERROR` line names the field and the rule id, never the text. Nothing was
sent. This check cannot be overridden: `--allow-redaction` does not reach it.
Fix: remove the secret from the named field and run the command again.

### socrates-override-invalid

`eris socrates submit --allow-redaction` named something that is not one of
eris's redaction classes. Nothing was sent. Fix: use a class the `fix:` line
lists, or drop the flag.

For `eris socrates classify --override <gate>=<reason>` (or `submit
--override`), it means the override cannot apply. The reason is missing,
blank, multi-line or over 200 characters. Or the gate is not one of the
rubric's gates, routes the candidate (a practice, an inferred premise) rather
than rejecting it, is turned off by the policy, does not reject these answers,
or is named twice. Nothing was scored or sent. Fix: override only the gate a
rejection named, once, with a one-line reason.

### socrates-redacted

A `WARN`, not a failure. One or more of eris's redaction classes matched a
field, and the match was replaced with `«redacted:<class>»` before sending.
The line names each class. If the match is not a secret, send it as written
with `--allow-redaction <class> --override-reason <why>`, which reports the
override to the eris vendor tracker.

### socrates-override-unused

A `WARN`. An `--allow-redaction` class matched nothing in the candidate, so
nothing was overridden and no report was filed. Fix: drop the flag.

### socrates-override-unreported

A `WARN`. An override let text through, and the `eris yak issue --vendor`
report of it was not delivered (the line names the yak's slug or how its run
ended). The candidate was sent anyway: a yak never fails the task it reports
on. Fix: see the named yak slug; a problem with eris itself is reported on the
vendor route, the eris project's own tracker.

### socrates-stamp-required

`eris socrates submit` was given a `decision` or `practice` with neither
`--answer` nor `--unfit`. Every such submit carries one stamp: the rubric
answers eris scored it with, or, for a decision the answers cannot express,
the hypothesis and evidence it is sent as. Nothing was sent. Fix: add
`--answer <question>=<answer>...` (`eris socrates classify --help` lists the
questions), or, for a decision, `--unfit --hypothesis <text>`; a practice takes
`--answer` only. A `prd` or `conflict` takes neither and is not refused.

### socrates-unfit-invalid

`eris socrates submit --unfit` cannot send the unfit stamp. It was given with
`--answer` or `--override` (an unfit candidate sends no answers), or with a
`--kind` other than `decision`, or the `--hypothesis` is blank or over 1000
characters. Only a decision can be unfit: a `practice` is written straight to
the Practices doc and never becomes an item a person answers, so it takes
`--answer`, and a `prd` or `conflict` is never scored. The `ERROR` line says
which. Nothing was sent. Fix: drop the conflicting flag, send a practice with
`--answer`, or correct the hypothesis.

### socrates-evidence-file-invalid

`eris socrates submit --evidence-file` could not read its evidence. The file
(or stdin, for `-`) cannot be read, is not JSON, or is not an array of at most
five `{kind, provenance, content}` entries: `kind` is `code`, `doc` or
`session_utterance`, `provenance` an `http(s)` URL or `repo@sha:path#L<n>`,
`content` non-blank and at most 20000 characters. `-` with stdin on a terminal
is refused rather than waited on. The `ERROR` line names the entry and field
(`evidence.1.kind`). Nothing was sent. Fix: correct the file, or pipe it in.

### socrates-evidence-invalid

`eris socrates submit --fragment <path>#L<x>[-L<y>]` could not build a fragment
from the reference. It is not `<path>#L<x>` or `<path>#L<x>-L<y>`, the range
ends before it starts, the path holds whitespace or `#`, or more than five
`--fragment` were given. Or the file cannot be sent under an honest
provenance: the directory is not in a git repo, the repo has no commits, the
file is untracked, it differs from HEAD (the provenance names HEAD's sha, so
uncommitted text is never sent under it), it is binary, the range runs past its
end or holds only blank lines, or it is over 20000 characters. The `ERROR` line
names the reference and never the file's text. Nothing was sent. Fix: pass a
line range of a file committed in this repo, committing it first if needed.

### socrates-unfit-unsupported

`eris socrates submit --unfit` was answered with a receipt that does not echo
`unfit`. A server that does not know the field drops it and files the
candidate as a plain one, so the hypothesis and evidence were not read. The
`ERROR` line names the candidate the receipt carries. Exit 1, nothing on stdout.
Fix: update the Socrates server to a version that supports unfit submits, or
check the url points at the right endpoint.

### socrates-policy-not-cached

`eris socrates policy --cached` found no cached policy: `~/.eris/socrates-policy.json`
is absent, unreadable or not a cached policy. `--cached` never fetches, and
never prints the rubric's defaults as if they were the org's. Nothing was
sent. Fix: run `eris socrates policy` without `--cached`, which fetches the
policy and writes the cache.

### socrates-reclassified

A `WARN`, not a failure. `eris socrates submit --answer` stamped the candidate
with the org policy hash it had cached, and the server's policy has changed
since: it scored the stamp under its current policy. The line names the
current hash, the stamped one, and the server's verdict, which is the one that
counts. eris refreshes `~/.eris/socrates-policy.json` (or, when that fails,
removes it so the next stamped submit fetches it), unless the cache holds a
rubric this build does not know: that cache is left as is and the line says so.
Fix: none needed; run
`eris socrates classify` again to see the verdict under the current policy.

### socrates-repo-policy-invalid

The nearest `eris.yaml` sets a `socrates` block that a repo may not set. A
repo's layer can only make the org's policy stricter, so `socrates` holds only
`policy`, and `policy` only these keys:

```yaml
socrates:
  policy:
    threshold: 5          # a number >= 0, at least the org's threshold
    gates:
      end_condition:
        enabled: true     # turn a hard gate on (never off, never a weight)
    auto_resolve: false   # pin auto-resolve off (never true)
```

Any other key (`verbosity`, `escalation`, `reporting`, a weight, `enabled:
false`, YAML 1.1's `on`) is refused, not dropped. The `ERROR` line names the
file and each offending key. Nothing was scored or sent. Fix: remove or
correct the named keys.

### socrates-repo-policy-looser

The nearest `eris.yaml`'s `socrates.policy` parses, but would loosen the org's
policy: its `threshold` is below the org's (as `eris socrates submit` cached it
in `~/.eris/socrates-policy.json`, else the rubric's own threshold), or it
names a question that is not a hard gate of the rubric being scored. `eris
socrates policy` refuses it too. The `ERROR` line names the file and each
problem. Nothing was scored or sent.
Fix: raise `threshold` to at least the org's or remove it; name only hard
gates.

### socrates-unreachable

The request to the endpoint (`<url>/v1/socrates/submit`,
`/v1/socrates/resolve`, `/v1/socrates/status`, or the `/v1/socrates/policy`
fetch that `submit` makes when no policy is cached or the cached one is over an
hour old, and `policy` makes always) did not complete: the host could
not be reached, or no answer arrived within 30 seconds. The url is the one
`eris login` saved (or `ERIS_YAKS_URL`). Nothing is retried. Fix: check the
url and the connection, then run the command again.

### socrates-not-entitled

The endpoint answered with a problem+json error carrying a subscribe link
(`_links.subscribe`): this workspace has not bought Socrates, or its
entitlement has lapsed. The `fix:` line is the link. Fix: subscribe through
it, then run the command again.

### socrates-refused

The endpoint answered with a problem+json error and no subscribe link. The
`ERROR` line carries its `detail`, `code` and HTTP status; a 401 means the
token was rejected. For `resolve`, a 404 means the endpoint holds no review
Epic by that id and a 409 that the Epic is still open (or has more entries
than one resolve reads); the `fix:` line says which. For `status`, a 404 means
the org holds no candidate with that id. For `settings team`, a
403 `admin_required` means only an org admin may change it, and a 422 that the
team is not one of the project's teams (the detail lists them). For
`settings policy` and `settings canon` a 403 means the same, and a 409 on a
policy change means it was saved by someone else since it was read: run the
command again. For `enrol` (and `settings enrolment <project>`) a 403 means
only an org admin may enrol, a 404 that no project readable to Socrates has
that name or id, and a 409 `linear_ref_ambiguous` that more than one project has that name (the
`fix:` line lists each candidate's id and name: pass one id), and a 409
`linear_disconnected` that the org's Linear connection must be restored first. For
`consult`, a 404 means the org has several enrolled projects and `--project`
was not passed (the detail lists them) or the project has not created that doc,
and a 409 means no Canon doc has been chosen; when the endpoint sent a settings
link (`_links.settings`), the `fix:` line is that link. Fix: for a 401 run
`eris login`; otherwise correct what the detail names.

### socrates-doc-unavailable

A `WARN`, not a failure. `eris socrates consult --brief` could not read one doc
because the endpoint said the org does not have it (HTTP 404, or 409 for a
Canon doc nobody has chosen), and went on with the others. The line names the
doc and the refusal, and the settings link when the endpoint sent one. Fix:
open the link or create the doc in Linear; a brief that read nothing fails with
`socrates-refused` instead.

### socrates-ref-ambiguous

A `WARN`, not a failure, and the command exits `0`. A Linear name the command
sent (a team key or name, a project name) matched more than one object, so the
endpoint changed nothing and listed the candidates as `<id>  <name>` lines. Fix:
run the command again with one candidate's id. `--output json` prints
`{ambiguous: {kind, candidates: [{id, name}]}}` on stdout instead.

### socrates-bad-response

The endpoint's answer was neither a receipt nor a problem+json error
(a proxy page, an outage, a different service), or it was a receipt with a
non-2xx status. Nothing in it is trusted. For `resolve`, such an answer with
HTTP 404 means the endpoint does not serve `/v1/socrates/resolve`: the server
predates the route (likewise `status` and `/v1/socrates/status`). `status
--candidate <id>` also raises it for an answer that holds no state for that
candidate, or another candidate's: an older server ignores the query and
answers for the org. Fix: check the url points at a Socrates endpoint, or
update the server.

### socrates-not-a-repo

`eris socrates discover` found no history to list: the working directory is
not inside a git repo, the repo has no commits, or `git` could not run or gave
no answer within 10 seconds (the `ERROR` line says which). Nothing was written.
Fix: run discover from inside the repo whose sources you want, with `git` on
PATH.

### socrates-cursor-invalid

`eris socrates discover` could not use the processed-source cursor. The
stored cursor or `--since` names no commit in this repo (history was rewritten,
or the repo was replaced); `--advance` named no commit, a commit outside
HEAD's history, or one that does not come after the stored cursor (the
cursor only moves forward); or `~/.eris/socrates/cursors.json` cannot be read, parsed or written.
Nothing was written. Fix: as the `fix:` line says. `--advance <rev>` moves a
cursor whose commit is gone, and removing the file starts every repo over.

### socrates-discover-invalid

`eris socrates discover` was given flags it cannot combine or read: `--limit`
outside 1-500 or not a whole number, or `--advance` with `--since` or
`--limit` (advancing lists nothing). Fix: as the `fix:` line shows.

### socrates-discover-truncated

A `WARN`, not a failure. More commits follow the cursor than `--limit` allows,
so `discover` listed the oldest of them. Fix: process those, run
`eris socrates discover --advance <the last sha listed>`, then list again.
With no cursor yet, it means history goes back further than the last
`--limit` commits it listed. Fix: pass `--since <rev>` to start further back,
or accept the window.

### yak-reports-forbidden

`eris yak reports` was answered `403`: the credential in use cannot read vendor reports, for example a
token that does not carry the yak product. Fix: `eris login`, which mints a login that does. Exit 1.

### yak-reports-unconfigured

`eris yak reports` was answered `503 vendor_unconfigured`: the endpoint's vendor report mirror is not set
up, so it has no reports to list for any org. Nothing in this org or on this machine changes it; retry
later. Exit 1.

### yak-reports-unavailable

`eris yak reports` was refused with a status eris has no remedy for (`404` from an endpoint that does not
serve the route yet, a `5xx`). The block names the status and the server's error code, never the response
body. A timeout, an unreachable endpoint or a body that does not match the contract is
[`yak-admin-unavailable`](#yak-admin-unavailable) instead. Retry; `eris whoami` shows which org and url this
directory uses. Exit 1.

### yak-clusters-invalid

`eris yak clusters` was given a `--days` that is not `7` or `30`, a `--limit` outside `1` to `50`, or a
`--min-sightings` that is not a whole number. It is refused before any request, because the endpoint
answers `400 invalid_query` for the same values. Fix: use `--days 7` or `--days 30`, `--limit <1..50>` and
`--min-sightings <n>`. Exit 1.

### yak-clusters-unavailable

`eris yak clusters` was refused with a status eris has no remedy for (`404` from an endpoint that does not
serve the route yet, a `5xx`). The block names the status and the server's error code, never the response
body. A timeout, an unreachable endpoint or a body that does not match the contract is
[`yak-admin-unavailable`](#yak-admin-unavailable) instead. Retry; `eris whoami` shows which org and url this
directory uses. Exit 1.

### yak-show-missing-id

`eris yak show` was run without an id. Fix: `eris yak show <id>`, taking the id from `eris yak clusters`
(a cluster) or from a cluster's observations table (an observation). Exit 1.

### yak-show-not-found

`eris yak show <id>` named no cluster and no observation in this org: the cluster read and the observation
read both answered `404`, or the id is not a plain id (letters, digits, `_` and `-`, up to 64). Fix: list ids
with `eris yak clusters`. Exit 1.

### yak-show-unavailable

`eris yak show` was refused with a status eris has no remedy for (a `5xx`, a `403`). The block names the
status and the server's error code, never the response body. A timeout, an unreachable endpoint or a body
that does not match the contract is [`yak-admin-unavailable`](#yak-admin-unavailable) instead. Retry. Exit 1.

### yak-retry-missing-id

`eris yak retry` was given no observation id. Run `eris yak retry <observation-id>`; find one with `eris yak
show <cluster-id>`. Exit 1.

### yak-retry-not-found

`eris yak retry` named an observation this org does not hold (`404`), or an id that is not shaped like one
(nothing was sent). Exit 1.

### yak-retry-admin-required

`eris yak retry` was refused `403 admin_required`: only an admin of the org can requeue a failed observation.
Ask an org admin to run it. Exit 1.

### yak-retry-unavailable

`eris yak retry` was refused with a status eris has no remedy for (a `5xx`). The block names the status and
the server's error code. Retry. Exit 1.

### events-invalid

`eris events list` or `parked` was given a `--product`, `--day`, `--limit` or `--cursor` the endpoint would
refuse (a day that is not a real UTC date, a limit outside 1..500, a cursor over 64 characters, no product
for `list`). Nothing was sent. Exit 1.

### events-not-found

`eris events` read a route that is not served to this org (`404`). `events parked` is the operator org's
read, so every other org gets this. Exit 1.

### events-unavailable

`eris events` was refused with a status eris has no remedy for (`403` for a credential without the
`linear-proxy` product, or a `5xx`). The block names the status and the server's error code. Retry, or run
`eris login`. Exit 1.

### events-unknown-command

`eris events` was given a command other than `list` or `parked`. Run `eris events --help`. Exit 1.

### doctrine-unknown-verb

`eris doctrine <word>` named no doctrine command. The commands are `check`, `schema`, `gates`,
`effect`, `set`, `pull`, `push` and `path`; `eris doctrine --help` lists them. Exit 1.

### doctrine-org-unresolved

`eris doctrine pull` found an `eris login` bearer for this directory, but it names no org (it is not a
`sib_<org>_…` token), so there is no org policy to pull. Run `eris login` to mint an org bearer, or set
`ERIS_ORG` to the org this directory acts as. Exit 3.

### doctrine-pull-unwritable

`eris doctrine pull` could not write the new tree under `~/.eris/doctrine/`, or could not swap the
org's link onto it. The block names the path and the system's reason. Nothing was swapped: the
previous tree, if any, is still the org's. Make `~/.eris/doctrine` writable by you (a pull creates it
`0700`), then pull again. Exit 3.

### doctrine-local-modified

The org's pulled tree under `~/.eris/doctrine/<orgId>/` no longer matches what was pulled: a file was
edited, added or removed, the manifest does not decode, or the files no longer hash to the manifest's
`bundle_sha`. The block names the first difference. Every verb that reads the tree checks it first
(`eris doctrine path` does), so an edited policy is never read as the org's. Run `eris doctrine pull`
to restore it; it replaces the tree without reading it. To keep the edit instead, `eris doctrine
push` saves it as the org's policy. Exit 3.

### eris-login-required

A verb that calls the hosted gates API has no usable `eris login` bearer: none is saved for this
directory's org and `ERIS_YAKS_TOKEN` is unset, the credentials file cannot be read, or the gateway
rejected the token (HTTP 401; the block names the server's error code). Run `eris login` once on the
machine, or set `ERIS_YAKS_TOKEN` to a `sib_` service token with its `ERIS_YAKS_URL`. Exit 3.

### login-url-refused

The `eris login` URL a verb would send the bearer to is not `https:`, or is `http:` on a
host other than `localhost`, `127.0.0.1` or `[::1]`, or is not a URL at all. Every verb that sends the
bearer (`eris yak`, `eris socrates`, `eris gate`, `eris doctrine`, `eris loop`, `eris org`) resolves it
through one check and stops before any request: the bearer never crosses a cleartext link. `eris yak`
prints it as a warning and exits 0, as for every other sign-in problem. Set `ERIS_YAKS_URL` (or the `url` in `~/.eris/yaks.json`) to
the gateway's `https` URL. Exit 3.

### gate-store-forbidden

The gateway accepted the bearer but refused it for this request (HTTP 402 or 403): the org does not
have Gates, or the token's scope does not cover the route. Sign in with an account whose org has
Gates, or ask the org's admin. Exit 3.

### gate-store-unreachable

The hosted gates API gave no answer within the deadline, the network failed, it answered with a
`5xx`, or (for `eris doctrine pull`) the org's policy changed between the policy and settings reads
twice running. Nothing was written. Retry once the gateway answers; `ERIS_YAKS_URL` (or `yaks.json`'s
`url`) names the host when it is not the default. Exit 3.

### gate-contract-mismatch

The gateway answered with something this client's contract does not describe: a status the route
does not answer with, a body that does not decode (an HTML page from a proxy, an older or newer
contract), a reply over the size cap, or a policy bundle whose values do not hash to the
`bundle_sha` the server named. A pulled bundle that does not survive being written to disk and read
back is also this slug. Nothing was written. Update eris (`eris update`); if it persists, the gateway
and this client disagree on the gates contract. Exit 3.

### doctrine-push-refused

The gateway does not take a policy save on this bearer (HTTP 403 or 405 from `PUT /v1/gates/policy`):
the login is not an org admin's. Service tokens and members cannot save the org's policy. Nothing
was saved and the tree under `~/.eris/doctrine/<orgId>/` is as you left it. Sign in as an org admin
with `eris login` and push again; or change the policy in the org's Gates settings, then run
`eris doctrine pull`. `eris doctrine settings set` raises the same slug on `PUT /v1/gates/settings`
for the same reason. Exit 3.

### doctrine-push-needs-approval

The save loosens the org's policy (any loop edit, a looser posture, and so on), and the org's
Mandate requires a passkey approval for that: `PUT /v1/gates/policy` answered HTTP 403
`policy_widening_requires_passkey`. Open <https://dash.sibylline.group/gates/approve>, approve with
your passkey, then rerun with `ERIS_GATES_APPROVAL=<handle> eris doctrine push`. The approval lasts
5 minutes and covers one save; the gateway spends it only on a save that needs it, and eris never
prints it.

The same slug covers an approval that cannot be used: `ERIS_GATES_APPROVAL` is set but is not an
approval handle (`mnd_...`; refused before any request, without echoing the value), or the Mandate
refused the one sent (expired, already used, revoked, or not covering this save). Approve again and
rerun. Nothing was saved and the tree is as you left it. `eris doctrine settings set` raises this
slug for a settings save that loosens them (`ERIS_GATES_APPROVAL=<handle> eris doctrine settings set
<key> <value>`). Exit 3.

### doctrine-push-stale

The org's live policy is not the one your edited tree was pulled on, so pushing would revert the
newer save (or the gateway answered HTTP 409 to the save). Nothing was saved and the tree is
untouched. Copy your edited files out of `~/.eris/doctrine/<orgId>/`, run `eris doctrine pull`,
re-apply them, then push again. When the save carried an approval (`ERIS_GATES_APPROVAL`), it may
have been used: approve again at <https://dash.sibylline.group/gates/approve> before you push. Exit 3.

### doctrine-push-invalid

The tree cannot be pushed: it holds a file a policy bundle does not carry, a file that does not
decode (the block names it), or the gateway refused the bundle (HTTP 400, 413 or 422: not a valid
bundle, over 256 KiB, or holding a credential). Nothing was saved and the tree is untouched. Fix or
remove the named file (`eris doctrine check --file <doctrine.md>` names doctrine problems), then push
again. Exit 3.

### doctrine-org-managed

`eris doctrine set` was pointed at a file inside `~/.eris/doctrine/`, the org's pulled policy, which
this machine never edits in place. Change the active posture in the org's Gates settings, then run
`eris doctrine pull`; or pass `--file` naming a local doctrine file. Exit 3.

### doctrine-posture-unknown

`eris doctrine set <posture>` named a posture the doctrine file has no `## <posture>` section for. The
block lists the slugs it does have (`eris doctrine check` lists them too). Exit 3.

### doctrine-out-of-date

The gateway refused a receipt write (HTTP 409 `doctrine_out_of_date`): the org requires every writer to
hold its live policy (staleness `hard`), and this machine's pulled copy is not it. Nothing was
recorded. Run `eris doctrine pull`, then re-run the command. With staleness `soft` the write lands and
the verb prints one `WARN` naming `eris doctrine pull` instead. Exit 3.

### linear-issue-not-found

The gateway's tracker connection has no issue with this key visible to your org (HTTP 404
`issue_not_found`) on a receipt read or write. Check the issue key and that the issue is not archived.
Exit 3.

### linear-rate-limited

The gate receipt store answered HTTP 429 and the verb's bounded retry (it waits the reply's
`Retry-After`, capped, then a fixed backoff) ran out. Nothing past the refused call was read or
written; a write that was retried reused its comment id, so it was never stored twice. Wait the time
the block names and re-run. Exit 3.

### linear-issue-claimed

`eris loop launch` or `resume` asked the gateway to claim an issue another loop holds (HTTP 409
`issue_already_claimed`). The block names the holder's loop, runtime, session and when its claim
expires. Nothing was claimed or spawned. Message that loop or wait for its hand-back; `eris loop stop`
releases a claim this machine holds. Exit 3.

### linear-state-not-found

A loop asked the gateway to move an issue to a state its team's workflow does not have (HTTP 404
`state_not_found`): `In Progress` on launch, `Todo` on stop. The loop verbs only warn with it; the
session already started or stopped. Add the state to the team's workflow, or move the issue by hand.
Exit 3.

### yak-unresolved

`eris loop resolve` or `launch` was given a yak id the gateway could not turn into an issue key: the
yak is unknown, has no cluster yet, or its cluster has no tracker issue yet. Nothing was claimed or
spawned. Pass the issue key instead, or re-run once the yak has an issue. Exit 2.

### loop-usage

An `eris loop` operand was refused before anything was claimed, requested or spawned: a loop name with
`/`, `\` or `..`, an issue that is not a key, a `--cwd` that is relative, missing or `$HOME`, a missing
`--model`, a `--context` or `--prompt` over 1,024 characters, a blank or oversized hand-back, a loop body
off its caps, or the `claude` CLI not on PATH. The block names the operand. Correct it and re-run
(`eris loop <command> --help`). Exit 2.

### loop-unknown

The org's pulled policy carries no loop by that name. The block lists the loops it does carry. Name one
of them (`eris loop list`), or author the loop in the org's Gates settings, run `eris doctrine pull`, and
re-run. Exit 2.

### loop-launch-failed

The `claude` CLI failed to start or stop a background session: it exited non-zero, printed no
`backgrounded · <id> · <name>` receipt, timed out, or could not run. A launch that had claimed the issue
released the claim (`aborted`, the reason as its body) before failing. Fix what the detail names (the
CLI, its background daemon, the working directory) and re-run. Exit 1.

### loop-hand-back-failed

`eris loop hand-back` posted on some targets but not on the ones the block names; a WARN line above it
says why for each. The receipt lines for the targets that did get the hand-back were printed first.
Fix the cause (sign-in, the issue key, the gateway) and re-run the hand-back with the same body on the
target that got nothing. Exit 1.

### loop-session-not-found

A `<ref>` (a session id, its exact name, or the issue key of a loop session) names no background
session under `~/.claude/jobs/`. `claude agents` lists the sessions there. Exit 2.

### loop-session-ambiguous

A `<ref>` names more than one background session (two jobs with one name, or two working loops on one
issue). The block lists their ids; pass one of them. Exit 2.

### loop-claim-ledger-unwritable

The claim ledger, `~/.eris/loop/claims/`, could not be written. A launch or resume that had reserved a
claim released it (`aborted`) first, so no claim is held that this machine cannot name. Make the
directory writable by you (it is created 0700) and re-run. Exit 3.

### loop-secret-detected

`eris loop hand-back` found a secret in the body: a vendored gitleaks rule (`packages/outbound-scan`)
matched it. The `ERROR` line names the rule ids, never the text. Nothing was sent: the claim is still
held and no comment was posted. This check cannot be overridden. Remove the secret from the hand-back
and run it again. Exit 2.

### asks-store-unreachable

The asks API (`GET /v1/asks`) gave no answer within the deadline, the network failed, or it answered
with a `5xx`. `eris gate check` never reads an unreadable asks API as "no asks": it fails instead. Retry
once the gateway answers. Exit 3.

### asks-store-forbidden

The asks API accepted the bearer but refused it (HTTP 402 or 403): the org may not raise or read asks
on this token. Sign in with an account whose org may, or ask the org's admin. Exit 3.

### asks-contract-mismatch

The asks API answered with a status the route does not answer with, a body that is not an `ask@1`
listing, or a reply over the size cap. Update eris (`eris update`); if it persists, the asks API and
this client disagree on the contract. Exit 3.

### asks-rate-limited

The asks API answered HTTP 429. The block names the wait when the reply carried `Retry-After`. Wait and
re-run. Exit 3.

### gate-usage

An `eris gate` command line is wrong: a required flag or the `<gate>` operand is missing, `--gates`
and `--profile` were both given, `--burden` came without `--base` (or the reverse), `--pr` is not a
number (each exit 1, before anything is read); or a value is wrong once read: an issue key that is
not `ABC-123`-shaped, a gate name that is not kebab-case, a `--verdict` other than `PASS`, `AMENDED` or
`BLOCKING` (a skip is `eris gate skip`), an `--impact` other than `U0`-`U3`, a blank `--authorized` or
`--reason`, a `--reason` under 12 characters, an unrecognised screenshot or video extension, or a
reserved `unlocked-*` gate (exit 2). Nothing was sent. The block's `fix:` names the usage
([GATE.md](GATE.md)).

### gate-profile-unknown

`eris gate check --profile <name>` named no profile in force: the built-in `spine` and `deep`, the
org's pulled `profiles.yaml`, or the `--profiles` file. The block lists the profiles there are. Exit 2.

### gate-file-unreadable

A file `eris gate record` or `skip` must hash (`--artifact`, `--doctrine`, an evidence file) cannot be
read. The block names the flag and the path, never the bytes. Relative paths resolve from the current
directory. Exit 3.

### gate-evidence-too-large

An inline evidence file (`--log`, `--test-run`, `--e2e`, or one `--evidence` line) is over 16 KiB, or a
`--screenshot`/`--video` is over 25 MiB. A receipt is a record, not a log store: record the part the
gate relied on (a failure summary, the last lines). Nothing was sent. Exit 2.

### gate-artifact-uncommitted

`eris gate record --artifact` named a file inside a checkout with a hosted `origin`, but the file's
bytes are not committed at HEAD, or HEAD is not pushed to `origin`. The receipt would name a commit no
other checkout can read. Commit and push, then record again. Nothing was sent. Exit 3.

### gate-skip-unauthorized

`eris gate skip` was given a grant that reads as a machine grant but does not hold: a `doctrine`
grant that is not exactly `doctrine:<posture>`, has no `--doctrine` file, or names a posture that is
not the active one or does not set the gate `off` (the block names the doctrine's sha256 it judged
and, when the active posture does turn the gate off, the exact flags it accepts); or a `repo` grant
that is not exactly `repo:no-eris-yaml` on `define-future` in a git repo with no root `eris.yaml`.
Run the gate, or skip it on a human grant (`--authorized '<name> asked: <request>'`). Nothing was
sent. Exit 3.

### gate-receipt-unseen

`eris gate check --expect <ids>` re-read the issue's receipts (about 30 s) and no listing held every
id: the store's reads lag its writes. Re-run the same check in a minute; if an id stays unseen, check
it is a comment on this issue (`eris gate record` printed it). Exit 3.

### gate-check-failed

At least one gate `eris gate check` judged does not pass: a row reads `missing`, `bad-digest`,
`blocking`, `unresolved`, `drift`, `unauthorized-skip`, `doctrine-stale` or `forbidden`, the
`burden` row reads `unmet`, the user-impact floor is `unmet` or `unclassified`, a door at the first
rung has no human sign-off, `@remediate` reads `unsupported`, or `@asks` reads `open`. The block names
each, and its `fix:` says what clears each status ([GATE.md](GATE.md#statuses)). Exit 3.

### gate-burden-unreadable

The `--burden` rubric cannot be read, is not YAML, or is not a `surfaces:` map of surface to a
non-empty list of evidence kinds (`text`, `log`, `test-run`, `e2e`, `screenshot`, `video`). Exit 3.

### gate-burden-unresolved

`eris gate check --burden` could not say which surfaces the change crosses: the directory is not in a
git checkout, `--base` names no commit or shares no history with HEAD, git could not list the
changes, the checkout has no root `eris.yaml`, the root opts nothing into discovery
(`discover.language` + `discover.paths`) or its discover block cannot be read, or the estate has leaf
`eris.yaml` files under the root (this build resolves surfaces from the root's claims only, so a
leaf's narrower claim could own a changed path). Exit 3.

### gate-ladder-invalid

The door-class ladder `eris gate check` reads (`--ladder`, or the build's) cannot be read, is not
YAML, or does not decode: `classes:` maps door classes (`all`, `U0`-`U3`, `U<n>:<crossing>`) to a rung,
and no U3 class sits above the human-after rung. Fix the file, or move it aside to read every class at
the default rung. Exit 3.

### gate-ci-event-invalid

`eris gate ci` could not read a `pull_request` event: no `--event` and no `GITHUB_EVENT_PATH`, the
file is unreadable or not JSON, or it lacks `pull_request.title`, `.head.ref`, `.head.sha`,
`.base.sha` or `.user.login` (each sha a full 40-hex commit). It fails closed: nothing is fetched. Run
it from a workflow triggered by `pull_request`, with `--event "$GITHUB_EVENT_PATH"`
([GATE.md](GATE.md#ci)). Exit 3.

### gate-issue-missing

`eris gate ci` found no issue key on the pull request: none in the head ref (`<you>/<key>-...`) and
none in the title, the author is not on the org's `settings.ci.bot_allowlist`, and the org's
`settings.ci.untracked_prs` is `block`. Put the key in the PR title (`ABC-123: ...`) or the branch
name; a title edit re-runs the check when the workflow triggers on `edited`. An org that accepts
untracked PRs sets `untracked_prs` to `warn` or `allow` in its Gates settings
([GATE.md](GATE.md#ci)). Exit 3.

### gate-ci-bot-surface

`eris gate ci` ran the surfaces leg for an untracked pull request (no issue key, and an allowlisted
bot author or `untracked_prs: warn|allow`), and the PR's merge-base diff changes a path on a
registered surface, at the fork's registry or the head's, or the registry itself; the
`@surface-path` rows name each. A surface change needs an issue so the ticketed legs (profile,
monotone, unlock) judge it: put the issue key in the PR title or branch ([GATE.md](GATE.md#ci)).
Exit 3.

### gate-ci-write-refused

`eris gate ci`'s gateway client refused a request that is not a `GET` before it left the process:
the check reads the gateway and writes nothing, and every call it makes goes through one GET-only
fetch. It means a leg tried to write, and it is reported in place of any failure the client made of
the refused request. Nothing was sent. Report it with the command's output ([GATE.md](GATE.md#ci)).
Exit 3.

### gate-monotone-wider

`eris gate ci`'s monotone leg found that the `.claude/surfaces.yml` diff, a surface vocabulary or a
registered review skill widens the surface bar on at least one dimension; the `@monotone` rows name
each. The issue's latest `surface-widen` receipt is missing, does not pass, carries no human
`--authorized` grant (a `doctrine:` grant never approves a widening), or its artifact lacks one of the
wider rows. Tighten instead, or have a human approve the widening: save the `@monotone` rows the run
printed (without the `@monotone` prefix) to a file, commit and push it, record
`eris gate record surface-widen --issue <KEY> --verdict PASS --artifact <that file> --authorized
"<name> asked: <request>"`, and re-run the check ([GATE.md](GATE.md#ci)). Exit 3.

### gate-monotone-unresolved

`eris gate ci`'s monotone leg could not read the two sides: the directory is not in a git checkout,
the event's base sha names no commit here or shares no history with `HEAD`, or git could not list the
changes or read a file at the merge-base. Check out the PR with `fetch-depth: 0`. Exit 3.

### gate-unlock-human

`eris gate ci`'s unlock leg did not unlock the merge, and no human signed it. The failure names every
reason: the hosted posture does not set `signoff.unlock: on`; a bar gate is missing, failing or not
bound to the PR head (`stale-head`), or its qualifier is not met (`no-report`, `not-clean`) or is one
this build does not judge (`unjudged`); the surface does not list `merge` under `one_way_unlock`; it is
not on the base registry yet; its ledger has no fresh passing `audit-surfaces` baseline, the change
budget since it is spent, or no `unlocked-merge` announcement names this head; the surface is
locked; or the diff touches a governance file (the registry, a registered vocabulary or review
skill: always human, with each `@monotone` row named, and a wider row no human `surface-widen`
receipt covers named again). A `door-signoff` on the issue that does not hold is named too:
`stale-head` (recorded before a later code push, on a commit that is not its ancestor, or over a file
artifact), `wrong-action` (no `door: merge` evidence line), or no human grant. A human signs off at
the PR head with `eris gate record door-signoff --issue <KEY> --verdict PASS --artifact <committed
plan or note> --evidence "door: merge" --authorized "<name> asked: <request>"`, or close each reason
and re-run the job ([GATE.md](GATE.md#ci)). Exit 3.

### gate-unlock-unresolved

`eris gate ci` could not read the change: the directory is not in a git checkout, the event's base
names no commit or shares no history with `HEAD`, the event's head sha is neither `HEAD` nor the PR
parent (`HEAD^2`) of a two-parent merge onto the base tip whose tree is their clean merge, the base
and head share no merge-base, or git could not list the changed paths or read the registry at a
commit. Check out the PR with `fetch-depth: 0` ([GATE.md](GATE.md#ci)). Exit 3.

### asks-listing-truncated

The asks API answered `eris gate check`'s read of open blocking asks with a full page. The route has
no cursor, so asks past that page may be open: the check fails closed rather than read a partial
list as complete. Answer or withdraw stale asks to bring the open set under the page. Exit 3.

### doctrine-usage

`eris doctrine effect` read stdin that is not one JSON object of the shape
`{"contract": "policy"|"surfaces", "before": <value|null>, "after": <value|null>}`, or could not read
stdin at all. Pipe the object in ([DOCTRINE.md](DOCTRINE.md#effect)). Exit 2.

### doctrine-file-missing

A doctrine verb needs a doctrine file and has none: `eris doctrine check` was given no `--file`,
the build names no default doctrine file and no org policy is pulled, or the file it names cannot be
read. Pass `--file <path>`, or run `eris login`, then `eris doctrine pull`. From `eris doctrine path`: no signed-in org resolves for the directory, or nothing
is pulled for it; run `eris login`, then `eris doctrine pull`. `eris doctrine gates` with no doctrine file is not a failure: it prints nothing,
since no posture then skips or defers a gate. Exit 3.

### doctrine-policy-invalid

A doctrine file does not parse as a doctrine, or a posture's `policy:` block breaks the contract:
an unknown value, a `policy:` outside a ```` ```yaml ```` fence, more than one `policy:` block in a
section, an `active:` that names no section, or a value that lowers the floor (a U2/U3
requirement list without its floor, `final-gates` or `user-impact` set `off`, a `lifts` class
other than U0/U1, a U3 ceiling above its cap, a `signoff.waive` key). `eris doctrine check` prints one
`<file>:<line>: <message>` line per problem on stderr before the block and nothing on stdout;
`eris doctrine gates` names the first. From `eris doctrine effect`, a `before` or `after` value
that does not decode as a `policy:` block. Fix each line named; the floor is
[DOCTRINE.md](DOCTRINE.md#the-floor). Exit 3, never a default posture in its place.

### gate-profile-unreadable

The `--profiles` file (or the build's default profiles file) cannot be read, is not YAML, or is
not a map of kebab-case profile names to a non-empty list of kebab-case gate names, or to
`{ require: [...], forbid: [...] }` with no gate in both lists. Exit 3.

### gate-surfaces-invalid

`eris doctrine effect` with `"contract": "surfaces"` was given a `before` or `after` value that
does not decode as a `.claude/surfaces.yml`: a missing or empty `surfaces:` map, a surface name
that is not kebab-case, an unknown key at any level, a malformed `audit_ttl`, `change_budget`,
`ledger` or unlock gate, or two surfaces sharing a ledger. The block names the side and the first
problem. From `eris gate ci`, the registry (`--registry`, default `.claude/surfaces.yml`) at the
merge-base, the head or in the working tree is one of those, is not valid YAML, holds more than one
document, an anchor, alias or merge key, or is a symlink; the block names the side and each line.
Exit 3.

### surface-lock-unauthorized

`eris surface lock` or `unlock` was given no `--authorized` grant, or a grant that is not a human
one (`doctrine:<posture>` never signs). A lock and its lift are human writes: pass
`--authorized 'Dan asked: <request>'`. Nothing was read or sent. Exit 3.

## Adding a new slug

Call `reportFailure({ slug, what, fix, docs })` (it writes the block and
returns 1) from `ts/lib/eris-fail.ts` at the callsite (`docs`
defaults to `docs/ERRORS.md#<slug>`), then add a `### <slug>` heading here. A
plugin calls `renderFailureBlock` from the SDK (`src/cli/plugin.ts`). Slugs are
lowercase kebab-case, stable once shipped.

`tests/errors-doc.test.ts` asserts that every slug has a heading here, and it
**derives** the slug list from the raisers rather than carrying a copy: in the
`eris` shim, its `printf 'slug: …'` block; in every TypeScript tree (`src/`,
`ts/lib/`, `plugins/`), `slug: "…"` literals, `fail("…", …)` calls, the members
of every `…Slug` union, and `renderWarnLines(…, "<slug>")` arguments. So a new
slug is covered the moment it is raised — but it also fails the suite until its
heading exists, which is the point. The check runs both ways: a heading whose
slug nothing raises fails the suite too, so delete the heading in the change
that removes the last raiser.

### skills-unknown

`eris skills install` was given a skill name this build does not publish, or the build carries no
skills at all. Nothing was installed. The `fix:` line lists the published names; run the command
with one of them, or with none to install every one. A build with no skills is incomplete:
reinstall eris. See [SKILLS.md](SKILLS.md).

### skills-target-occupied

A path `eris skills install` writes holds something it does not recognise as the skill: a file, a
symlink pointing elsewhere, a directory whose `SKILL.md` is not named for this skill, or a parent
(`~/.agents/skills`, `~/.claude/skills`) that is not a directory. eris never overwrites it, and
refuses before writing anything for any named skill. Move or remove the path the error names (the
`fix:` line has the command), then run the install again. See [SKILLS.md](SKILLS.md).

### skills-install-failed

A write under `~/.agents/skills` or `~/.claude/skills` failed (permissions, a full disk, a
read-only home). Skills before the failing one are installed. When the skill's own copy failed, its
previous copy is put back; when only its Claude Code link failed, the new copy stays and the link is
missing. Fix the cause the error names and run the command again: a rerun leaves installed skills
`unchanged` and finishes the rest.

### skills-lint-unreadable

`eris skills lint` was given a path that does not exist or is not a directory, so nothing was
linted: a mistyped path is refused rather than reported clean. Name the directory that holds
`skills/` or `.claude/skills/`, or run the command from it with no argument. See
[SKILLS.md](SKILLS.md#eris-skills-lint-dir).

### slack-code-missing

`eris slack link` was given no link. Nothing was sent. In Slack, press an ask button: Slack
replies, only to you, with a one-time `Link Slack account` link. Run `eris slack link <link-url>`. Exit 1.

### slack-code-invalid

`eris slack link` was given a URL with no `code=` value, or one that is not 1 to 64 letters, digits, `-`
or `_`. Nothing was sent, and the input is not echoed. Give the full link Slack sent you. Exit 1.

### slack-link-not-url

`eris slack link` was given something that is not the link's full `http(s)` URL, or a word the argument
parser refuses (a bare code, a flag-shaped word, an extra word). Nothing was sent, and the argument is not
shown, because it may be a live single-use link code. Give the full `Link Slack account` URL Slack sent
you, once. Exit 1.

### slack-code-unknown

The link was refused with `404 invalid_code`: it is unknown, already used, older than 10 minutes, or was
made for another org. Nothing was linked. Press an ask button in Slack again for a new link and run the
command within 10 minutes. Exit 1.

### slack-already-linked

The link was refused with `409 slack_already_linked`: that Slack account, or you, already has a link. The
code is spent. Run `eris slack unlink`, then press an ask button in Slack for a new link. Exit 1.

### slack-unavailable

The preview or link was refused with `502 slack_unavailable`: Slack could not name the account the link is
for, so no link is offered. Retry in a moment. Exit 1.

### slack-member-required

`eris slack link` or `unlink` was refused with `403 member_required`: a service token has no member to
link. Run `eris login` as a person. Exit 1.

### slack-scope-denied

The Slack link was refused with `403 scope_denied`: the token does not carry the `linear-proxy` scope the
asks routes need. Run `eris login`; `eris whoami` lists what the token carries. Exit 1.

### slack-unknown-verb

`eris slack` was given a command it does not have. The commands are `link` and `unlink`. Exit 1.

### slack-rate-limited

The Slack link was refused with `429`: the org's asks budget is spent. Nothing changed. Wait the
`Retry-After` seconds the message names (a minute when it names none) and run the command again. Exit 1.
