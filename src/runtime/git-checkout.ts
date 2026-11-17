/**
 * Whether `dir` is the root of a git checkout, by structure rather than by the
 * mere presence of a `.git` entry: a `.git` directory holding a `HEAD` file, or
 * a `.git` file whose first line starts `gitdir:` (a worktree or submodule
 * pointer). A stray empty or bogus `.git` is not a checkout, so an upward walk
 * for a manifest never stops on one.
 *
 * Only ENOENT and ENOTDIR mean "no marker here". Any other error (EACCES, EIO,
 * ELOOP, ...) leaves it unknown whether `dir` is a checkout root, and a walk that
 * crossed it could take an enclosing repo's manifest as this one's, so the
 * probe reports it as `unknown` for the caller to refuse.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

const POINTER_PEEK_BYTES = 256;

export type GitCheckoutProbe =
  | { readonly kind: "root" }
  | { readonly kind: "not-root" }
  | { readonly kind: "unknown"; readonly path: string; readonly code: string };

const ROOT: GitCheckoutProbe = { kind: "root" };
const NOT_ROOT: GitCheckoutProbe = { kind: "not-root" };

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** A filesystem error that means the path is not there, as opposed to there but uninspectable. */
function absent(err: unknown): boolean {
  const code = errCode(err);
  return code === "ENOENT" || code === "ENOTDIR";
}

function unknown(path: string, err: unknown): GitCheckoutProbe {
  return { kind: "unknown", path, code: errCode(err) ?? "read failed" };
}

export function probeGitCheckoutRoot(dir: string): GitCheckoutProbe {
  const marker = join(dir, ".git");
  let st;
  try {
    st = statSync(marker);
  } catch (err) {
    return absent(err) ? NOT_ROOT : unknown(marker, err);
  }
  if (st.isDirectory()) {
    try {
      statSync(join(marker, "HEAD"));
      return ROOT;
    } catch (err) {
      return absent(err) ? NOT_ROOT : unknown(marker, err);
    }
  }
  if (!st.isFile()) return NOT_ROOT;
  let fd: number | undefined;
  try {
    fd = openSync(marker, "r");
    const buf = Buffer.alloc(POINTER_PEEK_BYTES);
    const n = readSync(fd, buf, 0, POINTER_PEEK_BYTES, 0);
    return buf.toString("utf8", 0, n).startsWith("gitdir:") ? ROOT : NOT_ROOT;
  } catch (err) {
    return absent(err) ? NOT_ROOT : unknown(marker, err);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
