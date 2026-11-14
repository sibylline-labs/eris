---
name: socrates-resolve
description: Resolve a closed Socrates review Epic into the project's living docs, the agentic way, reading every entry's verdict and comment thread first. Use when a Socrates review Epic closes, when a Socrates comment on an Epic says to run `eris socrates resolve`, or when the user says they have reviewed or closed a Socrates review Epic. Run it unprompted when you see one close; never on an Epic that is still open.
---

# Resolve a closed review Epic

A person reviews each entry in a Socrates review Epic: Done accepts it, Canceled rejects it, and a
comment says how to change it. Closing the Epic is the command to apply them. There are three ways
it gets applied; this skill picks the right one.

## 1. Check whether the hosted resolver has it

When the Epic closed, Socrates commented on it saying which path it took (a comment that starts
with **Socrates**). If it says the hosted resolver applied it, tell your user what it did and stop.
For an Epic with no such comment, read the org's current setting; `auto_resolve: on` means hosted:

```sh
eris socrates settings policy
```

## 2. Resolve it agentically (the correct way)

Read the Epic and every sub-issue with its full comment thread in Linear. A comment that starts
with **Socrates** is Socrates' own, never a reviewer's. For each sub-issue:

- **Done, no comment:** it applies as filed.
- **Done decision, with an edit instruction** (new wording, "this is a practice", "this belongs in
  Key Assumptions"): apply it with `--amend`. Write the amendment as a JSON file, an object with at
  least one of `title` (a single line of at most 80 characters, with file names, domains and dotted
  identifiers in backticks), `statement` (also a single line, at most 4000 characters), `target` (`lbd`, `ka` or `practices`) and optionally
  `source_comment`, then pass `--amend <child>=<path>` (repeatable, once per child). The receipt's
  `amended:` lists what applied. `--amend` takes only a Done decision. A Done practice or PRD with an
  edit instruction, and a split, are pending edits for the user: never drop `--amend` and resolve,
  which would write the unedited entry.
- **Amend failures:** `socrates-amend-invalid` is local and nothing was sent: fix that `--amend`.
  An endpoint refusal exits `socrates-refused`. If the child is already written or resolved, or is
  not marked Done by a person, drop that `--amend` and run again. For an unwritten Done conflict,
  PRD, practice or decision that carries an edit instruction, fix the `--amend` or hold it pending:
  never drop it and resolve.
  `socrates-amend-ignored` is an `ERROR` failure (exit 1, empty stdout), never a `WARN`: the Epic is
  already resolved without that edit and running again changes nothing, so fix the named entry in
  the living docs by hand.
- **Conflict or supersession:** the reviewer's latest comment is the answer. Resolve carries it,
  word for word, to every site the issue lists under its authoritative sites; with no comment, it
  carries the proposed resolution. So the latest comment must be the settled text itself, fit to
  stand in each of those sites. A conversational or instruction-shaped comment ("update X to Y")
  is pending until the reviewer restates it. With neither comment nor proposed resolution, it is
  carried over, never applied.
- **Canceled:** rejected. Its comment is the reason.
- **Still open:** carried over to a new review Epic.

Never change a Done or Canceled state, and never close or reopen an issue yourself: those are the
reviewer's, and resolve propagates what a settled conflict says. Then:

- **Nothing pending, or every edit written as an amendment:** run the resolve and report its
  receipt, including `amended:`.

```sh
eris socrates resolve <epic> [--amend <child>=<path>]...
```

- **Something pending, your user present:** name each pending entry and what it needs. Run the
  resolve only when your user says to; then tell them which entries to fix in their docs.
- **Something pending, no user present** (a loop, a scheduled or delegated run): don't resolve.
  Report each pending entry and what it needs, and stop.

## 3. What the deterministic resolve does alone

Bare `eris socrates resolve <epic>`, which needs no inference, is the baseline every org has:

- It applies Done entries exactly as filed and records Canceled ones as rejected.
- It carries the latest reviewer comment on a Done conflict, verbatim, to the linked sites. It does
  not interpret that comment.
- It carries open entries, unanswered conflicts and states that automation set to a new review
  Epic.
- It does **not** apply edit instructions, reroutes or splits on its own (that takes `--amend`),
  and it does not decide which side of a conflict is right.

Running it again changes nothing and prints the same receipt. It refuses an Epic that is still
open. `--help` has the rest:

```sh
eris socrates resolve --help
```

Reference: `eris socrates --help` · https://github.com/sibylline-labs/eris
