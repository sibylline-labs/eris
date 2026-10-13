# Shell Tab Completion

`eris completion` emits tab-completion scripts for bash and zsh (the
`kubectl completion` pattern): command groups, verbs, flags, and file names
after a file-valued flag.

```
eris <TAB>                      # command groups
eris yak <TAB>                  # yak verbs
eris yak issue --<TAB>          # --summary --body --body-file ...
eris yak issue --body-file <TAB>     # file names
```

## Install

```bash
# bash — current shell only
source <(eris completion bash)
# bash — every shell
echo 'source <(eris completion bash)' >> ~/.bashrc

# zsh — current shell only
source <(eris completion zsh)
# zsh — every shell
echo 'source <(eris completion zsh)' >> ~/.zshrc
```

Sourcing via process substitution is the recommended route: the emitted
script embeds a snapshot of the command tree derived from the installed eris
source, so regenerating at shell startup keeps completion in lock-step with
upgrades. If you prefer a static file (marginally faster shell startup),
save the output and re-emit after upgrading eris:

```bash
eris completion bash > ~/.eris/completion.bash
echo 'source ~/.eris/completion.bash' >> ~/.bashrc
```

Completion registers for the command name `eris`. If you invoke a checkout
directly as `./eris`, add `complete -F _eris_completions ./eris` after
sourcing.

## How it works

**Static tree — generated from the verb registry.** `eris completion` is a
TypeScript verb (`src/cli/commands/completion/`). At emission time
`emit.ts` reads the composed registry (core's `src/cli/registry.ts` plus the
build's plugins) and generates the groups, each group's subs, nested subs,
and the long flags of every command path. A row added to the registry, or
declared by a plugin, completes with no other edit.

- **Flags are per command path.** `eris yak issue --<TAB>` offers exactly the
  flags `yak issue` accepts. Before a verb is typed (`eris yak --<TAB>`), or
  after a verb the registry does not know, the group's whole set is offered.
  `--help` is always offered, and `eris <TAB>` offers `--help` and `--version` beside the groups.
- **Value-taking flags come from the registry too** (`takesValue`): the word
  after one is never completed as a positional and never counted as one.
  A value flag whose row says `file: true` completes file names: yak's
  `--body-file` and `--evidence-file`. A plugin declares its own the same way.
- **Positional slots are on the row** (`complete`, one entry per slot): literal
  words, `@file` for file names, or a completion domain, whose words only a
  shell function can list at tab-press time. A domain's helper and library texts are
  emitted once and its function is called with the words typed in the earlier slots
  ([PLUGINS.md](dev/PLUGINS.md#completion-domains)). A row with no `complete`
  completes no positionals.

Emission imports the registry and nothing else. It runs on every shell start,
so no other verb's source is on its path: a file mid-edit elsewhere in eris
cannot break a login shell. Emission itself needs no `yq`.

**A tab press never invokes eris and never touches the network.** It reads
only the tree embedded in the script, and offers nothing rather than erroring:
a tab press must never print to stderr or hang. A domain's helper is held to
the same: each helper and library text must be exactly one function definition
in a subset of shell that bash and zsh frame alike, so sourcing the script
defines it and runs nothing; composition refuses anything else
(`src/cli/commands/completion/domain.ts`).

## zsh route

zsh loads the identical completion body through `bashcompinit` (the engine
sets the `ksharrays` localoption so `COMP_WORDS` indexing matches bash).
One body for both shells was chosen over a native `_eris` because it halves
the maintenance surface and the grammar (two-level verbs + positional
domains) gains little from zsh's `_arguments` machinery. The wrapper runs
`compinit` only when `compdef` is not already defined, so it composes with
existing `.zshrc` setups.

## Compatibility

The emitted script is bash-3.2-clean (macOS `/bin/bash`): no associative
arrays, no `mapfile`, no `${var,,}`. `eris completion bash` itself runs under
a 3.2 `/bin/bash` too, because the shim is 3.2-clean and hands the verb to
bun. `tests/completion.test.ts`
checks the scripts with `/bin/bash -n` and `zsh -n`, drives `_eris_completions`
with COMP_WORDS under `/bin/bash` (and the zsh route through a real
`compinit` + `bashcompinit`), and asserts that a tab press runs neither eris
nor a network client.

If your shell rc caches the emitted script and re-emits when eris changes,
watch `src/` and `plugins/`: the command tree comes from the composed registry.

## Troubleshooting

- **New verbs missing after an upgrade** — you saved a static file instead
  of sourcing via process substitution; re-run `eris completion <shell>`.
