# `eris skills` and `eris docs`

Two commands for coding agents: one installs the agent skills this build publishes, the other
prints the verb reference a skill can read instead of carrying its own copy.

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
