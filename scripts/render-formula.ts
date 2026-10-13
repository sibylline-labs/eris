/**
 * render-formula.ts — render the Homebrew formula for one release.
 *
 *   bun scripts/render-formula.ts --tag v0.2.0 --sums SHA256SUMS \
 *     [--repo owner/name] [--template packaging/homebrew/eris.rb.tmpl] [--out Formula/eris.rb]
 *
 * Fills the template's @MARKERS@ from the release tag and the release's
 * SHA256SUMS (the file the release workflow publishes beside the binaries), and
 * writes the formula to `--out`, or to stdout. It refuses a tag that is not
 * `vMAJOR.MINOR.PATCH[-prerelease]`, a SHA256SUMS that lacks either binary, and
 * a template with a marker left unfilled, so a formula that would fail on every
 * user's machine is never committed to the tap.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { RELEASE_TAG as TAG } from "../src/cli/commands/update/semver";

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const DEFAULT_REPO = "sibylline-labs/eris";
const DEFAULT_TEMPLATE = join(import.meta.dir, "..", "packaging", "homebrew", "eris.rb.tmpl");

/** The binary each marker's checksum belongs to. */
const ASSETS = { SHA256_DARWIN_ARM64: "eris-darwin-arm64", SHA256_LINUX_X64: "eris-linux-x64" } as const;

/** `name → sha256` from a `sha256sum`-format file (`<hex>  <name>`, or `<hex> *<name>`). */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-fA-F]{64}) [ *](\S+)\r?$/.exec(line);
    if (m === null) continue;
    const hex = m[1]!.toLowerCase();
    const prior = sums.get(m[2]!);
    if (prior !== undefined && prior !== hex) throw new Error(`SHA256SUMS lists ${m[2]} twice with different checksums`);
    sums.set(m[2]!, hex);
  }
  return sums;
}

export interface FormulaInput {
  readonly template: string;
  readonly tag: string;
  readonly repo: string;
  readonly sums: string;
}

export function renderFormula({ template, tag, repo, sums }: FormulaInput): string {
  if (!TAG.test(tag)) throw new Error(`--tag must look like v0.2.0 or v0.3.0-rc.1: ${JSON.stringify(tag)}`);
  if (!REPO.test(repo)) throw new Error(`--repo must be owner/name: ${JSON.stringify(repo)}`);
  const checksums = parseSums(sums);
  const missing = Object.values(ASSETS).filter((name) => !checksums.has(name));
  if (missing.length > 0) throw new Error(`SHA256SUMS has no checksum for ${missing.join(", ")}`);
  const values: Record<string, string> = { REPO: repo, TAG: tag, VERSION: tag.slice(1) };
  for (const [marker, asset] of Object.entries(ASSETS)) values[marker] = checksums.get(asset)!;
  const out = template.replace(/@([A-Z0-9_]+)@/g, (whole, name: string) => (Object.hasOwn(values, name) ? values[name]! : whole));
  const left = out.match(/@[A-Z0-9_]+@/g);
  if (left !== null) throw new Error(`the template has markers this script does not fill: ${[...new Set(left)].join(", ")}`);
  return out;
}

function main(argv: string[]): number {
  let values: { tag?: string; sums?: string; repo?: string; template?: string; out?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { tag: { type: "string" }, sums: { type: "string" }, repo: { type: "string" }, template: { type: "string" }, out: { type: "string" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    process.stderr.write(`ERROR usage: bun scripts/render-formula.ts --tag <vX.Y.Z> --sums <SHA256SUMS> [--repo owner/name] [--template <file>] [--out <file>] (${(e as Error).message})\n`);
    return 1;
  }
  if (values.tag === undefined || values.sums === undefined) {
    process.stderr.write("ERROR --tag and --sums are required\n");
    return 1;
  }
  try {
    const formula = renderFormula({
      template: readFileSync(values.template ?? DEFAULT_TEMPLATE, "utf8"),
      tag: values.tag,
      repo: values.repo ?? DEFAULT_REPO,
      sums: readFileSync(values.sums, "utf8"),
    });
    if (values.out === undefined) process.stdout.write(formula);
    else writeFileSync(values.out, formula);
    return 0;
  } catch (e) {
    process.stderr.write(`ERROR ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)));
