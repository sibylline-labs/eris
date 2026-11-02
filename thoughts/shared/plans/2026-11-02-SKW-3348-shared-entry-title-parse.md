# SKW-3348: one shared entry-title parse for render and applyOps

## Overview

In `packages/socrates-core`, `checkEntry` (`src/doc-surgery.ts`) stops running `parseTitle` over the whole
`` `<id>` <title> `` bullet text and instead calls a new exported `parseEntryTitleLine`, which strips the
readable entry-ID handle and runs `parseTitle` on the bare title; `renderDocEntry` (`src/render.ts`) builds
the line with the matching exported `entryTitleLine`, and `checkTitle` delegates to `parseTitle`, so render,
`applyOps` and Olympus submit (SKW-2544) apply one rule.

- **the rule:** `parseTitle` on the bare title: non-empty after trim, one line, `<= ENTRY_TITLE_MAX_LENGTH` (80),
  nothing Linear autolinks. Olympus `validateCandidateTitle` (SKW-2544) runs exactly this on the bare title,
  importing `parseTitle` and `ENTRY_TITLE_MAX_LENGTH` from `eris/socrates-core`; both stay exported by name.
- **handle:** the readable entry ID (`` `SAAS-D10` ``) `renderDocEntry` prepends; a hash handle is a `hash:`
  field and never in the title line.

## Current State Analysis

- `doc-surgery.ts:133` `MAX_TITLE_LEN = 80`; `render.ts:85` `ENTRY_TITLE_MAX_LENGTH = 80`: two constants.
- `doc-surgery.ts:311` `parseTitle(titleLine.slice(2))` measures `` `SAAS-D10` <title> ``.
- `render.ts:113-116` validates the bare title, then prepends `` `<id>` `` (`render.ts:114`).
- `render.ts:194-203` `checkTitle` checks line breaks and length only, not autolinking, so a title naming
  `payload.source` renders and is then refused by `applyOps` (`autolinkable`).
- Observed red on `origin/main` (`8179f16`): `renderDecision` with an 80-char title and handle `SAAS-D10`
  renders a 93-char line; `applyOps` append returns
  `{"ok":false,"refusal":{"kind":"bad-title","reason":"too-long",...}}`.
- Baseline (no `ci.local` in `eris.yaml`): `bun test tests/socrates-core-*.test.ts tests/socrates.test.ts`
  143 pass / 0 fail; `packages/socrates-core` typecheck clean. Full `bun test`: 1 pre-existing fail
  (`a distribution run from source > typechecks ...`), from 3 TS errors in `src/runtime/process.ts:225,230`
  that root `bunx tsc --noEmit` also prints. Neither file is touched here.

## Desired End State

- Any title `parseTitle` accepts, rendered by `renderDecision`/`renderPractice` with any valid handle, passes
  `applyOps` (`append_entry` and `supersede_entry`).
- Any title `parseTitle` refuses makes `renderDecision`/`renderPractice`/`renderConflictEntry`/`renderPrdEntry`
  throw `EntryRenderError`; nothing renders that `applyOps` or Olympus submit would refuse.
- One length constant (`ENTRY_TITLE_MAX_LENGTH`, declared in `doc-surgery.ts`, re-exported from `render.ts`).

### Key Discoveries:
- `render.ts` and `doc-surgery.ts` import nothing, so `render.ts` importing from `doc-surgery.ts` adds no cycle.
- `index.ts` re-exports `* from "./render"` and `parseTitle` by name from `./doc-surgery`; Olympus imports both
  `parseTitle` and `ENTRY_TITLE_MAX_LENGTH` from the package root.
- Handle shape: `checkHandle` (`render.ts:206`) `^[A-Z][A-Z0-9]*-[A-Z]+[1-9][0-9]*$`.
- `EntryRenderReason` is consumed only by `tests/socrates-core-render.test.ts`.

## What We're NOT Doing

| Out of scope | Why | Destination |
|---|---|---|
| Olympus `eris` pin bump so resolve picks the fix up | separate repo; the SKW-2544 loop owns the submit side | noted on SKW-3081 by the SKW-2544 loop (peer message Nov-02) |
| Pre-existing `src/runtime/process.ts` TS errors / distribution-typecheck fail | inherited, unrelated to socrates-core | yak `01M6EG8YK32HJN22QDAV19YA8D` |
| Shortening the SKW-3318 over-long titles | SKW-2544 scope | SKW-2544 |

## Implementation Approach

Move the rule to the one module that mints `Title` and make render consume it: a `Title` brand on the input of
`entryTitleLine` puts "render never emits an unparsed title" on the type rung, and `parseEntryTitleLine` is the
only reader of a title line.

## Invariants and Their Rung

| Invariant | Rung | Artifact | Why not higher |
|---|---|---|---|
| The title line render writes and `checkEntry` reads go through one parse/format pair | arch | `parseEntryTitleLine` + `entryTitleLine` in `doc-surgery.ts`; `checkEntry` and `renderDocEntry` call them; `MAX_TITLE_LEN` deleted, `render.ts` has no limit of its own | — (highest rung) |
| Render only emits a title `parseTitle` minted | type | `entryTitleLine(handleId: string \| null, title: Title)` takes the `Title` brand only `parseTitle` mints | — |
| A rendered doc entry with any accepted title and any handle passes `applyOps` | test | `tests/socrates-core-doc-surgery.test.ts` round-trip over 80/1-char titles × `SAAS-D10`, `ACME-BILL-D123`-style and hash handles, `append_entry` + `supersede_entry` | the bytes of a rendered string are invisible to the checker |
| Render refuses what `parseTitle` refuses (incl. autolinkable) | test | `tests/socrates-core-render.test.ts` reason table gains `title-autolinkable` | the refusal is a runtime value |

Red first: the AC round-trip test fails on `origin/main` with `bad-title` / `too-long` (observed above); the
autolinkable render case fails on main because `renderDecision` returns a string instead of throwing.

## Hera primitive map (eris, eris-internal, olympus)

Every function here is `pure` (string parsing in a dependency-free package); no Hera primitive applies. A
pre-Hera sibling is not precedent, and none is cited.

| Function | Primitive | Reference |
|---|---|---|
| `parseEntryTitleLine` (new) | pure | `parseTitle` (`doc-surgery.ts:179`) |
| `entryTitleLine` (new) | pure | — |
| `checkEntry` (changed) | pure | — |
| `renderDocEntry`, `checkTitle`, `checkHandle` (changed) | pure | — |

## Phase 1: shared parse

### Changes Required:

#### 1. `packages/socrates-core/src/doc-surgery.ts`
- Rename `MAX_TITLE_LEN` to exported `ENTRY_TITLE_MAX_LENGTH = 80`; `parseTitle` uses it.
- Export `ENTRY_HANDLE_ID = "[A-Z][A-Z0-9]*-[A-Z]+[1-9][0-9]*"`.
- Export `entryTitleLine(handleId: string | null, title: Title): string` → `` - `<id>` <title> `` or `- <title>`.
- Export `parseEntryTitleLine(text: string): { ok: true; handleId: string | null; title: Title } | Refused`:
  `text` is the bullet text after the marker; a leading `` `<ENTRY_HANDLE_ID>` `` plus whitespace is stripped,
  then `parseTitle` runs on the rest.
- `checkEntry`: `parseEntryTitleLine(titleLine.slice(2))`.

#### 2. `packages/socrates-core/src/render.ts`
- Import the four names; re-export `ENTRY_TITLE_MAX_LENGTH`; delete the local constant.
- `checkTitle` returns `Title`: keep the `LINE_BREAK` pre-check (`title-multiline`, it covers U+2028/9), then
  `parseTitle`; map `empty`/`too-long` → `title-too-long`, `multi-line` → `title-multiline`,
  `autolinkable` → new `title-autolinkable`.
- `checkHandle` uses `ENTRY_HANDLE_ID`; `renderDocEntry` uses `entryTitleLine`.
- `renderPrdEntry`/`renderConflictEntry` keep `checkTitle` (now `parseTitle`), matching submit's all-kind check.

#### 3. `packages/socrates-core/src/index.ts`
- Export `parseEntryTitleLine`, `entryTitleLine`, `ENTRY_HANDLE_ID` by name from `./doc-surgery`.

### Success Criteria:

#### Automated Verification:
- [ ] `bun test tests/socrates-core-*.test.ts tests/socrates.test.ts` all pass, including the new cases.
- [ ] `cd packages/socrates-core && bun run typecheck` clean.
- [ ] Full `bun test`: only the pre-existing distribution-typecheck fail remains.
- [ ] `rg -n 'MAX_TITLE_LEN|= 80' packages/socrates-core/src` → only `ENTRY_TITLE_MAX_LENGTH = 80` in `doc-surgery.ts`.

#### Manual Verification:
- [ ] The repro one-liner from Current State returns `ok: true`.

## Testing Strategy

### Unit Tests:
- AC: `renderDecision`/`renderPractice` with an 80-char title and `handle: { id: "SAAS-D10" }` passes
  `applyOps` `append_entry`; also `supersede_entry`, a long multi-segment-free handle (`ABCDEFGH-D999`), and
  a hash handle.
- 81-char title still refused by render (`title-too-long`) and by `applyOps` when hand-written.
- `parseEntryTitleLine`: handle stripped and returned; no handle → `handleId: null`; a backticked non-handle
  word (`` `foo` bar ``) is not stripped and counts toward the length.
- Render throws `title-autolinkable` for `"Adopt payload.source"`; backticked `` `payload.source` `` passes.

### Integration Tests:
- n/a: no I/O in this package; `writeDoc` tests already cover the port path over `applyOps`.

## Performance Considerations

None: one extra regex per entry.

## Migration Notes

None. Existing doc entries are unchanged; titles that previously rendered but were refused at `applyOps` for
autolinking now fail earlier at render with `title-autolinkable`.

## References

- SKW-3348; related SKW-2544 (Olympus submit rule), SKW-3081 (blocked).
- `packages/socrates-core/src/doc-surgery.ts:133,179-187,305-316`; `src/render.ts:85,108-122,194-216`.
