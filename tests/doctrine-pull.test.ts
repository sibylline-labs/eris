/**
 * `eris doctrine pull` and `eris doctrine path`, over the gates client (docs/dev/GATES-CLIENT.md).
 *
 * The seam is the doctrine handler with a loopback `Bun.serve` standing in for the gateway's
 * `/v1/gates/policy` and `/settings` routes and a sandbox HOME (under .scratch/) holding the login and
 * the pulled tree. Every request crosses real HTTP; the server counts them. The bearer is assembled
 * at runtime so no literal trips a secret scanner. The live gateway's sha algorithm was observed
 * against this client's `computeGatesBundleSha` before these tests were written; here the server
 * names the sha the client computes, and the tests drive every way that agreement can break.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { computeGatesBundleSha, gatesEndpoint, type GatesOrgBundle, type GatesSettings } from "eris/gates-contract";
import { doctrineHandler } from "../plugins/doctrine/doctrine";
import { seedAfterLogin } from "../plugins/doctrine/pull";
import { CliExit } from "../src/cli/ts-verb";

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, "..");
const ORG = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const LOGIN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");

const BUNDLE: GatesOrgBundle = {
  active: "business-as-usual",
  postures: {
    "rapid-prototype": { name: "Rapid prototype", bullets: ["Ship small experiments quickly."], policy: { profile_default: "spine", gates: { "premise-gate": "off" } } },
    "business-as-usual": { name: "Business as usual", bullets: ["The default.", "The established process."], policy: { profile_default: "deep" } },
  },
  profiles: { spine: ["understand-scope", "premise-gate", "plan-review", "final-gates"], deep: { require: ["understand-scope", "premise-gate", "sdk-check", "plan-review", "final-gates"] } },
  loops: { "one-shot": "# One shot\n\nRun the issue to a ready PR.\n" },
} as GatesOrgBundle;
const SETTINGS: GatesSettings = { staleness: "soft", ci: { check_profile_in_ci: "on", untracked_prs: "block", bot_allowlist: ["dependabot[bot]"] } };

type Route = () => Response;

let sandbox: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let sha: string;
let routes: Record<string, Route>;
let hits: { path: string; auth: string | null }[];

const problem = (status: number, code: string) => Response.json({ type: "about:blank", status, code }, { status, headers: { "content-type": "application/problem+json" } });
const policyReply = (s = sha) => Response.json({ contract: "gates-contract/v1.5", bundle: BUNDLE, bundle_sha: s });
const settingsReply = (s = sha) => Response.json({ contract: "gates-contract/v1.5", settings: SETTINGS, bundle_sha: s });

beforeAll(async () => {
  sha = await computeGatesBundleSha(BUNDLE, SETTINGS);
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "doctrine-pull-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      hits.push({ path: url.pathname, auth: req.headers.get("authorization") });
      const route = routes[`${req.method} ${url.pathname}`];
      return route ? route() : problem(404, "not_found");
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(sandbox, { recursive: true, force: true });
});

const login = (url: string) => writeFileSync(join(home, ".eris", "yaks.json"), JSON.stringify({ url, token: LOGIN }), { mode: 0o600 });

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(sandbox, "home-")));
  mkdirSync(join(home, ".eris"), { recursive: true, mode: 0o700 });
  login(`http://127.0.0.1:${server.port}`);
  hits = [];
  routes = { "GET /v1/gates/policy": () => policyReply(), "GET /v1/gates/settings": () => settingsReply() };
});

async function doctrine(args: string[], format: "text" | "json" = "text") {
  let stdout = "";
  let stderr = "";
  let rc: number;
  try {
    rc = await doctrineHandler({}, () => "", { home, cwd: sandbox, now: () => new Date("2026-11-17T12:00:00.000Z") })(args, {
      erisDir: REPO,
      env: { PATH: process.env.PATH, HOME: home },
      format,
      stdout: { write: (s: string) => ((stdout += s), true) },
      stderr: { write: (s: string) => ((stderr += s), true) },
    });
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    rc = e.code;
  }
  return { rc, stdout, stderr };
}

const slugOf = (stderr: string) => /^slug: (\S+)$/m.exec(stderr)?.[1];
const linked = () => join(home, ".eris", "doctrine", ORG);

describe("eris doctrine pull", () => {
  it("writes a verified tree the offline verbs read, and path names it through the org's link", async () => {
    /** When pull writes files that do not reproduce the bundle, or path names the staging dir instead of the link, `check --file $(eris doctrine path)` reads the wrong doctrine or none: observed on stdout and the tree. */
    const r = await doctrine(["pull"]);
    expect(r).toEqual({ rc: 0, stdout: `${ORG}\t${sha}\n`, stderr: "" });
    expect(hits.map((h) => h.path).sort()).toEqual(["/v1/gates/policy", "/v1/gates/settings"]);
    expect(hits.every((h) => h.auth === `Bearer ${LOGIN}`)).toBe(true);
    expect(readlinkSync(linked())).toMatch(new RegExp(`^\\.${ORG}\\.${sha}\\.`));
    const manifest = JSON.parse(readFileSync(join(linked(), "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ contract: "gates-contract/v1.5", org: ORG, bundle_sha: sha, settings: SETTINGS, pulled_at: "2026-11-17T12:00:00.000Z" });
    expect(Object.keys(manifest.files).sort()).toEqual(["doctrine.md", "loops/one-shot.md", "profiles.yaml"]);

    const p = await doctrine(["path"]);
    expect(p).toEqual({ rc: 0, stdout: `${join(linked(), "doctrine.md")}\n`, stderr: "" });
    const check = await doctrine(["check", "--file", p.stdout.trim()]);
    expect(check).toEqual({ rc: 0, stdout: " rapid-prototype\tpolicy\n*business-as-usual\tpolicy\n", stderr: "" });
  });

  it("json: { org, bundle_sha, dir } and nothing on stderr", async () => {
    /** When json mode prints the text row or a note on stderr, a caller parsing the pull breaks: observed on both streams. */
    const r = await doctrine(["pull"], "json");
    expect(r.rc).toBe(0);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual({ org: ORG, bundle_sha: sha, dir: realpathSync(linked()) });
  });

  it("is the fix for an edited tree: path refuses it, pull replaces it without reading it, path accepts the new one", async () => {
    /** When pull verifies the old tree first, doctrine-local-modified's own fix ('run eris doctrine pull') can never succeed; when path skips verification, an edited doctrine is trusted: observed on the exit codes and slugs. */
    expect((await doctrine(["pull"])).rc).toBe(0);
    appendFileSync(join(linked(), "doctrine.md"), "- an edit\n");
    const edited = await doctrine(["path"]);
    expect(edited.rc).toBe(3);
    expect(edited.stdout).toBe("");
    expect(slugOf(edited.stderr)).toBe("doctrine-local-modified");
    expect(edited.stderr).toContain("doctrine.md was edited");
    expect((await doctrine(["pull"])).rc).toBe(0);
    expect((await doctrine(["path"])).rc).toBe(0);
  });

  it("refuses a bundle whose sha the values do not hash to, and keeps the tree it had", async () => {
    /** When the client trusts the server's bundle_sha, a tampered or mis-hashed bundle replaces the org's policy: observed on the slug and on the link still naming the old tree. */
    expect((await doctrine(["pull"])).rc).toBe(0);
    const before = readlinkSync(linked());
    routes["GET /v1/gates/policy"] = () => policyReply("aaaaaaaaaaaa");
    routes["GET /v1/gates/settings"] = () => settingsReply("aaaaaaaaaaaa");
    const r = await doctrine(["pull"]);
    expect(r.rc).toBe(3);
    expect(r.stdout).toBe("");
    expect(slugOf(r.stderr)).toBe("gate-contract-mismatch");
    expect(readlinkSync(linked())).toBe(before);
  });

  it("reads once more when policy and settings name different shas, then refuses if they still do", async () => {
    /** When a save lands between the two reads and the client pairs them anyway, the tree holds one version's policy with another's settings; when it retries forever a busy org hangs the pull: observed on the request count and slug. */
    let settingsCalls = 0;
    routes["GET /v1/gates/settings"] = () => (++settingsCalls === 1 ? settingsReply("bbbbbbbbbbbb") : settingsReply());
    expect((await doctrine(["pull"])).rc).toBe(0);
    expect(settingsCalls).toBe(2);

    hits = [];
    routes["GET /v1/gates/settings"] = () => settingsReply("bbbbbbbbbbbb");
    const r = await doctrine(["pull"]);
    expect(r.rc).toBe(3);
    expect(slugOf(r.stderr)).toBe("gate-store-unreachable");
    expect(hits.length).toBe(4);
  });

  it.each([
    [401, "invalid_token", "eris-login-required"],
    [403, "forbidden", "gate-store-forbidden"],
    [402, "payment_required", "gate-store-forbidden"],
    [503, "unavailable", "gate-store-unreachable"],
    [409, "conflict", "gate-contract-mismatch"],
  ])("maps HTTP %d (%s) to %s, without the bearer in the block", async (status, code, slug) => {
    /** When a status maps to the wrong slug, the failure block's fix sends the user to the wrong remedy (a login for an outage); when the bearer reaches stderr it lands in a log: observed on the slug and stderr. */
    routes["GET /v1/gates/policy"] = () => problem(status, code);
    const r = await doctrine(["pull"]);
    expect(r.rc).toBe(3);
    expect(slugOf(r.stderr)).toBe(slug);
    expect(r.stderr).not.toContain(LOGIN);
  });

  it("refuses a 200 whose body the contract does not describe", async () => {
    /** When an undecoded body reaches the tree writer, a proxy's HTML page or an older contract becomes the org's policy: observed on the slug. */
    routes["GET /v1/gates/policy"] = () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } });
    const r = await doctrine(["pull"]);
    expect(r.rc).toBe(3);
    expect(slugOf(r.stderr)).toBe("gate-contract-mismatch");
  });

  it("never sends the bearer to a plain-http host that is not loopback", async () => {
    /** When the origin check is missing, a login URL typed as http:// sends the org bearer in cleartext: observed by a fetch spy that must never be called. */
    login("http://example.invalid");
    const r = await doctrine(["pull"]);
    expect(r.rc).toBe(3);
    expect(slugOf(r.stderr)).toBe("login-url-refused");
    let called = 0;
    const spy = (() => {
      called++;
      return Promise.reject(new Error("no"));
    }) as unknown as typeof fetch;
    for (const url of ["http://example.invalid", "http://10.0.0.1", "ftp://x", "not a url"]) expect(gatesEndpoint(url, LOGIN, { fetch: spy }).ok).toBe(false);
    for (const url of ["https://gates.example.com", "http://localhost:8080", "http://127.0.0.1:1", "http://[::1]:2"]) expect(gatesEndpoint(url, LOGIN, { fetch: spy }).ok).toBe(true);
    expect(called).toBe(0);
  });

  it("with no login: pull asks for one, path says nothing is pulled", async () => {
    /** When a missing login surfaces as a raw resolver slug or a crash, the user is not told to run eris login; when path invents a default file, a verb reads doctrine nobody pulled: observed on the slugs. */
    rmSync(join(home, ".eris", "yaks.json"));
    const pull = await doctrine(["pull"]);
    expect(pull.rc).toBe(3);
    expect(slugOf(pull.stderr)).toBe("eris-login-required");
    expect(hits.length).toBe(0);
    const path = await doctrine(["path"]);
    expect(path.rc).toBe(3);
    expect(slugOf(path.stderr)).toBe("doctrine-file-missing");
  });

  it("path with a login but no pull is doctrine-file-missing", async () => {
    /** When path prints the link path before anything is pulled, `check --file $(eris doctrine path)` fails on a missing file with no remedy named: observed on the slug and stdout. */
    const r = await doctrine(["path"]);
    expect(r.rc).toBe(3);
    expect(r.stdout).toBe("");
    expect(slugOf(r.stderr)).toBe("doctrine-file-missing");
  });

  it("with no --file, check and gates read the pulled tree; an edited tree is refused unless --file names another", async () => {
    /** When the offline verbs ignore the pulled tree, an org's own doctrine never governs them; when they read it unverified, an edited doctrine is trusted: observed on stdout and the slug. */
    expect((await doctrine(["pull"])).rc).toBe(0);
    expect(await doctrine(["check"])).toEqual({ rc: 0, stdout: " rapid-prototype\tpolicy\n*business-as-usual\tpolicy\n", stderr: "" });
    const gates = await doctrine(["gates"]);
    expect(gates.rc).toBe(0);
    expect(gates.stdout).toContain("@user-impact\t");
    appendFileSync(join(linked(), "doctrine.md"), "- an edit\n");
    const edited = await doctrine(["check"]);
    expect({ rc: edited.rc, stdout: edited.stdout, slug: slugOf(edited.stderr) }).toEqual({ rc: 3, stdout: "", slug: "doctrine-local-modified" });
    expect((await doctrine(["gates"])).rc).toBe(3);
    // A named file never reads the tree, so the edit cannot fail it.
    const named = await doctrine(["check", "--file", resolve(REPO, "tests/fixtures/doctrine/doctrine.md")]);
    expect(named.stderr).not.toContain("doctrine-local-modified");
  });

  it("the after-login pull writes the tree and says so on stderr only", async () => {
    /** When the post-login pull prints on stdout, a script reading the login's line breaks; when it does not write the tree, the org has no doctrine until a manual pull: observed on both streams and the link. */
    let out = "";
    let err = "";
    await seedAfterLogin({ home, cwd: sandbox, now: () => new Date("2026-11-17T12:00:00.000Z") })({
      erisDir: REPO,
      env: { PATH: process.env.PATH, HOME: home },
      format: "text",
      stdout: { write: (s: string) => ((out += s), true) },
      stderr: { write: (s: string) => ((err += s), true) },
    });
    expect({ out, err }).toEqual({ out: "", err: `INFO pulled org ${ORG} policy ${sha}\n` });
    expect(readlinkSync(linked())).toMatch(new RegExp(`^\\.${ORG}\\.${sha}\\.`));
  });
});
