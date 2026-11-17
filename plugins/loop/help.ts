/**
 * help.ts — `eris loop`'s help texts, kept apart from the dispatch so each stays short. docs/LOOP.md
 * is the long form.
 */

export const USAGE = `Usage: eris loop <command>

Launch and tend the org's loops: each runs as a background Claude Code session
on one tracker issue and holds the issue's claim until its hand-back. Loop
bodies come only from the org's policy, pulled to ~/.eris/doctrine/<orgId>/loops/
(author them in the org's Gates settings).

Commands:
  list                    The loops the org's policy carries
  resolve <ISSUE|YAK-ID>  The issue key an operand names
  launch <loop> <ISSUE|YAK-ID> --cwd <abs> --model <m> [--report-to <KEY>]
         [--caller <name>] [--context <text>] [--force] [--unclaimed]
                          Claim the issue and start the loop; prints
                          'delegated <ISSUE> → loop <slug> · <session> · model <m>'
  resume <ref> | --all [--prompt <text>] [--unclaimed]
                          Continue a finished session, holding its claim again
  stop <ref>              Stop a session, release its claim, move an In Progress
                          issue to Todo
  hand-back <ISSUE> [--claim <id>] [--report-to <KEY>] [--outcome <o>] < body
                          Post a loop's hand-back as the org's app

A <ref> is a session id, its exact name, or the issue key of a loop session.

Config: 'eris login' (the claim, the policy pull, a yak lookup). See docs/LOOP.md.
`;

const EXIT = `Exit status: 0 done; 1 the runtime failed to start or stop (loop-launch-failed);
2 an operand was refused before anything was claimed or spawned (loop-usage,
loop-unknown, loop-session-not-found, loop-session-ambiguous); 3 a precondition
(not signed in, the issue claimed by another loop, the org's policy tree edited).
See docs/LOOP.md.
`;

export const HELP = {
  list: `Usage: eris loop list [--output json]

Print the loops the org this directory acts as carries in its policy, one slug
per line (pulled first when this machine has no copy). An edited copy is refused
(doctrine-local-modified): 'eris doctrine push' saves it, 'eris doctrine pull'
restores the org's.

Flags:
  --output json  Print {"loops": [...]}

${EXIT}`,
  resolve: `Usage: eris loop resolve <ISSUE|YAK-ID> [--output json]

Print the issue key an operand names. An ABC-123 key is normalised offline; a
yak id (26-character ULID or 36-character UUID) is looked up on the 'eris login'
gateway: the observation's cluster, then the cluster's current issue.

Flags:
  --output json  Print {"issue": "...", "yak"?: "..."}

${EXIT}`,
  launch: `Usage: eris loop launch <loop> <ISSUE|YAK-ID> --cwd <abs> --model <m> [--report-to <KEY>]
         [--caller <name>] [--context <text>] [--force] [--unclaimed] [--output json]

Claim the issue, pull the org's policy when the claim names a newer one, read
the loop's body from it, and start the loop as a background Claude Code session
named eris-loop-<slug>-<issue> in --cwd. Bind the claim to the session and move
the issue (and an unstarted parent) to In Progress. A failure after the claim
releases it. Refused while a local session is still at work on the issue,
unless --force (which also releases this machine's prior claim on it). With
--unclaimed only a session of the same loop counts, so follow-on loops run in
parallel on distinct names.

Flags:
  --cwd          The target repo (absolute, not $HOME); its org's policy is used
  --model        Claude's model (an alias such as sonnet or opus, or a full name)
  --report-to    An issue key the hand-back is also posted on
  --caller       The launching session's name, for the loop to message
  --context      One line of context for the loop (at most 1024 characters)
  --force        Launch beside a live session; release the prior claim
  --unclaimed    Run with no claim and no status write
  --output json  Print {"issue", "slug", "session", "runtime", "model",
                 "claimId"?, "yak"?}

${EXIT}`,
  resume: `Usage: eris loop resume <ref> | --all [--prompt <text>] [--unclaimed] [--output json]

Continue a finished session with --prompt (default: carry on from where it left
off). A loop session holds its issue's claim again: this machine's claim is
re-bound to it only when that claim is bound to this very session, else a fresh
one is reserved (refused while another loop holds the issue, unless
--unclaimed). --all resumes every failed loop session whose issue is open.
Prints 'resumed <ISSUE> → loop <slug> · <id>' per session.

Flags:
  --all          Every failed loop session on an open issue
  --prompt       The continuation prompt (one line, at most 1024 characters)
  --unclaimed    Reserve no claim
  --output json  Print {"lines": [...]}

${EXIT}`,
  stop: `Usage: eris loop stop <ref> [--output json]

Stop the session. When this machine's claim on its issue is bound to this very
session, release it (aborted) and move the issue to Todo only while it is In
Progress (In Review, Blocked and the rest stand). A session holding no claim
touches neither. Prints 'stopped <ISSUE> → loop <slug> · <id>'.

${EXIT}`,
  handBack: `Usage: eris loop hand-back <ISSUE> [--claim <id>] [--report-to <KEY>]
         [--outcome handed_back|aborted] [--output json] < body

Post the hand-back on stdin as the org's app: with --claim, as the release
response of that claim; otherwise (or when the claim no longer holds the issue)
as a comment on the issue. --report-to also comments there. Each write is tried
once, and again only when the gateway rate-limited it.

Flags:
  --claim        The claim id from the loop's 'Claim:' line
  --report-to    An issue key the hand-back is also posted on
  --outcome      handed_back (default) or aborted
  --output json  Print {"lines": [...], "failed": [...]}

Exit status: 0 every target got the hand-back; 1 a target got nothing
(loop-hand-back-failed); 2 the body was blank or over 65536 characters, or an
operand was refused (loop-usage); 3 not signed in. See docs/LOOP.md.
`,
} as const;
