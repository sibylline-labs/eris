/**
 * output.ts — the output contract's checks: which surfaces accept
 * `--output json`, the refusal for one that does not, and how a value is
 * echoed into a diagnostic. The global `--output` parse itself is argv
 * parsing, in src/cli/args.ts.
 *
 * The refusal blocks are the contract in docs/OUTPUT-CONTRACT.md §2–§4;
 * `tests/cli-router.test.ts` holds them against the earlier Bash
 * implementation's answers, frozen in
 * tests/fixtures/yaml-parity/oracle-goldens.json.
 */

import { renderFailureBlock } from "../../ts/lib/eris-fail";
import { deriveJsonSurfaces } from "./registry";

export type OutputFormat = "text" | "json";

/** A value echoed into a diagnostic: C0 controls except tab and newline, plus
 *  DEL, removed; then every trailing newline dropped. */
export function sanitizeDisplay(s: string): string {
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\n+$/, "");
}

/**
 * The surfaces with a machine rendering: a group maps to `true` (every sub)
 * or to the subs that qualify. Derived from the registry's `json` rows;
 * `unsupportedJsonBlock` is its only reader.
 */
export const JSON_SURFACES: Readonly<Record<string, true | readonly string[]>> = deriveJsonSurfaces();

/** The column a json surface's shape starts at in the refusal's fix text. */
export const FIX_COLUMN = 43;

/** One line of the refusal's fix text: `  eris <path>`, then from `FIX_COLUMN` what it prints. */
export function jsonFixLine(path: string, shape: string): string {
  const head = `  eris ${path}`;
  return `${head}${" ".repeat(Math.max(1, FIX_COLUMN - head.length))}${shape}\n`;
}

/** The refusal's fix text: this header and core's own json surfaces, then each
 *  plugin's lines (src/cli/compose.ts): the plugin's own `jsonFix`, else a
 *  line per json row. A json row or argv shape added to core is named here too
 *  (tests/cli-router.test.ts holds the two together). */
export const UNSUPPORTED_FIX_SURFACES = `the surfaces that accept --output json are:
${jsonFixLine("--version", "{version, release_repo, build_id, extra}")}${jsonFixLine("update", "{current, latest, update_available, updated}")}`;

/** The fix text with `lines` (each ending in a newline) after the header. The
 *  last newline is dropped: a trailing one renders as an empty `fix:` line. */
export function unsupportedFix(lines: readonly string[] = []): string {
  return `${UNSUPPORTED_FIX_SURFACES}${lines.join("")}`.replace(/\n$/, "");
}

export const UNSUPPORTED_FIX = unsupportedFix();

/** `output::assert_supported`. Returns the refusal block, or null. A composed
 *  build passes its own allow-list and fix text (src/cli/compose.ts). */
export function unsupportedJsonBlock(
  group: string | undefined,
  sub: string | undefined,
  format: OutputFormat,
  home: string,
  surfaces: Readonly<Record<string, true | readonly string[]>> = JSON_SURFACES,
  fix: string = UNSUPPORTED_FIX,
): string | null {
  if (format !== "json") return null;
  const g = group ?? "";
  const s = sub ?? "";
  const surface = Object.hasOwn(surfaces, g) ? surfaces[g] : undefined;
  if (surface === true || (surface && surface.includes(s))) return null;
  return renderFailureBlock(
    {
      slug: "output-json-unsupported",
      what:
        `'eris ${sanitizeDisplay(`${g}${s !== "" ? ` ${s}` : ""}`)}' has no JSON rendering — ` +
        "refusing --output json rather than printing human text a parser would read as JSON",
      fix,
      docs: "docs/OUTPUT-CONTRACT.md#3-machine-surfaces",
    },
    home,
  );
}
