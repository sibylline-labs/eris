/**
 * `eris update` on real compiled binaries: `build()` writes eris at two tags,
 * the older one is copied into a scratch directory and updates itself from the
 * loopback release fixture to the newer one, which then answers as that tag.
 * tests/update.test.ts covers every refusal against a stand-in binary; this file
 * is what a stand-in cannot show: the rename over a running compiled executable,
 * and the new binary's own `--version` as the smoke check.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PLUGINS } from "../plugins";
import { build } from "../src/build";
import { checkoutOnly, expectFailBlock, REPO, type Sandbox, sandbox } from "./helpers/blackbox";
import { releaseFixture, type ReleaseFixture } from "./helpers/release-fixture";

setDefaultTimeout(180_000);

const REPOSITORY = "example-org/eris-fork";
const ASSET = `eris-${process.platform}-${process.arch}`;
const TOKEN = ["ghp", "_", "b".repeat(36)].join("");
const DOCS_BASE = "https://docs.example.com/eris/blob/main";

describe.skipIf(checkoutOnly("builds its own binaries from this checkout's source"))("eris update on a compiled binary", () => {
  const dist = join(REPO, "dist", "update-fixture");
  const v1 = join(dist, "eris-v0.0.1");
  const v2 = join(dist, "eris-v0.0.2");
  let fx: ReleaseFixture;
  let sb: Sandbox;
  let bin: string;
  let installed: string;

  beforeAll(async () => {
    expect(["darwin-arm64", "linux-x64"], `these tests run on a platform releases publish for, not ${process.platform}-${process.arch}`).toContain(`${process.platform}-${process.arch}`);
    rmSync(dist, { recursive: true, force: true });
    const common = { entry: join(REPO, "src/main.ts"), root: REPO, plugins: PLUGINS, releaseRepo: REPOSITORY };
    await build({ ...common, outfile: v1, tag: "v0.0.1" });
    await build({ ...common, outfile: v2, tag: "v0.0.2", versionExtra: "core example-pin", docsBase: DOCS_BASE });
    fx = releaseFixture(REPOSITORY);
    fx.publish({ tag: "v0.0.2", assets: { [ASSET]: readFileSync(v2) } });
  });
  afterAll(() => {
    fx?.stop();
    rmSync(dist, { recursive: true, force: true });
  });

  beforeEach(() => {
    sb?.cleanup();
    sb = sandbox("eris-update-bin-");
    bin = join(sb.dir, "bin");
    mkdirSync(bin);
    installed = join(bin, "eris");
    copyFileSync(v1, installed);
    chmodSync(installed, 0o755);
    fx.hits.length = 0;
  });
  afterAll(() => sb?.cleanup());

  const run = (args: string[], env: Record<string, string> = {}) => sb.run(args, { program: installed, env: { ERIS_UPDATE_API: fx.api, ...env } });

  it("replaces itself with the newer release, and then answers as it", async () => {
    /** When the rename over a running executable fails, the new binary is not the one a later run starts, or its asset home is not its own, a user is left on the old release or with a binary that cannot run — observed by running the same path before and after. */
    const before = await sb.run(["--version"], { program: installed });
    expect(before.stdout).toBe(`eris v0.0.1 (${REPOSITORY})\n`);

    const r = await run(["update"], { GH_TOKEN: TOKEN, TMPDIR: join(sb.dir, "does-not-exist") });
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: "" });
    expect(r.stderr).toContain("INFO ✓ updated eris v0.0.1 -> v0.0.2");
    expect(r.stderr).not.toContain(TOKEN);

    const after = await sb.run(["--version"], { program: installed });
    expect({ status: after.status, stdout: after.stdout, stderr: after.stderr }).toEqual({
      status: 0,
      stdout: `eris v0.0.2 (${REPOSITORY})\ncore example-pin\n`,
      stderr: "",
    });
    expect(readdirSync(bin)).toEqual(["eris"]);
    // The asset requests carried the token to the API and not to storage.
    expect(fx.hits.filter((h) => h.server === "api").map((h) => h.authorization)).toEqual(Array(3).fill(`Bearer ${TOKEN}`));
    expect(fx.hits.filter((h) => h.server === "cdn").map((h) => h.authorization)).toEqual([null, null]);
    expect(fx.browserHits()).toBe(0);
    // The updated binary carries the newer build's docs base.
    const refused = await sb.run(["--output", "json", "completion", "bash"], { program: installed });
    expect(refused.stderr).toContain(`\ndocs: ${DOCS_BASE}/docs/OUTPUT-CONTRACT.md#3-machine-surfaces\n`);
  });

  it("reports an available update with --check and changes nothing, then reports none once updated", async () => {
    /** When --check replaces the binary, or the exit code does not follow the answer, a script gating on it updates the wrong machines — observed at the exit codes and the binary's version across a check, an update and a second check. */
    const check = await run(["update", "--check"]);
    expect({ status: check.status, stdout: check.stdout, stderr: check.stderr }).toEqual({ status: 10, stdout: "update available: v0.0.1 -> v0.0.2\n", stderr: "" });
    expect((await sb.run(["--version"], { program: installed })).stdout).toBe(`eris v0.0.1 (${REPOSITORY})\n`);
    expect((await run(["update"])).status).toBe(0);
    const again = await run(["--output", "json", "update", "--check"]);
    expect(again.status).toBe(0);
    expect(JSON.parse(again.stdout)).toEqual({ current: "v0.0.2", latest: "v0.0.2", update_available: false, updated: false });
  });

  it("keeps running after a refused update", async () => {
    /** When a checksum mismatch is noticed after the rename, the user's binary is already the bad download — observed by running the same path after the refusal. */
    fx.publish({ tag: "v0.0.3", assets: { [ASSET]: readFileSync(v2) }, sums: `${"0".repeat(64)}  ${ASSET}\n` });
    const r = await run(["update", "--to", "v0.0.3"]);
    expectFailBlock(r, "update-checksum-mismatch");
    expect(readdirSync(bin)).toEqual(["eris"]);
    expect((await sb.run(["--version"], { program: installed })).stdout).toBe(`eris v0.0.1 (${REPOSITORY})\n`);
  });

  /** Start `eris update` as a child we can signal; resolves with how it ended. */
  const startUpdate = () => {
    const child = spawn(installed, ["update"], { env: { ...sb.env, ERIS_UPDATE_API: fx.api }, stdio: ["ignore", "pipe", "pipe"] });
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve) => {
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("close", (code, signal) => resolve({ code, signal, stderr }));
    });
    return { child, ended };
  };

  it("an interrupt during the download removes the partial file and leaves the binary as it was", async () => {
    /** When Ctrl-C kills update mid-download, a partial binary stays beside the real one as a hidden file nobody removes — observed in the bin directory after the child dies of the signal. */
    fx.publish({ tag: "v0.0.4", assets: { [ASSET]: readFileSync(v2) } });
    const { child, ended } = startUpdate();
    let sent = false;
    fx.midDownload = () => {
      // The first body is SHA256SUMS; the temp file exists once the binary's has begun.
      if (!sent && readdirSync(bin).length > 1) {
        sent = true;
        child.kill("SIGINT");
      }
    };
    const end = await ended;
    fx.midDownload = null;
    expect(sent).toBe(true);
    expect(end.signal).toBe("SIGINT");
    expect(readdirSync(bin)).toEqual(["eris"]);
    expect((await sb.run(["--version"], { program: installed })).stdout).toBe(`eris v0.0.1 (${REPOSITORY})\n`);
  });

  it("an interrupt while the new binary is being checked puts the old one back", async () => {
    /** When Ctrl-C lands between the rename and the check, the new binary is left in place unrun and .old beside it — observed as the file at the path, which must be the old binary byte for byte. */
    const marker = join(sb.dir, "smoke-started");
    // A release whose binary, when asked for its version, says it started and then waits.
    fx.publish({ tag: "v0.0.5", assets: { [ASSET]: `#!/bin/sh\necho started > '${marker}'\nsleep 30\n` } });
    const { child, ended } = startUpdate();
    const deadline = Date.now() + 20_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(existsSync(marker)).toBe(true);
    // The replacement is in place now: this is the script, not the old binary.
    expect(readFileSync(installed, "utf8")).toStartWith("#!/bin/sh");
    child.kill("SIGINT");
    const end = await ended;
    expect(end.signal).toBe("SIGINT");
    expect(readFileSync(installed).equals(readFileSync(v1))).toBe(true);
    expect(readdirSync(bin)).toEqual(["eris"]);
  });

  it("a source checkout refuses, with the same fixture and no request made", async () => {
    /** When the checkout updates itself, it replaces bun or its own shim — observed at the block and at the fixture. Paired with the replacements above, which made requests against the same fixture. */
    const r = await sb.run(["update"], { env: { ERIS_UPDATE_API: fx.api } });
    expectFailBlock(r, "update-not-compiled");
    expect(fx.hits).toEqual([]);
  });
});
