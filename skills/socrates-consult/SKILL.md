---
name: socrates-consult
description: Read the team's living docs and Canon from Socrates before you plan, design or decide on a project that is enrolled in it, so the work follows what was already decided instead of re-deciding it. Use before writing a plan, starting a design, choosing between approaches, changing a convention, or answering a question about how this project works, in any repo whose project uses Socrates. Run it unprompted; skip it when the project is not enrolled.
---

# Read Socrates before you decide

Socrates keeps the project's decisions, assumptions, practices and the org's Canon in the user's
Linear. Read them first; a plan that contradicts them needs the user's say-so.

## 1. Read the brief

```sh
eris socrates consult --brief
```

It prints Canon, then the project's 1-Pager, decisions, key assumptions, retro findings and
practices. An org that enrols several projects needs `--project <name>`; `--help` lists the flags.

## 2. Read Canon when the work touches a house rule

```sh
eris socrates consult --canon
```

## 3. Use what you read

- Answer first, then cite: the doc and the entry's ID or title for every claim you take from it. A
  claim you cannot cite is your inference: say so.
- When the docs do not settle it, say "not confirmed in Socrates" plainly. Absence is not consent,
  and code you read is not a recorded decision.
- An entry still under review in an open review Epic is pending, not settled; never present it as
  current.
- Checking a plan, lead with the verdict: clear, conflicts (each with its entry), or contested
  (an open conflict or a pending entry touches it).
- When your plan departs from an entry or from Canon, tell your user before you act on it. If they
  confirm the departure, it is a conflict to file: the `socrates-capture` skill files it. Never
  edit a living doc yourself.

## When it fails

- Not signed in, or the project is not enrolled: tell your user in one line and carry on; the
  `eris-socrates` skill sets that up.
- A refusal that prints a settings link: the org has not chosen that doc. Show your user the link and
  carry on without it. Never invent a house rule.

Reference: `eris socrates --help` · https://github.com/sibylline-labs/eris
