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
    expect(Object.keys(parsed("release.yml").jobs)).toEqual(["plan", "build", "publish", "tap"]);
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

  it("no workflow reads a secret but the tap job, and it reads only the tap token", () => {
    /** When a secret is read outside the tap job, repo code that runs in other jobs (the suite, a build) can reach it; ci.yml reads none. */
    const reads = (f: string, job: string) => [...JSON.stringify(parsed(f).jobs[job]).matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
    expect(Object.keys(parsed("ci.yml").jobs).flatMap((j) => reads("ci.yml", j))).toEqual([]);
    for (const job of ["plan", "build", "publish"]) expect({ job, secrets: reads("release.yml", job) }).toEqual({ job, secrets: [] });
    expect(new Set(reads("release.yml", "tap"))).toEqual(new Set(["TAP_PUSH_TOKEN"]));
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
