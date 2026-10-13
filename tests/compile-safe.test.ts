/**
 * The source `bun build --compile` bundles stays compile-safe.
 *
 * The compiled binary carries a module graph frozen at build time, rooted at a
 * virtual `/$bunfs/root`. Two idioms that work under a plain `bun src/main.ts`
 * break there, and neither fails a build or a checkout-path test:
 *
 *   - a dynamic `import()` whose specifier is computed (a template with a
 *     substitution, a variable, a `join(...)`): the bundler cannot see the
 *     target, so the module is absent and the verb dies at runtime with
 *     `/$bunfs/root/... does not exist` (observed: `config validate`).
 *   - `import.meta.dir` / `url` / `path` used to find a file next to the
 *     source: in a binary it names `/$bunfs/root`, where no repo file exists.
 *     The install root comes from `src/runtime/home.ts` instead.
 *
 * Failure mode caught: a new computed loader or a new `import.meta` path read
 * in any file the binary bundles. Observed at: the parsed source, by the
 * TypeScript compiler's own AST, so prose and string contents never match.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const REPO = join(import.meta.dir, "..");

/** What `scripts/build.ts` bundles from `src/main.ts`: the program, its libraries and the
 *  build's plugins. */
const ROOTS = ["src", "ts", "plugins"];
const ROOT_FILES: string[] = [];

/** `import.meta` properties that are not a filesystem path, and so safe in a binary. */
const SAFE_META = new Set(["main", "env"]);

/** Path reads with a reason they cannot reach a binary. */
const META_ALLOWED: Readonly<Record<string, string>> = {
  // The one resolver of the install root: it reads import.meta.dir only when not compiled.
  "src/runtime/home.ts": "the install-root resolver",
};

function sources(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(join(REPO, dir)).flatMap((e) => {
      const rel = join(dir, e);
      if (statSync(join(REPO, rel)).isDirectory()) return walk(rel);
      return /\.tsx?$/.test(e) && !e.endsWith(".d.ts") ? [rel] : [];
    });
  return [...ROOTS.flatMap(walk), ...ROOT_FILES];
}

export interface Hazard {
  file: string;
  line: number;
  kind: "computed-import" | "import-meta-path";
  text: string;
}

/** Every compile hazard in one source text. */
export function hazards(file: string, text: string): Hazard[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Hazard[] = [];
  const at = (n: ts.Node, kind: Hazard["kind"]) =>
    out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, kind, text: n.getText(sf) });
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0];
      if (arg === undefined || !(ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) at(n, "computed-import");
    }
    if (ts.isPropertyAccessExpression(n) && ts.isMetaProperty(n.expression) && n.expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
      if (!SAFE_META.has(n.name.text)) at(n, "import-meta-path");
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("the bundled source is compile-safe", () => {
  it("has no computed dynamic import and no import.meta path read outside the resolver", () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(20); // the scan sees the tree
    const bad = files
      .flatMap((f) => hazards(f, readFileSync(join(REPO, f), "utf8")))
      .filter((h) => !(h.kind === "import-meta-path" && h.file in META_ALLOWED))
      .map((h) => `${h.file}:${h.line}: ${h.kind}: ${h.text}`);
    expect(bad).toEqual([]);
  });

  it("every allow-list entry is still a file the scan reads", () => {
    const files = new Set(sources());
    for (const f of Object.keys(META_ALLOWED)) expect(files.has(f)).toBe(true);
  });

  it("positive control: flags each hazard shape and passes the safe ones", () => {
    const bad = [
      "const m = await import(`./vars/${sub}.ts`);",
      "const m = await import(file);",
      'const m = await import(join(dir, "x.ts"));',
      'const p = join(import.meta.dir, "..");',
      "const u = new URL(import.meta.url);",
      "const f = import.meta.path;",
    ].join("\n");
    expect(hazards("x.ts", bad).map((h) => h.kind)).toEqual([
      "computed-import",
      "computed-import",
      "computed-import",
      "import-meta-path",
      "import-meta-path",
      "import-meta-path",
    ]);
    const safe = [
      'const m = await import("./config/validate.ts");',
      "const n = await import(`./literal.ts`);",
      "if (import.meta.main) run();",
      "// import(`./${x}`) and import.meta.dir in prose",
      'const s = "import(file) import.meta.url";',
    ].join("\n");
    expect(hazards("x.ts", safe)).toEqual([]);
  });
});
