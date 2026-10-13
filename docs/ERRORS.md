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

Fix: install bun (<https://bun.sh>) and run `./install.sh --checkout` in the eris
checkout (it also installs the `node_modules` the verbs need). Or run
`./install.sh` for the standalone release binary, which needs no bun.

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
volume. A checkout install (`./install.sh --checkout`) writes no cache.

### eris-deps-not-installed

> Raised by the TypeScript verb runner (`src/cli/ts-verb.ts`), when a verb's
> module graph names a package the checkout's `node_modules` cannot resolve.

A TypeScript verb (every row the registry routes to `ts`, which is every row) is
imported lazily, and one of its packages is
missing: `node_modules` is absent, or is the install from before a pull that
added a dependency. The `ERROR` line names the package and the source file that
asked for it, instead of a bare `ERROR ResolveMessage: Cannot find package '…'`.

Fix: `bun install --frozen-lockfile` from the eris checkout (the `fix:` line names
the directory). `install.sh --checkout` does the same on a fresh checkout. eris does not run
it for you: an inline install is unbounded and reaches the network mid-command.

Only a missing PACKAGE is reported this way. A missing relative module is a defect
in the checkout's own source and still crashes with bun's message.

### update-not-compiled

> Raised by `eris update` before any request.

This eris runs from a source checkout (`./eris`, or the `~/.local/bin/eris`
wrapper `install.sh --checkout` writes), not from a compiled release binary. A
checkout has no single file to replace: it is a working tree under version
control.

Fix: update the checkout, `git pull && bun install --frozen-lockfile` in the
directory the `fix:` line names. To run a release binary instead, run
`./install.sh` (see the README).

### update-unsupported-platform

> Raised by `eris update` before any request.

Releases publish a binary for `darwin-arm64` and `linux-x64` only, and this eris
was compiled for another platform (built from source on a machine with another
OS or CPU). There is no asset to download for it.

Fix: build eris from source for this platform and run that build; see
"From source" in the README. Updating means pulling and building again.

### update-brew-managed

> Raised by `eris update` before any request.

Homebrew installed this eris: its real path (symlinks resolved) is under a
Homebrew `Cellar` (`/opt/homebrew/Cellar`, `/usr/local/Cellar` or
`/home/linuxbrew/.linuxbrew/Cellar`). Replacing a file Homebrew owns leaves its
receipt and the file disagreeing, and the next `brew upgrade` or
`brew uninstall` misbehaves.

Fix: `brew upgrade eris`.

### update-api-invalid

> Raised by `eris update` before any request.

`ERIS_UPDATE_API`, the override for the releases API base (a GitHub Enterprise
host, or a test server), is set to something eris will not use: it is not a URL,
its scheme is neither `https` nor `http`, it is `http` to a host that is not
loopback, or it carries credentials, a query or a fragment. The refusal exists so
a stray variable cannot send a token in clear text to a host nobody chose. The
`ERROR` line shows the scheme and host only.

Fix: set it to an `https://` URL (for example `https://ghe.example.com/api/v3`),
or unset it to use `https://api.github.com`.

### update-token-invalid

> Raised by `eris update` before any request.

`GH_TOKEN` (or, when it is unset or blank, `GITHUB_TOKEN`) holds something no
GitHub token contains: a space or line break inside the value, or a non-ASCII
character. Leading and trailing whitespace is ignored, so a token read from a file
with its newline still works. The refusal names the variable and never shows its
value: sending such a value makes the HTTP client report an error that quotes it.

Fix: set the variable to the token alone, or unset it.

### update-unreachable

> Raised by `eris update` when the releases API or the download host does not
> answer.

The connection was refused, the name did not resolve, the connection dropped, or
a host went quiet: the API did not answer within 30 seconds, or a download sent
nothing for 60 seconds. Nothing was changed; a download in progress is removed.

Fix: check the network connection (eris update needs https access to
`api.github.com`, and to GitHub's release storage host for the download), then
run `eris update` again.

### update-rate-limited

> Raised by `eris update` when GitHub refuses the request for its rate limit.

GitHub answered 429, or 403 with the rate limit spent. An anonymous client gets
60 requests an hour per address; an authenticated one gets far more. `eris
update` makes up to three API requests per run. When GitHub reported when the
limit resets, the `ERROR` line says so.

Fix: set `GH_TOKEN` (or `GITHUB_TOKEN`) to a GitHub token. Any token works for
a public repository, with no scopes. If one is already set, its own limit is
spent: wait for the reset time, then run `eris update` again.

### update-needs-token

> Raised by `eris update` when GitHub answers 404 and no token is set.

GitHub answers 404, not 403, to a request that is not allowed to see a private
repository, so an anonymous 404 does not say whether the release is missing or
the repository is private. This refusal is the anonymous case.

Fix: if the repository is private, set `GH_TOKEN` (or `GITHUB_TOKEN`) to a token
that can read it and run `eris update` again. Otherwise the release does not
exist: list them at `https://github.com/<owner>/<repo>/releases`.

### update-release-not-found

> Raised by `eris update` when the release is not installable.

Either GitHub answered 404 to a request that carried a token, so the repository
has no such release (or the token cannot see the repository), or the release
found is a draft, or a prerelease that `--to` did not name. `eris update` installs
the latest published release; a prerelease only with `--to <tag>`.

Fix: check the tag against the repository's releases page. With a private
repository, the token must be able to read it.

### update-api-error

> Raised by `eris update` for any other answer the API gives.

An answer that is not a release and not one of the cases above: a 500, a 403 that
is not the rate limit, a 401 (the token was rejected, or the API wants one), a
body that is not a release record, a redirect chain that is too long or leaves
for a scheme eris will not follow, or a download larger than eris will accept.
The `ERROR` line names the host and the status.

Fix: for a 401, unset `GH_TOKEN` or replace it with a valid token. For a 403 on a
private repository, the token must be able to read it. Otherwise retry in a few
minutes.

### update-asset-missing

> Raised by `eris update` before it downloads the binary.

The release exists but cannot be installed: it lists no `eris-<os>-<arch>` for
this platform, no `SHA256SUMS`, or a `SHA256SUMS` with no line for this
platform's binary. eris never installs a binary it cannot check, so a release
without its checksum is refused. The same slug covers an asset the release lists
but the API answers 404 for.

Fix: choose another release with `eris update --to <tag>`.

### update-checksum-mismatch

> Raised by `eris update` after the download, before anything is replaced.

The downloaded binary's sha256 differs from the one in the release's
`SHA256SUMS`. The `ERROR` line gives both. The partial file is removed and the
installed binary is untouched.

Fix: run `eris update` again. If it repeats, the release is corrupt or has been
tampered with: do not install it.

### update-target-unwritable

> Raised by `eris update`, before any request when it can tell.

The directory that holds the eris binary cannot be written, or a file there could
not be created: a read-only filesystem, a directory owned by another user (a
system-wide install), a full disk. `eris update` stages the new binary beside the
old one, so it needs write access to that directory, not only to the binary.

Fix: run `eris update` as a user who owns the directory, or reinstall eris into a
directory you own (`install.sh` installs to `~/.local/bin`).

### update-smoke-failed

> Raised by `eris update` after the replacement.

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
(`provenance.repro.command`), which the vendored contract never
length-validates. Caught locally anyway, same reasoning as
[`yak-summary-too-long`](#yak-summary-too-long) — a repro is a command, not a
narrative, so 2000 chars is generous headroom over any real invocation. Fix:
shorten it — redaction can grow text, so check the real length with
`--no-redact` if the count is surprising.

### yak-repo-too-long

A (redacted) `--repo <owner/name>` hint exceeds 200 chars — a
local courtesy bound, not a wire-contract one: a target-repo hint rides
inside `provenance` (`provenance.repo.target_repos`), which the vendored
contract never length-validates. Caught locally anyway, same reasoning as
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

Local validation against the vendored Yaks contract
(`plugins/yak/yaks-schema.v1.ts`) failed for a reason other than a length bound
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

No Yaks base URL resolved. Set `ERIS_YAKS_URL` or add a `"url"` field to
`~/.eris/yaks.json`; there is no default host. This is environment/config,
never the agent's fault — it warns and exits 0 rather than failing the task.

### yak-unreachable

The Yaks endpoint could not be reached at all (connection refused, DNS failure,
etc.) within the request's bound. Warn + exit 0 — the report was dropped, not
delivered; the agent's task is unaffected.

### yak-timeout

The Yaks endpoint did not respond within the bounded request window (30s
default). No retry — matches the registry transport's own posture. Warn + exit 0.

### yak-transport-error

The Yaks endpoint responded, but not usably: a non-2xx status, an unparseable
200 body, or a 200 that does not match the receipt contract
(`YakReceipt` in `plugins/yak/yaks-schema.v1.ts`). Warn + exit 0; the `WARN` line
names the HTTP status or the parse failure.

### yak-config-permissive

`~/.eris/yaks.json` is readable by users other than its owner (not mode
`0600`). Refused, never read — a credential file with group/world read is a
leak surface. Fix: `chmod 0600 ~/.eris/yaks.json`.

### yak-config-malformed

`~/.eris/yaks.json` exists but is not valid JSON, or is not a JSON object.
Fix: recreate it as `{"url": "...", "token": "..."}`.

### yak-token-unresolved

No bearer token resolved for the Yaks endpoint — neither `ERIS_YAKS_TOKEN` nor a
`"token"` field in a readable `~/.eris/yaks.json`. Environment/config, warn +
exit 0. Minting a token is an operator step (`plugins/yak/yak-setup.ts`, then
registration with the endpoint's operator), not something an agent can fix
mid-task.

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
