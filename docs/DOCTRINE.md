# `eris doctrine` — the doctrine `policy:` contract

A doctrine is a markdown file of **postures**: named ways of working (a quick prototype, business
as usual, a lock-in before a launch), one of them active. Each posture may carry a `policy:` block
that says which review gates run and how strictly, who signs off which kind of change, and what
evidence each class of change must show before it closes. `eris doctrine` reads that file. `check`,
`schema`, `gates` and `effect` are offline: they read a local file, a profiles file, or stdin, and
never the network. `pull` fetches the org's hosted policy and `path` names the file it wrote
([pull and path](#pull-and-path)); `push` saves an edited copy back ([push](#push)); `set` switches a
local doctrine file's active posture and has the gateway comment the issues it affects
([set](#set)).

```
eris doctrine check  [--file <path>] [--cite] [--output json]
eris doctrine schema
eris doctrine gates  [--file <path>] [--profiles <file>] [--explain]
eris doctrine effect [--profiles <file>] [--output json] < {"contract": ..., "before": ..., "after": ...}
eris doctrine pull   [--output json]
eris doctrine push   [--output json]
eris doctrine settings [show | set <key> <value>] [--output json]
eris doctrine history [--output json]
eris doctrine set    <posture> --reason <why> --file <path> [--profiles <file>] [--actor <who>] [--issues <KEY,KEY>]
eris doctrine path
```

The contract itself (the Schema, its explanations, the reader and the evaluators) is the
workspace package `packages/gates-contract`, exported as `eris/gates-contract`, so another tool can
read a doctrine the way these verbs do without running eris.

## The file

````markdown
active: business-as-usual

## rapid-prototype
Rapid prototype
- Ship small experiments quickly.

## business-as-usual
Business as usual
- Steady delivery with the full review on anything user-visible.

```yaml
policy:
  gates:
    premise-gate: lite
    research: off
  user_impact:
    U1: [revert-path, e2e]
```
````

- `active: <slug>`, before the first section, names the active posture. It must name a section.
- Each `## <slug>` starts a posture. The line after the heading is its display name; `- ` bullets
  are prose.
- A posture's policy is a fenced ```` ```yaml ```` block anywhere in its section whose YAML has a
  top-level `policy:` key. At most one per section; a bare `policy:` line outside a fence is a
  problem, not a policy. A posture with no block has no policy: every gate runs in full.

Every problem is reported with the 1-based line it came from.

## The policy

`eris doctrine schema` prints the whole contract as a JSON Schema (draft 2020-12) document,
generated from the Schema at run time. Every field carries its plain-English explanation twice: as
the standard `description`, and structured under `x-eris-explain` (`summary`, `protects`, `raise`,
`lower`, and for an enum the meaning of each value and their order from loosest to strictest). A
builder or form reads both from there; nothing restates them.

| Key | What it sets |
|---|---|
| `profile_default` | The review profile an issue starts on (`spine`, `deep`). |
| `escalate_on` | The kinds of change that move an issue up to the deep profile. |
| `gates` | Each gate's mode, by name: `on`, `lite`, `once-at-end`, `off`. An unnamed gate is `on`. |
| `close` | Each close stage's mode, by name: `on`, `file-only`, `off`. |
| `signoff` | Who approves each door (`one-way`, `two-way`: `human` or `self`), whether registered surfaces may unlock one-way doors (`unlock`), and the gates a posture adds to a surface's unlock bar (`raise`). |
| `ceilings` | The highest autonomy rung (`R0` human first, `R1` review after, `R2` automatic) a door class may reach. |
| `lifts` | The rung a bleed-reducing fix of a low-risk class is raised to. |
| `remediate` | Hands a failing review to a bounded agent loop: which failures, the loop, the runtimes, the round cap. |
| `ask` | Ask volume controls: the two-way timeout, the digest cadence, the per-session budget. |
| `user_impact` | Evidence each user-impact class (U0 to U3) owes on top of its floor. |

## The floor

No posture can lower it. `eris doctrine check` refuses a policy that tries, and the same rules ride
in the JSON Schema under `x-eris-floor` as data a builder can show:

- U2 changes always owe `revert-path`, `zero-downtime` and `e2e`; U3 changes owe those and
  `rollback-rehearsal`. A `user_impact.U2` or `U3` list may add, never drop.
- `final-gates` and `user-impact` are never `off` (they may run `lite` or `once-at-end`).
- `lifts` names only U0 and U1 classes, at `R1` or `R2`.
- U3 is capped at `R1` in `ceilings`.
- `signoff.raise` only adds gates (an empty list is refused, since it reads as a waiver), and a
  `signoff.waive` key is refused outright.

## `check`

Validates every posture's `policy:` block. Text output is one `<slug>\t<policy|no-policy>` line per
posture, the active one marked `*`. `--cite` prints the active posture's citation,
`<Display name> (<slug>@<policy-hash>)`, where the hash is the first 12 hex of the sha256 of the
policy block's YAML text: editing an inactive posture or the prose leaves it unchanged.
`--output json` prints `{ active, policy_hash, citation, postures: [{ slug, name, line, section,
policy, policy_sha256, policy_hash, citation }] }`.

Any problem prints `<file>:<line>: <message>` lines on stderr and exits 3
([`doctrine-policy-invalid`](ERRORS.md#doctrine-policy-invalid)) with nothing on stdout. With no
`--file`, and no default from the build, it exits 3
([`doctrine-file-missing`](ERRORS.md#doctrine-file-missing)).

## `gates`

Prints the active posture's effective gate map: one `<profile>\t<gate>\t<mode>` line per gate of
each work profile, then `@user-impact\t<class>\t<req,...>` per class that owes anything (the floor
plus the posture's raise), `@lift\t<door class>\t<rung>` per lift, `@remediate\t<key>\t<value>` per
remediation setting when the posture has a block, and `@ask\t<key>\t<value>` per ask setting, with
defaults filled. `--explain` follows each row with indented lines a newcomer can read.

The profiles are the built-in `spine` and `deep` unless `--profiles` names a YAML map:

```yaml
quick: [plan-review, final-gates]
guarded:
  require: [premise-gate, final-gates, user-impact]
  forbid: [research]
```

It prints nothing when there is no doctrine file or the active posture has no policy, since no
gate is then skipped or deferred. A doctrine that does not parse exits 3.

## `effect`

Reads one JSON object on stdin and prints one sentence per knob whose value differs, read from the
Schema's own explanations:

```
$ echo '{"contract": "policy", "before": {"gates": {"plan-review": "lite"}}, "after": null}' | eris doctrine effect
gates.plan-review: lite → on. Plans now get the full review before any code, adding about one review round.
```

`"policy"` values are a posture's `policy:` block, compared as they take effect (an unnamed gate is
`on`, a class owes its floor) over the profiles' gates. `"surfaces"` values are a decoded
`.claude/surfaces.yml`, compared with each surface's defaults filled in. `null` (or an absent side)
is the all-defaults value. `--output json` prints `{ effects: [{ path, knob, before, after,
direction, sentence }] }`, `direction` one of `raise` (stricter), `lower` (looser), `change`.

Stdin that is not that object exits 2 ([`doctrine-usage`](ERRORS.md#doctrine-usage)); a side that
does not decode exits 3 ([`doctrine-policy-invalid`](ERRORS.md#doctrine-policy-invalid),
[`gate-surfaces-invalid`](ERRORS.md#gate-surfaces-invalid)).

## `pull` and `path`

An organisation keeps its doctrine in the hosted gates service. `pull` fetches it, on the
`eris login` bearer of the org the directory acts as (`ERIS_ORG`, else `repo.org` in the nearest
`eris.yaml`, else the machine's default org), through the gates client
([dev/GATES-CLIENT.md](dev/GATES-CLIENT.md)), and writes it as files:

```
~/.eris/doctrine/<orgId>/manifest.json   { contract, org, bundle_sha, settings, files, pulled_at }
                        doctrine.md profiles.yaml loops/<slug>.md
```

- The client recomputes the bundle's `bundle_sha` from the values it decoded; a bundle whose sha
  does not match is refused (`gate-contract-mismatch`).
- The new tree is written beside the old one, read back and verified, and only then swapped in, so a
  failed pull leaves the previous tree in place.
- `<orgId>` is a link to the current tree; `path` prints the doctrine through it,
  `~/.eris/doctrine/<orgId>/doctrine.md`, after checking every file against the manifest. A tree
  edited by hand fails `doctrine-local-modified`; `pull` restores it, and [`push`](#push) saves the
  edit as the org's policy.

- `eris login` runs a pull once the token is written. A pull that fails there is one `WARN` naming
  its slug; the login still exits 0, and `eris doctrine pull` retries it.
- With no `--file`, `check`, `gates` and `effect` read the pulled tree (its `doctrine.md` and
  `profiles.yaml`), verified first: an edited tree fails `doctrine-local-modified` unless a flag
  names another file. A build's own defaults (below) win over the tree.

```sh
eris doctrine pull                                   # <orgId>\t<bundle_sha>
eris doctrine check                                  # the pulled doctrine.md, verified
eris doctrine check --file "$(eris doctrine path)"   # the same file, named
```

## `push`

`push` saves your edits to the pulled tree as the org's policy, on the same bearer, with
`PUT /v1/gates/policy`:

- It reads the live policy first and refuses (`doctrine-push-stale`) unless the live `bundle_sha` is
  the one the tree was pulled on, so a newer save is never silently reverted. The refusal leaves the
  tree exactly as you left it.
- A tree whose files decode to the live bundle saves nothing: no request is sent, the tree is
  re-pulled, and the verb prints `unchanged`.
- A file a bundle does not carry (anything but `doctrine.md`, `profiles.yaml` and `loops/<slug>.md`),
  an unsupported policy or profile key the bundle contract cannot carry (named in the refusal), or a
  file that no longer decodes, is `doctrine-push-invalid` before any request.
- The save is sent once, and judged as a save from the org's Gates settings is. The gateway refuses
  it unless the bearer is an org admin's `eris login` (`doctrine-push-refused`); a policy it will
  not take is `doctrine-push-invalid`. After a save the tree is replaced by the saved bundle,
  re-rendered and verified, so YAML comments and layout in your files are normalized.
- When the org has a Mandate, a save that loosens its policy (any loop edit, a looser posture, and so
  on) needs a passkey approval (`doctrine-push-needs-approval`). Open
  <https://dash.sibylline.group/gates/approve>, approve with your passkey, and rerun with the handle in
  `ERIS_GATES_APPROVAL`. It lasts 5 minutes and covers one save. The gateway spends it only on a save
  that needs it, so setting it on every push is safe; eris checks its shape before any request, sends
  it only in the save's body as `mandate_handle`, and never prints it.
- After a save, stderr names what it changed (`INFO changed: posture <name> changed, loop <slug>
  edited, ...`: `active`, `posture <name> added|removed|changed`, `profiles`,
  `loop <slug> added|removed|edited`) and, for a widening, how it was authorised and why
  (`INFO widened (<auth_mode>): <reasons>`). `--output json` carries the same as `changed`,
  `widened`, `reasons` and `auth_mode`.

```sh
eris doctrine push                                   # org <orgId>\tbundle_sha <sha>\tversion <n|unchanged>
ERIS_GATES_APPROVAL=<handle> eris doctrine push      # a widening save, approved with your passkey
```

## `settings` and `history`

`settings` reads and writes the org's Gates settings (`GET` and `PUT /v1/gates/settings`), the
other half of the bundle the Gates editor in the org's portal edits:

```sh
eris doctrine settings                                # one '<key>\t<value>' per key
eris doctrine settings set skills_repo acme/skills    # org <orgId>\tbundle_sha <sha>\tversion <n>
eris doctrine settings set spend_cap_calls unset      # drop an optional key
```

Keys: `skills_repo` (`owner/repo`, or `unset`), `staleness` (`soft` | `hard`),
`ci.check_profile_in_ci` (`on` | `off`), `ci.untracked_prs` (`block` | `warn` | `allow`),
`ci.bot_allowlist` (comma-separated GitHub logins, or `none`) and `spend_cap_calls` (a positive
integer, or `unset`).

- A `set` edits the settings of the newest stored version and sends them with that version as
  `expected_version`; a save that landed in between is `doctrine-push-stale`, never overwritten.
  Setting a key to the value it holds saves nothing.
- The save is judged as `push` is: an org admin's `eris login` (`doctrine-push-refused` otherwise),
  and on a Mandate org a loosening setting needs `ERIS_GATES_APPROVAL=<handle>`
  (`doctrine-push-needs-approval`).
- A save moves the org's `bundle_sha`, so the pulled tree is stale: run `eris doctrine pull` before
  the next `push`.

`history` lists every stored version of the org's policy, oldest first, with who saved it
(`auth_mode`: `cli` for a save made with this CLI, `portal_admin` for one made in the portal, `mandate_passkey` for a loosening a passkey approved, or `seed`) and whether it loosened the policy.

## `set`

`set <posture> --reason <why> --file <path>` switches `active:` in the named doctrine file, appends the
attributed change to `doctrine-history.jsonl` beside it, and asks the gateway
(`/v1/gates/doctrine-comments`) to write one tracker comment on each impacted open issue: one whose
latest gate receipt is on a different policy. The comment reads
`Doctrine changed: A → B · by <actor> · reason: …`, then one sentence per effect. A second flip
within ten minutes of the first updates that comment in place. eris holds no tracker credential: the
gateway reads the issue and writes the comment with the org's own connection. The org's pulled tree
is never edited here (`doctrine-org-managed`); the gateway is asked before the file is written, so a
refused request leaves the file as it was.

## A distribution's defaults

This build has no default doctrine or profiles file of its own: with no pulled tree, `check` needs
`--file`, and `gates` and `effect` use the built-in profiles. A distribution that keeps its organisation's doctrine somewhere
known composes the plugin with defaults in place of this build's, from `eris/sdk`:

```ts
import { composeCli, doctrinePlugin, HANDLERS, PLUGINS, REGISTRY } from "eris/sdk";

const doctrine = doctrinePlugin((ctx) => ({ doctrineFile: myDoctrinePath(ctx.env), profilesFile: myProfilesPath(ctx.env) }));
export const CLI = composeCli(REGISTRY, HANDLERS, [...PLUGINS.filter((p) => p.name !== "doctrine"), doctrine]);
```

A flag still wins over a default. The defaults may be a fixed object or a function of the command
line's context, resolved each time a verb runs.
