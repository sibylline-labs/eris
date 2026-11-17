/**
 * body.ts — a loop's body, read only from the org's pulled, verified policy tree:
 * `<tree>/loops/<slug>.md`. A loop the tree does not carry is refused (`loop-unknown`); loops are
 * authored in the org's Gates settings, never on this machine.
 *
 * Invariants:
 *  - the slug is one the tree's manifest names (the tree was verified against it), and the file
 *    resolves inside the tree's `loops/` (no link out of it);
 *  - the body is at most `BODY_MAX_BYTES`, valid UTF-8, holds no NUL byte, and is not blank.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { block, stop, usage } from "./failure";
import type { LoopTree } from "./index";
import { BODY_MAX_BYTES } from "./names";

const LOOPS = "loops";

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** The body of loop `slug` from the org's verified tree. */
export function readLoopBody(tree: LoopTree, slug: string): string {
  const loops = join(tree.dir, LOOPS);
  const path = join(loops, `${slug}.md`);
  if (!tree.loops.includes(slug) || !isFile(path)) {
    const known = tree.loops.length > 0 ? tree.loops.join(", ") : "none";
    stop(
      block(
        "loop-unknown",
        `the org's policy (${tree.org}, bundle ${tree.bundleSha}) has no loop ${JSON.stringify(slug)}; it carries: ${known}`,
        "Name one of the org's loops ('eris loop list'), or author the loop in the org's Gates settings, then run 'eris doctrine pull' and re-run.",
        2,
      ),
    );
  }
  let inside: boolean;
  try {
    inside = dirname(realpathSync(path)) === realpathSync(loops);
  } catch (e) {
    return usage(`cannot resolve loop ${JSON.stringify(slug)}: ${(e as Error).message}`);
  }
  if (!inside) usage(`loop ${JSON.stringify(slug)} resolves outside ${loops}`, "Run 'eris doctrine pull' to restore the org's policy tree.");
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch (e) {
    return usage(`cannot read loop ${JSON.stringify(slug)}: ${(e as Error).message}`);
  }
  if (data.length > BODY_MAX_BYTES) usage(`loop ${JSON.stringify(slug)} is ${data.length} bytes; the cap is ${BODY_MAX_BYTES}`);
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return usage(`loop ${JSON.stringify(slug)} is not valid UTF-8`);
  }
  if (body.trim() === "") usage(`loop ${JSON.stringify(slug)} is empty`);
  if (body.includes("\0")) usage(`loop ${JSON.stringify(slug)} contains a NUL byte`);
  return body;
}
