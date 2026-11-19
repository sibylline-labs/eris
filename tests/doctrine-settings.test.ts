/**
 * `eris doctrine settings` and `eris doctrine history`, over the gates client.
 *
 * The seam is the doctrine handler with a loopback `Bun.serve` standing in for the gateway's
 * `/v1/gates/{policy,settings,policy/history}` routes, and a sandbox HOME (under .scratch/) holding the
 * login. Every request crosses real HTTP; the server keeps the stored versions, so a save changes what
 * the next read returns. The bearer and the approval are assembled at runtime so no literal trips a
 * secret scanner. The PUT body, reply and refusal codes are those the gateway's own tests assert.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { computeGatesBundleSha, type GatesOrgBundle, type GatesSettings } from "eris/gates-contract";
import { doctrineHandler } from "../plugins/doctrine/doctrine";
import { CliExit } from "../src/cli/ts-verb";

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, "..");
const ORG = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const LOGIN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const APPROVAL = ["mnd", ORG, "ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210_-ZyXwV"].join("_");

const BUNDLE = {
  active: "business-as-usual",
  postures: { "business-as-usual": { name: "Business as usual", bullets: ["The default."], policy: { profile_default: "spine" } } },
  profiles: { spine: ["understand-scope", "final-gates"] },
  loops: {},
} as unknown as GatesOrgBundle;
const SEED: GatesSettings = { staleness: "soft", ci: { check_profile_in_ci: "on", untracked_prs: "block", bot_allowlist: ["dependabot[bot]"] } };

type Stored = { version: number; settings: GatesSettings; bundle_sha: string; auth_mode: string };

let sandbox: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let versions: Stored[];
let puts: { auth: string | null; body: Record<string, unknown> }[];
let hits: string[];
let putAnswer: Response | null;

const problem = (status: number, code: string) => Response.json({ type: "about:blank", status, code }, { status, headers: { "content-type": "application/problem+json" } });
const latest = () => versions[versions.length - 1]!;

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "doctrine-settings-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      hits.push(`${req.method} ${url.pathname}`);
      const contract = "gates-contract/v1.5";
      if (req.method === "GET" && url.pathname === "/v1/gates/policy") return Response.json({ contract, bundle: BUNDLE, bundle_sha: latest().bundle_sha });
      if (req.method === "GET" && url.pathname === "/v1/gates/settings") return Response.json({ contract, settings: latest().settings, bundle_sha: latest().bundle_sha });
      if (req.method === "GET" && url.pathname === "/v1/gates/policy/history") {
        return Response.json({ contract, versions: versions.map((v) => ({ ...v, saved_at: `2026-11-1${v.version}T12:00:00.000Z`, widened: false, reasons: [], bundle: BUNDLE })) });
      }
      if (req.method === "PUT" && url.pathname === "/v1/gates/settings") {
        const body = (await req.json()) as { settings: GatesSettings; expected_version?: number; mandate_handle?: string };
        puts.push({ auth: req.headers.get("authorization"), body });
        if (putAnswer !== null) return putAnswer;
        const sha = await computeGatesBundleSha(BUNDLE, body.settings);
        versions.push({ version: latest().version + 1, settings: body.settings, bundle_sha: sha, auth_mode: body.mandate_handle === undefined ? "portal_admin" : "mandate_passkey" });
        return Response.json({ contract, version: latest().version, bundle_sha: sha, saved_at: "2026-11-18T12:30:00.000Z", widened: body.mandate_handle !== undefined, reasons: body.mandate_handle !== undefined ? ["ci.untracked_prs loosened"] : [], auth_mode: latest().auth_mode });
      }
      return problem(404, "not_found");
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(sandbox, "home-")));
  mkdirSync(join(home, ".eris"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".eris", "yaks.json"), JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token: LOGIN }), { mode: 0o600 });
  versions = [{ version: 1, settings: SEED, bundle_sha: await computeGatesBundleSha(BUNDLE, SEED), auth_mode: "seed" }];
  puts = [];
  hits = [];
  putAnswer = null;
});

async function doctrine(args: string[], format: "text" | "json" = "text", env: Record<string, string> = {}) {
  let stdout = "";
  let stderr = "";
  let rc: number;
  try {
    rc = await doctrineHandler({}, () => "", { home, cwd: sandbox })(args, {
      erisDir: REPO,
      env: { PATH: process.env.PATH, HOME: home, ...env },
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

describe("eris doctrine settings", () => {
  // admits: a show that prints the wrong key or drops one turns this red; observed in stdout.
  it("show prints one key per line, an absent optional as '-', and reads only", async () => {
    const r = await doctrine(["settings"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toBe("skills_repo\t-\nstaleness\tsoft\nci.check_profile_in_ci\ton\nci.untracked_prs\tblock\nci.bot_allowlist\tdependabot[bot]\nspend_cap_calls\t-\n");
    expect(hits.some((h) => h.startsWith("PUT"))).toBe(false);
  });

  // admits: JSON that drops bundle_sha or renames settings breaks every script reading it.
  it("show --output json is { org, bundle_sha, settings }", async () => {
    const j = JSON.parse((await doctrine(["settings", "show"], "json")).stdout);
    expect(j).toEqual({ org: ORG, bundle_sha: versions[0]!.bundle_sha, settings: SEED });
  });

  // admits: a set that sends the whole settings wrong (loses a sibling key), or omits the bearer or the
  // base version, turns this red; observed in the PUT body the loopback server records.
  it("set sends the full edited settings once, with the bearer and the newest version as the base", async () => {
    const r = await doctrine(["settings", "set", "skills_repo", "acme/skills"]);
    expect(r.rc).toBe(0);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.auth).toBe(`Bearer ${LOGIN}`);
    expect(puts[0]!.body).toEqual({ settings: { ...SEED, skills_repo: "acme/skills" }, expected_version: 1 });
    expect(r.stdout.split("\t")).toEqual([`org ${ORG}`, `bundle_sha ${latest().bundle_sha}`, "version 2\n"]);
    expect(r.stderr).toContain("INFO changed: skills_repo");
  });

  // admits: a type error turning the list or the cap into a string, or 'unset' not dropping the key.
  it("set reads each key's value: list, cap, enum, and 'unset' drops an optional", async () => {
    await doctrine(["settings", "set", "ci.bot_allowlist", "renovate[bot], dependabot[bot]"]);
    await doctrine(["settings", "set", "spend_cap_calls", "5000"]);
    await doctrine(["settings", "set", "staleness", "hard"]);
    expect(latest().settings).toEqual({ staleness: "hard", ci: { check_profile_in_ci: "on", untracked_prs: "block", bot_allowlist: ["renovate[bot]", "dependabot[bot]"] }, spend_cap_calls: 5000 });
    await doctrine(["settings", "set", "spend_cap_calls", "unset"]);
    expect("spend_cap_calls" in latest().settings).toBe(false);
  });

  // admits: a no-op set that still saves burns a version and a Mandate approval.
  it("set to the value a key already holds sends no PUT and prints 'unchanged'", async () => {
    const r = await doctrine(["settings", "set", "staleness", "soft"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toBe(`org ${ORG}\tbundle_sha ${versions[0]!.bundle_sha}\tversion unchanged\n`);
    expect(puts).toHaveLength(0);
  });

  // admits: a bad key or value reaching the gateway as a save; observed as no PUT and exit 2.
  it("refuses an unknown key, a bad enum, a bad repo and a bad cap before any save", async () => {
    for (const args of [["bogus", "x"], ["staleness", "firm"], ["skills_repo", "not a repo"], ["spend_cap_calls", "-3"], ["spend_cap_calls", "1.5"], ["ci.bot_allowlist", "bad login"]]) {
      const r = await doctrine(["settings", "set", ...args]);
      expect(r.rc).toBe(2);
      expect(slugOf(r.stderr)).toBe("doctrine-usage");
    }
    expect(puts).toHaveLength(0);
    expect((await doctrine(["settings", "set", "staleness"])).rc).toBe(2);
  });

  // admits: a stale read-modify-write overwriting a save made after this one read; observed as the 409 slug.
  it("a save landing between the read and the PUT is refused, doctrine-push-stale, never overwritten", async () => {
    putAnswer = problem(409, "policy_version_conflict");
    const r = await doctrine(["settings", "set", "staleness", "hard"]);
    expect(r.rc).toBe(3);
    expect(slugOf(r.stderr)).toBe("doctrine-push-stale");
    expect(r.stderr).toContain("eris doctrine settings show");
    expect(puts).toHaveLength(1);
  });

  // admits: a widening on a Mandate org reaching the user as a generic failure instead of the approval page.
  it("names the approval page and ERIS_GATES_APPROVAL when a widening needs a passkey", async () => {
    putAnswer = problem(403, "policy_widening_requires_passkey");
    const r = await doctrine(["settings", "set", "ci.untracked_prs", "allow"]);
    expect(slugOf(r.stderr)).toBe("doctrine-push-needs-approval");
    expect(r.stderr).toContain("ERIS_GATES_APPROVAL=<handle> eris doctrine settings set");
  });

  // admits: the handle printed anywhere, or not sent as mandate_handle in the one PUT.
  it("sends ERIS_GATES_APPROVAL as mandate_handle in the one PUT, reports the widening, and never prints it", async () => {
    const r = await doctrine(["settings", "set", "ci.untracked_prs", "allow"], "text", { ERIS_GATES_APPROVAL: APPROVAL });
    expect(r.rc).toBe(0);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body.mandate_handle).toBe(APPROVAL);
    expect(r.stderr).toContain("INFO widened (mandate_passkey): ci.untracked_prs loosened");
    expect(r.stdout + r.stderr).not.toContain(APPROVAL);
  });

  // admits: a malformed handle sent to the gateway, or echoed back.
  it("refuses a malformed ERIS_GATES_APPROVAL before any request, without echoing it", async () => {
    const r = await doctrine(["settings", "set", "staleness", "hard"], "text", { ERIS_GATES_APPROVAL: "mnd_notahandle" });
    expect(slugOf(r.stderr)).toBe("doctrine-push-needs-approval");
    expect(r.stderr).not.toContain("mnd_notahandle");
    expect(hits).toHaveLength(0);
  });

  // admits: a member's bearer told to fix a flag instead of to sign in as an admin.
  it("tells a non-admin bearer to sign in as an org admin", async () => {
    putAnswer = problem(403, "admin_required");
    const r = await doctrine(["settings", "set", "staleness", "hard"]);
    expect(slugOf(r.stderr)).toBe("doctrine-push-refused");
    expect(r.stderr).toContain("org admin");
  });

  // admits: a signed-out machine sending a request, or exiting 0.
  it("with no login exits 3 and sends no request", async () => {
    rmSync(join(home, ".eris", "yaks.json"));
    const r = await doctrine(["settings"]);
    expect(r.rc).toBe(3);
    expect(hits).toHaveLength(0);
  });
});

describe("eris doctrine history", () => {
  // admits: history out of order, or dropping who saved a version (auth_mode); observed in stdout and JSON.
  it("lists every version oldest first with who saved it, and as JSON with the settings each held", async () => {
    await doctrine(["settings", "set", "staleness", "hard"]);
    const lines = (await doctrine(["history"])).stdout.trim().split("\n");
    expect(lines.map((l) => l.split("\t").slice(0, 3))).toEqual([["1", "2026-11-11T12:00:00.000Z", "seed"], ["2", "2026-11-12T12:00:00.000Z", "portal_admin"]]);
    const j = JSON.parse((await doctrine(["history"], "json")).stdout);
    expect(j.org).toBe(ORG);
    expect(j.versions[1].settings.staleness).toBe("hard");
    expect(j.versions[0].bundle).toBeUndefined();
  });
});
