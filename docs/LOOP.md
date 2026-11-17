# `eris loop` — the org's loops as background sessions

A **loop** is an org-authored runbook: a markdown body the org keeps in its Gates settings, beside its
doctrine and profiles. `eris loop` runs one on a tracker issue as a detached Claude Code background
session, and the session holds the issue's **claim** until it hands back. Every tracker read and write
the verbs make is a request to the gateway on the `eris login` bearer
([dev/GATES-CLIENT.md](dev/GATES-CLIENT.md)): eris holds no tracker credential.

```
eris loop list                    [--output json]
eris loop resolve <ISSUE|YAK-ID>   [--output json]
eris loop launch <loop> <ISSUE|YAK-ID> --cwd <abs> --model <m> [--report-to <KEY>]
                 [--caller <name>] [--context <text>] [--force] [--unclaimed] [--output json]
eris loop resume <ref> | --all [--prompt <text>] [--unclaimed] [--output json]
eris loop stop <ref>               [--output json]
eris loop hand-back <ISSUE> [--claim <id>] [--report-to <KEY>] [--outcome handed_back|aborted] [--output json] < body
```

A `<ref>` is a session id (the job id `claude --bg` printed, or its session id), the session's exact
name, or the issue key of a loop session. A loop session is named `eris-loop-<slug>-<issue>`.

The runtime is Claude Code: a session is a `claude --bg` background job, kept under
`~/.claude/jobs/<id>/state.json`. Every `claude` child runs under a deadline, with the caller's env less
its Claude Code session markers (`CLAUDECODE`, `CLAUDE_CODE_*`) and eris's bearer (`ERIS_YAKS_TOKEN`).

## Where a loop body comes from

Only from the org's pulled, verified policy tree, `~/.eris/doctrine/<orgId>/loops/<slug>.md`
([DOCTRINE.md](DOCTRINE.md#pull-and-path)). Nothing on this machine authors a loop:

- With no tree on this machine, the verb pulls the org's policy first.
- When a claim's reply names a policy (`bundle_sha`) other than the tree's, the verb pulls first, so a
  loop never starts from a body older than the gateway's view.
- An edited tree is refused (`doctrine-local-modified`): run `eris doctrine push` to save the edits as
  the org's policy, or `eris doctrine pull` to discard them. The verbs never push and never pull over
  an edited tree.
- A slug the tree's manifest does not carry is `loop-unknown`. The body must resolve inside the tree's
  `loops/` (no link out of it), be at most 256 KiB of UTF-8 with no NUL byte, and not be blank.

## list

`eris loop list` prints the slugs the org's tree carries, one per line, sorted. JSON:
`{"loops": [...]}`. The org is the one the current directory acts as (`ERIS_ORG`, else `repo.org` in
the nearest `eris.yaml`, else the default org).

## resolve

`eris loop resolve <ref>` prints the issue key an operand names. An issue key (`ABC-123`, any case) is
upper-cased with no request. A yak id, a 26-character ULID or a 36-character UUID, is looked up on the
gateway: `GET /v1/yaks/observations/<id>` (`/v0` for a UUID) names its cluster, and
`GET /v1/yaks/clusters/<cluster>` the cluster's current issue. The lookup never follows a redirect, so
the bearer cannot be carried to another host. JSON: `{"issue": "...", "yak"?: "..."}`. A yak with no
issue yet is `yak-unresolved` (exit 2).

## The claim

The gateway holds at most one live claim per org and issue. This machine keeps a ledger,
`~/.eris/loop/claims/<ISSUE>.json` (directory `0700`, file `0600`, written whole), naming the claim id
it holds for an issue, the loop, and the session the claim is bound to. The ledger is advisory: the
gateway is the authority, and the ledger is how `stop`, `reap` and a forced relaunch name the claim they
release. An entry is dropped only while it still names the claim being released, so a forced
successor's entry survives its predecessor's late hand-back.

## launch

`eris loop launch <loop> <ref> --cwd <abs> --model <m>` runs, in order:

1. Normalise every operand. A refusal here (`loop-usage`, exit 2) has claimed, requested and spawned
   nothing. `--cwd` must be an absolute directory that is not `$HOME`; `--model` is required.
2. The `claude` CLI on PATH, then a yak id resolved to its issue.
3. Unless `--force`: refuse while a local loop session on the issue is still at work. With
   `--unclaimed`, only a session of the same loop counts.
4. With `--force`: release this machine's prior claim on the issue (`aborted`).
5. Unless `--unclaimed`: reserve the claim (`POST /v1/linear/issues/<key>/claim`). Another loop's claim
   is `linear-issue-claimed` (exit 3), naming the holder.
6. The org's tree for `--cwd`'s org, pulled when the claim names a newer bundle; the loop's body; the
   prompt.
7. `claude --bg <prompt> --name eris-loop-<slug>-<issue> --model <m>` in `--cwd`.
8. Bind the claim to the session (once more after 3 s when the gateway opened no agent session), then
   move the issue, and its parent, to In Progress while each is unstarted. A closed issue is never
   reopened; a failed move only warns.

Any failure after step 5 releases the claim (`aborted`, the reason as its body) before the verb stops.
The receipt is `delegated <ISSUE>[ (yak <8>)] → loop <slug> · <session> · model <m>`.

## hand-back

`eris loop hand-back <ISSUE> --claim <id> < body` is how a loop reports. With `--claim` (the id its
prompt's `Claim:` line carries) the body is the claim's release response; when the claim no longer
holds the issue (`superseded`, `not_claimed`), or with no `--claim`, it is a comment on the issue.
`--report-to <KEY>` also comments there. The body is refused before anything is sent when it is blank or
over 65,536 characters. Each write is tried once, and again (bounded, waiting the reply's
`Retry-After`) only when the gateway shed it with a 429. A target that got nothing fails the verb with
`loop-hand-back-failed` (exit 1) after the lines for what did land are printed.

## stop

`eris loop stop <ref>` stops the session (`claude stop`). When this machine's claim on its issue is
bound to that very session, it releases the claim (`aborted`) and moves the issue back to Todo, but only
while it is In Progress: In Review, Blocked and every other state stand. A session that holds no claim
touches neither. The receipt is `stopped <ISSUE> → loop <slug> · <id>`.

## resume

`eris loop resume <ref> [--prompt <text>]` continues a finished session (`claude --bg --resume`). A
working session is refused. The session holds its issue's claim again: this machine's claim is re-bound
to the resumed session when it is bound to this very session; otherwise a fresh claim is reserved
first (refused while another loop holds the issue, unless `--unclaimed`), and released if the resume
fails. The continuation prompt carries the claim's `Claim:` and `Hand-back:` lines. `--all` resumes
every failed loop session whose issue is open, reading every issue before resuming any. The receipt is
`resumed <ISSUE> → loop <slug> · <id>`.

## The prompt

A session starts from a generic header, then a blank line, then the loop's body. The header carries
only what every loop needs to keep its contract; a house rule (how to comment, which CI runners, what a
pull request body cites) belongs in the org's loop body.

```
Loop <slug> · target issue <ISSUE>
Yak: <id>                                  (when launched from a yak id)
Report to: <KEY> — the hand-back command below also posts your hand-back on <KEY>.
Caller: <name>                             (--caller)
Model: <model>                             (--model)
Context: <one line>                        (--context)
Claim: <id> — this loop holds <ISSUE>'s claim until its hand-back.
Hand-back: post your hand-back once, with `eris loop hand-back <ISSUE> --claim <id> [--report-to <KEY>] < <file>` (the body on stdin): ...
```

Each line but the first and the last appears only when its value was given. The whole prompt is one
argv word, so it is capped at 256 KiB (`loop-usage`).

## Exit status

`0` done; `1` the runtime failed to start or stop (`loop-launch-failed`) or a hand-back reached no
target (`loop-hand-back-failed`); `2` an operand was refused before anything was claimed or spawned
(`loop-usage`, `loop-unknown`, `loop-session-not-found`, `loop-session-ambiguous`, `yak-unresolved`);
`3` a precondition (not signed in, the issue claimed by another loop, the org's policy tree edited, the
claim ledger unwritable). Every failure is the slugged block on stderr ([ERRORS.md](ERRORS.md)), with
nothing on stdout.
