# `eris gate` — gate receipts

A **gate** is a review step a change passes through: a premise check, a plan review, the final
gates before merge. A **gate receipt** records that a gate ran (or was skipped, and on whose
grant), what it judged, and the evidence it relied on. `eris gate` writes receipts to an issue
through the hosted gates store and reads them back to decide whether a change may close.

```
eris gate record <gate> --issue <KEY> --verdict PASS|AMENDED|BLOCKING --artifact <path> [evidence flags]
eris gate skip   <gate> --issue <KEY> --reason <why> --authorized <grant> --artifact <path>
eris gate check  --issue <KEY> (--gates <a,b,...> | --profile <name>) [--expect <id,...>]
```

Every verb signs in with `eris login` (the org this directory acts as: `ERIS_ORG`, else `repo.org` in
the nearest `eris.yaml`, else the default org); `ERIS_YAKS_TOKEN`, a `sib_` service token, wins when
set. No `eris.yaml` is needed. The store writes the issue's comment itself, with the org's own tracker
connection: eris never holds a tracker credential ([dev/GATES-CLIENT.md](dev/GATES-CLIENT.md)).

When the org's policy is pulled (`eris doctrine pull`, which `eris login` runs once), `--doctrine` and
`--profiles` default to the pulled, verified tree, and every receipt call names the bundle this
machine holds. A reply saying it is not the live one prints one
`WARN this machine's copy of the org's policy is not the live one ...: run 'eris doctrine pull'`; an
org that requires the live policy refuses the write (`doctrine-out-of-date`). An edited tree stops
every verb before anything is sent (`doctrine-local-modified`).

## record

Hashes the artifact, snapshots the active doctrine posture when there is one, uploads each media
file, and appends one `gate-receipt@v2` record. stdout is the new comment's id, which
`check --expect` takes.

- An artifact inside a git checkout with a hosted `origin` is recorded as repo, branch, commit and
  repo-relative path, so `check` finds it from any directory. It must be committed at HEAD and HEAD
  pushed (`gate-artifact-uncommitted` otherwise). Any other file is recorded by absolute path.
- A PASS or AMENDED receipt carries a gzip copy of the artifact (up to 48 KiB encoded) that `check`
  re-hashes once the file itself is gone. No copy is carried when the bytes are not UTF-8 text or the
  secret scan matches; a `WARN` names why.
- Evidence: `--evidence <text>` (repeatable), `--log`, `--test-run`, `--e2e` (text files up to 16 KiB,
  carried inline with their sha256), `--screenshot`, `--video` (up to 25 MiB, uploaded; `check`
  re-reads the stored asset's digest).
- `--impact U0|U1|U2|U3` proposes the issue's user-impact class; `--authorized <grant>` is the only
  way a later receipt may lower a U2 or U3 class.
- A write the store rate-limits is retried a bounded number of times under the same comment id,
  which the store dedupes on.

## skip

Records a SKIPPED receipt: why the gate is not run (`--reason`, 12 characters or more), and the
grant behind the decision. A grant is one of:

| Grant | Holds when |
|---|---|
| a human one, `'<name> asked: <request>'` | always; it is recorded as given |
| `doctrine:<posture>` with `--doctrine <file>` | that posture is the active one and sets `gates.<gate>: off` |
| `repo:no-eris-yaml` | the gate is `define-future` and the git repo has no root `eris.yaml` |

A grant that reads as a doctrine or repo grant in any other spelling is refused
(`gate-skip-unauthorized`). `check` re-judges a doctrine or repo grant every time it reads the
receipt, so the skip counts only while the posture (or the repo) still bears it out.

## check

Reads the issue's receipts and prints one row per gate, `<gate>\t<status>\t<verdict>`; the latest
receipt per gate, by the store's time, decides. Exit 0 when every row passes, 3 otherwise
(`gate-check-failed`).

### Statuses

| Status | Meaning | Passes |
|---|---|---|
| `pass` | PASS or AMENDED, and the artifact (or its verified stored copy) hashes as recorded | yes |
| `skipped` | SKIPPED on a grant that still holds | yes |
| `deferred` | the posture runs the gate `once-at-end`, and `final-gates` is not being checked | yes |
| `absent` | a profile's forbidden gate with no receipt | yes |
| `missing` | no receipt | no |
| `bad-digest` | evidence no longer matches its sha256, or its stored asset is gone | no |
| `blocking` | a BLOCKING verdict, or review-report evidence (this build does not judge review reports) | no |
| `unresolved` | the artifact's repo has no checkout here, in `~/.eris/clones.json` or the harness clone, and no stored copy verifies | no |
| `drift` | the artifact changed after it passed | no |
| `unauthorized-skip` | SKIPPED with no grant | no |
| `doctrine-stale` | a doctrine or `repo:no-eris-yaml` skip the posture or repo no longer bears out | no |
| `forbidden` | a profile's forbidden gate that has a receipt | no |

### Profiles and doctrine

`--profile <name>` checks the gates a work profile requires (built in: `spine`, `deep`; else the
org's pulled `profiles.yaml`; `--profiles <file>` reads a YAML map instead, where an entry may be
`{ require: [...], forbid: [...] }`). Under a profile each gate's mode comes from the active posture:
an `off` gate with no receipt gets a doctrine SKIPPED recorded for it, a `once-at-end` gate reads
`deferred` until `final-gates` is checked, and `define-future` in a git repo with no root `eris.yaml`
gets a `repo:no-eris-yaml` SKIPPED. `--dry-run` prints those skips as
`<gate>\tskipped\t<reason>` and records nothing.

### The derived rows

After the gate rows, in this order:

- `burden\t<pass|unmet>\t<kinds>` with `--burden <rubric> --base <ref>`: the paths changed since
  `--base` resolve to surfaces through the root `eris.yaml`'s `discover.paths` (the most specific
  claim wins), and the passing receipts must carry every evidence kind the rubric says those surfaces
  owe. An estate with leaf `eris.yaml` files is refused (`gate-burden-unresolved`): this build reads
  the root's claims only.
- Naming a floor gate (`final-gates`, `user-impact`): one row per requirement of the issue's
  user-impact class, then `@floor\t<pass|unmet|unclassified>\t<class>`, then
  `@door\t<rung>\t<class>`. The door's rung comes from the ladder file (`--ladder`, or the build's;
  none: every class at the human-after rung), lifted by the posture's `lifts` on a bleed-reducing
  fix and capped by its `ceilings`. At the human-before rung the check fails unless a `door-signoff`
  receipt passes with a human grant.
- `@remediate\tunsupported\t-` when the issue has a `remediate` receipt: this build does not judge a
  remediation loop, so the check fails rather than pass it unread.
- Naming `final-gates` (or with `--asks`): `@asks\t<clear|open>\t<n>`, the open blocking asks bound to
  the issue (and, with `--pr <N>`, to that pull request). Any open one fails the check; an asks API
  that cannot be read fails it too, never reading as "no asks". `--asks` also prints the result as one
  JSON line.

### Read lag

The store's reads lag its writes by seconds to about a minute. `--expect <id,...>` (the ids
`record` printed) makes `check` re-read, about 30 s in all, until one listing holds every id, and
fail closed (`gate-receipt-unseen`) if none does.
