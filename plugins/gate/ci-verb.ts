/**
 * ci-verb.ts — `eris gate ci`: the one required check a repo's CI runs on a pull request. The routing
 * and its pure parts are ci.ts; this file wires the I/O.
 *
 * It reads the `pull_request` event (`--event`, default `$GITHUB_EVENT_PATH`), the org's hosted policy
 * and settings on the `eris login` bearer (`ERIS_YAKS_TOKEN` + `ERIS_YAKS_URL` on a runner), and decides
 * under the live hosted posture: a locally pulled tree is never read. One endpoint is built per run, on
 * `getOnlyFetch`, and every gateway call goes through it, so the verb writes nothing: an `off` gate
 * prints `skipped` (`CheckInput.readOnly`), never a receipt. A refused non-GET is held and stops the
 * verb with `gate-ci-write-refused`, before any failure the client made of it.
 *
 * Each leg runs and prints `@ci\t<leg>\t<pass|fail|skipped>` after its rows; the verb then fails with
 * the first failing leg's failure, so one run names every gap.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { activePosture, type ContractFailure, fetchOrgPolicy, gateProfilesOf, type GatesEndpoint, invalidDoctrine, type RetryOpts } from "eris/gates-contract";
import { readArgs, type VerbContext } from "../../src/cli/plugin";
import { checkGates } from "./check";
import { decideCi, decodeEvent, eventInvalid, getOnlyFetch, issueKeyFrom, issueMissing, postureFromBundle, type PullRequestEvent, untrackedSurface, type WriteRefusal, writeRefused } from "./ci";
import { GateFailure, stop, unwrap } from "./failure";
import { changedPaths, type Git, liveGit, memoReads, mergeBase, repoRoot } from "./git";
import plugin, { type GateDefaults } from "./index";
import { judgeMonotone } from "./monotone";
import { matchSurfaces } from "./registry";
import { type StoreOptions, storeEndpoint } from "./store";
import { checkUnlock, humanSignoff, registryAt } from "./unlock";

/** What the verb takes from the caller in a test; the process's own when absent. */
export interface CiDeps {
  readonly home?: string;
  readonly cwd?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly jitter?: () => number;
}

const CI_USAGE = `Usage: eris gate ci ${plugin.rows["gate ci"].usage}

The required CI check: read the pull_request event, fetch the org's hosted
policy and settings on the eris login bearer (ERIS_YAKS_TOKEN + ERIS_YAKS_URL
in CI), and run the legs the settings route the PR to. Every request is a GET;
nothing is recorded. Prints '@policy\\t<bundle_sha>\\t<active posture>',
'@issue\\t<KEY|->\\t<ref|title|none>', each leg's rows, then
'@ci\\t<leg>\\t<pass|fail|skipped>'. Exit 0 only when every leg passes.

  A PR with an issue key (head ref '<you>/abc-123-...', else the title) runs:
    profile   the hosted posture's profile_default (default spine), checked
              as 'gate check --profile --dry-run' does: a gate the posture sets
              off reads skipped (when settings.ci.check_profile_in_ci is on)
    monotone  the registry, its vocabularies and review skills at the merge-base
              against the head; a wider row passes only when the issue's
              surface-widen receipt carries it with a human grant
    unlock    whether the merge may proceed without a human on each crossed
              surface, else a human door-signoff bound to the head that
              carries 'door: merge'
  A PR with no key: an author on settings.ci.bot_allowlist, or untracked_prs
  warn (a WARN line) or allow, runs the surfaces leg, which fails
  (gate-ci-bot-surface) when its merge-base diff touches a registered surface
  or the registry; untracked_prs block fails (gate-issue-missing).

  --event      The pull_request event JSON (default $GITHUB_EVENT_PATH)
  --registry   The surfaces registry, repo-relative (default .claude/surfaces.yml)

See docs/GATE.md#ci.
`;

/** Fallback waits (ms) across 5 retries of a receipt read: about 95 s; at most 60 s each. */
const READ_DELAYS_MS: ReadonlyArray<number> = [5000, 10_000, 20_000, 30_000, 30_000];
const READ_MAX_WAIT_MS = 60_000;

/**
 * The gates endpoint on the directory's login, its fetch GET-only, and `held`, which stops with
 * `gate-ci-write-refused` once any request was refused. The client reads a refused request as
 * unreachable, so `held` runs after every call and before any client failure is reported.
 */
export async function getOnlyEndpoint(o: Omit<StoreOptions, "fetch" | "policySha" | "onStale"> & { readonly fetch?: typeof globalThis.fetch | undefined }): Promise<{ readonly ep: GatesEndpoint; readonly held: () => void }> {
  let refused: WriteRefusal | undefined;
  const held = () => {
    if (refused !== undefined) stop(writeRefused(refused));
  };
  const ep = await storeEndpoint({ home: o.home, env: o.env, cwd: o.cwd, fetch: getOnlyFetch(o.fetch, (method, url) => void (refused ??= { method, url })) });
  return { ep, held };
}

/** The surfaces leg: the PR's merge-base diff matched against the registry at its fork and at its head. */
async function surfacesLeg(g: Git, cwd: string, registry: string, ev: PullRequestEvent, out: (l: string) => void): Promise<void> {
  const unresolved = (what: string): never => stop({ slug: "gate-unlock-unresolved", what, fix: "Check out the PR with fetch-depth: 0 so its base and head commits are present.", docs: "docs/ERRORS.md#gate-unlock-unresolved", exit: 3 });
  const top = await repoRoot(g, cwd);
  if (top === null) return unresolved(`${cwd} is not inside a git checkout`);
  const { base, head } = ev.pull_request;
  const fork = await mergeBase(g, top, base.sha, head.sha);
  if (fork === null) return unresolved(`no merge-base of base ${base.sha.slice(0, 12)} and head ${head.sha.slice(0, 12)} in this checkout`);
  // A commit range, never the worktree: a pull_request checkout is the merge commit.
  const changed = await changedPaths(g, top, `${fork}..${head.sha}`);
  if (changed === null) return unresolved("git could not list the PR's changes");
  const sides = [await registryAt(g, top, fork, registry), await registryAt(g, top, head.sha, registry)];
  const hits = new Set(changed.filter((p) => p === registry));
  for (const reg of sides) if (reg !== null) for (const s of matchSurfaces(reg, changed)) for (const f of s.matched_files) hits.add(f);
  const sorted = [...hits].sort();
  for (const f of sorted) out(`@surface-path\t${f}`);
  if (sorted.length > 0) untrackedSurface(ev.pull_request.user.login, sorted);
}

type TicketedLeg = "profile" | "monotone" | "unlock";

/** `eris gate ci`. */
export async function runCi(args: string[], ctx: VerbContext, defaults: GateDefaults = {}, deps: CiDeps = {}): Promise<number> {
  const a = readArgs(plugin.rows, "gate ci", args, ctx, { help: CI_USAGE });
  if (a === null) return 0;
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.home ?? ctx.env.HOME ?? homedir();
  const out = (l: string) => void ctx.stdout.write(`${l}\n`);
  const warn = (l: string) => void ctx.stderr.write(`${l}\n`);
  const registry = a.flags["--registry"] ?? ".claude/surfaces.yml";
  const eventFile = a.flags["--event"] ?? ctx.env.GITHUB_EVENT_PATH ?? "";
  if (eventFile === "") eventInvalid("no --event and no GITHUB_EVENT_PATH: there is no pull_request event to read");
  let text: string;
  try {
    text = readFileSync(resolve(cwd, eventFile), "utf8");
  } catch {
    return eventInvalid(`${eventFile}: cannot read the event file`);
  }
  const ev = decodeEvent(eventFile, text);

  const { ep, held } = await getOnlyEndpoint({ home, env: ctx.env, cwd, fetch: deps.fetch });
  const policy = await fetchOrgPolicy(ep);
  held();
  const pulled = unwrap(policy);
  const hostedName = `the org's hosted policy ${pulled.bundle_sha}`;
  const read = postureFromBundle(pulled.bundle);
  const bad = invalidDoctrine(hostedName, read);
  if (bad !== null) stop(bad);
  const posture = activePosture(read);
  out(`@policy\t${pulled.bundle_sha}\t${posture?.slug ?? "-"}`);
  const pr = ev.pull_request;
  const { key, from } = issueKeyFrom(pr.head.ref, pr.title);
  out(`@issue\t${key ?? "-"}\t${from}`);
  const route = decideCi({ key, author: pr.user.login, ci: pulled.settings.ci });
  const g = memoReads(liveGit(ctx.env));
  if (route.kind === "missing") return issueMissing(pr.head.ref, pr.title);
  if (route.kind === "untracked") {
    if (route.warn !== null) warn(route.warn);
    await surfacesLeg(g, cwd, registry, ev, out);
    out("@ci\tsurfaces\tpass");
    return 0;
  }

  const now = (deps.now ?? (() => new Date()))();
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const readRetry: RetryOpts = {
    delaysMs: READ_DELAYS_MS,
    maxWaitMs: READ_MAX_WAIT_MS,
    sleep,
    jitter: deps.jitter ?? Math.random,
    onRetry: (waitMs, attempt) => warn(`WARN the gateway rate-limited a receipt read; retry ${attempt}/${READ_DELAYS_MS.length} in ${Math.round(waitMs / 1000)}s`),
  };
  const doctrine = { file: hostedName, read: () => read };
  const legs: Record<TicketedLeg, () => Promise<unknown>> = {
    profile: () => {
      const profiles = gateProfilesOf(pulled.bundle.profiles);
      const name = posture?.policy?.profile_default ?? "spine";
      const chosen = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
      if (chosen === undefined) {
        return stop({
          slug: "gate-profile-unknown",
          what: `the hosted posture's profile_default ${name}: no such profile in the org's policy`,
          fix: `Name one of: ${Object.keys(profiles).sort().join(", ") || "(none)"}.`,
          docs: "docs/ERRORS.md#gate-profile-unknown",
          exit: 2,
        });
      }
      return checkGates({
        ep,
        issue: route.key,
        gates: chosen.require,
        forbid: chosen.forbid,
        cwd,
        g,
        out,
        warn,
        sleep,
        readRetry,
        writeRetry: readRetry,
        doctrine,
        applyModes: true,
        readOnly: true,
        ...(defaults.reviews !== undefined ? { reviews: defaults.reviews } : {}),
        head: { headSha: pr.head.sha, base: pr.base.sha },
        now,
      });
    },
    monotone: () =>
      judgeMonotone({
        cwd,
        base: pr.base.sha,
        registry,
        issue: route.key,
        g,
        out: (l) => out(`@monotone\t${l}`),
        err: warn,
        signoff: (issue) => humanSignoff({ ep, g, cwd, readRetry, reviews: defaults.reviews }, issue, "surface-widen"),
      }),
    unlock: () =>
      checkUnlock({
        ep,
        issue: route.key,
        action: "merge",
        base: pr.base.sha,
        headSha: pr.head.sha,
        registry,
        cwd,
        g,
        doctrine: { file: hostedName, read },
        ...(defaults.reviews !== undefined ? { reviews: defaults.reviews } : {}),
        now,
        readRetry,
        out,
        warn,
      }),
  };
  let first: ContractFailure | undefined;
  for (const leg of ["profile", "monotone", "unlock"] as const) {
    if (!route.legs.includes(leg)) {
      out(`@ci\t${leg}\tskipped`);
      continue;
    }
    let failed: ContractFailure | undefined;
    try {
      await legs[leg]();
    } catch (e) {
      if (!(e instanceof GateFailure)) throw e;
      failed = e.failure;
    }
    held();
    out(`@ci\t${leg}\t${failed === undefined ? "pass" : "fail"}`);
    first ??= failed;
  }
  held();
  if (first !== undefined) stop(first);
  return 0;
}
