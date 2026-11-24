/**
 * ratchet.ts — the monotone bar's `ratchet` dimension: pure classification of the shrink-only JSON
 * baselines a repo declares in its root `eris.yaml` (`ratchets: [<path>, ...]`). One row per changed
 * leaf, `ratchet\t<file>#<json pointer>\t<field>\t<tighter|wider>\t<detail>`:
 *
 *   - a number going down is tighter, up is wider (`value`);
 *   - a key holding a number added is wider, removed is tighter (`key`);
 *   - a string-array member added is wider, removed is tighter (`member`);
 *   - the file deleted is wider, first added is tighter (`file`);
 *   - a path dropped from `ratchets:` is wider, newly declared is tighter (`declaration`).
 *
 * Any other change (a string, a boolean, a mixed array, a type change, a non-number key removed) reads
 * wider: what the rules do not name as tighter fails closed. Zero filesystem or git I/O; the reader
 * lives in the gate plugin.
 */

import type { Dim, MonotoneVerdict } from "./monotone";

/** A declared ratchet file on one side: absent, or its parsed JSON. */
export type RatchetFile = { readonly kind: "absent" } | { readonly kind: "json"; readonly value: unknown };

export interface RatchetSide {
  /** The repo-relative paths the root `eris.yaml` lists under `ratchets:` (empty when none). */
  readonly declared: readonly string[];
  /** Every path declared on either side, read on this side. */
  readonly files: ReadonlyMap<string, RatchetFile>;
}

const ABSENT: RatchetFile = { kind: "absent" };

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((m) => typeof m === "string");

/** One RFC 6901 reference token, with control characters escaped so a row stays one line. */
const token = (k: string): string => k.replace(/~/g, "~0").replace(/\//g, "~1").replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** A value as a row detail prints it: single-line JSON. */
const shown = (v: unknown): string => JSON.stringify(v as Json) ?? "null";

/** Every changed leaf between `base` and `head` under `pointer`. */
function diff(file: string, pointer: string, base: unknown, head: unknown, rows: Dim[]): void {
  const at = (p: string, field: string, verdict: MonotoneVerdict, detail: string): void => {
    rows.push({ scope: "ratchet", subject: `${file}#${p}`, field, verdict, detail });
  };
  if (typeof base === "number" && typeof head === "number") {
    if (base !== head) at(pointer, "value", head < base ? "tighter" : "wider", `${base} -> ${head}`);
    return;
  }
  if (isObject(base) && isObject(head)) {
    for (const k of [...new Set([...Object.keys(base), ...Object.keys(head)])].sort()) {
      const p = `${pointer}/${token(k)}`;
      if (!(k in head)) gone(file, p, base[k], rows);
      else if (!(k in base)) added(file, p, head[k], rows);
      else diff(file, p, base[k], head[k], rows);
    }
    return;
  }
  if (isStringArray(base) && isStringArray(head)) {
    for (const m of [...new Set(head)].filter((m) => !base.includes(m)).sort()) at(pointer, "member", "wider", `added ${shown(m)}`);
    for (const m of [...new Set(base)].filter((m) => !head.includes(m)).sort()) at(pointer, "member", "tighter", `removed ${shown(m)}`);
    return;
  }
  if (shown(base) !== shown(head)) at(pointer, "value", "wider", `${shown(base)} -> ${shown(head)}`);
}

/** A key present only at head. */
function added(file: string, pointer: string, v: unknown, rows: Dim[]): void {
  const subject = `${file}#${pointer}`;
  if (isObject(v) && Object.keys(v).length > 0) {
    for (const k of Object.keys(v).sort()) added(file, `${pointer}/${token(k)}`, v[k], rows);
  } else if (isStringArray(v) && v.length > 0) {
    for (const m of [...new Set(v)].sort()) rows.push({ scope: "ratchet", subject, field: "member", verdict: "wider", detail: `added ${shown(m)}` });
  } else {
    rows.push({ scope: "ratchet", subject, field: "key", verdict: "wider", detail: `added ${shown(v)}` });
  }
}

/** A key present only at base: a number, an object of them or a string list going is tighter; anything else is wider. */
function gone(file: string, pointer: string, v: unknown, rows: Dim[]): void {
  const subject = `${file}#${pointer}`;
  if (isObject(v) && Object.keys(v).length > 0) {
    for (const k of Object.keys(v).sort()) gone(file, `${pointer}/${token(k)}`, v[k], rows);
  } else if (isStringArray(v) && v.length > 0) {
    for (const m of [...new Set(v)].sort()) rows.push({ scope: "ratchet", subject, field: "member", verdict: "tighter", detail: `removed ${shown(m)}` });
  } else {
    const tighter = typeof v === "number" || isObject(v) || isStringArray(v);
    rows.push({ scope: "ratchet", subject, field: "key", verdict: tighter ? "tighter" : "wider", detail: `removed ${shown(v)}` });
  }
}

/** The changed rows of every ratchet declared on either side (`same` leaves print nothing, so none are returned). */
export function classifyRatchets(base: RatchetSide, head: RatchetSide): Dim[] {
  const rows: Dim[] = [];
  const fileOf = (side: RatchetSide, path: string): RatchetFile => side.files.get(path) ?? ABSENT;
  for (const path of [...new Set([...base.declared, ...head.declared])].sort()) {
    const at = (field: string, verdict: MonotoneVerdict, detail: string): void => {
      rows.push({ scope: "ratchet", subject: `${path}#`, field, verdict, detail });
    };
    const inBase = base.declared.includes(path);
    const inHead = head.declared.includes(path);
    if (!inHead) {
      at("declaration", "wider", "undeclared");
      continue;
    }
    if (!inBase) {
      at("declaration", "tighter", "declared");
      continue;
    }
    const b = fileOf(base, path);
    const h = fileOf(head, path);
    if (b.kind === "absent" && h.kind === "absent") continue;
    if (h.kind === "absent") at("file", "wider", "deleted");
    else if (b.kind === "absent") at("file", "tighter", "added");
    else diff(path, "", b.value, h.value, rows);
  }
  return rows;
}
