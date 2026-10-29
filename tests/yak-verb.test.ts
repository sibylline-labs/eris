/**
 * `eris yak` behind the TS router: the dispatcher contract that
 * commands/yak.sh owned — group usage, the unknown-verb block, the per-call
 * environment handed to the yak.ts core (ERIS_OUTPUT, ERIS_YAK_SHELL_ID), and
 * the warn-and-exit-0 answer to a missing dependency. The core's own outcome
 * table (receipts, redaction, transport failures) is tests/yak.test.ts.
 *
 * Network cases use a loopback `Bun.serve` and a sandbox HOME, so nothing
 * reaches a real Yaks endpoint or this machine's ~/.eris.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { YAKS_CONTRACT_VERSION } from "eris/yak-contract";
import { renderFailureBlock } from "../ts/lib/eris-fail";
import { runYakVerb, YAK_USAGE } from "../plugins/yak/handlers";
import { CliExit } from "../src/cli/ts-verb";

const REPO = resolve(import.meta.dir, "..");

interface Captured {
  rc: number;
  stdout: string;
  stderr: string;
}

let sandbox: string;
let server: ReturnType<typeof Bun.serve>;
const bodies: Record<string, unknown>[] = [];

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "yak-verb-")));
  mkdirSync(join(sandbox, "home"), { recursive: true });
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method !== "POST") return new Response("not found", { status: 404 }); // the post-submit status read
      const body = (await req.json()) as Record<string, unknown>;
      bodies.push(body);
      return Response.json({ id: `obs-${bodies.length}`, idempotency_key: body.idempotency_key, replay: false, contract_version: YAKS_CONTRACT_VERSION });
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(sandbox, { recursive: true, force: true });
});

function baseEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    HOME: join(sandbox, "home"),
    ERIS_YAKS_URL: `http://127.0.0.1:${server.port}`,
    ERIS_YAKS_TOKEN: "tok",
    ...extra,
  };
}

async function call(
  args: string[],
  opts: { format?: "text" | "json"; env?: Record<string, string | undefined>; deps?: Parameters<typeof runYakVerb>[2] } = {},
): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const ctx = {
    erisDir: REPO,
    env: opts.env ?? baseEnv(),
    format: opts.format ?? "text",
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: (s: string) => ((stderr += s), true) },
  };
  let rc: number;
  try {
    rc = await runYakVerb(args, ctx, { cwd: sandbox, ...opts.deps });
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    rc = e.code;
  }
  return { rc, stdout, stderr };
}

describe("eris yak — the group dispatcher", () => {
  it("bare, --help and -h print the group usage on stdout and exit 0", async () => {
    /** When the group help regresses to another verb's (or to a refusal), an operator asking `eris yak --help` never learns where the bearer file lives. */
    for (const args of [[], ["--help"], ["-h"]]) {
      const r = await call(args);
      expect({ args, ...r }).toEqual({ args, rc: 0, stdout: YAK_USAGE, stderr: "" });
    }
    expect(YAK_USAGE).toContain("Usage: eris yak <command>");
    expect(YAK_USAGE).toContain("~/.eris/yaks.json");
  });

  it("every flag description in the group usage starts in one column, continuation lines included", () => {
    /** When the flag block is padded by hand, a long `--x | --x-file` spelling pushes its description out of line and `eris yak --help` reads ragged — observed at YAK_USAGE. */
    const block = YAK_USAGE.split("\n\n").find((p) => p.startsWith("  --"))!.split("\n");
    const columns = block.map((line) => line.match(/^ {2}(?:--\S+(?: \S+)*?(?: \| --\S+(?: \S+)*?)? {2,}| +)/)![0].length);
    expect(block.length).toBeGreaterThanOrEqual(6);
    expect(new Set(columns)).toEqual(new Set([columns[0]!]));
  });

  it("an unknown verb is the four-line yak-unknown-verb block on stderr, rc 1, nothing on stdout", async () => {
    /** When the dispatcher forwards an unknown verb (or dies with a bare line), the agent gets no slug or fix to act on. */
    const r = await call(["bogus"]);
    expect(r).toEqual({
      rc: 1,
      stdout: "",
      // The block renderer is golden-pinned against bash (tests/eris-fail-golden.test.ts).
      stderr: renderFailureBlock(
        { slug: "yak-unknown-verb", what: "unknown yak command 'bogus'", fix: "use one of: issue, suggest, fatal, status, discover, config\nrun 'eris yak --help' for the full command list" },
        REPO,
      ),
    });
  });

  it("each verb reaches the core, and `<verb> --help` is the core's usage, not the group's", async () => {
    /** When a verb stops reaching yak.ts, its misuse checks and its own usage silently vanish. */
    for (const verb of ["issue", "suggest", "fatal"]) {
      const r = await call([verb]);
      expect({ verb, rc: r.rc, stdout: r.stdout }).toEqual({ verb, rc: 1, stdout: "" });
      expect(r.stderr).toContain("slug: yak-summary-required");
    }
    const help = await call(["issue", "--help"]);
    expect(help.rc).toBe(0);
    expect(help.stdout).toContain("usage: eris yak <issue|suggest|fatal> [flags]");
    expect(help.stdout).not.toContain("Usage: eris yak <command>");
  });

  it("--output json reaches the core: one record on stdout, nothing on stderr", async () => {
    /** When ctx.format stops crossing into the core as ERIS_OUTPUT, a json caller is handed human text (or a block on stderr) it cannot parse. */
    const r = await call(["issue", "--summary", "x"], { format: "json" });
    expect(r.rc).toBe(1);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toMatchObject({ verb: "issue", delivered: false, error: { slug: "yak-body-required" } });
  });

  it("the execution_id is the caller shell's pid on the shell-session rung", async () => {
    /** When ERIS_YAK_SHELL_ID is not set from the caller's pid, every call from one terminal mints a fresh idempotency key and dedup never converges. */
    const env = baseEnv();
    for (const k of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_HOST_SESSION_ID", "ERIS_YAK_EXECUTION_ID"]) delete env[k];
    const before = bodies.length;
    const r = await call(["issue", "--summary", "s", "--body", "b"], { env, deps: { ppid: 4242 } });
    expect(r).toEqual({ rc: 0, stdout: `recorded: obs-${before + 1}\n`, stderr: "" });
    expect(bodies[before]!.execution_id).toBe("shell:4242");
  });

  it("an uninstalled dependency warns and exits 0 — text block, or the json record", async () => {
    /** When a stale node_modules crashes `eris yak` (or exits 1), the command whose job is to report a broken harness becomes one more thing that stops the agent. */
    const load = async () => {
      throw Object.assign(new Error("Cannot find package 'zod'"), { code: "ERR_MODULE_NOT_FOUND", specifier: "zod" });
    };
    const what = "eris's node_modules is missing (or incomplete) — 'eris yak' cannot run its TypeScript core without it";
    const text = await call(["issue", "--summary", "s"], { deps: { load } });
    expect(text).toEqual({
      rc: 0,
      stdout: "",
      stderr: renderFailureBlock({ slug: "yak-deps-not-installed", what, fix: `from ${REPO}, run: bun install` }, REPO),
    });
    const json = await call(["suggest"], { format: "json", deps: { load } });
    expect(json.rc).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual({
      verb: "suggest",
      delivered: false,
      redactions: { count: 0, classes: [], skipped: false },
      error: { slug: "yak-deps-not-installed", reason: what },
    });
  });
});

describe("eris yak — through the shim", () => {
  it("two calls from one shell carry the same shell:<pid> execution_id, and no yq is needed", async () => {
    /** When the router's bun process stops being the shim's exec (so process.ppid is no longer the caller's shell), dedup for a plain-terminal caller breaks with no error. */
    const before = bodies.length;
    const script = `unset CLAUDE_CODE_SESSION_ID CLAUDE_CODE_HOST_SESSION_ID ERIS_YAK_EXECUTION_ID
'${REPO}/eris' yak issue --summary one --body b1
'${REPO}/eris' yak issue --summary two --body b2
echo "shell:$$"`;
    const bunDir = resolve(process.execPath, "..");
    // Async: the loopback server answers from this process's event loop.
    const p = Bun.spawn(["bash", "-c", script], {
      cwd: sandbox,
      env: { ...baseEnv(), PATH: `${bunDir}:/usr/bin:/bin` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, rc] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect({ rc, stderr: err }).toEqual({ rc: 0, stderr: "" });
    const shell = out.trim().split("\n").at(-1);
    expect(bodies.slice(before).map((b) => b.execution_id)).toEqual([shell, shell]);
  }, 30_000);
});
