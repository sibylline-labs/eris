# `eris doctrine` — the doctrine `policy:` contract

A doctrine is a markdown file of **postures**: named ways of working (a quick prototype, business
as usual, a lock-in before a launch), one of them active. Each posture may carry a `policy:` block
that says which review gates run and how strictly, who signs off which kind of change, and what
evidence each class of change must show before it closes. `eris doctrine` reads that file. `check`,
`schema`, `gates` and `effect` are offline: they read a local file, a profiles file, or stdin, and
never the network. `pull` fetches the org's hosted policy and `path` names the file it wrote
([pull and path](#pull-and-path)).

```
eris doctrine check  [--file <path>] [--cite] [--output json]
eris doctrine schema
eris doctrine gates  [--file <path>] [--profiles <file>] [--explain]
eris doctrine effect [--profiles <file>] [--output json] < {"contract": ..., "before": ..., "after": ...}
eris doctrine pull   [--output json]
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
  edited by hand fails `doctrine-local-modified`; `pull` restores it. Change the policy in the
  org's Gates settings, not on disk.

```sh
eris doctrine pull                                   # <orgId>\t<bundle_sha>
eris doctrine check --file "$(eris doctrine path)"
eris doctrine gates --file "$(eris doctrine path)" --profiles "$(dirname "$(eris doctrine path)")/profiles.yaml"
```

## A distribution's defaults

This build has no default doctrine or profiles file: `check` needs `--file`, and `gates` and
`effect` use the built-in profiles. A distribution that keeps its organisation's doctrine somewhere
known composes the plugin with defaults in place of this build's, from `eris/sdk`:

```ts
import { composeCli, doctrinePlugin, HANDLERS, PLUGINS, REGISTRY } from "eris/sdk";

const doctrine = doctrinePlugin((ctx) => ({ doctrineFile: myDoctrinePath(ctx.env), profilesFile: myProfilesPath(ctx.env) }));
export const CLI = composeCli(REGISTRY, HANDLERS, [...PLUGINS.filter((p) => p.name !== "doctrine"), doctrine]);
```

A flag still wins over a default. The defaults may be a fixed object or a function of the command
line's context, resolved each time a verb runs.
