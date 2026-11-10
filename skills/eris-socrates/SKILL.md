---
name: eris-socrates
description: Set up Socrates so this coding agent can read the team's living docs and Canon and file its decisions as reviewable candidates in the user's Linear. Use when the user asks to set up, install, connect or sign in to Socrates or `eris socrates`, or when an `eris socrates` command fails because eris is missing or signed out. Reading before a decision and filing after one are the socrates-consult and socrates-capture skills.
---

# Set up Socrates

Socrates keeps a project's living docs and the org's Canon current in your user's Linear.
`eris socrates` is the client. This skill gets you signed in and names the verbs. Each verb's
`--help` is the source for how to use it, so run it and follow what it prints instead of
relying on this file.

## 0. Install the skills globally

Install with `-g`, so every project's sessions load them. Without `-g` the skills CLI installs at
project scope, which writes `.agents/`, `.claude/skills/` and `skills-lock.json` into the repo you
are standing in. Run this from any directory:

```sh
npx skills add sibylline-labs/eris -g --skill eris-socrates
npx skills add sibylline-labs/eris -g --skill socrates-consult
npx skills add sibylline-labs/eris -g --skill socrates-capture
```

## 1. Check for bun

eris is TypeScript that runs on bun. If it isn't installed, ask your user to install it
from https://bun.sh, then continue.

```sh
bun --version
```

Expect: a version number.

## 2. Run eris

Run eris straight from npm, then add the same package globally so later sessions can call
`eris` directly. If a global install isn't possible, run every `eris …` command below as
`npx @sibylline-labs/eris@latest …`. Use only these two install paths.

```sh
npx @sibylline-labs/eris@latest --version
bun add -g @sibylline-labs/eris
```

Expect: `eris` followed by a version.

## 3. Sign in (your user, in a browser)

Run the command below. It prints a link and a short code, then waits up to 10 minutes. Ask
your user to open the link, check it shows the same code, and approve. eris writes the token
itself: never ask your user for a token or to paste one into this chat.

```sh
eris login
```

Expect: `logged in: token "…" written to …`

## 4. Use it

Two sibling skills carry the day-to-day work: `socrates-consult` reads the living docs and Canon
before you plan or decide, and `socrates-capture` offers to file what a session decided when the
stint ends. A refusal that prints a settings link means the org has not chosen that doc yet. Show
your user the link and carry on without it; never invent a house rule.

## 5. The verbs

| Verb | Use it to |
|---|---|
| `eris socrates consult` | Print the Canon, Practices, or a brief of the living docs |
| `eris socrates classify` | Check a candidate locally and print its verdict; sends nothing |
| `eris socrates submit` | Send one decision, practice or PRD for review |
| `eris socrates status` | See what is pending and which review Epics are open |
| `eris socrates policy` | Print the org's policy that `classify` and `submit` apply |
| `eris socrates discover` | List the commits in this repo that no candidate has covered yet |
| `eris socrates resolve` | Resolve a closed review Epic |
| `eris socrates settings team` | Set which Linear team reviews file on (an org admin's); takes a team key, name or id |

Before you run a verb for the first time, run `eris socrates <verb> --help` and follow it.
For a failure, the printed `fix:` line says what to do next.
A Linear team or project is accepted by name, key or id, so pass what the user typed. If a name matches several objects, the command prints a `WARN` listing the candidates and exits 0 having changed nothing: run it again with one candidate's id.

## Done

Tell your user that Socrates is set up and that you will read it before you decide and offer to file what you decide.

Reference: `eris socrates --help` · https://github.com/sibylline-labs/eris
