/**
 * `eris gate ci` at the verb seam: the gate handler driven with argv, a loopback `Bun.serve` standing
 * in for the gateway (the hosted policy and settings, the receipt listings, the asks), a sandbox HOME
 * holding the login, and real git checkouts under .scratch/. The server logs every request it is
 * sent, method and path, which is the GET-only oracle. The bearer is assembled at runtime so no
 * literal trips a secret scanner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appendReceipt, computeGatesBundleSha, type GatesOrgBundle, type GatesSettings, sha256Hex } from "eris/gates-contract";
import { getOnlyFetch, issueKeyFrom, type KeySource } from "../plugins/gate/ci";
import { getOnlyEndpoint } from "../plugins/gate/ci-verb";
import { GateFailure } from "../plugins/gate/failure";
import { gateHandler } from "../plugins/gate/gate";
import { classifyMonotone, type Dim, type MonotoneSide } from "../plugins/gate/monotone";
import { validateSurfacesYaml } from "../plugins/gate/registry";
import { CliExit } from "../src/cli/ts-verb";

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, "..");
const ORG = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const LOGIN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const NOW = new Date("2026-11-17T09:00:00.000Z");
const NOTE = "# review\nclean\n";

/** A hosted bundle whose active posture runs profile `ci` and sets sdk-check off; its signoff leaves unlock off. */
const BUNDLE: GatesOrgBundle = {
  active: "ci",
  postures: {
    ci: { name: "CI", bullets: ["Test posture."], policy: { profile_default: "ci", gates: { "sdk-check": "off" }, signoff: { "one-way": "human", "two-way": "self" } } },
  },
  profiles: { ci: ["plan-review", "sdk-check"] },
  loops: {},
};

interface StoredRow {
  comment_id: string;
  created_at: string;
  marker_version: "v2";
  payload: unknown;
}

let sandbox: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let store: Record<string, StoredRow[]>;
let seen: { method: string; path: string }[];
let clock: number;
let settings: GatesSettings;
let bundle: GatesOrgBundle;

const ci = (over: Partial<GatesSettings["ci"]> = {}): GatesSettings => ({
  staleness: "soft",
  ci: { check_profile_in_ci: "on", untracked_prs: "block", bot_allowlist: ["renovate[bot]"], ...over },
});

async function route(method: string, url: URL): Promise<Response> {
  const sha = await computeGatesBundleSha(bundle, settings);
  if (method === "GET" && url.pathname === "/v1/gates/policy") return Response.json({ contract: "gates-contract/v1.5", bundle, bundle_sha: sha });
  if (method === "GET" && url.pathname === "/v1/gates/settings") return Response.json({ contract: "gates-contract/v1.5", settings, bundle_sha: sha });
  if (method === "GET" && url.pathname === "/v1/gates/receipts") {
    const issue = url.searchParams.get("issue") ?? "";
    return Response.json({ issue, receipts: store[issue] ?? [], invalid: 0, contract_version: "gates-contract/v1" });
  }
  if (method === "GET" && url.pathname === "/v1/asks") return Response.json({ asks: [] });
  return Response.json({ status: 404, code: "not_found" }, { status: 404, headers: { "content-type": "application/problem+json" } });
}

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "gate-ci-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({ method: req.method, path: url.pathname });
      return route(req.method, url);
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(sandbox, "home-")));
  mkdirSync(join(home, ".eris"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".eris", "yaks.json"), JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token: LOGIN }), { mode: 0o600 });
  store = {};
  seen = [];
  clock = 0;
  settings = ci();
  bundle = BUNDLE;
});

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd, env: { PATH: process.env.PATH, HOME: home } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function write(dir: string, rel: string, body: string): void {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

const REGISTRY = `surfaces:
  auth:
    paths:
      - src/auth/**
      - src/session.ts
    one_way_unlock:
      merge: [adversarial-review]
    ledger: ABC-9
    change_budget: 2
`;

/**
 * `acme/shop` on `main` with the auth surface registered, checked out on `feat`, whose one commit runs
 * `change` and commits a review note; `seed` adds files to the base commit. Returns the checkout, the head and the base sha.
 */
function shop(change: (d: string) => void = (d) => write(d, "src/auth/login.ts", "export const a = 2;\n"), seed: (d: string) => void = () => {}) {
  const d = realpathSync(mkdtempSync(join(sandbox, "repo-")));
  write(d, ".claude/surfaces.yml", REGISTRY);
  write(d, "src/auth/login.ts", "export const a = 1;\n");
  write(d, "src/other.ts", "x\n");
  seed(d);
  git(d, "init", "-q", "-b", "main");
  git(d, "remote", "add", "origin", "git@github.com:acme/shop.git");
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "base");
  git(d, "checkout", "-q", "-b", "feat");
  change(d);
  write(d, "review.md", NOTE);
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "change");
  return { d, head: git(d, "rev-parse", "HEAD"), base: git(d, "rev-parse", "main") };
}

/** The recorded fixture event with the checkout's shas filled in, and `pr` overriding its fields. */
function event(head: string, base: string, pr: { title?: string; ref?: string; login?: string } = {}): string {
  const ev = JSON.parse(readFileSync(join(REPO, "tests", "fixtures", "gate-ci", "pull_request.json"), "utf8"));
  ev.pull_request.head.sha = head;
  ev.pull_request.base.sha = base;
  if (pr.title !== undefined) ev.pull_request.title = pr.title;
  if (pr.ref !== undefined) ev.pull_request.head.ref = pr.ref;
  if (pr.login !== undefined) ev.pull_request.user.login = pr.login;
  const file = join(realpathSync(mkdtempSync(join(sandbox, "event-"))), "event.json");
  writeFileSync(file, JSON.stringify(ev));
  return file;
}

const at = () => new Date(Date.UTC(2026, 10, 17, 8, 0, clock++)).toISOString();

function put(issue: string, payload: Record<string, unknown>): void {
  (store[issue] ??= []).push({ comment_id: `c-${clock}`, created_at: at(), marker_version: "v2", payload });
}

const text = (content: string) => ({ kind: "text", content, sha256: sha256Hex(content) });

/** A PASS receipt on `issue` for `gate` over the review note committed at `commit`. */
const bound = (gate: string, commit: string, issue = "ABC-1", over: Record<string, unknown> = {}) => ({
  schema: "gate-receipt@v2",
  gate,
  issue,
  verdict: "PASS",
  artifact: { _tag: "git", repo: "acme/shop", ref: "feat", commit, path: "review.md", sha256: sha256Hex(NOTE) },
  actor: "op@example.com",
  evidence: [],
  recorded_at: "2026-11-17T08:00:00.000Z",
  ...over,
});

/** A PASS receipt on `issue` over a file outside any repo. */
function fileReceipt(gate: string, issue: string, over: Record<string, unknown> = {}) {
  const path = join(home, `${gate}.md`);
  writeFileSync(path, "# a\n");
  return { ...bound(gate, "", issue), artifact: { _tag: "file", path, sha256: sha256Hex("# a\n") }, ...over };
}

const signoff = (head: string) => bound("door-signoff", head, "ABC-1", { authorized: "Pat asked: ship it", evidence: [text("door: merge")] });

/** Every fact the unlock leg reads on the ledger: a fresh baseline and this head's announcement. */
function ledger(head: string): void {
  put("ABC-9", fileReceipt("audit-surfaces", "ABC-9"));
  put("ABC-9", fileReceipt("unlocked-merge", "ABC-9", { evidence: [text(["unlocked one-way: merge", "surface: auth", `issue: ABC-1 head: ${head}`].join("\n"))] }));
}

interface Ran {
  code: number;
  out: string;
  err: string;
}

async function gateCi(cwd: string, ev: string): Promise<Ran> {
  let out = "";
  let err = "";
  const ctx = {
    erisDir: REPO,
    env: { HOME: home, PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: sandbox, ERIS_CLONES_FILE: join(home, "none.json") },
    stdout: { write: (s: string) => ((out += s), true) },
    stderr: { write: (s: string) => ((err += s), true) },
    format: "text" as const,
  };
  try {
    return { code: await gateHandler({}, { home, cwd, now: () => NOW, sleep: async () => {}, jitter: () => 0 })(["ci", "--event", ev], ctx), out, err };
  } catch (e) {
    if (e instanceof CliExit) return { code: e.code, out, err };
    throw e;
  }
}

const policyRow = async () => `@policy\t${await computeGatesBundleSha(bundle, settings)}\tci\n`;

describe("issueKeyFrom", () => {
  // admits: algorithmic: a key read from the wrong place routes a ticketed PR to gate-issue-missing, or an untracked one past it; regexes no type sees.
  it("reads the key from the head ref first, then the title, and none from a key-shaped substring", () => {
    const table: Array<[string, string, { key: string | null; from: KeySource }]> = [
      ["alice/abc-1-thing", "Anything", { key: "ABC-1", from: "ref" }],
      ["abc-12", "ABC-99 title", { key: "ABC-12", from: "ref" }],
      ["feat", "ABC-7: fix the gate", { key: "ABC-7", from: "title" }],
      ["feat", "[ABC-1234] fix", { key: "ABC-1234", from: "title" }],
      ["renovate/abc-lib-2.x", "Update lib", { key: null, from: "none" }],
      ["feat", "bump XABCX-12a", { key: null, from: "none" }],
      ["feat", "no key here", { key: null, from: "none" }],
    ];
    expect(table.map(([ref, title]) => issueKeyFrom(ref, title))).toEqual(table.map(([, , want]) => want));
  });
});

describe("eris gate ci: a ticketed PR", () => {
  // admits: integration: the recorded event must route by its head ref and run profile, monotone and unlock over the hosted posture,
  // an off gate reading skipped, with every request a GET (observed on the loopback log: no type sees which method a client sends).
  it("prints the policy, issue and leg rows for the fixture event, reads an off gate as skipped and sends only GETs", async () => {
    const { d, head, base } = shop();
    put("ABC-1", bound("plan-review", head));
    put("ABC-1", bound("adversarial-review", head));
    put("ABC-1", bound("posture-check", head));
    put("ABC-1", signoff(head));
    ledger(head);
    const r = await gateCi(d, event(head, base));
    expect({ code: r.code, out: r.out }).toEqual({
      code: 0,
      out:
        `${await policyRow()}@issue\tABC-1\tref\n` +
        "plan-review\tpass\tPASS\nsdk-check\tskipped\tdoctrine ci sets gates.sdk-check: off\n@ci\tprofile\tpass\n" +
        "@ci\tmonotone\tpass\n" +
        "@door\tone-way\tunclassified\n" +
        "@surface\tauth\t1\n@lock\topen\tauth\nadversarial-review\tpass\tPASS\nposture-check\tpass\tPASS\n@baseline\tfresh\tauth\n@budget\t1/2\tauth\n@announce\tpresent\tauth\n" +
        "door-signoff\tpass\tPASS\n@unlock\thuman-signed\tmerge\n@ci\tunlock\tpass\n",
    });
    expect([...new Set(seen.map((s) => s.method))]).toEqual(["GET"]);
    expect(seen.some((s) => s.path === "/v1/gates/receipts")).toBe(true);
  });

  // admits: integration: proves GET /v1/gates/policy -> fetchOrgPolicy -> postureFromBundle -> checkUnlock prints @unlock\tunlocked\tmerge with zero door-signoff receipt and strictly GET-only wire traffic when the hosted bundle sets signoff.unlock: on.
  it("unlocks a one-way surface merge without door-signoff when the hosted bundle sets signoff.unlock: on (GET-only)", async () => {
    /** When the hosted bundle decoder drops signoff.unlock, gate ci fails gate-contract-mismatch or falls back to human-signed even when every bar gate, baseline, budget and announcement holds: observed on stdout, exit code and the loopback method log. */
    const { d, head, base } = shop();
    bundle = {
      ...BUNDLE,
      postures: {
        ci: {
          ...BUNDLE.postures.ci!,
          policy: { ...BUNDLE.postures.ci!.policy, signoff: { "one-way": "human", "two-way": "self", unlock: "on" } },
        },
      },
    };
    put("ABC-1", bound("plan-review", head));
    put("ABC-1", bound("adversarial-review", head));
    put("ABC-1", bound("posture-check", head));
    ledger(head);
    const r = await gateCi(d, event(head, base));
    expect(r.code).toBe(0);
    expect(r.out).toContain("@unlock\tunlocked\tmerge\n@ci\tunlock\tpass\n");
    expect(r.out).not.toContain("door-signoff\t");
    expect([...new Set(seen.map((s) => s.method))]).toEqual(["GET"]);
  });

  // admits: integration: proves hosted signoff.raise (surface and * wildcard with :qualifier) survives GET /v1/gates/policy -> renderBundle -> readDoctrine -> unlockBar and fails closed to @unlock\thuman\tmerge until every raised gate passes bound to the PR head.
  it("enforces hosted signoff.raise (surface and * wildcard) in gate ci: human when a raised gate is missing, unlocked once bound", async () => {
    /** When hosted signoff.raise is dropped or mis-parsed across bundle decode and render, a posture-raised bar gate is silently skipped and a surface merges without it: observed on gate rows, @unlock outcome and strictly GET-only traffic. */
    const { d, head, base } = shop();
    bundle = {
      ...BUNDLE,
      postures: {
        ci: {
          ...BUNDLE.postures.ci!,
          policy: {
            ...BUNDLE.postures.ci!.policy,
            signoff: {
              "one-way": "human",
              "two-way": "self",
              unlock: "on",
              raise: {
                auth: { merge: ["e2e"] },
                "*": { merge: ["audit-surfaces:clean"] },
              },
            },
          },
        },
      },
    };
    put("ABC-1", bound("plan-review", head));
    put("ABC-1", bound("adversarial-review", head));
    put("ABC-1", bound("posture-check", head));
    ledger(head);
    const missing = await gateCi(d, event(head, base));
    expect(missing.code).toBe(3);
    expect(missing.out).toContain("e2e\tmissing\t-\n");
    expect(missing.out).toContain("audit-surfaces:clean\tmissing\t-\n");
    expect(missing.out).toContain("@unlock\thuman\tmerge\n@ci\tunlock\tfail\n");

    put("ABC-1", bound("e2e", head));
    put("ABC-1", bound("audit-surfaces", head));
    const passed = await gateCi(d, event(head, base));
    expect(passed.code).toBe(0);
    expect(passed.out).toContain("e2e\tpass\tPASS\n");
    expect(passed.out).toContain("audit-surfaces:clean\tpass\tPASS\n");
    expect(passed.out).toContain("@unlock\tunlocked\tmerge\n@ci\tunlock\tpass\n");
    expect([...new Set(seen.map((s) => s.method))]).toEqual(["GET"]);
  });

  // admits: integration: a surface diff with no human sign-off must fail the unlock leg (never pass a one-way merge unsigned); observed at the leg row and the slug.
  it("fails the unlock leg on a surface diff with no door-signoff (gate-unlock-human)", async () => {
    settings = ci({ check_profile_in_ci: "off" });
    const { d, head, base } = shop();
    const r = await gateCi(d, event(head, base));
    expect(r.code).toBe(3);
    expect(r.out).toContain("@ci\tprofile\tskipped\n@ci\tmonotone\tpass\n");
    expect(r.out).toEndWith("@unlock\thuman\tmerge\n@ci\tunlock\tfail\n");
    expect(r.err).toContain("slug: gate-unlock-human");
  });

  // admits: integration: a door-signoff that does not sign this head and action must not human-sign the merge; head binding runs real git ancestry.
  it("reads a door-signoff without 'door: merge' as wrong-action, and one before a later code push as stale-head", async () => {
    settings = ci({ check_profile_in_ci: "off" });
    const { d, head, base } = shop();
    put("ABC-1", bound("door-signoff", head, "ABC-1", { authorized: "Pat asked: ship it" }));
    const wrong = await gateCi(d, event(head, base));
    expect(wrong.out).toContain(`door-signoff\twrong-action\tPASS\n@dispatch\tadversarial-review\teris loop launch adversarial-review ABC-1 --cwd ${d} --runtime opencode --pool neon --unclaimed\n@unlock\thuman\tmerge\n`);

    store = {};
    put("ABC-1", signoff(head));
    write(d, "src/auth/login.ts", "export const a = 3;\n");
    git(d, "commit", "-q", "-am", "code after the sign-off");
    const later = git(d, "rev-parse", "HEAD");
    const stale = await gateCi(d, event(later, base));
    expect(stale.code).toBe(3);
    expect(stale.out).toContain(`door-signoff\tstale-head\tPASS\n@dispatch\tadversarial-review\teris loop launch adversarial-review ABC-1 --cwd ${d} --runtime opencode --pool neon --unclaimed\n@unlock\thuman\tmerge\n@ci\tunlock\tfail\n`);
  });

  // admits: integration: a PR that widens the registry must fail monotone unless a human surface-widen covers it, and still run unlock; observed at the rows and the first failure's slug.
  it("fails the monotone leg on a registry widening with no surface-widen (gate-monotone-wider), and every leg still reports", async () => {
    settings = ci({ check_profile_in_ci: "off" });
    const { d, head, base } = shop((dir) => {
      write(dir, ".claude/surfaces.yml", REGISTRY.replace("      - src/session.ts\n", ""));
      write(dir, "src/auth/login.ts", "export const a = 2;\n");
    });
    const r = await gateCi(d, event(head, base));
    expect(r.code).toBe(3);
    expect(r.out).toContain("@monotone\tsurface\tauth\tpaths\twider\tremoved src/session.ts\n@ci\tmonotone\tfail\n");
    expect(r.out).toContain("@governance\t.claude/surfaces.yml\n");
    expect(r.out).toEndWith("@ci\tunlock\tfail\n");
    expect(r.err).toContain("slug: gate-monotone-wider");
    expect(r.err).not.toContain("gate monotone");
  });

  // admits: integration: a keyed PR raising an eris.yaml-declared ratchet must fail the monotone leg with the ratchet row, read from the
  // base commit and the head checkout; a surface-only reader would pass it.
  it("fails the monotone leg on a raised eris.yaml ratchet with its ratchet row (gate-monotone-wider)", async () => {
    settings = ci({ check_profile_in_ci: "off" });
    const frozen = (lines: number) => `${JSON.stringify({ baseline: { "src/big.ts": { lines } } })}\n`;
    const { d, head, base } = shop(
      (dir) => write(dir, "scripts/size.frozen.json", frozen(1200)),
      (dir) => {
        write(dir, "eris.yaml", "service: shop\nratchets:\n  - scripts/size.frozen.json\n");
        write(dir, "scripts/size.frozen.json", frozen(1100));
      },
    );
    const r = await gateCi(d, event(head, base));
    expect(r.code).toBe(3);
    expect(r.out).toContain("@monotone\tratchet\tscripts/size.frozen.json#/baseline/src~1big.ts/lines\tvalue\twider\t1100 -> 1200\n@ci\tmonotone\tfail\n");
    expect(r.err).toContain("slug: gate-monotone-wider");
  });

  // admits: boundary-io: a malformed event must fail closed (no fetch), never route as an untracked PR; the event is parsed from a file.
  it("refuses an event that is not a pull_request payload before any request (gate-ci-event-invalid)", async () => {
    const { d } = shop();
    const file = join(realpathSync(mkdtempSync(join(sandbox, "event-"))), "bad.json");
    writeFileSync(file, JSON.stringify({ pull_request: { title: "ABC-1" } }));
    const r = await gateCi(d, file);
    expect({ code: r.code, out: r.out, requests: seen.length }).toEqual({ code: 3, out: "", requests: 0 });
    expect(r.err).toContain("slug: gate-ci-event-invalid");
  });
});

describe("eris gate ci: an untracked PR", () => {
  // admits: integration: an untracked human PR must fail under block and pass with a WARN under warn; routing over the hosted settings.
  it("fails an untracked PR under block (gate-issue-missing) and passes it with a WARN under warn", async () => {
    const { d, head, base } = shop((dir) => write(dir, "src/other.ts", "y\n"));
    const ev = event(head, base, { ref: "feat/tidy", title: "tidy" });
    const blocked = await gateCi(d, ev);
    expect({ code: blocked.code, out: blocked.out }).toEqual({ code: 3, out: `${await policyRow()}@issue\t-\tnone\n` });
    expect(blocked.err).toContain("slug: gate-issue-missing");

    settings = ci({ untracked_prs: "warn" });
    const warned = await gateCi(d, ev);
    expect({ code: warned.code, out: warned.out }).toEqual({ code: 0, out: `${await policyRow()}@issue\t-\tnone\n@ci\tsurfaces\tpass\n` });
    expect(warned.err).toContain("WARN gate ci: the PR names no issue key");
  });

  // admits: integration: an allowlisted bot must never change a registered surface without a ticket; the match runs over the PR's merge-base diff in real git.
  it("fails an allowlisted bot's PR that touches a registered surface (gate-ci-bot-surface), naming each path", async () => {
    const { d, head, base } = shop();
    const r = await gateCi(d, event(head, base, { ref: "renovate/lib-2.x", title: "Update lib", login: "renovate[bot]" }));
    expect({ code: r.code, out: r.out }).toEqual({ code: 3, out: `${await policyRow()}@issue\t-\tnone\n@surface-path\tsrc/auth/login.ts\n` });
    expect(r.err).toContain("slug: gate-ci-bot-surface");
  });
});

describe("the GET-only guard", () => {
  // admits: boundary-io: a non-GET must be refused before the network whatever shape the call takes; the client's method is a runtime value no type separates.
  it("passes a GET through and refuses POST, PUT, DELETE and a POST Request without calling the inner fetch", async () => {
    const called: string[] = [];
    const refused: string[] = [];
    const inner = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      called.push(`${init?.method ?? (input instanceof Request ? input.method : "GET")}`);
      return new Response("{}");
    }) as typeof fetch;
    const get = getOnlyFetch(inner, (method, url) => refused.push(`${method} ${url}`));
    expect((await get("http://127.0.0.1:1/v1/gates/receipts?issue=ABC-1")).status).toBe(200);
    for (const method of ["POST", "PUT", "DELETE", "post"]) await expect(get("http://127.0.0.1:1/x?q=1", { method })).rejects.toThrow();
    await expect(get(new Request("http://127.0.0.1:1/y", { method: "POST", body: "{}" }))).rejects.toThrow();
    expect(called).toEqual(["GET"]);
    expect(refused).toEqual(["POST http://127.0.0.1:1/x", "PUT http://127.0.0.1:1/x", "DELETE http://127.0.0.1:1/x", "POST http://127.0.0.1:1/x", "POST http://127.0.0.1:1/y"]);
  });

  // admits: integration: the client maps any fetch rejection to gate-store-unreachable, so a refused write must still stop as gate-ci-write-refused (exit 3) with no request sent; observed on the loopback log.
  it("refuses a POST through the verb's endpoint with no request sent, and reports gate-ci-write-refused, not unreachable", async () => {
    const { ep, held } = await getOnlyEndpoint({ home, env: { HOME: home }, cwd: sandbox });
    const sent = await appendReceipt(ep, { commentId: "c-1", issue: "ABC-1", receipt: {}, prose: "x" });
    expect(sent.ok ? "sent" : sent.failure.slug).toBe("gate-store-unreachable");
    expect(seen).toEqual([]);
    let caught: unknown;
    try {
      held();
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof GateFailure ? { slug: caught.failure.slug, exit: caught.failure.exit } : caught).toEqual({ slug: "gate-ci-write-refused", exit: 3 });
  });
});

const BASE_YAML = `surfaces:
  auth:
    paths:
      - src/auth/**
      - src/session.ts
    one_way_unlock:
      merge:
        - audit-surfaces:clean
        - adversarial-review:high
    audit_ttl: 30d
    change_budget: 10
    severity_floor: medium
`;

const edit = (from: string, to: string): string => {
  expect(BASE_YAML).toContain(from);
  return BASE_YAML.replace(from, to);
};

const side = (yaml: string | null): MonotoneSide => {
  if (yaml === null) return { registry: null, files: new Map() };
  const v = validateSurfacesYaml(yaml);
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  return { registry: v.value, files: new Map() };
};

describe("classifyMonotone", () => {
  const cases: Array<[string, string | null, string, "tighter" | "same" | "wider"]> = [
    ["a path removed", edit("      - src/session.ts\n", ""), "paths", "wider"],
    ["a glob broadened", edit("src/auth/**", "src/**"), "paths", "wider"],
    ["a path added", edit("      - src/session.ts\n", "      - src/session.ts\n      - src/token.ts\n"), "paths", "tighter"],
    ["an unlock action enabled", edit("    audit_ttl: 30d\n", "      deploy:\n        - posture-check\n    audit_ttl: 30d\n"), "one_way_unlock.deploy", "wider"],
    ["an unlock gate removed", edit("        - audit-surfaces:clean\n", ""), "one_way_unlock.merge", "wider"],
    ["an effort lowered", edit("adversarial-review:high", "adversarial-review:medium"), "one_way_unlock.merge", "wider"],
    ["an effort raised", edit("adversarial-review:high", "adversarial-review:max"), "one_way_unlock.merge", "tighter"],
    ["an unlock action removed", edit("    one_way_unlock:\n      merge:\n        - audit-surfaces:clean\n        - adversarial-review:high\n", ""), "one_way_unlock.merge", "tighter"],
    ["audit_ttl longer", edit("audit_ttl: 30d", "audit_ttl: 60d"), "audit_ttl", "wider"],
    ["30d as 720h", edit("audit_ttl: 30d", "audit_ttl: 720h"), "audit_ttl", "same"],
    ["change_budget raised", edit("change_budget: 10", "change_budget: 11"), "change_budget", "wider"],
    ["severity_floor raised", edit("severity_floor: medium", "severity_floor: high"), "severity_floor", "wider"],
    ["a ledger added", edit("    severity_floor: medium\n", "    severity_floor: medium\n    ledger: ABC-9\n"), "ledger", "wider"],
    ["the registry deleted", null, "registry", "wider"],
  ];
  for (const [name, head, field, want] of cases) {
    // admits: algorithmic: a dimension compared in the wrong direction lets a widening through unsigned; it spans two revisions of one YAML file, which no type or lint sees.
    it(`${name}: ${field} reads ${want}`, () => {
      const rows: Dim[] = classifyMonotone(side(BASE_YAML), side(head), []);
      expect(rows.find((r) => r.field === field)?.verdict ?? "same").toBe(want);
      expect(rows.some((r) => r.verdict === "wider")).toBe(want === "wider");
    });
  }
});
