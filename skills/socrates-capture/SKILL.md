---
name: socrates-capture
description: Offer to record, in Socrates, the decisions, practices and PRDs a work session made, so they reach the project's living docs in the user's Linear for review. Use when a work stint ends or the user wraps up, signs off or says they are done, and whenever this session made or changed a decision, a way of working or a PRD, such as choosing between approaches, setting a convention, or rejecting an option. Offer it without being asked; skip it when the session decided nothing.
---

# Capture what this session decided

`eris socrates` files each decision as a candidate that a person reviews. This skill finds the
session's decisions, checks each one locally, and files the ones your user approves. Each verb's
`--help` says how to call it: run it and follow what it prints.

## 1. Check you can file

```sh
eris socrates status
```

Expect: `pending candidates: <n>`. If it fails for sign-in or enrolment, tell your user in one line
and stop; the `eris-socrates` skill sets that up.

## 2. Find this session's decisions

Scope to what this session produced: its commits, PRs, issues and design or plan documents.

```sh
eris socrates discover
```

It lists the repo's commits that no candidate has covered. Keep only the ones from this session,
and add any decision that has no commit yet (a rejected option, a convention agreed in chat). A
session that decided nothing ends here: say so and stop.

## 3. Check each candidate

For each one, write a title, a statement and a `--source` link to where it was decided, then:

```sh
eris socrates classify --help
eris socrates classify --title <title> --statement <statement> --source <url>
```

Answer the questions as `--help` describes, from what you observed. Show your user each candidate
and its verdict, and ask which to file. Never file without that answer.

## 4. File the approved ones

```sh
eris socrates submit --title <title> --statement <statement> --source <url>
```

Give `submit` the same answers `classify` took. Quote the receipt line it prints
(`submitted: <id>` or `already submitted: <id>`). A refusal prints a `fix:` line: follow it,
and never remove a redaction yourself.

## 5. Move the cursor

When every discovered commit is filed or deliberately skipped:

```sh
eris socrates discover --advance <rev>
```

Reference: `eris socrates --help` · https://github.com/sibylline-labs/eris
