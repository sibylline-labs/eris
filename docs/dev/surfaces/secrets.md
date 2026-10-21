# Secrets surface: pattern-class vocabulary

Repo-local addendum for the `secrets` surface registered in `.claude/surfaces.yml`:
the yak redaction pass (`plugins/yak/yak-redact.ts`), its call site
(`plugins/yak/yak-submit.ts`) and its tests (`tests/yak-redact.test.ts`). Format
per the universal class core; class IDs use the prefix `S`.

Seeded by hand from failure modes the pass's own header and tests already record,
not from an audit run. Extend it when an audit of this surface names a new class.

Tests are cited by a substring of their title, so `rg -F '<substring>' tests/yak-redact.test.ts`
finds them.

## S1: Pass-ordering shadowing

**Shape:** a class whose pattern can match a run *inside* another class's token runs
before that token's own class, so the inner class replaces only the embedded run.
Triggered by adding a pass, or moving one, in the fixed pipeline order.

**Why it kills:** the token's head survives in plaintext next to a `«redacted:…»`
marker, so the output looks handled while a live credential prefix ships. A token's
secret is base64url, so it can contain `-sk-`, `ghp_` and other shapes by chance.

**Concrete fingerprint:** a `sib_` secret containing an `sk-key` run comes out as
`sib_<orgId>_<head>-«redacted:sk-key»` instead of one `«redacted:sib-token»`. The
mirror case: an earlier pass whose run is wider than its token swallows the anchor of
text glued after it (`<token>Authorization: Basic <cred>` gives
`«redacted:sib-token»: Basic <cred>`), so the later pass never fires.

**Typical severity:** High. Critical when the surviving head carries the org id and a
usable secret prefix.

**Check mode:** hybrid. Deterministic for known instances: `embeds another class's shape`
(the `sib-token` over `sk-key` and `github-token` case) and
`classified once as sib-token, not as assignment` (a broader `assignment` claiming first),
and `the glued-on text is left to the later passes` (the mirror case).
LLM for a new or moved pass: could its pattern match inside another class's token alphabet?
A new pass needs a test where a longer token embeds its shape.

## S2: Partial-match plaintext tail

**Shape:** a bounded value capture (`{1,N}`, a fixed-length token body, an anchored
length) shorter than the real secret, so the match ends mid-secret.

**Why it kills:** the first N characters become the marker and the remainder follows it
in plaintext. That is worse than no redaction because the output looks handled. The
bound is an input property the author does not control: the evidence field runs to
20,000 chars, and issuers lengthen secrets. Widening is right only where the issuer's
length is not fixed: `sib_` secrets are exactly 43 characters, so `SIB_TOKEN_RE` pins 43
and leaves anything glued on to the later passes (S1).

**Concrete fingerprint:** `«redacted:assignment»` directly followed by the rest of a
secret. A later pass that would have consumed that tail can hide it again by declining the run
because it starts with a marker (S3): `Authorization: Bearer «redacted:sk-key»<tail>`.

**Typical severity:** High. Critical when the tail is most of the secret.

**Check mode:** deterministic. `no plaintext run of the secret survives, even at 10,000 chars`,
and `fully consumes a long JSON-quoted value` assert that no
slice of the secret survives past the old bound. Its counterweight is
`does not swallow the closing brace or a following key`: widening a capture must not eat
the next JSON key. `runs on past an earlier class's marker` (auth-header and assignment) and
`is an earlier class's marker, alone or with a tail` (conn-string) assert that a later pass
still consumes a tail left after a marker.

## S3: Marker re-match and double count

**Shape:** a later pass treats an earlier pass's `«redacted:<class>»` marker as its own
value, typically a quoted value under a governed name such as `"api_key": "«redacted:sk-key»"`.
The fix is a guard in a pass that takes an arbitrary run as its value. A pass may decline
only where declining leaves nothing but the marker and text that cannot be secret.
`assignment` declines a value that is exactly one marker, bare or alone in quotes.
`auth-header` declines an exact marker after a known scheme word. `conn-string` never
declines: its scheme and host runs take whatever is pasted against them. A guard that
declines any value that merely starts with a marker reintroduces S2, because whatever
follows the marker in that run ships in plaintext. Redacting that run whole has its own
failure: with no whitespace in between, the run swallows the name of the next
assignment, and that assignment's value ships. `assignment` therefore redacts both
readings. Prefer over-redaction and a double count to either leak.

**Why it kills:** no plaintext leaks, but the marker is reclassified (here as the generic
`assignment`) and counted twice. The class counts in the stderr summary line become wrong,
and `redact()` stops being idempotent, so redacting already-redacted text changes it.

**Concrete fingerprint:** a secret redacted as the generic `assignment` instead of its own
class (`"api_key": "«redacted:sk-key»"` comes back as `«redacted:assignment»`), or a second
`redact()` call that reports a nonzero total.

**Typical severity:** Medium. Low when only the summary line is affected.

**Check mode:** deterministic. `the marker itself is never re-matched` (every class's
marker, in each position a guard covers), `redacting twice equals redacting once`, and
`not re-redacted and reclassified as 'assignment'` pin the decline. The S2 tests named
`runs on past an earlier class's marker`, `is an earlier class's marker, alone or with a tail`
and `runs straight into another assignment` pin its limits.
