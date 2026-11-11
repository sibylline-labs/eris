---
name: socrates-resolve
description: Resolve a closed Socrates review Epic into the project's living docs, the agentic way, reading every entry's verdict and comment thread first. Use when a Socrates review Epic closes, when a Socrates comment on an Epic says to run `eris socrates resolve`, or when the user says they have reviewed or closed a Socrates review Epic. Run it unprompted when you see one close; never on an Epic that is still open.
---

# Resolve a closed review Epic

A person reviews each entry in a Socrates review Epic: Done accepts it, Canceled rejects it, and a
comment says how to change it. Closing the Epic is the command to apply them. There are three ways
it gets applied; this skill picks the right one.

## 1. Check whether the hosted resolver has it

```sh
eris socrates settings policy
```

`auto_resolve: on` means the org's hosted resolver applies the Epic when it closes: read the
Socrates comment on the Epic, tell your user what it did, and stop. `off` means you resolve it.

## 2. Resolve it agentically (the correct way)

Read the Epic and every sub-issue with its full comment thread in Linear. For each one:

- **Done, no comment:** it applies as filed.
- **Done, with an edit instruction** (new wording, a split, "this is a practice", "this belongs
  in Key Assumptions"): note the change it asks for. `eris socrates resolve` applies the entry as
  filed and cannot carry an edit or a reroute yet, so it is a pending edit.
- **Conflict or supersession:** the reviewer's comment is the answer, and it applies to every doc,
  register row and issue the conflict links. Resolve carries the latest reviewer comment, word for
  word, to each of those sites. Make sure the last comment states the settled text; if it doesn't,
  ask your user to add it. A conflict with no answer is carried over, never applied.
- **Canceled:** rejected. Its comment is the reason.
- **Still open:** carried over to a new review Epic.

Never change a Done or Canceled state, and never close or reopen an issue: those are the
reviewer's. Then:

- **No pending edits:** run the resolve and report its receipt.

```sh
eris socrates resolve <epic>
```

- **Pending edits:** name each one and the change it asks for, and run the resolve only when your
  user says to. The edits are not applied: tell your user which entries to fix in their docs.
- **No user present** (a loop, a scheduled or delegated run) **and pending edits:** don't resolve.
  Report the entries and their edits, and stop.

## 3. What the deterministic resolve does alone

Bare `eris socrates resolve <epic>`, which needs no inference, is the baseline every org has:

- It applies Done entries exactly as filed and records Canceled ones as rejected.
- It carries the latest reviewer comment on a Done conflict, verbatim, to the linked sites. It does
  not interpret that comment.
- It carries open entries, unanswered conflicts and states that automation set to a new review
  Epic.
- It does **not** apply edit instructions, reroutes or splits, and it does not decide which side
  of a conflict is right.

Running it again changes nothing and prints the same receipt. It refuses an Epic that is still
open. `--help` has the rest:

```sh
eris socrates resolve --help
```

Reference: `eris socrates --help` · https://github.com/sibylline-labs/eris
