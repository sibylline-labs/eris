/**
 * settings.ts — `~/.eris/settings.json`, the operator's standing environment.
 *
 *   {
 *     "source": ["~/creds/.dev-credentials"],
 *     "env":    { "API_TOKEN": "${API_EDITOR_TOKEN}" },
 *     "unset":  ["READ_ONLY_TOKEN"]
 *   }
 *
 * The three keys are the file form of
 * `set -a; source <file>; set +a; env -u <NAME> NAME=value … eris`:
 *
 *   - `source` — files of `KEY=value` lines (`export` prefix, `#` comments, single
 *     or double quotes, `$VAR` / `${VAR}` outside single quotes), read in order,
 *     a later file winning. They are PARSED, never executed: a command
 *     substitution stays literal text.
 *   - `env` — entries over the sourced values, each value `${VAR}`-expanded
 *     against the environment as it will be (caller first, then the settings
 *     resolved so far). An unset reference expands to "", as in a shell.
 *   - `unset` — names removed from the result, the caller's own value INCLUDED:
 *     it exists to drop a variable a shell profile exports.
 *
 * `source` and `env` fill only variables the caller left UNSET; a variable in the
 * environment wins, an empty one included. The router applies the result to its
 * own process before routing, so a TS verb and every child it spawns see the
 * same values.
 *
 * Fail-open: a missing settings file is silence; an unreadable or malformed one,
 * a missing source file, an unparseable line, a non-string value and a DENIED name
 * are each one stderr warning and skipped — never a refusal. Warnings name files,
 * line numbers and keys, never a value. Denied: `BUN_CONFIG_VERBOSE_FETCH` (bun
 * would print bearers and secret bodies, see the `eris` shim) and the router's
 * own `_ERIS_*` handover.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readEnv } from "./env";

type Env = Record<string, string | undefined>;
type Warn = (msg: string) => void;

export interface Settings {
  source: string[];
  env: Record<string, string>;
  unset: string[];
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function home(env: Env): string {
  return env.HOME || homedir();
}

export function settingsPath(env: Env): string {
  return join(home(env), ".eris", "settings.json");
}

function denied(name: string): boolean {
  return name === "BUN_CONFIG_VERBOSE_FETCH" || name.startsWith("_ERIS_");
}

/** `$VAR` and `${VAR}` against `lookup`; an unset name expands to "". */
export function expand(value: string, lookup: (name: string) => string | undefined): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a, b) => lookup(a ?? b) ?? "");
}

function stringList(doc: Record<string, unknown>, key: string, path: string, warn: Warn): string[] {
  const raw = doc[key];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warn(`${path}: "${key}" must be a list of strings — ignored`);
    return [];
  }
  return raw.filter((v, i) => {
    if (typeof v === "string") return true;
    warn(`${path}: ${key}[${i}] is not a string — skipped`);
    return false;
  });
}

/** The validated settings document, or an empty one when there is none to use. */
export function readSettings(path: string, warn: Warn): Settings {
  const none: Settings = { source: [], env: {}, unset: [] };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") warn(`ignoring ${path}: ${(e as Error).message}`);
    return none;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    warn(`ignoring ${path}: not valid JSON (${(e as Error).message})`);
    return none;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    warn(`ignoring ${path}: expected a JSON object`);
    return none;
  }
  const d = doc as Record<string, unknown>;
  const env: Record<string, string> = {};
  if (d.env !== undefined) {
    if (d.env === null || typeof d.env !== "object" || Array.isArray(d.env)) {
      warn(`${path}: "env" must be an object of strings — ignored`);
    } else {
      for (const [k, v] of Object.entries(d.env)) {
        if (denied(k)) warn(`${path}: env.${k} is not settable here — skipped`);
        else if (typeof v !== "string") warn(`${path}: env.${k} is not a string — skipped`);
        else env[k] = v;
      }
    }
  }
  const unset = stringList(d, "unset", path, warn).filter((k) => {
    if (!denied(k)) return true;
    warn(`${path}: unset ${k} is not allowed here — skipped`);
    return false;
  });
  return { source: stringList(d, "source", path, warn), env, unset };
}

/** One sourced file's assignments, in order. Values are expanded by the caller's
 *  `lookup` as each line is read, so a line can use one assigned above it. */
export function parseEnvFile(
  text: string,
  path: string,
  lookup: (name: string) => string | undefined,
  warn: Warn,
): [string, string][] {
  const out: [string, string][] = [];
  const local = new Map<string, string>();
  const see = (n: string) => (local.has(n) ? local.get(n) : lookup(n));
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim().replace(/^export\s+/, "");
    if (line === "" || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    const key = eq > 0 ? line.slice(0, eq) : "";
    if (!NAME.test(key)) {
      warn(`${path}:${i + 1}: not a KEY=value line — skipped`);
      return;
    }
    let rest = line.slice(eq + 1);
    let value: string;
    const q = rest[0];
    if (q === "'" || q === '"') {
      const end = rest.indexOf(q, 1);
      if (end < 0) {
        warn(`${path}:${i + 1}: unterminated quote — skipped`);
        return;
      }
      value = rest.slice(1, end);
      if (q === '"') value = expand(value.replace(/\\(["\\$`])/g, "$1"), see);
    } else {
      rest = rest.replace(/\s+#.*$/, "").trim();
      value = expand(rest, see);
    }
    local.set(key, value);
    out.push([key, value]);
  });
  return out;
}

/** Apply the settings file to `env`, in place. */
export function applySettings(env: Env, warn: Warn): void {
  const path = settingsPath(env);
  const s = readSettings(path, warn);
  const layer: Record<string, string> = {};
  const lookup = (n: string) => readEnv(env, n) ?? readEnv(layer, n);
  for (const src of s.source) {
    const file = src.startsWith("~/") ? join(home(env), src.slice(2)) : src;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      warn(`${path}: source ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message} — skipped`);
      continue;
    }
    for (const [k, v] of parseEnvFile(text, file, lookup, warn)) {
      if (denied(k)) warn(`${file}: ${k} is not settable here — skipped`);
      else layer[k] = v;
    }
  }
  for (const [k, v] of Object.entries(s.env)) layer[k] = expand(v, lookup);
  for (const [k, v] of Object.entries(layer)) {
    if (readEnv(env, k) === undefined) env[k] = v;
  }
  for (const k of s.unset) delete env[k];
}
