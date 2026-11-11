---
name: socrates-capture
description: Offer to record, in Socrates, the decisions, practices and PRDs a work session made, so they reach the project's living docs in the user's Linear for review. Use when a work stint ends or the user wraps up, signs off or says they are done; whenever this session made or changed a decision, a way of working or a PRD, such as choosing between approaches, setting a convention, or rejecting an option; and whenever the user asks you to log or record something in Socrates. Offer it without being asked; skip it when the session decided nothing.
---

# Capture what this session decided

`eris socrates` files each decision as a candidate that a person reviews in the project's review
Epic. This skill finds the session's decisions, checks each against the living docs and the CLI,
and files what the CLI says to file. Each verb's `--help` says how to call it: run it and follow
what it prints.

## 1. Check you can file

```sh
eris socrates status
```

Expect `pending candidates: <n>`. If sign-in or enrolment fails, tell your user and stop.

## 2. Find this session's decisions

When a caller hands you a list of PRs, issues and plan documents, that list is the run: skip
`discover`. Otherwise list the repo's unprocessed commits and keep only this session's:

```sh
eris socrates discover
```

Add what was decided with no commit yet: a rejected option, a convention agreed in chat. Read each
item's intent (the PR description, a design or planning doc, what your user said), not the code diff.
A candidate is one claim the session made or your user endorsed: a title of at most 80 characters
that states it, a one-sentence statement in the voice of the doc it will live in, and a `--source`
link to where it was decided. Never invent one. A session that decided nothing ends here: say so and stop.

## 3. Read the living docs, then check each candidate

```sh
eris socrates consult --brief --project <name>
```

An entry that already says it means the candidate is already recorded; one that later settled it
the other way makes it stale (skip it). A current entry, Canon rule or PRD row that says otherwise
makes it a conflict. Then, for each candidate:

```sh
eris socrates classify --help
eris socrates classify --title <title> --statement <statement> --source <url> --project <name>
```

Answer every question the help asks, from what you observed, and do what the `next:` line says.
Write the statement before you classify and never reword it to change the verdict; if you think a
gate misread it, say so to your user and leave it unfiled. Three shapes take no questions:

- A PRD the session wrote or extended files once, never one entry per decision in it:
  `eris socrates classify --kind prd --title <title> --statement <grammar> --source <url> --project <name>`.
- A contradiction is a conflict linking every site involved, and is never dropped:
  `eris socrates classify --kind conflict --title <title> --statement <grammar> --source <url> --project <name>`.
- A decision the questions cannot express goes up as a hypothesis with its evidence:
  `eris socrates submit --unfit --hypothesis <what you think it is> --evidence-file <path> --title <title> --statement <statement> --source <url>`.

When your user asked you to log something, follow the exception a `not filed` line names.

## 4. File them

With your user present, show each candidate with its `next:` line and file the ones they approve.
With no user present (a loop, a scheduled or delegated run), file what `next:` says to file: the
review Epic is where a person decides, and the first practice creates a missing Practices doc.

```sh
eris socrates submit <the flags and answers classify took> --project <name> --evidence <why, and where: repo@sha:path#L or a PR link>
eris socrates submit <the flags and answers classify took> --project <name> --fragment <path>#L<x>-L<y>
```

Attach a passage committed in the repo you are in with `--fragment`: only its provenance reaches
Linear; cite any other repo in `--evidence`. Quote the receipt (`submitted: <id>` or
`already submitted: <id>`). A refusal prints a `fix:` line: follow it, and never remove a redaction
yourself.

## 5. Move the cursor

Only after a full `discover` run, never a scoped one (a caller's list or some of the listed
commits), once every listed commit is filed or deliberately skipped:

```sh
eris socrates discover --advance <rev>
```

Reference: `eris socrates --help` · https://github.com/sibylline-labs/eris
