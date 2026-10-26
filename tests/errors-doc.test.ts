/**
 * Every slug eris raises has a `### <slug>` heading in docs/ERRORS.md.
 *
 * The slugs are harvested from the source, never listed by hand: a hand list
 * silently stops covering the next slug somebody adds (eighteen once shipped
 * past one). The harvest reads the shell that remains (the `eris` shim) AND
 * every TypeScript tree (bin/, src/, ts/lib/, plugins/).
 *
 * Kebab-case with at least one hyphen is the discriminator (docs/ERRORS.md:
 * "Slugs are lowercase kebab-case"); that keeps prose out. The raisers:
 *
 *   shell  printf 'slug: %s\n' <slug>        the shim's own block (eris)
 *   TS     slug: "<slug>"                    the renderFailureBlock / outcome shape
 *          type …Slug… = | "<slug>" …        a union of every slug an engine emits
 *          renderWarnLines(…, "<slug>")      a warn block's slug argument
 *          the yak engine: a lone `"<slug>",` line (an argument list)
 *
 * Forward direction only: every raised slug needs a heading. A heading with no
 * raiser is allowed — documenting a slug before its raiser lands is the safe
 * order.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const KEBAB = "[a-z0-9]+(?:-[a-z0-9]+)+";

interface Source {
  path: string;
  text: string;
}

/** Files whose lone `"<kebab>",` lines are slug arguments (verified per file). */
const LONE_LITERAL_FILES = new Set(["plugins/yak/yak-identity.ts", "plugins/yak/yak-submit.ts", "plugins/yak/yak.ts"]);

export function harvestSlugs(sources: readonly Source[]): Set<string> {
  const out = new Set<string>();
  const add = (re: RegExp, text: string) => {
    for (const m of text.matchAll(re)) out.add(m[1]!);
  };
  for (const { path, text } of sources) {
    if (path.endsWith(".ts")) {
      add(new RegExp(`slug: "(${KEBAB})"`, "g"), text);
      for (const u of text.matchAll(/type \w*Slug\w*\s*=([^;]*);/g)) add(new RegExp(`"(${KEBAB})"`, "g"), u[1]!);
      add(new RegExp(`renderWarnLines\\([^;]*?,\\s*"(${KEBAB})"\\s*\\)`, "g"), text);
      if (LONE_LITERAL_FILES.has(path)) add(new RegExp(`^\\s*"(${KEBAB})",?\\s*$`, "gm"), text);
    } else {
      add(new RegExp(`slug: %s\\\\n' (${KEBAB})`, "g"), text);
    }
  }
  return out;
}

export function undocumented(slugs: Iterable<string>, errorsMd: string): string[] {
  const headings = new Set([...errorsMd.matchAll(/^### (\S+)$/gm)].map((m) => m[1]!));
  return [...slugs].filter((s) => !headings.has(s)).sort();
}

function walk(dir: string, keep: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, keep));
    else if (keep(p)) out.push(p);
  }
  return out;
}

function repoSources(): { bash: Source[]; ts: Source[] } {
  const read = (abs: string): Source => ({ path: relative(REPO, abs), text: readFileSync(abs, "utf8") });
  const bash = [join(REPO, "eris")].map(read);
  const ts = [
    ...walk(join(REPO, "bin"), (p) => p.endsWith(".ts")),
    ...walk(join(REPO, "src"), (p) => p.endsWith(".ts")),
    ...walk(join(REPO, "ts/lib"), (p) => p.endsWith(".ts")),
    ...walk(join(REPO, "plugins"), (p) => p.endsWith(".ts")),
  ].map(read);
  return { bash, ts };
}

describe("docs/ERRORS.md covers every shipped slug", () => {
  it("every slug raised in shell or TypeScript has a heading", () => {
    /** When a raiser ships a slug with no `### <slug>` heading, its `docs:` link points nowhere. */
    const { bash, ts } = repoSources();
    const fromBash = harvestSlugs(bash);
    const fromTs = harvestSlugs(ts);
    const md = readFileSync(join(REPO, "docs/ERRORS.md"), "utf8");
    expect(undocumented(new Set([...fromBash, ...fromTs]), md)).toEqual([]);
    // Floors just under the measured counts (shell 1, TS 38):
    // a pattern that stops matching would otherwise pass vacuously.
    expect(fromTs.size).toBeGreaterThan(35);
    expect(fromBash.has("eris-bun-missing")).toBe(true);
  });

  it("a raiser with no heading is reported, from either language, and a heading clears it", () => {
    /** When the harvest stops seeing a raiser shape, a new undocumented slug ships green. */
    const sources: Source[] = [
      { path: "src/cli/commands/x.ts", text: 'die({ slug: "made-up-one", what: "w", fix: "f" });' },
      { path: "ts/lib/x.ts", text: 'export type XSlug =\n  | "made-up-two"\n  | "made-up-three";\nconst y: Mode = "not-a-slug";' },
      { path: "ts/lib/y.ts", text: 'stderr.write(renderWarnLines(reason, "made-up-four"));' },
      { path: "eris", text: "printf 'slug: %s\\n' made-up-five" },
    ];
    const slugs = harvestSlugs(sources);
    expect([...slugs].sort()).toEqual(["made-up-five", "made-up-four", "made-up-one", "made-up-three", "made-up-two"]);
    expect(undocumented(slugs, "### made-up-one\n### made-up-two\n")).toEqual(["made-up-five", "made-up-four", "made-up-three"]);
  });
});
