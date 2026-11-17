/**
 * A loop's body comes only from the org's pulled, verified policy tree (plugins/loop/body.ts and
 * `freshTree` in plugins/doctrine/pull.ts), and `eris loop list` / `resolve` read it and the yak
 * lookup.
 *
 * The seams: `readLoopBody` over a real tree directory, and the loop handler, through the build's own
 * wiring (`LOOP_DEFAULTS`), over the loopback gateway and sandbox HOME of tests/helpers/loop-fixture.ts.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readLoopBody } from "../plugins/loop/body";
import { LoopFailure } from "../plugins/loop/failure";
import { loop, loopWorld, type LoopWorld, ORG, slugOf, stopServer } from "./helpers/loop-fixture";

let w: LoopWorld;
beforeEach(async () => {
  w = await loopWorld();
});
afterEach(() => w.close());
afterAll(() => stopServer());

function bodyOr(dir: string, loops: string[], slug: string): string {
  try {
    return readLoopBody({ org: ORG, dir, bundleSha: "x", loops }, slug);
  } catch (e) {
    if (e instanceof LoopFailure) return `${e.failure.slug}/${e.failure.exit}`;
    throw e;
  }
}

describe("readLoopBody", () => {
  it("reads a loop the tree carries, and refuses one it does not, a link out of loops/, and a body off the caps", () => {
    /** When a body is read from outside the verified tree's loops/ (a link to any file), or is binary, blank or oversized, a session starts from text the org never authored: observed on each refusal's slug. */
    const dir = join(w.dir, "tree");
    mkdirSync(join(dir, "loops"), { recursive: true });
    writeFileSync(join(dir, "loops", "ok.md"), "# OK\n");
    writeFileSync(join(w.dir, "outside.md"), "# Outside\n");
    symlinkSync(join(w.dir, "outside.md"), join(dir, "loops", "linked.md"));
    writeFileSync(join(dir, "loops", "blank.md"), "  \n");
    writeFileSync(join(dir, "loops", "nul.md"), "a\0b");
    writeFileSync(join(dir, "loops", "latin.md"), Buffer.from([0xff, 0xfe, 0x41]));
    writeFileSync(join(dir, "loops", "big.md"), "x".repeat(256 * 1024 + 1));
    const all = ["ok", "linked", "blank", "nul", "latin", "big"];
    expect(bodyOr(dir, all, "ok")).toBe("# OK\n");
    expect(bodyOr(dir, all, "missing")).toBe("loop-unknown/2");
    expect(bodyOr(dir, ["linked"], "ok")).toBe("loop-unknown/2");
    for (const bad of ["linked", "blank", "nul", "latin", "big"]) expect([bad, bodyOr(dir, all, bad)]).toEqual([bad, "loop-usage/2"]);
  });
});

describe("eris loop list", () => {
  it("pulls the org's policy when none is on this machine, then lists the loops its tree carries", async () => {
    /** When list reads anything but the verified tree (or nothing when none is pulled), an operator launches a loop the org does not carry: observed on stdout and the policy reads the gateway saw. */
    const r = await loop(w, ["list"]);
    expect(r).toEqual({ rc: 0, stdout: "fixer\none-shot\n", stderr: "" });
    expect(w.seen.map((s) => s.path).sort()).toEqual(["/v1/gates/policy", "/v1/gates/settings"]);
    const json = await loop(w, ["list"], { format: "json" });
    expect(JSON.parse(json.stdout)).toEqual({ loops: ["fixer", "one-shot"] });
  });

  it("refuses an edited tree with doctrine-local-modified, naming push or pull, and pulls nothing over it", async () => {
    /** When an edited tree is read (or silently pulled over), a loop runs a body the org never saved, or the operator's edits are lost: observed on the slug, the fix line and the requests after the edit. */
    expect((await loop(w, ["list"])).rc).toBe(0);
    const file = join(w.home, ".eris", "doctrine", ORG, "loops", "fixer.md");
    writeFileSync(realpathSync(file), `${readFileSync(file, "utf8")}edited\n`);
    w.seen.length = 0;
    const r = await loop(w, ["list"]);
    expect([r.rc, slugOf(r.stderr), r.stdout]).toEqual([3, "doctrine-local-modified", ""]);
    expect(r.stderr).toContain("eris doctrine push");
    expect(w.seen).toEqual([]);
  });
});

describe("eris loop resolve", () => {
  it("normalises a typed key offline, and resolves a yak id through the gateway", async () => {
    /** When a yak id is launched as if it were a key (or a key costs a request), the loop claims nothing or the wrong issue: observed on stdout and the requests the gateway saw. */
    expect(await loop(w, ["resolve", "abc-7"])).toEqual({ rc: 0, stdout: "ABC-7\n", stderr: "" });
    expect(w.seen).toEqual([]);
    const yak = "01HZX3K5Q8W2N4R6T8V0Y2B4D7";
    w.refuse.set(`GET /v1/yaks/observations/${yak}`, () => Response.json({ cluster_id: "c-1" }));
    w.refuse.set("GET /v1/yaks/clusters/c-1", () => Response.json({ current_issue_identifier: "abc-9" }));
    const r = await loop(w, ["resolve", yak.toLowerCase()], { format: "json" });
    expect([r.rc, JSON.parse(r.stdout)]).toEqual([0, { issue: "ABC-9", yak }]);
    const bad = await loop(w, ["resolve", "nope"]);
    expect([bad.rc, slugOf(bad.stderr)]).toEqual([2, "loop-usage"]);
  });
});
