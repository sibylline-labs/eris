/**
 * The workflows keep the posture a public repository's release pipeline needs.
 * Read from the parsed YAML, not by eye: a release job that quietly gains write
 * access, an action that floats on a tag, or a secret read outside the one job
 * meant to hold it, is how a compromised dependency publishes a binary every
 * user then runs.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkoutOnly, REPO } from "./helpers/blackbox";

interface Step {
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}
interface Job {
  needs?: string | string[];
  "runs-on"?: string;
  permissions?: Record<string, string>;
  if?: string;
  env?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const DIR = join(REPO, ".github", "workflows");
const files = checkoutOnly("reads the checkout's workflow files") ? [] : readdirSync(DIR).filter((f) => f.endsWith(".yml"));
const text = (f: string) => readFileSync(join(DIR, f), "utf8");
const parsed = (f: string) => Bun.YAML.parse(text(f)) as Workflow;

describe.skipIf(checkoutOnly("reads the checkout's workflow files"))("the workflows", () => {
  it("find the workflows they police", () => {
    /** When the directory or parser stops yielding workflows, every check below passes having read nothing. */
    expect(files).toEqual(expect.arrayContaining(["ci.yml", "release.yml"]));
    expect(Object.keys(parsed("release.yml").jobs)).toEqual(["plan", "build", "publish", "npm"]);
  });

  it.each(files)("%s pins every action to a full commit SHA", (f) => {
    /** When an action floats on a tag or branch, whoever controls that ref runs code in a job that builds or publishes releases. */
    const uses = Object.values(parsed(f).jobs).flatMap((j) => j.steps.flatMap((s) => (s.uses === undefined ? [] : [s.uses])));
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  });

  it.each(files)("%s defaults to read-only contents", (f) => {
    /** When the workflow-wide permissions grow, every job, including ones that run repo code, can write. */
    expect(parsed(f).permissions).toEqual({ contents: "read" });
  });

  it("only the publish job can write contents, and only the npm job can mint an OIDC token", () => {
    /** When a build job gains write access, code it runs (the test suite) can alter releases or the repository; when a job other than npm holds `id-token: write`, code it runs can exchange the job's OIDC token for an npm publish token. */
    const writers = Object.entries(parsed("release.yml").jobs).flatMap(([name, job]) => (job.permissions === undefined ? [] : [[name, job.permissions] as const]));
    const writes = (p: Record<string, string>) => Object.fromEntries(Object.entries(p).filter(([, v]) => v === "write"));
    expect(writers.filter(([, p]) => Object.values(p).includes("write")).map(([name, p]) => [name, writes(p)])).toEqual([
      ["publish", { contents: "write" }],
      ["npm", { "id-token": "write" }],
    ]);
    // PAIRED: every scope not listed above is read-only.
    expect(writers.flatMap(([, p]) => Object.values(p)).every((v) => v === "read" || v === "write")).toBe(true);
  });

  it("no workflow reads a secret", () => {
    /** When a job reads a secret, repo code that runs in it (the suite, a build) can reach it; when the npm job reads one, a long-lived publish token is back in the pipeline that trusted publishing removed. ci.yml reads none. */
    const reads = (f: string, job: string) => [...JSON.stringify(parsed(f).jobs[job]).matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
    for (const f of ["ci.yml", "release.yml"]) for (const job of Object.keys(parsed(f).jobs)) expect({ f, job, secrets: reads(f, job) }).toEqual({ f, job, secrets: [] });
  });

  it("no if names secrets: a job gates on a token through env", () => {
    /** When an `if` names `secrets`, GitHub rejects the whole workflow, so no release can be cut. */
    for (const f of files) for (const job of Object.values(parsed(f).jobs)) for (const cond of [job.if, ...job.steps.map((s) => s.if)]) expect(cond ?? "").not.toContain("secrets.");
  });

  describe("the npm job", () => {
    const npm = () => parsed("release.yml").jobs.npm!;

    it("waits for the build, its oracle and the GitHub release", () => {
      /** When the npm job stops waiting for the build job, a red oracle leg still publishes the package; when it stops waiting for the publish job, npm carries a tag whose GitHub release failed. */
      expect([npm().needs].flat().sort()).toEqual(["build", "plan", "publish"]);
    });

    it("publishes through trusted publishing: an OIDC token, on a GitHub-hosted runner, and no npm token anywhere", () => {
      /** When `id-token: write` goes, npm has no credential and the publish fails ENEEDAUTH; when the job moves to a self-hosted runner (Blacksmith), npm refuses the OIDC exchange; when a step writes an authToken .npmrc (setup-node's registry-url) or reads NODE_AUTH_TOKEN, a token path that outlives the run is back — observed in the parsed job. */
      const job = npm();
      expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
      expect(job["runs-on"]).toMatch(/^(ubuntu|macos|windows)-[\w.-]+$/);
      const all = JSON.stringify(job);
      for (const banned of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "_authToken", "registry-url", "--userconfig"]) expect({ banned, found: all.includes(banned) }).toEqual({ banned, found: false });
      const publish = job.steps.filter((s) => /\bnpm publish\b(?!.*--dry-run)/.test(s.run ?? ""));
      expect(publish.length).toBe(1);
      expect(publish[0]!.run).toContain("--access public");
      const setupNode = job.steps.find((s) => s.uses?.startsWith("actions/setup-node@"));
      // Every Node 22 bundles npm 10, below the 11.5.1 trusted publishing needs.
      expect(setupNode?.with?.["node-version"]).toBe("24");
    });

    it("runs no repository code in any step, since the OIDC token reaches them all", () => {
      /** When a step runs bun, node, npx, or an npm command without --ignore-scripts, code at the release commit (a lifecycle script, a test) runs in a job that can mint an npm publish token — observed in the parsed job. */
      const runs = npm().steps.flatMap((s) => (s.run === undefined ? [] : [s.run]));
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) {
        expect(/\b(bun|node|npx)\b/.test(run)).toBe(false);
        for (const line of run.split("\n").filter((l) => /\bnpm (publish|version|view|pack|install|ci|run)\b/.test(l))) expect(line).toContain("--ignore-scripts");
      }
    });

    it("checks the tarball with a dry run before it publishes", () => {
      /** When the dry run is gone or follows the publish, a tarball npm would reject is found only at the real publish, after the GitHub release is out. */
      const { steps } = npm();
      const dry = steps.findIndex((s) => /npm publish\b.*--dry-run/.test(s.run ?? ""));
      const real = steps.findIndex((s) => /\bnpm publish\b(?!.*--dry-run)/.test(s.run ?? ""));
      expect(dry).toBeGreaterThan(-1);
      expect(real).toBeGreaterThan(dry);
    });
  });
});

describe.skipIf(checkoutOnly("reads the checkout's workflow files"))("the release tag grammar", () => {
  const TAGS = [
    "v0.2.0", "v10.20.30", "v0.3.0-rc.1", "v1.0.0-alpha-1", "v1.0.0-0.3.7", "v999999999.0.0",
    "0.2.0", "v0.2", "v0.2.0.1", "v0.2.0-", "v0.2.0-rc.", "v0.2.0-rc..1", "v0.2.0-.rc", "v1000000000.0.0", "v0.2.0+build", "v0.2.0-rc_1", "dev",
  ];
  it("is one grammar: the release job's check, RELEASE_TAG and the release eris update's parser agree on every tag", async () => {
    /** When the release job accepts a tag eris update cannot order (an empty prerelease identifier, a ten-digit number), that release publishes and every binary reads its version as not-a-version and offers it as an update forever — observed by running the job's regex, RELEASE_TAG and the parser on one table. */
    const { compareVersions, RELEASE_TAG } = await import("../src/cli/commands/update/semver");
    const step = parsed("release.yml").jobs.plan!.steps.find((s) => s.run?.includes("=~"))!;
    const workflow = new RegExp(/=~ (\^.*\$) \]\]/.exec(step.run!)![1]!);
    for (const tag of TAGS) {
      const parsedByUpdate = tag.startsWith("v") && compareVersions(tag, tag) !== null;
      expect({ tag, workflow: workflow.test(tag), releaseTag: RELEASE_TAG.test(tag) }).toEqual({ tag, workflow: parsedByUpdate, releaseTag: parsedByUpdate });
    }
  });
});
