# `eris gate` — gate receipts

A **gate** is a review step a change passes through: a premise check, a plan review, the final
gates before merge. A **gate receipt** records that a gate ran (or was skipped, and on whose
grant), what it judged, and the evidence it relied on. `eris gate` writes receipts to an issue
through the hosted gates store and reads them back to decide whether a change may close.

```
eris gate record <gate> --issue <KEY> [--verdict PASS|AMENDED|BLOCKING] [--artifact <path>] [evidence flags]
eris gate skip   <gate> --issue <KEY> --reason <why> --authorized <grant> --artifact <path>
eris gate check  --issue <KEY> (--gates <a,b,...> | --profile <name>) [--expect <id,...>] [--effort <level>] [--head-sha <sha>] [--diff-sha256 <sha256>]
eris gate ci     [--event <file>] [--registry <path>]

eris surface lock   <name> --reason <why> --authorized <grant> [--registry <path>]
eris surface unlock <name> --authorized <grant> [--reason <why>] [--registry <path>]
eris surface digest [--since <n>h|<n>d] [--registry <path>]
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
  carried inline with their sha256), `--review-report <file>` (a `review-report@1` file: YAML
  frontmatter with no `verdict` key plus prose body, strictly validated before anything is sent,
  stored with its canonical sha256, and rendered with a findings summary and prose preview),
  `--screenshot`, `--video` (up to 25 MiB, uploaded; `check` re-reads the stored asset's digest).
- With `--review-report`, `--artifact` defaults to the first report file and `--verdict` may be
  omitted: `record` derives `PASS` or `BLOCKING` from the report's findings, reviewer independence,
  actor binding, and refutation endorsements across the issue's prior receipts.
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
| `blocking` | a BLOCKING verdict, a failing review report, or review-report evidence in a build with no registered review skills | no |
| `review-stale` | a review report's skill or vocabulary moved on `main` (or could not be verified) and the receipt carries no human grant | no |
| `unresolved` | the artifact's repo has no checkout here, in `~/.eris/clones.json` or the harness clone, and no stored copy verifies | no |
| `drift` | the artifact or review-report target changed after it passed | no |
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
  none: U0/U1 at the auto rung and U2/U3 at the human-after rung), lifted by the posture's `lifts`
  on a bleed-reducing fix and capped by its `ceilings`. At the human-before rung the check fails
  unless a `door-signoff` receipt passes with a human grant.
- `@remediate\tunsupported\t-` when the issue has a `remediate` receipt: this build does not judge a
  remediation loop, so the check fails rather than pass it unread.
- Naming `final-gates` (or with `--asks`): `@asks\t<clear|open>\t<n>`, the open blocking asks bound to
  the issue (and, with `--pr <N>`, to that pull request). Any open one fails the check; an asks API
  that cannot be read fails it too, never reading as "no asks". `--asks` also prints the result as one
  JSON line.

### Review reports

When the build composes `gatePlugin({ reviews })`, `check` (and `ci`) judges `review-report@1`
evidence on a receipt: the review skill must be registered (against `reviews.skills`, when supplied,
and the merge-base `review_skills` during `ci` unlock), the recording actor must match
`reviewer.actor`, no `blocking`/`major` finding may remain open or unendorsed-refuted, the reviewer
must be independent of the author in a fresh context, `classes_checked` must cover every class in
the vocabulary at `main`, `effort` must meet `--effort` (or a bar gate's `:<effort>` qualifier),
and `target.head_sha` / `target.diff_sha256` must match `--head-sha` / `--diff-sha256` (or the
target checkout's `HEAD` and merge-base diff). If the skill or vocabulary moved on `main` (or could
not be verified), the gate reads `review-stale` unless the receipt carries a human `--authorized`
grant. Without `reviews` (the public default), any `review-report` evidence fails closed as
`blocking`.

### Read lag

The store's reads lag its writes by seconds to about a minute. `--expect <id,...>` (the ids
`record` printed) makes `check` re-read, about 30 s in all, until one listing holds every id, and
fail closed (`gate-receipt-unseen`) if none does.

## ci

The required check a repo's CI runs on a pull request. It reads the `pull_request` event (`--event`,
default `$GITHUB_EVENT_PATH`), fetches the org's hosted policy and settings on the `eris login` bearer
(`ERIS_YAKS_TOKEN` and `ERIS_YAKS_URL` on a runner), and decides under the live hosted posture: a
locally pulled tree is never read. It records nothing. Every request it sends is a `GET`; the one
gateway client it builds refuses any other method before the network, and a refusal stops it with
`gate-ci-write-refused`.

stdout, in order:

- `@policy\t<bundle_sha>\t<active posture>`
- `@issue\t<KEY|->\t<ref|title|none>`: the issue key from the head ref (`<you>/abc-123-...`) first,
  then the title (`ABC-123: ...`).
- each leg's rows, then `@ci\t<leg>\t<pass|fail|skipped>`.

A PR with an issue key runs three legs, each to the end, and the check fails with the first failing
leg's failure:

| Leg | What it checks |
|---|---|
| `profile` | when `settings.ci.check_profile_in_ci` is `on`: the hosted posture's `profile_default` (default `spine`) from the hosted bundle's profiles, as `check --profile --dry-run` does. A gate the posture sets `off` reads `skipped`. |
| `monotone` | `.claude/surfaces.yml` (`--registry`), each surface's vocabulary and each registered review skill at the merge-base against the head, one `@monotone\t<scope>\t<subject>\t<field>\t<tighter\|wider>\t<detail>` row per changed dimension. Any wider row fails (`gate-monotone-wider`) unless the issue's latest `surface-widen` receipt passes with a human grant and its artifact carries every wider row verbatim. |
| `unlock` | whether the merge may proceed without a human on each registered surface the diff crosses. When a surface is crossed it first prints `@door\t<one-way\|two-way>\t<source>`: every signal can only close the door, so it reads one-way when the latest `define-future` (bar a valid doctrine/repo skip) does not pass, its verified artifact is a graph-target delta removing or changing anything (including sparse v1 deltas omitting empty fields) or failing strict decode, or a `door:` evidence line says `one-way` or counts `-n`, `−n` (`U+2212`), or `~n` above 0; when any earlier `define-future` on the issue (`define-future history`) has unverifiable recorded bytes, an invalid or removing/changing delta, or an inline one-way `door:` line (`text`, `log`, `test-run`, `e2e`); or when the issue is unclassified or its class's unladdered rung is human-before. A clean two-way merge with no governance path prints `@surface` and `@lock` per crossed surface and `@unlock\tnot-needed\tmerge` (a locked surface or `signoff.two-way: human` keeps it human-signed). A one-way merge checks the bar's gate rows, `@baseline`, `@budget`, `@announce`, and `@governance` plus `@monotone` rows for a governance edit; when `adversarial-review` has no receipt bound to the head (and no receipt naming no commit) it prints `@dispatch\tadversarial-review\teris loop launch ...` with the shell-quoted main clone just before `@unlock\thuman`. It reads `unlocked` when `signoff.unlock: on` and every bar gate passes bound to the head, or `human-signed` on a passing human `door-signoff` carrying `door: merge`; anything else fails (`gate-unlock-human`), naming every reason. |

A PR with no key: under `settings.ci.untracked_prs: block` it fails (`gate-issue-missing`). An author
on `settings.ci.bot_allowlist`, or `untracked_prs: warn` (one `WARN` line) or `allow`, runs the
surfaces leg instead: one `@surface-path\t<path>` row per path the PR's merge-base diff changes on a
registered surface (the registry at the fork or at the head) or the registry itself, failing
(`gate-ci-bot-surface`) when there is any, else `@ci\tsurfaces\tpass`.

The check needs the PR's base and head commits in the checkout (`fetch-depth: 0`); it accepts the
merge commit a `pull_request` workflow checks out, judging the PR head that is its second parent.

## surface

The per-surface kill switch and the unlock roll-up over the registry (`.claude/surfaces.yml`,
`--registry`). A surface that names a `ledger:` issue can be locked: `lock` records a `surface-lock`
PASS receipt on that issue, `unlock` an AMENDED one, and the unlock leg of `eris gate ci` reads the
latest of them, so a locked surface never unlocks a merge without a human signing it. Both are human
writes: `--authorized` must be a human grant (`Dan asked: <request>`), and `doctrine:` or no grant stops
with `surface-lock-unauthorized` before anything is sent. Locking a locked surface, or lifting an open
one, records nothing and prints `-`; otherwise stdout is the receipt's comment id. An unreadable lock
receipt reads locked, and so does a timestamp tie. The registry is the receipt's artifact, so inside a
git checkout it must be committed and pushed first, as for `record --artifact`.

`digest` prints one row per registry surface, `<surface>\t<ledger|->\t<merge>\t<deploy>\t<effect>\t<locked|open|->`,
counting the `unlocked-<action>` receipts on its ledger inside `--since` (default `24h`), then one
`@digest` line for the pulse.

## A distribution's gate

A distribution composes these verbs from `eris/sdk` alone: `gatePlugin({ ladderFile, pulled, reviews })`
in place of this build's gate plugin, with `pulledTree` as `pulled` to read the org's verified policy
tree and `reviews` (`GateReviews`) supplying the registered review skills and `main` skill/vocabulary
freshness reader (`ReviewFreshness`). Without `reviews`, `check` and `ci` fail closed as `blocking`
on `review-report@1` evidence. `ladderFile` is the door-class ladder `check` reads with no `--ladder`;
without it U0/U1 read the auto rung and U2/U3 read the human-after rung. `loopPlugin` and `freshTree` compose the loop verbs
the same way, and `examples/distribution` composes all three.
