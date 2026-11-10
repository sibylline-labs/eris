---
name: yak-filing
description: File a yak when your own tooling fights back mid-task, or when you wish it were better. Use when a command errors, a hook blocks something legal, a doc or skill names a flag or file that doesn't exist, a tool fails silently, or you hand-rolled over several turns what a tool could do. Files a deduplicated `[Yak]` issue in the user's Linear and never blocks the task. Run it unprompted, in the turn you notice; skip it when Yaks is not set up.
---

# File a yak

A yak is a side channel from you to whoever maintains your tooling. When the tooling fights back,
file one in the same turn, then carry on with the task. Filing never blocks it.

## 1. Pick the verb

- `eris yak issue`: something is wrong (a hook blocks a legal edit, a doc names a flag that doesn't exist, a command fails silently).
- `eris yak suggest`: something could be better and nothing is broken (a flag or skill you wished existed; a workaround you hand-rolled more than once).
- `eris yak fatal`: the tooling broke and the task already stopped.

## 2. File it

```sh
eris yak issue --summary "<one line>" --body "<what happened, what you expected>" --repro "<command>"
```

`--repro` is optional: add it when one command shows the problem. Filing is deduplicated, so a
repeat adds weight to an existing report. Speak in the first person.

## 3. Check the machine can file

```sh
eris yak ready
```

It prints one readiness line. When it says to run `eris login`, tell your user in one line and carry
on. When Yaks is not set up at all, the `eris-yaks` skill sets it up.

## When it fails

A `WARN` line from `eris yak` still exits 0: the yak was stored or dropped, the task is unaffected.
Name the slug to your user once and carry on.

Reference: `eris yak --help` · https://github.com/sibylline-labs/eris
