/**
 * replace.ts — put a new binary where the running one is, and take it back if
 * the new one does not run.
 *
 * Every file it makes sits in the target's own directory, never a system temp
 * dir: a rename is only atomic inside one filesystem, and a binary that is
 * about to be executed should not be staged in a directory anyone can write.
 *
 *   1. `stage`: the download streams into `.eris-update-<pid>-<random>` beside the
 *      target, with the target's mode, and is removed if anything fails.
 *   2. `replace`: hard-links the target to `<target>.old` (a copy where the
 *      filesystem has no links), then renames the staged file over the target.
 *      The rename is atomic, so the target path names a whole binary at every
 *      moment, and replacing the file a process is running from is safe on
 *      macOS and Linux (the running image keeps its inode).
 *   3. The caller runs the new binary (`smoke`). If it fails, `<target>.old` is
 *      renamed back; if it passes, `.old` is removed.
 *
 * An interrupt (Ctrl-C, a TERM, a hangup) in step 1 removes the partial file, and
 * in steps 2-3 puts the old binary back (`onInterrupt`), so a killed update never
 * leaves a stray file or a binary nobody has run.
 */

import { accessSync, chmodSync, closeSync, constants, copyFileSync, linkSync, openSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { Refusal, reasonOf } from "./refusal";

export const oldPath = (target: string): string => `${target}.old`;

/**
 * Run `cleanup` if this process is interrupted, then die by that signal as it
 * would have without us. Returns the function that stands the guard down.
 */
export function onInterrupt(cleanup: () => void): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  const dispose = () => {
    for (const [sig, handler] of handlers) process.removeListener(sig, handler);
    handlers.clear();
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => {
      try {
        cleanup();
      } finally {
        dispose();
        process.kill(process.pid, sig);
      }
    };
    handlers.set(sig, handler);
    process.on(sig, handler);
  }
  return dispose;
}

function unwritable(dir: string, e: unknown): Refusal {
  return new Refusal({
    slug: "update-target-unwritable",
    what: `eris cannot write to ${dir}: ${reasonOf(e)}`,
    fix: `run eris update as a user who can write to ${dir}\nor reinstall eris into a directory you own`,
  });
}

/** Refuse now, before any download, when the target's directory cannot be written. */
export function checkWritable(target: string): void {
  const dir = dirname(target);
  try {
    accessSync(dir, constants.W_OK);
  } catch (e) {
    throw unwritable(dir, e);
  }
}

/** The staged file's path, once `fill` has written all of it through `write`. */
export async function stage(target: string, fill: (write: (chunk: Uint8Array) => void) => Promise<void>): Promise<string> {
  const dir = dirname(target);
  const path = join(dir, `.eris-update-${process.pid}-${randomBytes(4).toString("hex")}`);
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o700);
  } catch (e) {
    throw unwritable(dir, e);
  }
  const stand = onInterrupt(() => rmSync(path, { force: true }));
  try {
    try {
      await fill((chunk) => {
        for (let at = 0; at < chunk.length; ) at += writeSync(fd, chunk, at);
      });
    } finally {
      closeSync(fd);
    }
    chmodSync(path, statSync(target).mode & 0o777);
    return path;
  } catch (e) {
    rmSync(path, { force: true });
    if (e instanceof Refusal) throw e;
    throw unwritable(dir, e);
  } finally {
    stand();
  }
}

/** Remove a staged file that will not be used. */
export function discard(path: string): void {
  rmSync(path, { force: true });
}

/** Keep the running binary as `<target>.old`, and rename `staged` over `target`. */
export function replace(target: string, staged: string): void {
  const old = oldPath(target);
  try {
    rmSync(old, { force: true });
    try {
      linkSync(target, old);
    } catch {
      copyFileSync(target, old);
    }
    renameSync(staged, target);
  } catch (e) {
    rmSync(old, { force: true });
    throw unwritable(dirname(target), e);
  }
}

/** Remove `<target>.old` once the new binary has answered. */
export function forgetOld(target: string): void {
  try {
    unlinkSync(oldPath(target));
  } catch {
    // Nothing to remove, or it cannot be: the update itself succeeded.
  }
}

/** Put `<target>.old` back. Returns the reason it could not, else null. */
export function restore(target: string): string | null {
  try {
    renameSync(oldPath(target), target);
    return null;
  } catch (e) {
    return reasonOf(e);
  }
}
