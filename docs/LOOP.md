# `eris loop` — the org's loops as background sessions

A **loop** is an org-authored runbook: a markdown body the org keeps in its Gates settings, beside its
doctrine and profiles. `eris loop` runs one on a tracker issue as a detached Claude Code background
session, and the session holds the issue's **claim** until it hands back. Every tracker read and write
the verbs make is a request to the gateway on the `eris login` bearer
([dev/GATES-CLIENT.md](dev/GATES-CLIENT.md)): eris holds no tracker credential.

```
eris loop list                  [--output json]
eris loop resolve <ISSUE|YAK-ID> [--output json]
```

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
