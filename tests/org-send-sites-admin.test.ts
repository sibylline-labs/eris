/**
 * The yak admin verbs that read or write a destination (`discover`,
 * `config get`, `config set`) act as the org the caller's directory selects:
 * a repo that names org B reads and writes org B's server with org B's bearer
 * and never touches the default org's.
 *
 * The seam is `runYakVerb`, the dispatcher that forwards its `cwd` to the
 * admin handlers, over two real loopback servers (one per org) named in a
 * sandbox HOME's `yaks.json`. A wrong cwd shows as a request on the other
 * server, which for `config set` is a write into the wrong org. Bearers are
 * assembled at runtime so no literal trips a secret scanner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliExit } from "../src/cli/ts-verb";
import { runYakVerb } from "../plugins/yak/handlers";

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, "..");
const B64 = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
const ORG_A = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const ORG_B = "01J0AAAAAAAAAAAAAAAAAAAAAB";
const bearer = (org: string) => ["sib", org, B64].join("_");
const TEAM = "11111111-1111-4111-8111-111111111111";

interface Seen {
  method: string;
  path: string;
  authorization: string | null;
}

/** A loopback yaks server that records each request and answers the three admin routes. */
function serve(seen: Seen[]) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ method: req.method, path: url.pathname, authorization: req.headers.get("authorization") });
      if (url.pathname === "/v1/yaks/discovery") {
        return Response.json({ teams: [{ id: TEAM, key: "ENG", name: "Engineering" }], team_id: TEAM, projects: [], workflow_states: [], labels: [], default_state_id: null });
      }
      if (url.pathname === "/v1/yaks/config") {
        return Response.json({
          config: { team_id: TEAM, project_id: null, state_id: null, label_ids: [], new_issue_cap: 20 },
          updated_at: "2026-10-29T12:00:00.000Z",
          updated_by: { kind: "user", id: "mem_1", name: "admin" },
          configured: true,
        });
      }
      return Response.json({ error: { code: "not_found", message: "no such endpoint" } }, { status: 404 });
    },
  });
}

const seenA: Seen[] = [];
const seenB: Seen[] = [];
let sandbox: string;
let home: string;
let repoB: string;
let repoDefault: string;
let serverA: ReturnType<typeof serve>;
let serverB: ReturnType<typeof serve>;

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "send-sites-admin-")));
  serverA = serve(seenA);
  serverB = serve(seenB);
  home = join(sandbox, "home");
  mkdirSync(join(home, ".eris"), { recursive: true, mode: 0o700 });
  const store = { url: `http://127.0.0.1:${serverA.port}`, token: bearer(ORG_A), orgs: { [ORG_B]: { url: `http://127.0.0.1:${serverB.port}`, token: bearer(ORG_B) } } };
  writeFileSync(join(home, ".eris", "yaks.json"), JSON.stringify(store), { mode: 0o600 });
  repoB = join(sandbox, "repo-b");
  mkdirSync(join(repoB, ".git"), { recursive: true });
  writeFileSync(join(repoB, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(repoB, "eris.yaml"), `service: b\nrepo:\n  org: ${ORG_B}\n`);
  repoDefault = join(sandbox, "repo-default");
  mkdirSync(join(repoDefault, ".git"), { recursive: true });
  writeFileSync(join(repoDefault, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(repoDefault, "eris.yaml"), "service: a\n");
});
afterAll(() => {
  serverA.stop(true);
  serverB.stop(true);
  rmSync(sandbox, { recursive: true, force: true });
});
beforeEach(() => {
  seenA.length = 0;
  seenB.length = 0;
});

async function yak(args: string[], cwd: string): Promise<number> {
  const ctx = {
    erisDir: REPO,
    env: { PATH: process.env.PATH, HOME: home },
    format: "text" as const,
    stdout: { write: () => true },
    stderr: { write: () => true },
  };
  try {
    return await runYakVerb(args, ctx, { cwd, ppid: 1 });
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    return e.code;
  }
}

const VERBS: [string, string[], string][] = [
  ["discover", ["discover", "teams"], "GET /v1/yaks/discovery"],
  ["config get", ["config", "get"], "GET /v1/yaks/config"],
  ["config set", ["config", "set", "--team", "ENG"], "PUT /v1/yaks/config"],
];

describe.each(VERBS)("eris yak %s from a repo that selects org B", (_name, args, last) => {
  // admits: another admin verb or another dispatcher path resolving from the process cwd; these three plus status and ready (org-send-sites.test.ts) are the admin verbs
  it("reaches org B's server with org B's bearer and never org A's", async () => {
    /** When the dispatcher drops its cwd, or a handler resolves from process.cwd(), an org-B repo reads or writes the default org: observed as a request on server A. */
    expect(await yak(args, repoB)).toBe(0);
    expect(seenA).toEqual([]);
    expect(seenB.length).toBeGreaterThan(0);
    for (const r of seenB) expect(r.authorization).toBe(`Bearer ${bearer(ORG_B)}`);
    const final = seenB[seenB.length - 1];
    expect(`${final?.method} ${final?.path}`).toBe(last);
  });

  // admits: the default selection resolving some other org; the control for the case above
  it("reaches org A's server with org A's bearer from a repo that names no org", async () => {
    /** Control: the same verb from a default repo goes to server A, so the org-B case above is the cwd and not a fixture that always answers on B. */
    expect(await yak(args, repoDefault)).toBe(0);
    expect(seenB).toEqual([]);
    for (const r of seenA) expect(r.authorization).toBe(`Bearer ${bearer(ORG_A)}`);
    expect(seenA.length).toBeGreaterThan(0);
  });
});
