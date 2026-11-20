/**
 * `eris doctrine pull`, `push` and `set` through the real `eris` entrypoint (the checkout's shim, or the
 * compiled binary under `ERIS_BIN`): argv routing, the registry's flags and operands, the output
 * contract and exit codes of a subprocess, against a loopback `Bun.serve` standing in for the gateway.
 * The in-process seams (doctrine-push.test.ts, doctrine-set.test.ts) cover each refusal; this is the one
 * path an operator runs: pull, edit the tree, push it, then switch a posture and comment an issue.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeGatesBundleSha, type GatesOrgBundle, type GatesSettings, policyHash, readDoctrine, renderBundle } from "eris/gates-contract";
import { sandbox, type Sandbox } from "./helpers/blackbox";

setDefaultTimeout(60_000);

const ORG = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const LOGIN = ["sib", ORG, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
const BUNDLE: GatesOrgBundle = {
  active: "business-as-usual",
  postures: {
    "rapid-prototype": { name: "Rapid prototype", bullets: ["Ship small experiments quickly."], policy: { profile_default: "spine", gates: { "premise-gate": "off" } } },
    "business-as-usual": { name: "Business as usual", bullets: ["The default."], policy: { profile_default: "deep" } },
  },
  profiles: { spine: ["understand-scope", "premise-gate", "plan-review", "final-gates"], deep: { require: ["understand-scope", "premise-gate", "sdk-check", "plan-review", "final-gates"] } },
  loops: {},
} as GatesOrgBundle;
const SETTINGS: GatesSettings = { staleness: "soft", ci: { check_profile_in_ci: "on", untracked_prs: "block", bot_allowlist: [] } };

let sb: Sandbox;
let server: ReturnType<typeof Bun.serve>;
let live = BUNDLE;
let liveSha = "";
const requests: string[] = [];
const comments: { issue: string; body: string }[] = [];

beforeAll(async () => {
  liveSha = await computeGatesBundleSha(live, SETTINGS);
  const posture = readDoctrine(renderBundle(BUNDLE)["doctrine.md"]!).postures.find((p) => p.slug === "business-as-usual")!;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      requests.push(`${req.method} ${url.pathname}`);
      const route = `${req.method} ${url.pathname}`;
      if (route === "GET /v1/gates/policy") return Response.json({ contract: "gates-contract/v1.5", bundle: live, bundle_sha: liveSha });
      if (route === "GET /v1/gates/settings") return Response.json({ contract: "gates-contract/v1.5", settings: SETTINGS, bundle_sha: liveSha });
      if (route === "PUT /v1/gates/policy") {
        live = ((await req.json()) as { bundle: GatesOrgBundle }).bundle;
        liveSha = await computeGatesBundleSha(live, SETTINGS);
        return Response.json({ contract: "gates-contract/v1.5", version: 2, bundle_sha: liveSha, saved_at: "2026-11-17T12:30:00.000Z", widened: false, reasons: [], auth_mode: "cli" });
      }
      if (route === "GET /v1/gates/doctrine-comments") return Response.json({ issues: ["ABC-1"], contract_version: "gates-contract/v1" });
      if (route === "GET /v1/gates/receipts") {
        const receipt = {
          schema: "gate-receipt@v2",
          gate: "plan-review",
          issue: "ABC-1",
          verdict: "PASS",
          artifact: { _tag: "file", path: "/x/plan.md", sha256: "a".repeat(64) },
          doctrine: { path: "/x/doctrine.md", sha256: "b".repeat(64), posture: "business-as-usual", policy_hash: policyHash(posture) },
          actor: "op@example.com",
          evidence: [],
          recorded_at: "2026-11-17T08:00:00.000Z",
        };
        return Response.json({ issue: "ABC-1", receipts: [{ comment_id: "r1", created_at: "2026-11-17T08:00:00.000Z", marker_version: "v2", payload: receipt }], invalid: 0, contract_version: "gates-contract/v1" });
      }
      if (route === "POST /v1/gates/doctrine-comments") {
        const body = (await req.json()) as { issue: string; body: string };
        comments.push({ issue: body.issue, body: body.body });
        return Response.json({ id: "lin-1", issue: body.issue, body: body.body, createdAt: "2026-11-17T12:31:00.000Z", coalesced: false, contract_version: "gates-contract/v1" });
      }
      return new Response("{}", { status: 404, headers: { "content-type": "application/problem+json" } });
    },
  });
  sb = sandbox("eris-doctrine-e2e-");
  mkdirSync(join(sb.home, ".eris"), { recursive: true, mode: 0o700 });
  writeFileSync(join(sb.home, ".eris", "yaks.json"), JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token: LOGIN }), { mode: 0o600 });
});

afterAll(() => {
  server.stop(true);
  sb.cleanup();
});

describe("eris doctrine pull, push and set, as a subprocess", () => {
  it("pull, edit the tree, push it, then set a posture on a local file and comment the issue", async () => {
    /** When a verb is registered but not routed, parsed or exited on as the in-process seams assume, an operator's `eris doctrine push` fails at the shim while every handler test stays green: observed on the subprocess's status, stdout, stderr and the requests the gateway received. */
    const pull = await sb.run(["doctrine", "pull"]);
    expect([pull.status, pull.stdout, pull.stderr]).toEqual([0, `${ORG}\t${liveSha}\n`, ""]);
    const doc = join(sb.home, ".eris", "doctrine", ORG, "doctrine.md");
    writeFileSync(doc, readFileSync(doc, "utf8").replace("The default.", "The default, edited."));

    const stale = await sb.run(["doctrine", "path"]);
    expect(stale.status).toBe(3);

    const push = await sb.run(["doctrine", "push", "--output", "json"]);
    expect(push.status).toBe(0);
    expect(push.stderr).toBe("");
    const saved = JSON.parse(push.stdout) as { org: string; bundle_sha: string; version: number; pushed: boolean };
    expect(saved).toMatchObject({ org: ORG, bundle_sha: liveSha, version: 2, pushed: true });
    expect(requests.filter((r) => r === "PUT /v1/gates/policy")).toHaveLength(1);
    expect((await sb.run(["doctrine", "path"])).status).toBe(0);

    const again = await sb.run(["doctrine", "push"]);
    expect([again.status, again.stdout]).toEqual([0, `org ${ORG}\tbundle_sha ${liveSha}\tversion unchanged\n`]);
    expect(requests.filter((r) => r === "PUT /v1/gates/policy")).toHaveLength(1);

    const file = join(sb.home, "local-doctrine.md");
    writeFileSync(file, renderBundle(BUNDLE)["doctrine.md"]!);
    const set = await sb.run(["doctrine", "set", "rapid-prototype", "--reason", "ship it", "--file", file, "--actor", "op@example.com"]);
    expect([set.status, set.stdout]).toEqual([0, "ABC-1\tcommented\tlin-1\n"]);
    expect(readFileSync(file, "utf8")).toContain("active: rapid-prototype");
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body.split("\n")[0]).toContain("→ Rapid prototype");
  });
});
