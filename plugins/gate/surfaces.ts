/**
 * surfaces.ts — which surfaces a change crosses, for `eris gate check --burden`.
 *
 * The changed paths are the working tree against the merge-base of `<base>` and HEAD: every tracked
 * path the diff names (a delete, and both sides of a rename) plus the untracked ones. Each resolves to
 * the service holding the most specific `discover.paths` claim over it (an identical-path tie yields
 * every tied service); a path no claim covers crosses nothing.
 *
 * This build reads the claims of the checkout's root `eris.yaml` only. An estate with leaf manifests
 * under the root is refused (`gate-burden-unresolved`) rather than resolved from the root alone: a
 * leaf's narrower claim would own its paths, so the root's answer could name the wrong surface. An
 * estate that opts no manifest into discovery is refused too: no claims means the crossing is
 * unknowable, not empty.
 */

import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { parse as parseYaml } from "yaml";
import { precondition } from "./failure";
import { changedPaths, type Git, knownFiles, mergeBase, repoRoot, revParse, untrackedFiles } from "./git";

export interface Crossed {
  /** Every changed path, git-top-relative, sorted. */
  readonly changed: ReadonlyArray<string>;
  /** The surfaces those paths cross, sorted and distinct. */
  readonly surfaces: ReadonlyArray<string>;
  /** Every surface the estate claims, crossed or not (a rubric name outside it is likely a typo). */
  readonly known: ReadonlyArray<string>;
}

const unresolved = (what: string, fix: string): never => precondition("gate-burden-unresolved", what, fix);

const NEED_DISCOVER = "Opt the repo's eris.yaml docs into discovery (discover.language + discover.paths), or drop --burden.";

/** A repo-relative path, normalized: `./src/` is `src`, `./` is `.`; "" for blank, absolute or `..`-escaping. */
const canonPath = (p: string): string => {
  const t = p.trim();
  if (t === "" || t.startsWith("/")) return "";
  const n = posix.normalize(t).replace(/\/+$/, "");
  if (n === ".." || n.startsWith("../")) return "";
  return n === "" ? "." : n;
};
const normPath = (p: string): string => canonPath(p) || ".";

interface Claim {
  readonly service: string;
  readonly path: string;
}

/** The services holding the most specific claim that covers `file`, sorted and distinct. */
function claimantsOf(file: string, claims: readonly Claim[]): string[] {
  let best = -1;
  let holders = new Set<string>();
  for (const c of claims) {
    const p = normPath(c.path);
    if (!(p === "." || file === p || file.startsWith(`${p}/`))) continue;
    const depth = p === "." ? 0 : p.split("/").length;
    if (depth > best) {
      best = depth;
      holders = new Set([c.service]);
    } else if (depth === best) holders.add(c.service);
  }
  return [...holders].sort();
}

const field = (doc: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((v, k) => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined), doc);
const text = (v: unknown): string => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "");

/** The root manifest's claims: none when it does not opt into discovery, else its `discover.paths` under its `service`. */
function rootClaims(file: string): Claim[] {
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(file, "utf8"));
  } catch (e) {
    return unresolved(`the estate's eris.yaml docs do not parse: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`, "Fix the manifest ('eris lint' names it).");
  }
  const paths = field(doc, ["discover", "paths"]);
  const opted = Array.isArray(paths) ? paths.length > 0 : paths !== null && typeof paths === "object" ? Object.keys(paths).length > 0 : text(paths).length > 0;
  const language = opted ? text(field(doc, ["discover", "language"])) : "";
  if (language === "") return [];
  if (language !== "python" && language !== "typescript") {
    return unresolved(`the estate's discover blocks cannot be read: unsupported discover.language '${language}' in ${file} (packs: python, typescript)`, NEED_DISCOVER);
  }
  const service = text(field(doc, ["service"]));
  if (service === "") return unresolved(`the estate's discover blocks cannot be read: doc with a discover: block has no service: ${file}`, NEED_DISCOVER);
  const authored = Array.isArray(paths) ? paths.flatMap((p) => (p !== null && (typeof p === "string" || typeof p === "number") ? [String(p)] : [])) : [];
  return authored.filter((p) => canonPath(p) !== "").map((p) => ({ service, path: normPath(p) }));
}

/** The surfaces the change since `base` crosses, by the root `eris.yaml`'s `discover.paths`. */
export async function discoverPathsSurfaces(g: Git, cwd: string, base: string): Promise<Crossed> {
  const top = await repoRoot(g, cwd);
  if (top === null) return unresolved(`--base ${base}: ${cwd} is not inside a git checkout`, "Run check from a checkout of the changed repo.");
  const tip = await revParse(g, base, top);
  if (tip === null) return unresolved(`--base ${base}: does not name a commit in this checkout`, "Name a branch, tag or sha this checkout has (fetch it first in a shallow clone).");
  const fork = await mergeBase(g, top, tip, "HEAD");
  if (fork === null) return unresolved(`--base ${base}: shares no history with HEAD`, "Name the branch this change forked from.");
  const tracked = await changedPaths(g, top, fork);
  const untracked = await untrackedFiles(g, top);
  if (tracked === null || untracked === null) return unresolved(`--base ${base}: git could not list the changes`, "Re-run; check 'git status' works in this checkout.");

  const root = `${top}/eris.yaml`;
  let isRoot = false;
  try {
    readFileSync(root);
    isRoot = true;
  } catch {
    isRoot = false;
  }
  if (!isRoot) return unresolved(`no eris.yaml at ${top}, so no discover.paths to resolve surfaces from`, NEED_DISCOVER);
  const files = await knownFiles(g, top);
  const leaves = (files ?? []).filter((f) => f !== "eris.yaml" && posix.basename(f) === "eris.yaml").sort();
  if (files === null || leaves.length > 0) {
    const named = files === null ? "git could not list the estate's manifests" : `leaf manifest(s) ${leaves.slice(0, 3).join(", ")}${leaves.length > 3 ? ", ..." : ""}`;
    return unresolved(
      `the estate under ${top} has ${named}; this build resolves surfaces from the root eris.yaml's discover.paths only`,
      "Run check --burden with an eris build that walks the whole estate, or drop --burden.",
    );
  }
  const claims = rootClaims(root);
  if (claims.length === 0) return unresolved(`no eris.yaml under ${top} claims discover.paths`, NEED_DISCOVER);

  const changed = [...new Set([...tracked, ...untracked])].sort();
  const surfaces = [...new Set(changed.flatMap((f) => claimantsOf(f, claims)))].sort();
  return { changed, surfaces, known: [...new Set(claims.map((c) => c.service))].sort() };
}
