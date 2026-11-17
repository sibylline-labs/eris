# The gates client seam

Every eris verb that reads or writes an organisation's hosted gate state goes through one seam: a
typed client for the hosted gates API in `packages/gates-contract` (`eris/gates-contract`). This page
is its design. It fixes what the client owns, what stays in the verbs, where tracker writes happen,
and the order the gate verbs move onto it.

## What the seam owns

| Concern | Rule |
|---|---|
| Credential | The `eris login` bearer for the org the directory acts as, resolved by the SDK's `resolveOrgBearer` (`ERIS_ORG`, else `repo.org` in the nearest `eris.yaml`, else the default org). The verb resolves it; the client takes `{ url, token }` and never reads a file or the environment. |
| Origin | `gatesEndpoint(url, token)` refuses any URL that is not `https:`, or `http:` on `localhost`, `127.0.0.1` or `[::1]` (`login-url-refused`), before a client exists. The bearer never crosses a cleartext link. |
| Transport | Plain `fetch` (injectable for tests), one attempt, a deadline over the whole exchange (20 s), a reply cap (1 MiB for the policy routes). No retry inside the client; a retry is the verb's decision. |
| Decoding | A reply body is `unknown` until it decodes through its Effect Schema. A body that does not decode is `gate-contract-mismatch`; nothing undecoded reaches a verb. |
| Trust | A bundle is trusted only when the client's own `computeGatesBundleSha` over the decoded values equals the server's `bundle_sha`. |
| Failures | The client returns `Outcome<A>`: a value, or a `ContractFailure` (slug, what, fix, docs, exit). It never throws, prints or exits; the verb renders the failure block. |

The failure map, by what the gateway answered:

| Answer | Slug |
|---|---|
| no answer within the deadline, or a network error | `gate-store-unreachable` |
| HTTP 401 | `eris-login-required` |
| HTTP 402 or 403 | `gate-store-forbidden` |
| HTTP 5xx | `gate-store-unreachable` |
| any other status, a body that does not decode, a reply over the cap, or a `bundle_sha` the values do not hash to | `gate-contract-mismatch` |
| `/policy` and `/settings` name different `bundle_sha`s twice running | `gate-store-unreachable` |
| a receipt route: HTTP 409 `doctrine_out_of_date` (the org's staleness is `hard`) | `doctrine-out-of-date` |
| a receipt route: HTTP 404 `issue_not_found` | `linear-issue-not-found` |
| `PUT /v1/gates/policy`: HTTP 403 or 405 | `doctrine-push-refused` |
| `PUT /v1/gates/policy`: HTTP 409 | `doctrine-push-stale` |
| `PUT /v1/gates/policy`: HTTP 400, 413 or 422 | `doctrine-push-invalid` |
| a receipt, asset or artifact route: HTTP 429 (the failure carries `retryAfterMs` from `Retry-After`) | `linear-rate-limited` |
| the asks route: 402/403, no answer or 5xx, 429, anything else | `asks-store-forbidden`, `asks-store-unreachable`, `asks-rate-limited`, `asks-contract-mismatch` |

## Routes

| Route | Verb | Status |
|---|---|---|
| `GET /v1/gates/policy`, `GET /v1/gates/settings` | `doctrine pull`, `gate ci` | served |
| `GET /v1/gates/receipts?issue=` | `gate check`, `gate ci`, `surface digest` | served |
| `POST /v1/gates/receipts` | `gate record`, `gate skip`, `surface lock\|unlock` | served |
| `POST /v1/gates/assets`, `GET /v1/gates/assets/digest`, `GET /v1/gates/artifacts/<sha256>` | `gate record`, `gate check` | served |
| `GET /v1/asks?issue=&state=open&blocking=true` | `gate check` (the `@asks` row of a terminal gate) | served |
| `PUT /v1/gates/policy` | `doctrine push` | served |
| `GET\|POST /v1/gates/doctrine-comments` | `doctrine set` | served |

A route is added to the client in the slice whose verb first calls it, with its reply Schema
vendored into `packages/gates-contract` beside the bundle contract.

The receipt routes carry the pulled bundle's sha as `x-eris-policy-sha`; a reply marked
`x-gates-policy-stale: soft` is a WARN naming `eris doctrine pull`, and `hard` refuses the write. A
listing's rows decode leniently: a key the contract does not name is ignored, so the server may add
fields. A 429 is returned with its `Retry-After`; the client never retries, and a verb that retries
reuses the same comment id, which the gateway dedupes on.

What the public `gate` verbs do not judge fails closed rather than passing: a receipt whose evidence
is a review report reads `blocking` (judging one needs a distribution's registered review skills),
and an issue carrying a `remediate` receipt prints `@remediate unsupported` and fails.

## Tracker writes happen server-side

eris never holds a tracker credential. A receipt, a doctrine comment or an issue transition is a
request to the gateway, which writes the tracker with the org's own connection. One host, one bearer:
the seam has no second credential to resolve, leak or rotate, and a verb's output never depends on a
tracker API's shape. A verb that needs tracker state reads it back through a gateway route, never
from the tracker directly.

## Where the code lives

| Piece | Location | Why |
|---|---|---|
| Wire contract (bundle, settings, replies, `bundle_sha`) | `packages/gates-contract/src/bundle.ts` | data and pure functions; another tool reads it without eris |
| Client (`gatesEndpoint`, one function per route) | `packages/gates-contract/src/client.ts` | `fetch` and decode only, no CLI runtime |
| The org's pulled tree on disk (`~/.eris/doctrine/<orgId>/`) | `plugins/doctrine/org-tree.ts` | file I/O belongs to the verbs |
| Verbs | the plugin that owns the group (`plugins/doctrine/`, then a `gate` plugin, ...) | rows plus lazy handlers, through the SDK |

A plugin imports the client from `eris/gates-contract` and the credential from the plugin SDK
(`src/cli/plugin.ts`). Nothing under `packages/` imports a private package: the public
`package.json` names no private dependency: only this repo's own workspace packages and public npm
packages.

## The pulled tree

`eris doctrine pull` writes the org's bundle as files, so the offline verbs read the same doctrine the
gateway enforces:

```
~/.eris/doctrine/<orgId>            -> .<orgId>.<bundle_sha>.<pid>.<hex>/   (a symlink)
~/.eris/doctrine/.<orgId>.<...>/manifest.json   { contract, org, bundle_sha, settings, files, pulled_at }
                               doctrine.md profiles.yaml loops/<slug>.md
```

- The tree is written to a staging directory, read back and verified (every file's sha256 against the
  manifest, then the bundle the files decode to re-hashed to the manifest's `bundle_sha`), and only
  then swapped in with one `rename` of the symlink. A reader sees the old tree or the new one.
- Every verb that reads the tree verifies it first; an edited tree fails `doctrine-local-modified`.
- The file bytes are a contract of their own: any eris build that pulls the same bundle writes the
  same files, so builds on one machine share one tree.

## Slice order

Each slice is one pull request with zero private dependencies and a passing scrub check.

1. `doctrine pull`, `doctrine path`: the seam, the bundle contract, the tree.
2. `gate record`, `gate check`, `gate skip`: the receipt contract (v2/v3) and the records reply;
   `check` and `gates` default to the pulled tree; `eris login` pulls after signing in.
3. `gate ci`: the required pull-request check, on a GET-only fetch so it cannot write.
4. `surface lock`, `surface unlock`, `surface digest`.
5. `loop`: launch, policy and hand-back.
6. `doctrine push`, `doctrine set`.

A distribution that carries its own copy of a ported verb deletes that copy once it consumes the
public one from `eris/sdk` and `eris/gates-contract`, so each verb has one implementation.
