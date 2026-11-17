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
} as const;
