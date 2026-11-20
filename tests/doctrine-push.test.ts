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
import { bundleChanges, computeGatesBundleSha, type GatesOrgBundle, type GatesSettings } from "eris/gates-contract";
import { doctrineHandler } from "../plugins/doctrine/doctrine";
import { CliExit } from "../src/cli/ts-verb";

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, "..");
const ORG = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const LOGIN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const APPROVAL = ["mnd", ORG, "ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210_-ZyXwV"].join("_");

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
let putAnswer: ((body: Record<string, unknown>) => Response | null) | null;

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
        const body = (await req.json()) as { bundle: GatesOrgBundle; mandate_handle?: string };
        puts.push({ auth: req.headers.get("authorization"), body });
        const answer = putAnswer?.(body) ?? null;
        if (answer !== null) return answer;
        live = body.bundle;
        liveSha = await computeGatesBundleSha(live, SETTINGS);
        const passkey = body.mandate_handle !== undefined;
        return Response.json({
          contract: "gates-contract/v1.5",
          version: 7,
          bundle_sha: liveSha,
          saved_at: "2026-11-17T12:30:00.000Z",
          widened: passkey,
          reasons: passkey ? ["loop one-shot edited", "posture business-as-usual loosened"] : [],
          auth_mode: passkey ? "mandate_passkey" : "cli",
        });
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

async function doctrine(args: string[], format: "text" | "json" = "text", env: Record<string, string> = {}) {
  let stdout = "";
  let stderr = "";
  let rc: number;
  try {
    rc = await doctrineHandler({}, () => "", { home, cwd: sandbox, now: () => new Date("2026-11-17T12:00:00.000Z") })(args, {
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
    expect(r).toEqual({ rc: 0, stdout: `org ${ORG}\tbundle_sha ${liveSha}\tversion unchanged\n`, stderr: "" });
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
    expect(r.stderr).toBe("INFO changed: posture business-as-usual changed\n");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.auth).toBe(`Bearer ${LOGIN}`);
    expect((puts[0]!.body as { bundle: GatesOrgBundle }).bundle.postures["business-as-usual"]!.bullets).toEqual(["The default, edited.", "The established process."]);
    expect(Object.keys(puts[0]!.body as object)).toEqual(["bundle"]);
    expect(r.stdout).toBe(`org ${ORG}\tbundle_sha ${liveSha}\tversion 7\n`);
    expect(liveSha).not.toBe(await computeGatesBundleSha(BUNDLE, SETTINGS));
    const path = await doctrine(["path"]);
    expect(path.rc).toBe(0);
    expect((await doctrine(["check", "--file", path.stdout.trim()])).rc).toBe(0);
    expect(readFileSync(join(linked(), "doctrine.md"), "utf8")).toContain("The default, edited.");
  });

  it("json: { org, bundle_sha, version, saved_at, dir, pushed, widened, reasons, auth_mode, changed }", async () => {
    /** When json mode prints the text row, a caller parsing the push breaks: observed on stdout. */
    expect((await doctrine(["pull"])).rc).toBe(0);
    edit();
    const r = await doctrine(["push"], "json");
    expect(r.rc).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      org: ORG,
      bundle_sha: liveSha,
      version: 7,
      saved_at: "2026-11-17T12:30:00.000Z",
      dir: realpathSync(linked()),
      pushed: true,
      widened: false,
      reasons: [],
      auth_mode: "cli",
      changed: ["posture business-as-usual changed"],
    });
    expect(r.stderr).toBe("");
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
    [403, "policy_widening_requires_passkey", "doctrine-push-needs-approval"],
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
    expect(r.stderr).not.toContain("INFO");
    expect(puts).toHaveLength(1);
    expect(treeState()).toEqual(before);
    expect(r.stderr).not.toContain(LOGIN);
  });

  // admits: integration: a widening save without an approval must tell the operator where to get one; the slug, the dash URL and the env var are the whole recovery path, and only the gateway's answer reaches them.
  it("names the approval page and ERIS_GATES_APPROVAL when the gateway wants a passkey approval", async () => {
    expect((await doctrine(["pull"])).rc).toBe(0);
    edit();
    putAnswer = () => problem(403, "policy_widening_requires_passkey");
    const r = await doctrine(["push"]);
    expect(slugOf(r.stderr)).toBe("doctrine-push-needs-approval");
    expect(r.stderr).toContain("https://dash.sibylline.group/gates/approve");
    expect(r.stderr).toContain("ERIS_GATES_APPROVAL=<handle> eris doctrine push");
  });

  // admits: integration: an admin refusal must send the operator to 'eris login' as an admin, never to a per-org switch the gateway no longer reads.
  it("tells a non-admin bearer to sign in as an org admin, naming no flag", async () => {
    expect((await doctrine(["pull"])).rc).toBe(0);
    edit();
    putAnswer = () => problem(403, "admin_required");
    const r = await doctrine(["push"]);
    expect(slugOf(r.stderr)).toBe("doctrine-push-refused");
    expect(r.stderr).toContain("eris login");
    expect(r.stderr.toLowerCase()).not.toContain("flag");
  });

  // admits: boundary-io: the approval must ride in the one PUT as mandate_handle beside bundle, or a widening save never lands; and it is a bearer capability, so no output may echo it.
  it("sends ERIS_GATES_APPROVAL as mandate_handle in the one PUT, saves, and never prints it", async () => {
    expect((await doctrine(["pull"])).rc).toBe(0);
    edit();
    putAnswer = (body) => (body.mandate_handle === undefined ? problem(403, "policy_widening_requires_passkey") : null);
    const r = await doctrine(["push"], "text", { ERIS_GATES_APPROVAL: APPROVAL });
    expect(r.rc).toBe(0);
    expect(puts).toHaveLength(1);
    expect(Object.keys(puts[0]!.body as object)).toEqual(["bundle", "mandate_handle"]);
    expect((puts[0]!.body as { mandate_handle: string }).mandate_handle).toBe(APPROVAL);
    expect(r.stdout).toBe(`org ${ORG}\tbundle_sha ${liveSha}\tversion 7\n`);
    expect(r.stderr).toBe("INFO changed: posture business-as-usual changed\nINFO widened (mandate_passkey): loop one-shot edited; posture business-as-usual loosened\n");
    const json = await doctrine(["push"], "json", { ERIS_GATES_APPROVAL: APPROVAL });
    expect(`${r.stdout}${r.stderr}${json.stdout}${json.stderr}`).not.toContain(APPROVAL);
  });

  // admits: boundary-io: a mistyped approval must stop before the network, without echoing the value, rather than spend a request on a 400 the server will not explain.
  it("refuses a malformed ERIS_GATES_APPROVAL before any request, without echoing it", async () => {
    expect((await doctrine(["pull"])).rc).toBe(0);
    edit();
    const before = treeState();
    hits = [];
    const bad = `mnd_${"x".repeat(20)}-not-a-handle`;
    const r = await doctrine(["push"], "text", { ERIS_GATES_APPROVAL: bad });
    expect(r.rc).toBe(3);
    expect(slugOf(r.stderr)).toBe("doctrine-push-needs-approval");
    expect(r.stderr).not.toContain(bad);
    expect(hits).toEqual([]);
    expect(treeState()).toEqual(before);
  });

  // admits: integration: when the mandate service refuses the sent approval (401 revoked included), the operator must be sent to approve again, not to 'eris login' or a contract-mismatch dead end.
  it.each([
    [403, "expired"],
    [403, "exhausted"],
    [403, "not_covered"],
    [401, "revoked"],
    [404, "unknown_mandate"],
    [403, "mandate_out_of_path"],
  ])("maps a refusal of the sent approval (%i %s) to doctrine-push-needs-approval, approve again", async (status, code) => {
    expect((await doctrine(["pull"])).rc).toBe(0);
    edit();
    const before = treeState();
    putAnswer = () => problem(status, code);
    const r = await doctrine(["push"], "text", { ERIS_GATES_APPROVAL: APPROVAL });
    expect(r.rc).toBe(3);
    expect(slugOf(r.stderr)).toBe("doctrine-push-needs-approval");
    expect(r.stderr).toContain("approve again at https://dash.sibylline.group/gates/approve");
    expect(r.stderr).not.toContain(APPROVAL);
    expect(treeState()).toEqual(before);
  });

  // admits: integration: a 409 after an approval was sent may have spent it; the stale refusal must say so, or the rerun after a pull fails again on a used approval.
  it("says the approval may have been used when the save is stale after one was sent", async () => {
    expect((await doctrine(["pull"])).rc).toBe(0);
    edit();
    putAnswer = () => problem(409, "policy_version_conflict");
    const r = await doctrine(["push"], "text", { ERIS_GATES_APPROVAL: APPROVAL });
    expect(slugOf(r.stderr)).toBe("doctrine-push-stale");
    expect(r.stderr).toContain("Your approval may have been used; approve again at https://dash.sibylline.group/gates/approve.");
    const plain = await doctrine(["push"]);
    expect(plain.stderr).not.toContain("Your approval");
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

  // admits: integration: red on main — lax GatesOrgBundle decode strips signoff.unlock so push prints unchanged and overwrites the edited tree; observed on exit status, slug, key path, request log and on-disk tree bytes.
  it("refuses a posture policy key the bundle contract does not carry (signoff.unlock) before any request, leaving the tree intact", async () => {
    /** When push decodes a posture policy laxly, an unsupported key such as signoff.unlock is stripped, bundle_sha still matches live, and push prints unchanged while discarding the edit: observed on the exit status, slug, stderr key path, request log and tree bytes. */
    live = {
      ...BUNDLE,
      postures: {
        ...BUNDLE.postures,
        "business-as-usual": {
          ...BUNDLE.postures["business-as-usual"]!,
          policy: { ...BUNDLE.postures["business-as-usual"]!.policy, signoff: { "one-way": "human", "two-way": "self" } },
        },
      },
    };
    liveSha = await computeGatesBundleSha(live, SETTINGS);
    expect((await doctrine(["pull"])).rc).toBe(0);
    const docPath = join(linked(), "doctrine.md");
    const orig = readFileSync(docPath, "utf8");
    const bauAt = orig.indexOf("## business-as-usual");
    const edited = orig.slice(0, bauAt) + orig.slice(bauAt).replace("two-way: self\n", "two-way: self\n    unlock: on\n");
    expect(edited).not.toBe(orig);
    writeFileSync(docPath, edited);
    const before = treeState();
    hits = [];
    const r = await doctrine(["push"]);
    expect(r.rc).toBe(3);
    expect(r.stdout).toBe("");
    expect(slugOf(r.stderr)).toBe("doctrine-push-invalid");
    expect(r.stderr).toContain("doctrine.md: business-as-usual: policy.signoff.unlock");
    expect(r.stderr).not.toContain("doctrine check");
    expect(hits).toEqual([]);
    expect(treeState()).toEqual(before);
  });

  // admits: algorithmic: covers nested policy structs, fence-root sibling keys, profiles.yaml union objects and co-occurring valid edits without echoing rejected values.
  it("refuses unknown keys alongside a real edit across policy, fence root and profiles.yaml, naming every key and echoing no value", async () => {
    /** When an unsupported key rides beside a real edit, at the fence root or inside a profiles.yaml object, lax decode would save the rest and drop the key silently; values must never echo in the refusal: observed on stderr, request log and tree bytes. */
    expect((await doctrine(["pull"])).rc).toBe(0);
    const sentinel = "NEVER_ECHO_VALUE_9911";
    const docPath = join(linked(), "doctrine.md");
    const orig = readFileSync(docPath, "utf8");
    const bauAt = orig.indexOf("## business-as-usual");
    const editedDoc =
      orig.slice(0, bauAt) +
      orig
        .slice(bauAt)
        .replace("- The default.", "- The default, edited.")
        .replace("  profile_default: deep\n", `  profile_default: deep\n  signoff:\n    one-way: human\n    unlock: ${sentinel}\n  ask:\n    session_budget: 5\n  user_impact:\n    U4:\n      - e2e\n`)
        .replace("\n```\n", "\nextra_root: true\n```\n");
    writeFileSync(docPath, editedDoc);
    const profPath = join(linked(), "profiles.yaml");
    writeFileSync(profPath, `${readFileSync(profPath, "utf8")}custom:\n  require:\n    - final-gates\n  extra_prof: ${sentinel}\n`);
    const before = treeState();
    hits = [];
    const r = await doctrine(["push"]);
    expect(r.rc).toBe(3);
    expect(slugOf(r.stderr)).toBe("doctrine-push-invalid");
    for (const keyPath of [
      "doctrine.md: business-as-usual: extra_root",
      "doctrine.md: business-as-usual: policy.ask",
      "doctrine.md: business-as-usual: policy.signoff.unlock",
      "doctrine.md: business-as-usual: policy.user_impact.U4",
      "profiles.yaml: custom.extra_prof",
    ]) {
      expect(r.stderr).toContain(keyPath);
    }
    expect(`${r.stdout}${r.stderr}`).not.toContain(sentinel);
    expect(hits).toEqual([]);
    expect(treeState()).toEqual(before);
  });

  // admits: boundary-io: positive control proving strict unknown-key rejection still accepts YAML comments/layout normalization and open Record maps (gates, close).
  it("still accepts YAML comments and custom Record keys (gates, close) when pushing", async () => {
    /** When strict decoding treats open Record maps or YAML comments as unknown keys, legitimate hand-edits break: observed on unchanged and saved push outcomes. */
    expect((await doctrine(["pull"])).rc).toBe(0);
    const docPath = join(linked(), "doctrine.md");
    const orig = readFileSync(docPath, "utf8");
    const bauAt = orig.indexOf("## business-as-usual");
    writeFileSync(docPath, orig.slice(0, bauAt) + orig.slice(bauAt).replace("policy:\n", "# operator note\npolicy:\n"));
    const noop = await doctrine(["push"]);
    expect(noop.rc).toBe(0);
    expect(noop.stdout).toBe(`org ${ORG}\tbundle_sha ${liveSha}\tversion unchanged\n`);
    expect(puts).toEqual([]);
    const nextDoc = readFileSync(join(linked(), "doctrine.md"), "utf8");
    const bau2 = nextDoc.indexOf("## business-as-usual");
    writeFileSync(
      join(linked(), "doctrine.md"),
      nextDoc.slice(0, bau2) + nextDoc.slice(bau2).replace("  profile_default: deep\n", "  profile_default: deep\n  gates:\n    custom-gate: on\n  close:\n    custom-close: off\n"),
    );
    const saved = await doctrine(["push"]);
    expect(saved.rc).toBe(0);
    expect(puts).toHaveLength(1);
    expect(live.postures["business-as-usual"]?.policy.gates?.["custom-gate"]).toBe("on");
    expect(live.postures["business-as-usual"]?.policy.close?.["custom-close"]).toBe("off");
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

describe("bundleChanges", () => {
  // admits: algorithmic: the changed list is the operator's only summary of what a save touched; a missed or misnamed part (a removed posture read as unchanged, a loop edit hidden) misreports the save.
  it("names active, each posture and loop by kind of change, and profiles; none for an equal bundle", () => {
    expect(bundleChanges(BUNDLE, structuredClone(BUNDLE))).toEqual([]);
    const next = structuredClone(BUNDLE) as { -readonly [K in keyof GatesOrgBundle]: GatesOrgBundle[K] } & Record<string, unknown>;
    const postures = next.postures as Record<string, unknown>;
    const loops = next.loops as Record<string, string>;
    next.active = "rapid-prototype";
    delete postures["business-as-usual"];
    postures["lock-in"] = { name: "Lock in", bullets: ["Careful."], policy: {} };
    (postures["rapid-prototype"] as { bullets: string[] }).bullets = ["Faster."];
    (next.profiles as Record<string, unknown>).extra = ["final-gates"];
    loops["one-shot"] = "# One shot\n\nEdited.\n";
    loops["sweep"] = "# Sweep\n";
    expect(bundleChanges(BUNDLE, next as GatesOrgBundle)).toEqual([
      "active",
      "posture business-as-usual removed",
      "posture lock-in added",
      "posture rapid-prototype changed",
      "profiles",
      "loop one-shot edited",
      "loop sweep added",
    ]);
    const dropped = structuredClone(BUNDLE) as GatesOrgBundle;
    delete (dropped.loops as Record<string, string>)["one-shot"];
    expect(bundleChanges(BUNDLE, dropped)).toEqual(["loop one-shot removed"]);
  });

  // admits: algorithmic: a re-rendered tree reorders object keys; reading key order as a change would report every untouched posture as changed.
  it("ignores key order", () => {
    const reversed = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).reverse()) as T;
    const postures = Object.fromEntries(Object.entries(BUNDLE.postures).map(([slug, p]) => [slug, reversed(p)]));
    const reordered = { loops: BUNDLE.loops, profiles: reversed(BUNDLE.profiles), postures, active: BUNDLE.active } as GatesOrgBundle;
    expect(bundleChanges(BUNDLE, reordered)).toEqual([]);
  });
});
