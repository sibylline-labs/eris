# eris-fail fixtures

`report-templates.json` holds what the Bash implementation's `eris::report` printed for
every slug documented in `docs/ERRORS.md` (293 at capture), crossed with the five
argument variants in `tests/eris-fail-golden.test.ts`. It is FROZEN: the Bash
implementation is not part of this repository, and the TypeScript failure block
(`ts/lib/eris-fail.ts`) is held to what it printed.

**Every slug rendered the same block for a variant**, up to the slug itself and the
checkout path. The capture checked this and refused to write the file on any deviation.
So each variant is stored as one template with `<SLUG>` and `<ERIS>` placeholders, and the
test applies it to whatever slugs `docs/ERRORS.md` documents today. A slug added after
the capture is still checked.

**Provenance.** The file was captured from the last version of the Bash `eris::report`
before the port replaced it, run by the `bash` first on PATH (Homebrew bash 5 on macOS).
The capture ran one bash process over every slug × variant, with the failure-block
library sourced:

```
while IFS= read -r -d '' n; do args=(); for ((i = 0; i < n; i++)); do IFS= read -r -d '' a; args+=("$a"); done
  eris::report "${args[@]}" || true; printf '\036' >&2; done
```

It ran with only `PATH` and `ERIS_DIR=<checkout>` in the environment. Each block's slug
was replaced with `<SLUG>` and the checkout with `<ERIS>`. The file cannot be regenerated
from this repository; a change to the block is a change to the contract
(`docs/OUTPUT-CONTRACT.md` §4).
