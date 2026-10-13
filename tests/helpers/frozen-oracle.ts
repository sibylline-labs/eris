/**
 * frozen-oracle.ts — the Bash oracles the TS output pre-pass and failure block
 * were diffed against, FROZEN into a committed golden.
 *
 * Every answer comes from tests/fixtures/yaml-parity/oracle-goldens.json: the
 * earlier Bash implementation is not part of this repository, so a test whose
 * expected bytes were produced by it reads the recorded answer. A call with no
 * golden entry THROWS — it never skips and never falls back to a live tool.
 * The fixture's README records how the answers were captured.
 *
 * Keys are CONTENT-ADDRESSED: the sha256 of the op and its inputs. The eris
 * checkout in an answer is stored as the placeholder <ERIS> and substituted
 * back on read.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

export interface YqRun {
  status: number;
  stdout: string;
  stderr: string;
}

export const GOLDEN_FILE = join(import.meta.dir, "..", "fixtures", "yaml-parity", "oracle-goldens.json");
const ERIS = realpathSync(join(import.meta.dir, "..", ".."));

interface Entry {
  op: string;
  label: string;
  answer: unknown;
}

let store: Record<string, Entry> | null = null;

function golden(): Record<string, Entry> {
  if (store === null) store = existsSync(GOLDEN_FILE) ? (JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as Record<string, Entry>) : {};
  return store;
}

const sha = (...parts: string[]) => createHash("sha256").update(parts.join("\0")).digest("hex");

/** Deep-map every string in a JSON-shaped value. */
function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]));
  return v;
}

function call<T>(op: string, label: string, keyParts: string[], subst: Array<[string, string]>): T {
  const all: Array<[string, string]> = [...subst, [ERIS, "<ERIS>"]];
  const key = sha(op, ...keyParts);
  const hit = golden()[key];
  if (!hit) {
    throw new Error(
      `frozen-oracle: no golden for ${op} (${label}) in ${relative(ERIS, GOLDEN_FILE)}. The input changed or is new; ` +
        "the goldens cannot be re-recorded, so test an input they hold (tests/fixtures/yaml-parity/README.md).",
    );
  }
  const back = (s: string) => [...all].reverse().reduce((t, [a, p]) => t.replaceAll(p, a), s);
  return mapStrings(hit.answer, back) as T;
}

/** `bash -c <script> bash <args…>` from the Bash checkout, PATH + ERIS_DIR only (its `output::parse_global`). */
export function bashRepo(script: string, args: string[]): YqRun {
  return call("bashRepo", `${script.split("\n")[1] ?? script} ${args.join(" ")}`.slice(0, 80), [script, JSON.stringify(args)], []);
}

/** The Bash `eris::report <slug> <what> [<fix>] [<docs>]`: its stderr and status. */
export function errorsReport(args: string[]): YqRun {
  return call("errorsReport", args.join(" | ").slice(0, 80), [JSON.stringify(args)], []);
}
