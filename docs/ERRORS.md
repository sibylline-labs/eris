# eris failure model

Hard failures go through `renderFailureBlock` / `emitFailureAndExit`
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

No longer raised. A Yaks base URL always resolves now: `ERIS_YAKS_URL`, then the
`"url"` in `~/.eris/yaks.json`, then the default `https://api.sibylline.group`.
An older eris warned with this slug (exit 0) when neither was set; with this
one, set `ERIS_YAKS_URL` only to use another endpoint.

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

The Yaks endpoint answered `413`: the submission exceeded the endpoint's
whole-body size cap. The per-field length checks pass locally first, so the sum
is what overflowed; trim `--evidence` (the largest field), `--repro` or the
`--repo` hints. Warn + exit 0; the
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

### yak-team-not-found

`eris yak discover --team` or `eris yak config set --team` named a Linear team
id the workspace does not list (`404 team_not_found`). Run `eris yak discover
teams` and use one of its ids or keys. Exit 1.

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

### login-url-unresolved

No longer raised. `eris login` always has an endpoint: `--url`, then
`ERIS_YAKS_URL`, then the `"url"` in `~/.eris/yaks.json`, then the default
`https://api.sibylline.group`. An empty `--url` is refused as
[`flag-value-missing`](#flag-value-missing). An older eris raised this slug when
none of the first three was set; with this one, run `eris login`.

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

### socrates-unknown-verb

`eris socrates` was given a command it does not have. Fix: use `classify`,
`discover`, `resolve` or `submit`, or run `eris socrates --help`.

### socrates-flag-required

`eris socrates submit` or `eris socrates classify` was run without `--title`,
`--statement` or `--source`, which every candidate needs. Nothing was sent. Fix:
pass all three. Also raised when `submit`'s `--allow-redaction` and
`--override-reason` are not given together, and when `classify --request` is
given with another flag: the request carries the whole candidate, so pass
everything inside it or drop it. `eris socrates resolve` raises it when the
Epic is missing or is not an identifier (blank, or over 200 characters);
nothing was sent. Fix: pass the Epic's identifier, as the Epic's Socrates
comment prints the command.

### socrates-candidate-invalid

The candidate does not match the contract: a field is blank or over
its bound (title 200, statement 4000, project 200 characters), `--source` is
not an absolute `http(s)` URL, or `--kind` is not one of `decision`,
`practice`, `prd` or `conflict`. The `ERROR` line names each field. Nothing
was sent. `classify` also raises it when `--request` is not a JSON object, or
names a `rubric_version` this build does not score. Fix: correct the named
fields.

### socrates-answers-invalid

`eris socrates classify` was given answers that do not fit the rubric: a
question has no answer, an answer is not one of its question's enum values, a
key is not one of the rubric's questions, a question is answered twice, or an
`--answer` is not `<question>=<answer>`. Nothing was scored. The `fix:` lines
list every question with its answers. Fix: answer every question once, with
one of its answers.

### socrates-secret-detected

A field holds a secret: a vendored gitleaks rule (gitleaks v8.30.1,
`packages/outbound-scan`) matched the title, statement, source, project,
`--override-reason`, or a string in the request body just before it was sent.
The `ERROR` line names the field and the rule id, never the text. Nothing was
sent. This check cannot be overridden: `--allow-redaction` does not reach it.
Fix: remove the secret from the named field and run the command again.

### socrates-override-invalid

`eris socrates submit --allow-redaction` named something that is not one of
eris's redaction classes. Nothing was sent. Fix: use a class the `fix:` line
lists, or drop the flag.

For `eris socrates classify --override <gate>=<reason>`, it means the override
cannot apply. The reason is missing, blank, multi-line or over 200
characters. Or the gate is not one of the rubric's gates, routes the candidate
(a practice, an inferred premise) rather than rejecting it, does not reject
these answers, or is named twice. Nothing was scored. Fix: override only the
gate a rejection named, once, with a one-line reason.

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

### socrates-unreachable

The request to the endpoint (`<url>/v1/socrates/submit`, or
`/v1/socrates/resolve`) did not complete: the host could
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
than one resolve reads); the `fix:` line says which. Fix: for a 401 run
`eris login`; otherwise correct what the detail names.

### socrates-bad-response

The endpoint's answer was neither a receipt nor a problem+json error
(a proxy page, an outage, a different service), or it was a receipt with a
non-2xx status. Nothing in it is trusted. For `resolve`, such an answer with
HTTP 404 means the endpoint does not serve `/v1/socrates/resolve`: the server
predates the route. Fix: check the url points at a Socrates endpoint, or
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
HEAD's history, or one behind the stored cursor (the cursor only moves
forward); or `~/.eris/socrates/cursors.json` cannot be read, parsed or written.
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

## Adding a new slug

Call `emitFailureAndExit({ slug, what, fix, docs })` (or `reportFailure`, to
return 1 instead of exiting) from `ts/lib/eris-fail.ts` at the callsite (`docs`
defaults to `docs/ERRORS.md#<slug>`), then add a `### <slug>` heading here. A
plugin calls `renderFailureBlock` from the SDK (`src/cli/plugin.ts`). Slugs are
lowercase kebab-case, stable once shipped.

`tests/errors-doc.test.ts` asserts that every slug has a heading here, and it
**derives** the slug list from the raisers rather than carrying a copy: in the
`eris` shim, its `printf 'slug: …'` block; in every TypeScript tree (`src/`,
`ts/lib/`, `plugins/`), `slug: "…"` literals, the members of every `…Slug`
union, and `renderWarnLines(…, "<slug>")` arguments. So a new slug is covered
the moment it is raised — but it also fails the suite until its heading exists,
which is the point.
