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
    expect(Object.keys(parsed("release.yml").jobs)).toEqual(["plan", "build", "publish", "tap", "npm"]);
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

  it("only the publish job can write, and only to contents", () => {
    /** When a build or tap job gains write access, code it runs (the test suite, the render script) can alter releases or the repository. */
    const writers = Object.entries(parsed("release.yml").jobs).flatMap(([name, job]) => (job.permissions === undefined ? [] : [[name, job.permissions] as const]));
    expect(writers.filter(([, p]) => Object.values(p).includes("write"))).toEqual([["publish", { contents: "write" }]]);
    // PAIRED: the other jobs that set permissions set them read-only.
    expect(writers.filter(([name]) => name !== "publish").every(([, p]) => Object.values(p).every((v) => v === "read"))).toBe(true);
  });

  it("no workflow reads a secret but the tap and npm jobs, each only its own token", () => {
    /** When a secret is read outside the job meant to hold it, repo code that runs in other jobs (the suite, a build) can reach it; when one job reads the other's token, a compromised publish step can push to the tap, or a tap step can publish the package. ci.yml reads none. */
    const reads = (f: string, job: string) => [...JSON.stringify(parsed(f).jobs[job]).matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
    expect(Object.keys(parsed("ci.yml").jobs).flatMap((j) => reads("ci.yml", j))).toEqual([]);
    for (const job of ["plan", "build", "publish"]) expect({ job, secrets: reads("release.yml", job) }).toEqual({ job, secrets: [] });
    expect(new Set(reads("release.yml", "tap"))).toEqual(new Set(["TAP_PUSH_TOKEN"]));
    expect(new Set(reads("release.yml", "npm"))).toEqual(new Set(["NPM_TOKEN"]));
  });

  it("the tap job is gated on the token through env, never through an if on secrets", () => {
    /** When an `if` names `secrets`, GitHub rejects the whole workflow, so no release can be cut; when the gate is missing, a release without the tap token fails red after it published. */
    for (const f of files) for (const job of Object.values(parsed(f).jobs)) for (const cond of [job.if, ...job.steps.map((s) => s.if)]) expect(cond ?? "").not.toContain("secrets.");
    const tap = parsed("release.yml").jobs.tap!;
    expect(tap.env?.HAVE_TAP).toBe("${{ secrets.TAP_PUSH_TOKEN != '' }}");
    const gated = tap.steps.filter((s) => s.if?.includes("HAVE_TAP"));
    expect(gated.length).toBe(tap.steps.length);
  });

  it("the tap job runs repo code before the tap token is on disk, and none after", () => {
    /** When the render script runs after the tap checkout, repo code at the release commit runs with the tap token in the workspace's git config. */
    const steps = parsed("release.yml").jobs.tap!.steps;
    const tapCheckout = steps.findIndex((s) => s.with?.token !== undefined);
    const render = steps.findIndex((s) => s.run?.includes("render-formula.ts"));
    expect(tapCheckout).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(-1);
    expect(render).toBeLessThan(tapCheckout);
    expect(steps.slice(tapCheckout + 1).some((s) => /\bbun\b/.test(s.run ?? ""))).toBe(false);
  });

  describe("the npm job", () => {
    const npm = () => parsed("release.yml").jobs.npm!;

    it("waits for the build and its oracle, and holds only read access", () => {
      /** When the npm job stops waiting for the build job, a red oracle leg still publishes the package; when it gains write access, the code it runs can alter the repository. */
      expect([npm().needs].flat().sort()).toEqual(["build", "plan"]);
      expect(npm().permissions).toEqual({ contents: "read" });
    });

    it("is gated on the token through env, and the token is on disk only for the last step, which runs no repo code", () => {
      /** When the token is exported job-wide, the checkout and the dry run hold it; when a step follows the one that holds it, repo-controlled code runs with the token on disk; when the publish runs lifecycle scripts, a prepublish script at the release commit runs with it — observed in the parsed job. */
      const { env, steps } = npm();
      expect(env?.HAVE_NPM).toBe("${{ secrets.NPM_TOKEN != '' }}");
      // The job's own env reaches every step, so the secret may appear there only inside the presence test.
      expect(Object.entries(env ?? {}).filter(([, v]) => v.includes("secrets.NPM_TOKEN")).map(([k]) => k)).toEqual(["HAVE_NPM"]);
      const holders = steps.flatMap((s, i) => (JSON.stringify(s).includes("secrets.NPM_TOKEN") ? [i] : []));
      expect(holders).toEqual([steps.length - 1]);
      const last = steps.at(-1)!;
      expect(last.if).toBe("env.HAVE_NPM == 'true'");
      expect(last.run).toContain("npm publish");
      expect(last.run).toContain("--ignore-scripts");
      expect(/\b(bun|node|npx)\b/.test(last.run ?? "")).toBe(false);
    });

    it("fails red without the token, after checking the tarball, rather than passing having published nothing", () => {
      /** When a release is cut without NPM_TOKEN and the job ends green, the version never reaches the registry and nothing says so (a tag is not re-run on its own); when the dry run is missing, the missing-token run proves nothing about the package. */
      const { steps } = npm();
      const dry = steps.findIndex((s) => /npm publish\b.*--dry-run/.test(s.run ?? ""));
      const refuse = steps.findIndex((s) => s.if === "env.HAVE_NPM != 'true'");
      expect(dry).toBeGreaterThan(-1);
      expect(steps[dry]!.if).toBeUndefined();
      expect(refuse).toBeGreaterThan(dry);
      expect(steps[refuse]!.run).toContain("::error");
      expect(steps[refuse]!.run).toContain("exit 1");
    });
  });
});

describe.skipIf(checkoutOnly("reads the checkout's workflow files"))("the release tag grammar", () => {
  const TAGS = [
    "v0.2.0", "v10.20.30", "v0.3.0-rc.1", "v1.0.0-alpha-1", "v1.0.0-0.3.7", "v999999999.0.0",
    "0.2.0", "v0.2", "v0.2.0.1", "v0.2.0-", "v0.2.0-rc.", "v0.2.0-rc..1", "v0.2.0-.rc", "v1000000000.0.0", "v0.2.0+build", "v0.2.0-rc_1", "dev",
  ];
  it("is one grammar: the release job's check, the formula renderer and eris update's parser agree on every tag", async () => {
    /** When the release job accepts a tag eris update cannot order (an empty prerelease identifier, a ten-digit number), that release publishes and every binary reads its version as not-a-version and offers it as an update forever — observed by running the job's regex, the renderer's and the parser on one table. */
    const { compareVersions, RELEASE_TAG } = await import("../src/cli/commands/update/semver");
    const step = parsed("release.yml").jobs.plan!.steps.find((s) => s.run?.includes("=~"))!;
    const workflow = new RegExp(/=~ (\^.*\$) \]\]/.exec(step.run!)![1]!);
    for (const tag of TAGS) {
      const parsedByUpdate = tag.startsWith("v") && compareVersions(tag, tag) !== null;
      expect({ tag, workflow: workflow.test(tag), renderer: RELEASE_TAG.test(tag) }).toEqual({ tag, workflow: parsedByUpdate, renderer: parsedByUpdate });
    }
  });
});
