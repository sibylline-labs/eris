# `eris skills` and `eris docs`

Commands for coding agents: one installs the agent skills this build publishes, one checks a tree
of skills against the contract of each skill's kind, and one prints the verb reference a skill can
read instead of carrying its own copy.

## `eris skills install [<skill>...]`

Installs published skills for your coding agents. A published skill is a directory
`skills/<name>/` holding a `SKILL.md`, the layout the [skills](https://github.com/vercel-labs/skills)
CLI discovers. The skills come from the build that runs the command: a compiled binary carries
them, a checkout reads its own `skills/`. So `eris skills install` installs the skill text that
matches the eris you run.

```bash
eris skills install eris-socrates     # one skill
eris skills install socrates-consult socrates-capture
eris skills install                   # every published skill
```

Each skill is written to the paths `npx skills add sibylline-labs/eris -g --skill <skill>` writes:

| Path | For |
|---|---|
| `~/.agents/skills/<skill>/` | the skill itself; Codex, Cursor, Amp, Cline and the other agents the skills CLI calls universal read it |
| `~/.claude/skills/<skill>` → `../../.agents/skills/<skill>` | Claude Code, a relative symlink, written only when `~/.claude` exists |

eris does not write the skills CLI's own `~/.agents/.skill-lock.json`; that file is the skills
CLI's state. `npx skills remove -g <skill>`, or `rm -r` of the two paths, removes a skill.

A rerun is safe. A skill whose files already match prints `unchanged`; one whose files differ is
replaced whole (`updated`), local edits and extra files inside it included. A directory at
`~/.agents/skills/<skill>` counts as this skill only when its `SKILL.md` is named `<skill>`. When
`~/.claude` is itself a symlink, the link's relative path is computed from where `~/.claude` really
is, so it resolves. A copy-mode install at `~/.claude/skills/<skill>` (a directory whose
`SKILL.md` is named `<skill>`, as `npx skills add -a claude-code` leaves it) is replaced by the
link. Anything else at either path (a file, a symlink elsewhere, a different directory, or a
`skills` parent that is not a directory) is never overwritten: the command refuses before writing anything
([`skills-target-occupied`](ERRORS.md#skills-target-occupied)).

Text output, one block per skill:

```
installed eris-socrates -> ~/.agents/skills/eris-socrates
  claude-code: ~/.claude/skills/eris-socrates (linked)
```

`--output json` (or `--json`) prints one record:

```json
{"skills": [{"name": "eris-socrates", "path": "/home/me/.agents/skills/eris-socrates", "state": "installed",
  "links": [{"agent": "claude-code", "path": "/home/me/.claude/skills/eris-socrates", "state": "linked"}]}]}
```

`state` is `installed`, `updated` or `unchanged`; a link's `state` is `linked`, `replaced` or
`unchanged`. `links` is empty when `~/.claude` does not exist. Exit `0`.

Failures, each the slugged block with nothing on stdout and exit `1`:
[`skills-unknown`](ERRORS.md#skills-unknown), [`skills-target-occupied`](ERRORS.md#skills-target-occupied),
[`skills-install-failed`](ERRORS.md#skills-install-failed).

A distribution's build carries its own `skills/` and core's, its own winning on a shared name
(`build({ skillRoots })`, default the distribution's root then this package).

## `eris skills lint [<dir>]`

Checks every skill under `<dir>` (default: the current directory) against the contract of the kind
its `SKILL.md` declares. Skills are read from `<dir>/skills/*/SKILL.md` and
`<dir>/.claude/skills/*/SKILL.md`, each root in directory-name order; a symlinked skill directory is
followed. Nothing is written or fetched.

```bash
eris skills lint            # the skills under the current directory
eris skills lint ../agents  # another tree
```

Each skill declares exactly one `kind:` as a top-level key of its frontmatter (the `---` block at
the very start of the file):

```yaml
---
name: review-shape
kind: rubric
description: ...
---
```

Only a line that starts with `kind:` at column 0 counts. A `kind:` in the body, indented under
another key, or inside a folded `description:` is not a declaration. A quoted value is taken whole;
an unquoted one stops at ` #`, so a trailing comment is allowed after an unquoted value only.

| Kind | Contract |
|---|---|
| `tool` | ships a non-empty `scripts/` (a dotfile counts); the `SKILL.md` is judgment over the script |
| `rubric` | at most 60 lines; preloaded in the `skills:` frontmatter of an agent (`<dir>/agents/*.md`, `<dir>/.claude/agents/*.md`) or a skill, its producer; and named, as `<name>` or `<name>@<n>`, in some `.md` under a `gate` skill's directory, its judge |
| `reference` | knowledge only: outside fenced code, no ordered list of two or more items and no `Step N` / `Phase N` heading |
| `workflow` | over 200 lines, its stages live in a `references/` holding at least one `.md` |
| `gate` | no structural contract |
| `mode` | no structural contract |

A producer's `skills:` is read in its one-line forms only, `skills: a, b` or `skills: [a, "b"]`; a
block list under `skills:` is not read. A judge mention is a whole name: `shape` inside `shape-x`,
`my_shape` or `éshape` does not count. Line counts count lines, not newlines: a final newline adds
none.

Each finding has one of these rule ids:

| Rule | Meaning |
|---|---|
| `kind-missing` | no frontmatter, or no `kind:` in it, or an empty value |
| `kind-duplicate` | more than one top-level `kind:` |
| `kind-unknown` | a value that is not one of the six kinds (they are lower case) |
| `tool-without-scripts` | a `tool` with no `scripts/`, or an empty one |
| `reference-has-procedure` | a `reference` holding a numbered procedure |
| `workflow-stages-inline` | a `workflow` over 200 lines with no `.md` under `references/` |
| `rubric-too-long` | a `rubric` over 60 lines |
| `rubric-no-producer` | a `rubric` no agent or skill preloads |
| `rubric-no-judge` | a `rubric` no `gate` skill names |

Text output is one line per finding on stdout, and the count on stderr:

```
review-shape: rubric-no-judge: no kind: gate skill names it
1 finding(s) over 12 skills
```

The order is fixed: every `kind-*` finding first, then the contract findings, each in skill order
(`skills/` before `.claude/skills/`), and a rubric's rules in the table's order.

`--output json` (or `--json`) prints one record, with nothing on stderr:

```json
{"skills": 12, "findings": [{"skill": "review-shape", "rule": "rubric-no-judge", "message": "no kind: gate skill names it"}]}
```

Exit `1` when there is any finding, in either rendering; `0` when there is none. A `<dir>` that does
not exist or is not a directory is refused with nothing on stdout, exit `1`
([`skills-lint-unreadable`](ERRORS.md#skills-lint-unreadable)).

The same check is in the SDK, for a repository that runs it in-process: `lintSkills(dir)` returns
`{skills, findings}`, and `readSkillKind(text)` reads one `SKILL.md`'s kind (`eris/sdk`).

## `eris docs`

Prints the verb reference: every command the build composes (core's and every plugin's), with its
usage line, summary and flags.

`eris docs --json` (the global `--json`, the same as `--output json`) prints one record:

```json
{"schema": "eris-docs/1", "version": "v0.17.0", "commands": [{"schema": "eris-help/1", "path": "", ...}, ...]}
```

`commands` is the top-level help document, then one `eris-help/1` document per command path in
registry order: the same document `eris <path> --help --json` prints
([OUTPUT-CONTRACT.md §3.2](OUTPUT-CONTRACT.md#32-help-as-json)). Nothing is read or fetched; exit `0`.
