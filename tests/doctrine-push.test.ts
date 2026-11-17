/**
 * `eris doctrine push`, over the gates client (docs/dev/GATES-CLIENT.md).
 *
 * The seam is the doctrine handler with a loopback `Bun.serve` standing in for the gateway's
 * `/v1/gates/policy` (GET and PUT) and `/settings` routes, and a sandbox HOME (under .scratch/) holding
 * the login and the pulled tree. Every request crosses real HTTP; the server counts them and keeps the
 * live bundle, so a save changes what the next read returns. The bearer is assembled at runtime so no
 * literal trips a secret scanner. The PUT body, reply and refusal codes are those the gateway's own
 * tests assert (apps/gates test/gates.test.ts); the live route is probed separately.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { computeGatesBundleSha, type GatesOrgBundle, type GatesSettings } from "eris/gates-contract";
import { doctrineHandler } from "../plugins/doctrine/doctrine";
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

let sandbox: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let live: GatesOrgBundle;
let liveSha: string;
let puts: { auth: string | null; body: unknown }[];
let hits: string[];
let putAnswer: (() => Response) | null;

const problem = (status: number, code: string) => Response.json({ type: "about:blank", status, code }, { status, headers: { "content-type": "application/problem+json" } });

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "doctrine-push-")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      hits.push(`${req.method} ${url.pathname}`);
      if (req.method === "GET" && url.pathname === "/v1/gates/policy") return Response.json({ contract: "gates-contract/v1.5", bundle: live, bundle_sha: liveSha });
      if (req.method === "GET" && url.pathname === "/v1/gates/settings") return Response.json({ contract: "gates-contract/v1.5", settings: SETTINGS, bundle_sha: liveSha });
      if (req.method === "PUT" && url.pathname === "/v1/gates/policy") {
        const body = (await req.json()) as { bundle: GatesOrgBundle };
        puts.push({ auth: req.headers.get("authorization"), body });
        if (putAnswer !== null) return putAnswer();
        live = body.bundle;
        liveSha = await computeGatesBundleSha(live, SETTINGS);
        return Response.json({ contract: "gates-contract/v1.5", version: 7, bundle_sha: liveSha, saved_at: "2026-11-17T12:30:00.000Z", widened: false, reasons: [], auth_mode: "portal_admin" });
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
  live = BUNDLE;
  liveSha = await computeGatesBundleSha(live, SETTINGS);
  puts = [];
  hits = [];
  putAnswer = null;
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

/** Every file under the org's tree with its bytes, and the directory the link names. */
function treeState(): { dir: string; files: Record<string, string> } {
  const dir = realpathSync(linked());
  const files: Record<string, string> = {};
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) for (const l of readdirSync(join(dir, e.name))) files[`${e.name}/${l}`] = readFileSync(join(dir, e.name, l), "utf8");
    else files[e.name] = readFileSync(join(dir, e.name), "utf8");
  }
  return { dir, files };
}

const edit = () => {
  const file = join(linked(), "doctrine.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("The default.", "The default, edited."));
};

describe("eris doctrine push", () => {
  it("saves nothing for an unedited tree: no PUT, the same tree, 'unchanged'", async () => {
    /** When push sends the tree it just pulled, every no-op push mints a policy version (and may widen it): observed on the PUT count and the tree bytes. */
    expect((await doctrine(["pull"])).rc).toBe(0);
    const before = treeState();
    hits = [];
    const r = await doctrine(["push"]);
    expect(r).toEqual({ rc: 0, stdout: `${ORG}\t${liveSha}\tunchanged\n`, stderr: "" });
    expect(puts).toEqual([]);
    expect(hits.some((h) => h.startsWith("PUT"))).toBe(false);
    expect(treeState().files).toEqual(before.files);
  });

  it("saves an edit once, with the bearer, and swaps in the saved bundle as a tree the offline verbs read", async () => {
    /** When push PUTs a bundle other than the edited files, or swaps in the old tree, the operator's edit is lost or never live: observed on the PUT body, the reply row and 'doctrine check' over the new tree. */
    expect((await doctrine(["pull"])).rc).toBe(0);
    edit();
    const r = await doctrine(["push"]);
    expect(r.rc).toBe(0);
    expect(r.stderr).toBe("");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.auth).toBe(`Bearer ${LOGIN}`);
    expect((puts[0]!.body as { bundle: GatesOrgBundle }).bundle.postures["business-as-usual"]!.bullets).toEqual(["The default, edited.", "The established process."]);
    expect(Object.keys(puts[0]!.body as object)).toEqual(["bundle"]);
    expect(r.stdout).toBe(`${ORG}\t${liveSha}\t7\n`);
    expect(liveSha).not.toBe(await computeGatesBundleSha(BUNDLE, SETTINGS));
    const path = await doctrine(["path"]);
    expect(path.rc).toBe(0);
    expect((await doctrine(["check", "--file", path.stdout.trim()])).rc).toBe(0);
    expect(readFileSync(join(linked(), "doctrine.md"), "utf8")).toContain("The default, edited.");
  });

  it("json: { org, bundle_sha, version, saved_at, dir, pushed }", async () => {
    /** When json mode prints the text row, a caller parsing the push breaks: observed on stdout. */
    expect((await doctrine(["pull"])).rc).toBe(0);
    edit();
    const r = await doctrine(["push"], "json");
    expect(r.rc).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ org: ORG, bundle_sha: liveSha, version: 7, saved_at: "2026-11-17T12:30:00.000Z", dir: realpathSync(linked()), pushed: true });
  });

  it("refuses a stale base without a PUT and leaves the edited tree byte for byte as it was", async () => {
    /** When push saves over a policy that moved since the pull, the newer save is silently reverted; when it clears the tree on refusal, the operator's edits are gone: observed on the slug, the PUT count and the tree bytes. */
    expect((await doctrine(["pull"])).rc).toBe(0);
    edit();
    const before = treeState();
    live = { ...BUNDLE, active: "rapid-prototype" };
    liveSha = await computeGatesBundleSha(live, SETTINGS);
    const r = await doctrine(["push"]);
    expect(r.rc).toBe(3);
    expect(r.stdout).toBe("");
    expect(slugOf(r.stderr)).toBe("doctrine-push-stale");
    expect(puts).toEqual([]);
    expect(treeState()).toEqual(before);
  });

  it.each([
    [403, "admin_required", "doctrine-push-refused"],
    [405, "method_not_allowed", "doctrine-push-refused"],
    [409, "policy_version_conflict", "doctrine-push-stale"],
    [413, "payload_too_large", "doctrine-push-invalid"],
    [422, "policy_invalid", "doctrine-push-invalid"],
    [401, "unauthorized", "eris-login-required"],
    [503, "unavailable", "gate-store-unreachable"],
    [418, "teapot", "gate-contract-mismatch"],
  ])("maps the gateway's %i %s to %s, sent once, and leaves the tree as it was", async (status, code, slug) => {
    /** When a refusal class maps to the wrong slug, the operator is told to fix the wrong thing (log in, pull, edit); when the client retries a refused save it can land twice: observed on the slug, the PUT count and the tree bytes. */
    expect((await doctrine(["pull"])).rc).toBe(0);
    edit();
    const before = treeState();
    putAnswer = () => problem(status, code);
    const r = await doctrine(["push"]);
    expect(r.rc).toBe(3);
    expect(slugOf(r.stderr)).toBe(slug);
    expect(puts).toHaveLength(1);
    expect(treeState()).toEqual(before);
    expect(r.stderr).not.toContain(LOGIN);
  });

  it("refuses a file a bundle does not carry before any request, naming it", async () => {
    /** When push drops a stray file the swap would delete it with the old tree; when it reads the network first a broken tree still costs a round trip: observed on the slug, the message and the request log. */
    expect((await doctrine(["pull"])).rc).toBe(0);
    writeFileSync(join(linked(), "notes.txt"), "keep me");
    hits = [];
    const r = await doctrine(["push"]);
    expect(r.rc).toBe(3);
    expect(slugOf(r.stderr)).toBe("doctrine-push-invalid");
    expect(r.stderr).toContain("notes.txt");
    expect(hits).toEqual([]);
    expect(readFileSync(join(linked(), "notes.txt"), "utf8")).toBe("keep me");
  });

  it("refuses an edit that no longer reads as a bundle before any request", async () => {
    /** When push sends a bundle the contract does not decode, the gateway sees a 422 for a mistake the client could name: observed on the slug and the request log. */
    expect((await doctrine(["pull"])).rc).toBe(0);
    const file = join(linked(), "profiles.yaml");
    writeFileSync(file, "spine: [unclosed\n");
    hits = [];
    const r = await doctrine(["push"]);
    expect(r.rc).toBe(3);
    expect(slugOf(r.stderr)).toBe("doctrine-push-invalid");
    expect(hits).toEqual([]);
  });

  it("with no pulled policy exits 3, doctrine-file-missing, without a request", async () => {
    /** When push has no base it would save whatever it finds: observed on the slug and the request log. */
    const r = await doctrine(["push"]);
    expect(r.rc).toBe(3);
    expect(slugOf(r.stderr)).toBe("doctrine-file-missing");
    expect(hits).toEqual([]);
  });

  it("with no login exits 3 and never sends a request", async () => {
    /** When push runs without a bearer it either crashes or sends one anonymously: observed on the slug and the request log. */
    rmSync(join(home, ".eris", "yaks.json"));
    const r = await doctrine(["push"]);
    expect(r.rc).toBe(3);
    expect(slugOf(r.stderr)).toBe("eris-login-required");
    expect(hits).toEqual([]);
  });
});
