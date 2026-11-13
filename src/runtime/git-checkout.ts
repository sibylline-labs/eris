/**
 * Whether `dir` is the root of a git checkout, by structure rather than by the
 * mere presence of a `.git` entry: a `.git` directory holding a `HEAD` file, or
 * a `.git` file whose first line starts `gitdir:` (a worktree or submodule
 * pointer). A stray empty or bogus `.git` is not a checkout, so an upward walk
 * for a manifest never stops on one.
 */

import { closeSync, openSync, readSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const POINTER_PEEK_BYTES = 256;

export function isGitCheckoutRoot(dir: string): boolean {
  const marker = join(dir, ".git");
  let st;
  try {
    st = statSync(marker);
  } catch {
    return false;
  }
  if (st.isDirectory()) return existsSync(join(marker, "HEAD"));
  if (!st.isFile()) return false;
  let fd: number | undefined;
  try {
    fd = openSync(marker, "r");
    const buf = Buffer.alloc(POINTER_PEEK_BYTES);
    const n = readSync(fd, buf, 0, POINTER_PEEK_BYTES, 0);
    return buf.toString("utf8", 0, n).startsWith("gitdir:");
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
