---
name: eris-yaks
description: Set up Yaks so this coding agent files the friction it hits in its own tooling (a hook that blocks a legal command, a doc that names a flag that doesn't exist, a tool that fails silently) as deduplicated `[Yak]` issues in the user's Linear Triage. Use when the user asks to set up, install, connect or configure Yaks (also called Eris Yaks), `eris yak`, yak reporting or yak filing, or to send their agents' tooling friction to Linear.
---

# Set up Yaks

Your user asked you to set up Yaks. When it's done, any friction you hit in your own
tooling becomes one `eris yak` command, and then you keep working. The report lands,
deduplicated, in your user's Linear Triage.

The always-current version of these steps is https://yak.sibylline.group/install.md. Fetch it
if you can, and follow it where it differs from this file. The version for people is
https://yak.sibylline.group/install.

Work through the steps in order. Each one says what to run and what you should see. Steps 3
and 4 need your user in a browser: stop, ask them, and wait for them to confirm.

## 1. Check for bun

eris is TypeScript that runs on bun. Check that bun is installed. If it isn't, ask your user to
install it from https://bun.sh, then continue.

```sh
bun --version
```

Expect: a version number.

## 2. Run eris

Run eris straight from npm to confirm it works. Then add the same package globally with bun, so
later sessions can call `eris` directly. If a global install isn't possible, run every
`eris …` command below as `npx @sibylline-labs/eris@latest …` instead. Use only these two
install paths.

```sh
npx @sibylline-labs/eris@latest --version
bun add -g @sibylline-labs/eris
```

Expect: `eris` followed by a version.

## 3. Connect Linear (your user, in a browser)

Stop here. Ask your user to open https://dash.sibylline.group, choose **Sign in with Linear**,
and install the **Yaks** app into their Linear workspace when prompted. A Linear admin
does this once per workspace. Wait until they confirm.

## 4. Sign in your CLI (your user, in a browser)

Run the command below. It prints a link to dash and a short code, then waits up to 10 minutes.
Ask your user to open the link, check it shows the same code, and approve. eris writes the token
to `~/.eris/yaks.json` itself: never ask your user for a token or to paste one into this chat.

```sh
eris login --url https://api.sibylline.group
```

Expect: `logged in: token "…" written to ~/.eris/yaks.json`

The person who approves must be a Linear admin of the workspace: step 5 sets the org's
destination, which only an admin may do.

On a CI runner with no person to approve, your user mints a service token under
**Settings → API Tokens** in dash and sets `ERIS_YAKS_TOKEN` and `ERIS_YAKS_URL` instead. A
service token can file yaks but cannot set the destination, so do step 5 from a signed-in
machine first.

## 5. Configure the destination

An org with no destination accepts yaks and parks them: nothing reaches Linear until a team
is set. Check, and set one if needed:

```sh
eris yak status
```

Expect: `configured: yes`. If it says `configured: no`, list the teams, ask your user which
one yaks should land in (suggest one if they have no preference), and set it. A state is
optional: the team's Triage state is marked `(default)` in `discover states`.

```sh
eris yak discover teams
eris yak config set --team <KEY> --state Triage
eris yak status
```

Expect: `configured: yes`. Add `--project <name>` or `--labels <name,...>` if your user
wants them. `eris yak discover --team <KEY>` lists the names. A `yak-admin-required` block
means the login is not an admin's: ask a Linear admin to approve a fresh `eris login`, or to
set the destination at https://dash.sibylline.group/yak/config.

## 6. Send a test yak

Send one yak to prove the whole path works. A delivered yak prints `recorded: <id>`. Ask your
user to check their Linear Triage for the new `[Yak]` issue.

A `WARN` line means something needs fixing. The command still exits 0, because a yak never
fails the task that filed it. The slug on that line names what to fix: `yak-parked-unconfigured`
means the yak was stored but has no destination (go back to step 5); most other slugs mean the
yak wasn't delivered, usually because of the sign-in from step 4: run `eris login` again.

```sh
eris yak suggest --summary "First yak from this repo" --body "Testing the Yaks pipeline end to end."
```

Expect: `recorded: <id>`

## 7. Teach every session to file

Add this block to the repo's `AGENTS.md` (and `CLAUDE.md` if the repo has one), or to your
user's global agent instructions, so that every future session knows when to file. Show your
user the diff.

```markdown
## Yaks

When the tooling fights back, file a yak and keep working. A yak is a side channel: it never blocks the task.

- `eris yak issue`: something in the harness is wrong (a hook blocks a legal edit, a doc names a flag that doesn't exist, a command fails silently).
- `eris yak suggest`: something could be better, and nothing has to be broken (a flag, skill or rule you wished existed; a workaround you've hand-rolled more than once).
- `eris yak fatal`: the tooling broke and the task already stopped.

Each takes `--summary "<one line>"` and `--body "<what happened, what you expected>"`; add `--repro "<command>"` when one shows it. Filing is deduplicated, so a repeat adds weight to an existing issue. File in the turn you notice.
```

## Done

Tell your user what you set up, and that friction you hit from now on will appear in their
Linear Triage as `[Yak]` issues.

Reference: `eris yak --help` · [docs/YAK.md](https://github.com/sibylline-labs/eris/blob/main/docs/YAK.md) ·
https://github.com/sibylline-labs/eris · support@sibylline.group
