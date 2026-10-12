# Adding a command to Eris

A new subcommand of an existing group, or a new group. Every new verb is
TypeScript. Read [DEVELOPMENT.md](DEVELOPMENT.md) first. A group that belongs to
a product rather than to core is a plugin instead: [PLUGINS.md](PLUGINS.md).

## A subcommand of an existing core group

`completion` is the reference: its dispatcher is `src/cli/commands/completion.ts`
and each shell is one file under `src/cli/commands/completion/`. Say you are
adding `eris completion fish`:

1. **Handler.** Create `src/cli/commands/completion/fish.ts`, and route to it
   from the dispatcher's `groupArgs("completion", args)` switch.

2. **Register it.** A `"completion fish": { summary, flags, pos, usage }` row in
   `src/cli/registry.ts`. The handler reads its argv with
   `readVerbArgs("completion fish", args, ctx, { help: USAGE })`
   (`src/cli/args.ts`): the result's `flags` and `pos` are typed from the row, so
   a flag the row does not declare can be neither passed nor read. The router
   table, the `--output json` allow-list and the completion tree derive from the
   row with no further edit (`tests/cli-router.test.ts` pins the derived table).
   A positional with a completable domain gets a `SLOTS` entry in
   `src/cli/commands/completion/emit.ts`.

3. **Output.** Payload on stdout, every diagnostic on stderr
   ([OUTPUT-CONTRACT.md](../OUTPUT-CONTRACT.md)). A machine rendering means
   `json: true` on the registry row and a line in the refusal's fix text
   (`UNSUPPORTED_FIX_SURFACES`, `src/cli/output.ts`); never a per-command
   `--json`. A machine surface is pinned in `tests/output-contract.test.ts` and
   listed in the contract's surface table.

4. **Safety.**
   - A failure is a slugged block (`renderFailureBlock`, `ts/lib/eris-fail.ts`),
     and every slug gets a `docs/ERRORS.md` heading (`tests/errors-doc.test.ts`).
   - A subprocess goes through the runner in `src/runtime/process.ts` with a
     deadline. Nothing is backgrounded; fan-out is bounded.
   - A command a CI job runs completes without an answer.

5. **Tests.** A red-first `bun test` file under `tests/`: the handler with
   injected deps for logic, and a black-box run through `tests/helpers/blackbox.ts`
   for the CLI surface ([TESTING.md](TESTING.md)).

6. **Verify and document.**

   ```bash
   bunx tsc --noEmit && bun test ./tests
   ./eris completion fish   # run it and read its real output
   ```

   Update the group's doc under `docs/`.

## A new core group

1. **Dispatcher** `src/cli/commands/<group>.ts`: the group usage, the sub switch
   over `groupArgs("<group>", args)` (`bare` and `help` print usage on stdout and
   exit 0), and an `Unknown <group> command: <x>` failure. One file per sub at
   `src/cli/commands/<group>/<sub>.ts`, each reading its argv with `readVerbArgs`.

2. **Register it.**
   - A `<group>: { impl: "ts", summary }` row and one row per sub in
     `src/cli/registry.ts`.
   - A lazily imported entry in `HANDLERS` (`src/main.ts`);
     `tests/cli-registry.test.ts` fails for a `ts` group without one.
   - A line in `COMMANDS` (`src/cli/commands/usage.ts`), the top-level help. Its
     `--output` paragraph is derived from the json rows.

3. **Tests and docs.** Steps 3–6 above apply per sub. Add `docs/<GROUP>.md` and an
   entry in [docs/README.md](../README.md).

## Checklist

- [ ] Registry rows (group and every sub, flags exact) and a `HANDLERS` entry
- [ ] Lazy imports: `--help` works anywhere, with nothing configured
- [ ] stdout carries only the payload; every failure is a slugged block with an `ERRORS.md` heading and nothing on stdout
- [ ] A non-prompting path if CI-facing
- [ ] Nothing backgrounded; any fan-out bounded
- [ ] Red-first `bun test` coverage at the CLI seam; no network
- [ ] `bunx tsc --noEmit` and `bun test ./tests` green
