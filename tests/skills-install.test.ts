/**
 * `eris skills install` at the CLI seam: the real entrypoint (or, under
 * ERIS_BIN, the compiled binary, whose skills ride in its asset home) run with
 * a sandboxed HOME, asserted on the files it leaves and on its two streams.
 *
 * The layout oracle is what `npx skills add sibylline-labs/eris -g --skill <s>`
 * wrote when observed (skills@latest, Nov-11-2026): the skill at
 * `~/.agents/skills/<s>/`, byte-identical to this repo's `skills/<s>/`, and
 * `~/.claude/skills/<s>` a symlink to `../../.agents/skills/<s>`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, type Sandbox, sandbox } from "./helpers/blackbox";

const SKILLS = join(REPO, "skills");
const PUBLISHED = readdirSync(SKILLS)
  .filter((d) => existsSync(join(SKILLS, d, "SKILL.md")))
  .sort();

let sb: Sandbox;
afterEach(() => sb?.cleanup());

function setup(withClaude = true): Sandbox {
  sb = sandbox("eris-skills-");
  if (withClaude) mkdirSync(join(sb.home, ".claude"));
  return sb;
}

const canonical = (s: string) => join(sb.home, ".agents", "skills", s);
const claudeLink = (s: string) => join(sb.home, ".claude", "skills", s);

/** Every file under `dir`, relative, with its bytes. */
function tree(dir: string, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(dir, rel))) {
    const r = rel === "" ? e : join(rel, e);
    if (lstatSync(join(dir, r)).isDirectory()) Object.assign(out, tree(dir, r));
    else out[r] = readFileSync(join(dir, r), "utf8");
  }
  return out;
}

describe("eris skills install <skill>", () => {
  // admits: a skill written to another path, or with drifted bytes, is one no agent loads; only the files on disk show it.
  it("writes the skill where npx skills add -g does: the files byte for byte, and Claude Code's relative link", async () => {
    /** When the install path, the link or the copied bytes differ from the skills CLI's layout, Claude Code and the universal agents never see the skill: observed at the sandboxed HOME's files and the link's target. */
    setup();
    const r = await sb.run(["skills", "install", "eris-socrates"]);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    expect(r.stdout).toBe("installed eris-socrates -> ~/.agents/skills/eris-socrates\n  claude-code: ~/.claude/skills/eris-socrates (linked)\n");
    expect(tree(canonical("eris-socrates"))).toEqual(tree(join(SKILLS, "eris-socrates")));
    expect(lstatSync(claudeLink("eris-socrates")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(claudeLink("eris-socrates"))).toBe("../../.agents/skills/eris-socrates");
    expect(readFileSync(join(claudeLink("eris-socrates"), "SKILL.md"), "utf8")).toBe(readFileSync(join(SKILLS, "eris-socrates", "SKILL.md"), "utf8"));
    expect(existsSync(canonical("eris-yaks"))).toBe(false);
  });

  // admits: a link created into a home with no Claude Code makes ~/.claude appear, which other tools read as Claude Code installed.

  it("writes no Claude Code link when ~/.claude does not exist", async () => {
    /** When the link is written regardless, a machine without Claude Code gains a ~/.claude tree: observed at the HOME's entries and the JSON record's links. */
    setup(false);
    const r = await sb.run(["skills", "install", "eris-socrates", "--json"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ skills: [{ name: "eris-socrates", path: canonical("eris-socrates"), state: "installed", links: [] }] });
    expect(existsSync(join(canonical("eris-socrates"), "SKILL.md"))).toBe(true);
    expect(existsSync(join(sb.home, ".claude"))).toBe(false);
  });
});

describe("eris skills install (every skill), and a rerun", () => {
  // admits: a bare install that skips a skill, or a rerun that rewrites or fails, breaks the setup flow that calls it on every run.
  it("installs every published skill, and a rerun reports each unchanged", async () => {
    /** When a bare install misses a published skill, or a second run rewrites or refuses an installed one, setup leaves an agent without a skill or fails on rerun: observed at the JSON record of two runs and the files. */
    setup();
    const first = await sb.run(["--json", "skills", "install"]);
    expect(first.status).toBe(0);
    const firstDoc = JSON.parse(first.stdout) as { skills: { name: string; state: string; links: { state: string }[] }[] };
    expect(firstDoc.skills.map((s) => [s.name, s.state, s.links.map((l) => l.state)])).toEqual(PUBLISHED.map((s) => [s, "installed", ["linked"]]));
    for (const s of PUBLISHED) expect(tree(canonical(s))).toEqual(tree(join(SKILLS, s)));

    const again = await sb.run(["--json", "skills", "install"]);
    expect({ status: again.status, stderr: again.stderr }).toEqual({ status: 0, stderr: "" });
    const againDoc = JSON.parse(again.stdout) as typeof firstDoc;
    expect(againDoc.skills.map((s) => [s.name, s.state, s.links.map((l) => l.state)])).toEqual(PUBLISHED.map((s) => [s, "unchanged", ["unchanged"]]));
  });

  // admits: an edited or stale skill left in place keeps an agent on old instructions after an eris upgrade.

  it("replaces a skill whose files changed, and a copy-mode install at the Claude Code path with the link", async () => {
    /** When an install compares nothing, or refuses the directory `npx skills add -a claude-code` leaves, an upgrade keeps the old skill text: observed at the states printed and the files after. */
    setup();
    mkdirSync(canonical("eris-socrates"), { recursive: true });
    writeFileSync(join(canonical("eris-socrates"), "SKILL.md"), "stale\n");
    writeFileSync(join(canonical("eris-socrates"), "extra.md"), "left over\n");
    mkdirSync(claudeLink("eris-socrates"), { recursive: true });
    writeFileSync(join(claudeLink("eris-socrates"), "SKILL.md"), "---\nname: eris-socrates\ndescription: old copy\n---\n");
    const r = await sb.run(["skills", "install", "eris-socrates"]);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    expect(r.stdout).toBe("updated eris-socrates -> ~/.agents/skills/eris-socrates\n  claude-code: ~/.claude/skills/eris-socrates (replaced)\n");
    expect(tree(canonical("eris-socrates"))).toEqual(tree(join(SKILLS, "eris-socrates")));
    expect(readlinkSync(claudeLink("eris-socrates"))).toBe("../../.agents/skills/eris-socrates");
    expect(readdirSync(join(sb.home, ".agents", "skills"))).toEqual(["eris-socrates"]);
  });
});

describe("eris skills install refusals", () => {
  // admits: a typo installing nothing while exiting 0 reads as success to a setup script.
  it("an unknown skill refuses the whole command, lists the published ones, and writes nothing", async () => {
    /** When an unknown name is skipped instead of refused, or the valid name beside it is installed, setup reports success with a skill missing: observed at the exit, the failure block and the HOME. */
    setup();
    const r = await sb.run(["skills", "install", "eris-socrates", "nope"]);
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 1, stdout: "" });
    expect(r.stderr).toContain("ERROR no published skill named 'nope'\nslug: skills-unknown\n");
    expect(r.stderr).toContain(`fix: published skills: ${PUBLISHED.join(", ")}\n`);
    expect(existsSync(join(sb.home, ".agents"))).toBe(false);
    expect(existsSync(join(sb.home, ".claude", "skills"))).toBe(false);
  });

  // admits: replacing a link the user pointed at their own checkout destroys their setup silently.

  it("a foreign symlink at the Claude Code path is never replaced, nothing is written, and removing it lets a rerun link", async () => {
    /** When an occupied target is overwritten, or the refusal lands after the canonical copy was written, a user's own skill link is lost or half an install is left: observed at the link, the canonical path and the round trip of the fix. */
    setup();
    const mine = join(sb.dir, "my-own-skill");
    mkdirSync(mine);
    mkdirSync(join(sb.home, ".claude", "skills"), { recursive: true });
    symlinkSync(mine, claudeLink("eris-socrates"));
    const r = await sb.run(["skills", "install", "eris-yaks", "eris-socrates"]);
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 1, stdout: "" });
    expect(r.stderr).toContain(`ERROR ~/.claude/skills/eris-socrates is a symlink to ${mine}; nothing was installed\nslug: skills-target-occupied\n`);
    expect(r.stderr).toContain(`fix:   rm -r ${claudeLink("eris-socrates")}\n`);
    expect(readlinkSync(claudeLink("eris-socrates"))).toBe(mine);
    expect(existsSync(join(sb.home, ".agents"))).toBe(false);

    rmSync(claudeLink("eris-socrates"));
    const again = await sb.run(["skills", "install", "eris-socrates"]);
    expect(again.status).toBe(0);
    expect(readlinkSync(claudeLink("eris-socrates"))).toBe("../../.agents/skills/eris-socrates");
  });

  // admits: a file where the skill directory goes would be deleted by a blind replace.

  it("a file at the canonical path is refused", async () => {
    /** When the canonical path holds a file and the install removes it, user data under ~/.agents is lost: observed at the exit, the slug and the file. */
    setup();
    mkdirSync(join(sb.home, ".agents", "skills"), { recursive: true });
    writeFileSync(canonical("eris-socrates"), "mine\n");
    const r = await sb.run(["skills", "install", "eris-socrates"]);
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 1, stdout: "" });
    expect(r.stderr).toContain("ERROR ~/.agents/skills/eris-socrates is a file; nothing was installed\nslug: skills-target-occupied\n");
    expect(readFileSync(canonical("eris-socrates"), "utf8")).toBe("mine\n");
  });
});
