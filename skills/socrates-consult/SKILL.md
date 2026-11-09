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

Name the entries your plan or decision depends on, and say so when it departs from one.

## When it fails

- Not signed in, or the project is not enrolled: tell your user in one line and carry on; the
  `eris-socrates` skill sets that up.
- A refusal that prints a settings link: the org has not chosen that doc. Show your user the link and
  carry on without it. Never invent a house rule.

Reference: `eris socrates --help` · https://github.com/sibylline-labs/eris
