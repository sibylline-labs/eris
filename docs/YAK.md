# `eris yak` — land a durable observation with the Yaks endpoint

Three verbs an agent (or a human) can invoke inline when the harness fights back —
a broken tool, a confusing error, a config gap — or could serve them better, and never for the task's own
outcome. `eris yak` redacts, resolves identity, derives a dedup key, makes one
bounded HTTP call to a Yaks endpoint, and gets out
of the way. Everything after the receipt — clustering, issue-tracker writes,
incident routing — belongs to the endpoint, not to this CLI.

```
eris yak issue   --summary "…" --body "…"
eris yak suggest --summary "…" --body-file -
eris yak fatal   --summary "…" --body-file -
```

## Which verb

| Verb | When |
|---|---|
| `issue` | A harness/tooling defect — a command that errors, a flag that does the wrong thing, a doc that lies. A suspected defect goes here too, with the hedge in the body |
| `suggest` | An improvement to the harness — a missing verb or flag, a better default, a skill or rule that should exist, change or go. Nothing has to be broken |
| `fatal` | The harness itself is broken — the thing you're standing on, not the thing you're building |

None of the three is for the task's *own* outcome (a test failure in the code
you're writing, a bug in the feature you're implementing). They exist for
problems with the tools, not the work.

## Flags

```
eris yak <issue|suggest|fatal>
  --summary <text>                              required, ≤ 200 chars
  --body <text> | --body-file <path|->          required, ≤ 4000 chars (`-` = stdin)
  --evidence <text> | --evidence-file <path|->  optional, ≤ 20000 chars
  --repro <command>                             optional, ≤ 2000 chars — see below
  --repo <owner/name>                           optional, repeatable, ≤ 200 chars each,
                                                ≤ 20 total — see below
  --no-redact                                   skip the secret-scrub pass (loud warning)
```

`--body-file -` and `--evidence-file -` are mutually exclusive — there is only
one stdin. `--body-file -` with no pipe fails immediately (`yak-stdin-is-a-tty`)
rather than hanging: a command that blocks forever mid-task is exactly the
yak-shave this feature exists to remove.

Over-length fields fail locally with the actual/max lengths named, rather than
letting the server truncate silently — a server-side truncation would desync
the stored payload from the dedup key this CLI already derived from the full
text (see [Idempotency](#idempotency-and-replay)).

## Setup

`eris yak` reads its endpoint URL and bearer token from **one file**,
`~/.eris/yaks.json`, mode `0600`:

```json
{ "url": "https://yaks.example.com", "token": "…" }
```

There is no default endpoint: until a URL is configured, every yak warns
`yak-url-unresolved` and exits 0.

Mint the file with `bun plugins/yak/yak-setup.ts --url <endpoint>` (or with
`ERIS_YAKS_URL` set) from an eris checkout. It writes the file and prints the
follow-up step: the endpoint's operator has to register the bearer against
this machine's source slug, which the script does not automate. Until both
halves are done, every yak from this machine warns and exits 0 rather than
failing your task — see [Exit codes](#exit-codes).

`ERIS_YAKS_TOKEN` / `ERIS_YAKS_URL` override the file's `token` / `url` fields
independently. Nothing else is consulted: a per-source token *is* the ingest
identity, so it never comes from a file in a repository.

The directory `~/.eris` itself is `0755`; the **file's** mode is the guard. A
group- or world-readable `yaks.json` is refused outright — never parsed, never
logged — rather than silently trusting a permissive `~/.eris`.

## Exit codes

The table below describes **text mode** (the default). Under `--output json`
the diagnostics move entirely onto stdout's record — see below.

| Situation | Exit |
|---|---|
| Missing `--summary`/`--body`, an unreadable `--body-file`, `--body-file -` with no pipe, an over-length field, an unknown verb or flag | **`1`** — the four-line `ERROR`/`slug:`/`fix:`/`docs:` block, same contract as every other eris failure |
| Unresolved token/URL/device-id, an unreachable endpoint, a timeout, a non-2xx response | **`0`** — one `WARN` line + slug on stderr, empty stdout in text mode. A non-2xx status gets its own slug when the cause is local and a retry changes nothing — see the rungs below |
| An incomplete `node_modules` on this machine (`yak-deps-not-installed`) | **`0`** — the same four-line `ERROR`/`slug:`/`fix:`/`docs:` block as the exit-`1` row above, but exit `0`: a broken install on the operator's machine isn't something the calling agent could have done differently |
| No `bun` on PATH | **`1`** — the shim's own `eris-bun-missing` block, printed before any verb is routed; it is not yak-specific |
| Accepted (fresh or replay) | **`0`** |

The line that decides which bucket a failure falls into: *could the agent have
done anything differently?* A missing `--summary` is the agent's fault and is
fixable on the spot. An unset token, an unreachable endpoint, or a machine with no
network right now is not — failing the task over the operator's local
environment would be worse than the problem this feature exists to report. So
**environment, config, and transport problems never fail the task** — they warn
on stderr and let the calling command continue.

### Rungs for a non-2xx response

Every non-2xx response is `WARN` + exit `0`. The endpoint's refusals that a
retry does not fix get their own slug, so the `WARN` line (and `error.slug`
under `--output json`) names the remedy instead of a generic transport failure:

| Status | Slug | Meaning and fix |
|---|---|---|
| `401` | [`yak-unauthorized`](ERRORS.md#yak-unauthorized) | The endpoint rejected the bearer token. Check `~/.eris/yaks.json` / `ERIS_YAKS_TOKEN`, and that the token is registered. |
| `402` | [`yak-not-entitled`](ERRORS.md#yak-not-entitled) | The workspace is not entitled to Yaks (plan or seat). |
| `413` | [`yak-payload-too-large`](ERRORS.md#yak-payload-too-large) | The submission exceeded the endpoint's whole-body size cap. Trim `--evidence`. |
| any other non-2xx | [`yak-transport-error`](ERRORS.md#yak-transport-error) | An outage, a missing route, a proxy page: no local remedy is known. |

Each rung's `ERRORS.md` entry notes that a problem with eris itself is reported
on the vendor route, the eris project's own tracker, rather than into the
workspace.

### `--output json`

Under `--output json`, `eris yak <issue|suggest|fatal>` writes **exactly one
JSON record to stdout and nothing at all to stderr**, on every outcome above —
misuse, warn, and delivered alike, including the dispatcher-level check
(`yak-deps-not-installed`, `plugins/yak/handlers.ts`) that never reaches the
yak core. Exit codes are unchanged from the table above. The one exception is
`eris-bun-missing`: the shim prints it before bun starts, so no record exists.

The record: `{verb, delivered, id?, idempotency_key?, replay?,
contract_version?, key_mismatch?, redactions: {count, classes, skipped},
error?}`. **`delivered` is the field to branch on — never `id == null`**. Three fields exist specifically because their text-mode stderr
equivalent is suppressed under json and would otherwise be silently lost:

- **`redactions.skipped`** — `true` when `--no-redact` was set for this
  submission. A skipped scrub and a scrub that ran and found nothing both
  leave `count: 0, classes: []`; without this field the two are
  indistinguishable on the wire. Text mode's `yak-no-redact` WARN carries the
  same fact.
- **`key_mismatch`** — present (`true`/`false`) only when `delivered: true`.
  Mirrors text mode's `yak-key-mismatch` WARN — the record's own
  `idempotency_key` is the *receipt's* key, never the locally-derived one the
  mismatch is measured against, so this is the only way a machine caller can
  detect canonicalization drift.
- **`error.slug`/`error.reason`** — the content of the `WARN`/`ERROR` line
  itself, on every non-delivered outcome.

What is *not* reproduced in the record: the `fix:`/`docs:` lines from the
text-mode failure block. Those are reconstructable from `error.slug` — every
slug is a stable heading in [ERRORS.md](ERRORS.md) — the same way any other
`--output json` failure's remediation is looked up.

See [OUTPUT-CONTRACT.md §3](OUTPUT-CONTRACT.md#3-machine-surfaces).

## Redaction

`summary`, `body`, `evidence`, `repro`, every `--repo` hint, and the gathered provenance are scrubbed before
anything else sees them — before the dedup key is derived, before the payload
is validated, before the request leaves the machine. Each match is replaced
with `«redacted:<class>»`. In text mode the count and class breakdown print
to **stderr**, never stdout; under `--output json` the same information is
`redactions.{count,classes}` on the record instead — stderr carries nothing
either way (see [Exit codes](#--output-json) above).

Classes covered: PEM private-key blocks, JWTs, AWS access-key ids and
`aws_secret_access_key` assignments, GitHub/Slack/Google/`sk-`-style API keys,
`Authorization: Bearer|token …` headers, GCP service-account `"private_key"`
values, connection strings with an inline password, and **key-name
assignments** — `NAME=value` or `NAME: value` where `NAME` matches
`(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|CREDENTIAL|ACCESS_KEY|CLIENT_SECRET|MNEMONIC|SEED|SESSION|COOKIE|AUTH)`.

**Redaction is defence in depth, not a boundary.** It is a pattern scrub, and a
pattern scrub can always miss a shape it wasn't written for. Do not paste
material into `eris yak` on the assumption that anything sensitive will be
caught — the honest framing is "this makes an accidental leak less likely," not
"this makes a report safe by construction." `--no-redact` exists for the
(rare, and loudly warned) case where the scrub itself is corrupting a report
that needs to be read verbatim; it does not exist to work around a
false-positive scrub eating a legitimate report — if that happens, file it as
its own `eris yak issue` against the redaction pass.

## The wire contract

`eris yak` speaks the Yaks submission contract v2, the workspace package
`@sibylline-labs/yak-contract` ([`packages/yak-contract`](../packages/yak-contract)),
imported by name rather than vendored as a copy. One call per report:

- `POST <url>/v1/yaks` with `Authorization: Bearer <token>`. The ingress
  answers `202` with a receipt `{id, idempotency_key, replay, contract_version}`;
  any `2xx` whose body is a receipt counts as delivered, whatever the
  `contract_version` string says.
- `route` is always `"workspace"`: the report files into the caller's own
  tenant. It is not an input to the idempotency key.
- There is no `reporter`. The ingress derives the tracker user from the bearer
  token, so the CLI sends no identity of its own.
- `schema_version` is the package's `YAKS_CONTRACT_VERSION`. The body is
  validated against the package's `YakSubmission` before the request, so a field
  the contract would refuse never leaves the machine.

## Idempotency and replay

Every submission derives a dedup key from `{device_id, execution_id, verb,
summary, body, evidence}` **after** redaction — the endpoint re-derives the same
key from the payload it actually received, so deriving from anything else
would guarantee a mismatch on every report. Two calls with the same inputs in
the same task dedupe to one observation: the second gets back the *same*
receipt with `replay: true`, rendered as `already recorded: <id>` in text mode
(a fresh delivery renders `recorded: <id>`) — an agent can tell "this landed"
from "this already landed" without re-reporting.

The contract exposes no server-side mismatch signal on the receipt itself
(only a server console warning, invisible to the client). The one drift check
`eris yak` can make is comparing its own locally-derived key against the
receipt's `idempotency_key` — a mismatch prints a `yak-key-mismatch` warning
alongside a still-successful delivery. It is a symptom of this CLI's contract
package (`packages/yak-contract`) drifting from the endpoint's derivation, not
something a caller needs to act on.

## Repro

`--repro <command>` attaches a command that reproduces the problem being
reported — a failing test invocation, a `curl`/`eris` one-liner, a short
repro script's entry point. It rides on the wire inside `provenance` (as
`provenance.repro.command`) rather than as a new top-level field on
`YakSubmission`: that contract is the workspace package
`@sibylline-labs/yak-contract` ([The wire contract](#the-wire-contract)), and
not something this CLI can extend on its own — `YakProvenance`'s `.catchall()` exists
precisely so a CLI-side addition like this one doesn't have to wait on a
contract bump. It is redacted the same as `evidence` (a repro command can
itself embed a credential — `curl -H "Authorization: Bearer …"` is a
realistic shape) and bounded to 2000 chars locally, the same courtesy bound
`summary`/`body`/`evidence` get (see [`yak-repro-too-long`](ERRORS.md#yak-repro-too-long)).
It does not participate in the idempotency-key derivation — attaching or
editing a repro never changes an observation's dedup identity.

**That stability has a sharp edge: a repro-only resubmission is a silent
no-op.** The idempotency key is derived from `{device_id, execution_id, verb,
summary, body, evidence}` (see [Idempotency and replay](#idempotency-and-replay))
— `repro` deliberately isn't one of those fields, which is the right call
(you don't want editing a repro to fork a fresh cluster off the same report).
But it means resubmitting the *same* `summary`/`body`/`evidence` with a
*different* (or newly-added) `--repro` derives the *same* key, so the endpoint's
dedup treats it as a replay of the observation it already has: `delivered:
true` comes back, but no new `YakObservation` is created and the new repro
text is never stored or seen server-side. There is currently no supported way
to attach or change a repro on an existing cluster after its first
observation — only the repro that rode on whichever observation actually
created (or first populated) the cluster survives.

**Sandboxing — what this CLI guarantees, and what it doesn't.** `eris yak`
never executes the repro command, on this machine or anywhere else; it is
opaque text from the moment it's typed to the moment it's POSTed. Nothing in
this codepath (`plugins/yak/handlers.ts`, `plugins/yak/yak.ts`, `plugins/yak/yak-submit.ts`,
`plugins/yak/yak-context.ts`) shells out, and the submission carries no
credential, project id, region, or `eris.yaml` env context — `yak-context.ts`
explicitly excludes a config merge and any cloud-CLI/keychain read from its
provenance gather (see that file's own header). So the one thing THIS repo
could leak into a repro — live production access riding along with the
command — structurally cannot happen here: there is no production
credential in `eris yak`'s own process to leak.

That is the client-side half of the requirement. **Actually rerunning the
repro is the Yaks endpoint's job, not this CLI's** — "everything after the receipt —
clustering, issue-tracker writes, incident routing — belongs to the endpoint"
(see the top of this doc), and the same split applies to a rerun: only the
endpoint (or whatever runner it dispatches to) has cluster state and knows when
a fix lands. That side owns its own sandbox — an execution environment with
no path to a production credential, project, or deploy target. This CLI
captures and transmits `provenance.repro.command`, and that is all it does
with it.

## Target-repo hints

`--repo <owner/name>` names a repo this report concerns — repeatable, for a
report that spans more than one. It exists so triage doesn't have to run a
code search across the whole org before it can even clone a worktree: a Yaks
report with no target-repo hint anywhere forces a manual `search_code` sweep
just to find out where the problem lives.

```
eris yak issue --summary "…" --body "…" --repo acme/widgets
eris yak issue --summary "…" --body "…" \
  --repo acme/widgets --repo acme/widgets-api
```

**Auto-populated, always overridable.** When no `--repo` is given at all,
`eris yak` derives one hint from the invoking process's own git remote — the
same `origin` URL `provenance.git.origin_url` already carries for every
submission (see [Discoverability](#discoverability) below for what that
provenance gather already promises: best-effort, never a gate). An agent
filing a yak from inside a repo checkout gets a hint for free; one filed from
outside any checkout, or from a repo with no `origin` remote, simply carries
none. Passing `--repo` at all — even a single one — always wins over the
derived value; the two are never merged.

The derivation understands nested namespaces (a GitLab-style
`group/subgroup/project` derives in full, never truncated to just
`subgroup/project`) and refuses outright on a local checkout — a `file://`
origin or a bare filesystem path has no "owner" at all, and guessing one from
trailing path components would be a plausible-looking but wrong hint, worse
than none. An auto-derived hint also clears the same length bound an
explicit one does; one that wouldn't is dropped rather than sent unbounded.

**Not validated against a live repo list.** Like `repro`, a target-repo hint
is opaque text this CLI carries through, never confirms. A typo'd or
nonexistent repo name is exactly as harmless (and exactly as un-caught) as a
typo'd `--repro` command — triage reads it, decides whether it's right, and
moves on.

**On the wire.** Like `repro`, this rides inside `provenance` rather than as
a new top-level field on `YakSubmission` — the same non-breaking,
forward-compatible reason (`YakSubmission` is the contract package's, and this
CLI doesn't extend it). Unlike `repro`, it lands in the
`provenance.repo` category the CLI already had (`provenance.repo.service`,
the nearest `eris.yaml`'s declared service — see `plugins/yak/yak-context.ts`), as
`provenance.repo.target_repos`, always an array even for a single hint. The
contract types that one key and bounds it (at most 20 hints of at most 200
chars each), the same limits this CLI checks locally first. It
does not participate in the idempotency-key derivation, for the same reason
`repro` doesn't: attaching or changing a target-repo hint should never fork a
fresh cluster off a report that's otherwise identical, and the same
repro-only-resubmission caveat in [Idempotency and
replay](#idempotency-and-replay) applies here too — resubmitting the same
`summary`/`body`/`evidence` with a different `--repo` dedupes as a replay,
and the new hint is never stored or seen server-side.

**Surfacing it on the rendered issue is the endpoint's work, not this CLI's.**
Exactly the same split as everything after the receipt (see the top of this
doc): this CLI captures and transmits `provenance.repo.target_repos`;
rendering it into the issue belongs to the endpoint's issue-tracker write path.

## What a receipt does not promise

**A receipt is not a promise that an issue was created.** The endpoint accepts,
stores, and deduplicates every well-formed submission — but it may also
enforce an issue-creation ceiling per rolling window, and an observation
deferred by that ceiling is still accepted and stored: it just doesn't (yet)
become an issue. Whether `fatal` also pages anyone depends on how the
endpoint is configured; the submission succeeds either way.

In short: a `0` exit and a `recorded: <id>` line mean *the observation is
durably stored and deduplicated*. They do not mean *a human has been paged* or
*a ticket now exists*. If you need to confirm the latter, that's a question
for the Yaks endpoint's own surfaces, not for this CLI's receipt.

## Discoverability

`eris yak --help` and this doc only help someone who already went looking for
the verb. Teaching an agent that `eris yak` exists is the agent harness's
job (a skill, a rule, or the project's agent instructions), not this CLI's.

## Not built here

`eris yak list` / `get`, an offline queue for a machine with no network,
automatic/hook-triggered reporting, and any agentic triage of what gets
reported — all deliberately out of scope for v1. Reading cluster state,
detecting a fix-mark, dispatching a sandboxed repro rerun, and recording
pass/fail are server-side work — see [Repro](#repro) above. Rendering the
`--repo` hint(s) onto the issue is likewise server-side — see [Target-repo
hints](#target-repo-hints) above.

## See also

- [OUTPUT-CONTRACT.md](OUTPUT-CONTRACT.md) — the stdout/stderr split, exit
  codes, and the `--output json` machine surface this command participates in
- [ERRORS.md](ERRORS.md) — every `yak-*` slug's `ERROR`/`fix`/`docs` heading
- `plugins/yak/yak-setup.ts --help` — mint this machine's bearer
