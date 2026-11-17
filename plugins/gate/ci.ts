/**
 * ci.ts — the pure core of `eris gate ci`: one required check driven by the org's hosted policy and
 * settings, never by a local doctrine file.
 *
 *   - `PullRequestEvent`: the five fields of GitHub's `pull_request` event the check reads, decoded
 *     strictly (extra keys allowed), so a malformed event fails closed (`gate-ci-event-invalid`).
 *   - `issueKeyFrom`: the PR's issue key, from the head ref first, then the title.
 *   - `decideCi`: the route. A key runs the ticketed legs (profile when `check_profile_in_ci: on`,
 *     monotone, unlock); no key and an allowlisted author, or `untracked_prs: warn|allow`, runs only
 *     the surfaces leg (no registered surface may change untracked); no key under `block` fails
 *     `gate-issue-missing`.
 *   - `postureFromBundle`: the hosted bundle's doctrine, read as `readDoctrine` reads a file.
 *   - `getOnlyFetch`: the fetch the verb's one gateway endpoint is built on; a non-GET is refused
 *     before the network and reported to the caller, so the verb cannot write whatever the client exposes.
 */

import * as Schema from "effect/Schema";
import { decodeResult, type DoctrineRead, type GatesCiSettings, type GatesOrgBundle, readDoctrine, renderBundle } from "eris/gates-contract";
import { block, precondition } from "./failure";

const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/i, { expected: "a full 40-hex commit sha" }));

/** The `pull_request` event fields `gate ci` reads; every other key is allowed and ignored. */
export const PullRequestEvent = Schema.Struct({
  pull_request: Schema.Struct({
    title: Schema.String,
    head: Schema.Struct({ ref: Schema.String, sha: Sha }),
    base: Schema.Struct({ sha: Sha }),
    user: Schema.Struct({ login: Schema.String }),
  }),
});
export type PullRequestEvent = typeof PullRequestEvent.Type;

/** Stop with `gate-ci-event-invalid` naming `what`. */
export function eventInvalid(what: string): never {
  return precondition("gate-ci-event-invalid", what, 'Run gate ci on a pull_request event: --event "$GITHUB_EVENT_PATH" from a workflow triggered by pull_request.');
}

/** The event file's text, decoded, or `gate-ci-event-invalid` naming why. */
export function decodeEvent(where: string, text: string): PullRequestEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return eventInvalid(`${where}: not JSON`);
  }
  const decoded = decodeResult(PullRequestEvent, raw);
  if (decoded._tag === "Success") return decoded.success;
  const first = decoded.failure.issues[0];
  return eventInvalid(`${where}: not a pull_request event (${first === undefined ? "undecodable" : `${first.path.join(".") || "event"}: ${first.message}`})`);
}

const REF_KEY = /(?:^|\/)([a-z]{2,5}-[0-9]+)(?:-|$)/i;
const TITLE_KEY = /\b([A-Z]{2,5}-[0-9]+)\b/;

/** Where a PR's issue key came from. */
export type KeySource = "ref" | "title" | "none";

/** The issue key and where it was read: the head ref's `<team>-<n>` segment first, then the title. */
export function issueKeyFrom(ref: string, title: string): { readonly key: string | null; readonly from: KeySource } {
  const r = REF_KEY.exec(ref);
  if (r !== null) return { key: r[1]!.toUpperCase(), from: "ref" };
  const t = TITLE_KEY.exec(title);
  return t !== null ? { key: t[1]!, from: "title" } : { key: null, from: "none" };
}

export type Leg = "profile" | "monotone" | "unlock" | "surfaces";

/** The route a PR takes: the ticketed legs, the untracked surfaces leg (with a WARN line), or a refusal. */
export type CiRoute =
  | { readonly kind: "ticketed"; readonly key: string; readonly legs: readonly Leg[] }
  | { readonly kind: "untracked"; readonly warn: string | null; readonly why: "bot" | "warn" | "allow" }
  | { readonly kind: "missing" };

export function decideCi(input: { readonly key: string | null; readonly author: string; readonly ci: GatesCiSettings }): CiRoute {
  if (input.key !== null) {
    return { kind: "ticketed", key: input.key, legs: [...(input.ci.check_profile_in_ci === "on" ? (["profile"] as const) : []), "monotone", "unlock"] };
  }
  if (input.ci.bot_allowlist.includes(input.author)) return { kind: "untracked", warn: null, why: "bot" };
  switch (input.ci.untracked_prs) {
    case "block":
      return { kind: "missing" };
    case "warn":
      return { kind: "untracked", warn: "WARN gate ci: the PR names no issue key (untracked_prs: warn); only its surfaces are checked", why: "warn" };
    case "allow":
      return { kind: "untracked", warn: null, why: "allow" };
  }
}

export function issueMissing(ref: string, title: string): never {
  return precondition(
    "gate-issue-missing",
    `the PR names no issue key (head ref ${ref}, title ${JSON.stringify(title)}), and the org's untracked_prs is block`,
    "Put the issue key in the PR title (ABC-123: ...) or the branch name (<you>/abc-123-...); a title edit re-runs the check.",
  );
}

export function untrackedSurface(author: string, hits: readonly string[]): never {
  return precondition(
    "gate-ci-bot-surface",
    `the untracked PR by ${author} changes ${hits.length} path(s) on a registered surface or its registry: ${hits.join(", ")}`,
    "A surface change needs an issue: put its key in the PR title or branch so the ticketed legs (profile, monotone, unlock) run.",
  );
}

/** The hosted bundle's doctrine, read exactly as a pulled `doctrine.md` is. */
export function postureFromBundle(bundle: GatesOrgBundle): DoctrineRead {
  return readDoctrine(renderBundle(bundle)["doctrine.md"] ?? "");
}

/** A request the GET-only fetch refused: its method and its URL without the query. */
export interface WriteRefusal {
  readonly method: string;
  readonly url: string;
}

/** The `gate-ci-write-refused` block for `r`. */
export const writeRefused = (r: WriteRefusal) =>
  block(
    "gate-ci-write-refused",
    `gate ci refused a ${r.method} to ${r.url}: it reads the gateway and writes nothing`,
    "Report it: a gate ci leg tried to write. The check's client is GET-only, and nothing was sent.",
    3,
  );

/**
 * `inner` (default the global fetch) for GET only: any other method is told to `onRefuse` and rejected
 * without calling `inner`. The gates client reads any rejection as unreachable, so the caller keeps
 * what `onRefuse` was told and stops with `gate-ci-write-refused` itself.
 */
// lift-candidate: read-only-http — refuse non-GET before the network
export function getOnlyFetch(inner: typeof globalThis.fetch | undefined, onRefuse: (method: string, url: string) => void): typeof globalThis.fetch {
  const base = inner ?? globalThis.fetch;
  const guarded = (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET") {
      const url = (input instanceof Request ? input.url : String(input)).split("?")[0]!;
      onRefuse(method, url);
      return Promise.reject(new Error(`gate ci refused a ${method} to ${url}`));
    }
    return base(input, init);
  };
  return guarded as typeof globalThis.fetch;
}
