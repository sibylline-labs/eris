# Eris documentation

Start with the [repo README](../README.md) for install and quickstart; come here for the deep references.

## Start here

| Doc | What it covers |
|-----|----------------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The current-state map: the shim, the router and registry, plugin composition, and the constraints every change must survive |
| [OUTPUT-CONTRACT.md](OUTPUT-CONTRACT.md) | What eris guarantees to a **program**: the stdout/stderr split, exit codes, `--output text\|json`, the machine surfaces and their shapes, and the parseable failure block |
| [ERRORS.md](ERRORS.md) | Every error slug eris raises, with its fix |

## Command references

| Doc | Commands | One-liner |
|-----|----------|-----------|
| [YAK.md](YAK.md) | `eris yak …` | Land a durable, deduplicated observation with a Yaks endpoint |
| [COMPLETION.md](COMPLETION.md) | `eris completion bash\|zsh` | Shell tab completion: install and the derived command tree |
| [UPDATE.md](UPDATE.md) | `eris --version`, `eris update` | Which build this is, and replacing a binary with the newest release after checking it |

## Developing Eris

| Doc | What it covers |
|-----|----------------|
| [dev/DEVELOPMENT.md](dev/DEVELOPMENT.md) | Codebase layout, the shim → router → handler path, conventions |
| [dev/LAYOUT.md](dev/LAYOUT.md) | The annotated source tree |
| [dev/TESTING.md](dev/TESTING.md) | The `bun test` suite: layout, fixtures and goldens, loopback servers, writing new tests |
| [dev/ADDING-A-COMMAND.md](dev/ADDING-A-COMMAND.md) | Walkthrough: a new subcommand or command group, end to end |
| [dev/PLUGINS.md](dev/PLUGINS.md) | Writing a plugin: a verb group as rows plus handlers, composed at build time |
| [dev/RELEASING.md](dev/RELEASING.md) | Cutting a release: the tag, the workflow, the assets, the Homebrew tap |
