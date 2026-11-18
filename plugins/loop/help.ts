/**
 * help.ts — `eris loop`'s help texts, kept apart from the dispatch so each stays short. docs/LOOP.md
 * is the long form.
 */

import type { LoopRuntime } from "./runtime";

export const USAGE = `Usage: eris loop <command>

Launch and tend the org's loops: each runs as a background Claude Code session
on one tracker issue and holds the issue's claim until its hand-back. Loop
bodies come only from the org's policy, pulled to ~/.eris/doctrine/<orgId>/loops/
(author them in the org's Gates settings).

Commands:
  list                    The loops the org's policy carries
  resolve <ISSUE|YAK-ID>  The issue key an operand names
  launch <loop> <ISSUE|YAK-ID> --cwd <abs> --model <m> [--runtime <name>]
         [--report-to <KEY>] [--caller <name>] [--context <text>] [--force]
         [--unclaimed]
                          Claim the issue and start the loop; prints
                          'delegated <ISSUE> → loop <slug> · <session> · model <m>'
  status <ref>            A session's state, detail, claim and newest message
  resume <ref> | --all [--prompt <text>] [--unclaimed]
                          Continue a finished session, holding its claim again
  stop <ref>              Stop a session, release its claim, move an In Progress
                          issue to Todo
  reap [--dry-run] [--repo <abs>]...
                          Stop finished sessions, release their claims, remove
                          clean finished worktrees
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
  launch: `Usage: eris loop launch <loop> <ISSUE|YAK-ID> --cwd <abs> --model <m> [--runtime <name>]
         [--report-to <KEY>] [--caller <name>] [--context <text>] [--force]
         [--unclaimed] [--output json]

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
  --runtime      The runtime the session runs on: claude (the default), or one
                 this build supplies
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
  status: `Usage: eris loop status <ref>

Print '<id> · <name> · <state>', then detail:, needs:, claim: (this machine's
ledger), also: (the other sessions the ref names), one in-flight: line per
running tool call (stalled: past the 25-minute budget), and the session's newest
message. Text only: --output json is refused.

${EXIT}`,
  reap: `Usage: eris loop reap [--dry-run] [--repo <abs>]... [--output json]

Stop loop sessions that are done or blocked, release their claims and
reservations a launch never bound (after 15 minutes), and remove worktrees that
are clean, idle, unused by a working loop, and merged (a closed or merged pull
request, or HEAD on main). Never --force. The last line is a summary.

Flags:
  --dry-run      Print what would be done; change nothing
  --repo         A repo whose worktrees are reaped (absolute); repeatable.
                 Default: the clones in ~/.eris/clones.json and every session's repo
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

/** `loop launch`'s help: the public text, then the runtimes this build supplies and the flags each reads. */
export function launchHelp(runtimes: ReadonlyArray<readonly [string, LoopRuntime]>): string {
  if (runtimes.length === 0) return HELP.launch;
  const lines = runtimes.map(([name, rt]) => `  ${name}${(rt.flags ?? []).length > 0 ? `  (reads ${(rt.flags ?? []).map((f) => `${f.name} <value>`).join(", ")})` : ""}`);
  return `${HELP.launch}\nRuntimes this build supplies beside claude:\n${lines.join("\n")}\n`;
}
