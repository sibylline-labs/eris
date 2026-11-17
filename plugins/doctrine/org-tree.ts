/**
 * org-tree.ts — an org's pulled policy bundle on this machine:
 * `~/.eris/doctrine/<orgId>/{manifest.json,doctrine.md,profiles.yaml,loops/<slug>.md}`
 * (docs/dev/GATES-CLIENT.md#the-pulled-tree).
 *
 * Invariants:
 *  - `<orgId>` is a symlink to a complete, verified tree `.<orgId>.<bundle_sha>.<pid>.<hex>/`; a pull
 *    swaps it with one `rename`, so a reader sees the old tree or the new one, never neither.
 *  - A tree is written, then read back through `verifyTree`, before the swap: the files on disk
 *    reproduce the server's `bundle_sha`, or nothing is swapped in.
 *  - `verifyTree` reads only the tree: the file set and each file's sha256 against `manifest.json`,
 *    then `computeGatesBundleSha` over the decoded bundle and the manifest's settings.
 *  - The org id is a bare ULID (`isOrgId`), so it is one safe path segment, before any path is joined.
 *  - The manifest's bytes and the files' bytes are a shared format: another eris build reading the
 *    same `~/.eris/doctrine` verifies a tree this one wrote.
 *  - Two pulls at once each stage their own directory; the link always names one complete tree. The
 *    pull that swaps second may leave the first's staging directory behind, and a reader that
 *    resolved the link just before a swap may find its tree removed and fail once with
 *    `doctrine-local-modified`; the next run reads the new tree.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as Schema from "effect/Schema";
import {
  BUNDLE_DOCTRINE_FILE,
  BUNDLE_LOOPS_DIR,
  bundleFromFiles,
  computeGatesBundleSha,
  type ContractFailure,
  decodeResult,
  GATES_POLICY_CONTRACT_VERSION,
  GatesBundleSha,
  GatesOrgBundle,
  GatesSettings,
  type Outcome,
  type PulledPolicy,
  renderBundle,
} from "eris/gates-contract";
import { isOrgId } from "../../src/cli/plugin";

const OrgId = Schema.String.check(Schema.makeFilter((s) => isOrgId(s), { expected: "a 26-character org ULID" }));

export const DoctrineManifest = Schema.Struct({
  contract: Schema.Literal(GATES_POLICY_CONTRACT_VERSION),
  org: OrgId,
  bundle_sha: GatesBundleSha,
  settings: GatesSettings,
  /** Each materialized file's sha256, by its path relative to the tree. */
  files: Schema.Record(Schema.String, Schema.String),
  pulled_at: Schema.String,
});
export type DoctrineManifest = typeof DoctrineManifest.Type;

/** A verified tree: where it is (resolved once, so every read sees one tree) and its manifest. */
export interface OrgTree {
  readonly org: string;
  readonly dir: string;
  readonly manifest: DoctrineManifest;
}

const MANIFEST = "manifest.json";

export const doctrineRoot = (home: string): string => join(home, ".eris", "doctrine");

/** The org's tree as a path (a symlink when pulled). */
export const orgPath = (home: string, org: string): string => join(doctrineRoot(home), org);

export function localModified(org: string, what: string): ContractFailure {
  return {
    slug: "doctrine-local-modified",
    what: `~/.eris/doctrine/${org}/: ${what}, so it no longer matches the org's policy this machine pulled`,
    fix: "Run 'eris doctrine pull' to restore the org's policy; change the policy in the org's Gates settings, not on disk.",
    docs: "docs/ERRORS.md#doctrine-local-modified",
    exit: 3,
  };
}

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** Every file in a tree but the manifest, by relative path (a directory other than `loops/` lists as itself). */
function listTree(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === MANIFEST) continue;
    if (e.isDirectory() && e.name === BUNDLE_LOOPS_DIR) for (const l of readdirSync(join(dir, BUNDLE_LOOPS_DIR))) out.push(`${BUNDLE_LOOPS_DIR}/${l}`);
    else out.push(e.name);
  }
  return out.sort();
}

/** Verify a tree offline against its manifest: the manifest when it holds, else `doctrine-local-modified`. */
export async function verifyTree(dir: string, org: string): Promise<Outcome<DoctrineManifest>> {
  const modified = (what: string): Outcome<never> => ({ ok: false, failure: localModified(org, what) });
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
  } catch {
    return modified(`${MANIFEST} is unreadable`);
  }
  const decoded = decodeResult(DoctrineManifest, raw);
  if (decoded._tag !== "Success") return modified(`${MANIFEST} is not a manifest`);
  const manifest = decoded.success;
  if (manifest.org !== org) return modified(`${MANIFEST} names org ${manifest.org}`);
  let present: string[];
  try {
    present = listTree(dir);
  } catch {
    return modified("its files are unreadable");
  }
  const expected = Object.keys(manifest.files).sort();
  const extra = present.find((p) => !Object.hasOwn(manifest.files, p));
  if (extra !== undefined) return modified(`${extra} was added`);
  const gone = expected.find((p) => !present.includes(p));
  if (gone !== undefined) return modified(`${gone} was removed`);
  const files: Record<string, string> = {};
  for (const rel of expected) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(dir, rel));
    } catch {
      return modified(`${rel} is unreadable`);
    }
    if (sha256(bytes) !== manifest.files[rel]) return modified(`${rel} was edited`);
    files[rel] = bytes.toString("utf8");
  }
  const input = bundleFromFiles(files);
  if ("bad" in input) return modified(input.bad);
  const bundle = decodeResult(GatesOrgBundle, input.value);
  if (bundle._tag !== "Success") return modified("its files no longer decode as a policy bundle");
  const sha = await computeGatesBundleSha(bundle.success, manifest.settings);
  if (sha !== manifest.bundle_sha) return modified(`its bundle hashes to ${sha}, not ${manifest.bundle_sha}`);
  return { ok: true, value: manifest };
}

/** The org's verified tree, null when it has none; `doctrine-local-modified` when it was edited. */
export async function orgTree(home: string, org: string): Promise<Outcome<OrgTree | null>> {
  const link = orgPath(home, org);
  try {
    lstatSync(link);
  } catch {
    return { ok: true, value: null };
  }
  let dir: string;
  try {
    dir = realpathSync(link);
  } catch {
    return { ok: false, failure: localModified(org, "its link names no tree") };
  }
  const verified = await verifyTree(dir, org);
  return verified.ok ? { ok: true, value: { org, dir, manifest: verified.value } } : verified;
}

/**
 * Write a pulled bundle as a new tree, verify it, and swap the org's link onto it. A tree that does
 * not reproduce `bundle_sha` is removed and refused (`gate-contract-mismatch`); the old tree stays.
 * The old tree's contents are never read, so a pull is the fix for an edited one.
 */
export async function materialize(home: string, org: string, pulled: PulledPolicy, now: Date): Promise<Outcome<string>> {
  const root = doctrineRoot(home);
  const staged = join(root, `.${org}.${pulled.bundle_sha}.${process.pid}.${randomBytes(4).toString("hex")}`);
  const files = renderBundle(pulled.bundle);
  const manifest: DoctrineManifest = {
    contract: GATES_POLICY_CONTRACT_VERSION,
    org,
    bundle_sha: pulled.bundle_sha,
    settings: pulled.settings,
    files: Object.fromEntries(Object.entries(files).map(([rel, body]) => [rel, sha256(body)])),
    pulled_at: now.toISOString(),
  };
  const unwritable = (e: unknown): Outcome<never> => {
    rmSync(staged, { recursive: true, force: true });
    return {
      ok: false,
      failure: {
        slug: "doctrine-pull-unwritable",
        what: `cannot write ${staged}: ${(e as Error).message}`,
        fix: `Make ${root} writable by you (it is created 0700), then run 'eris doctrine pull' again.`,
        docs: "docs/ERRORS.md#doctrine-pull-unwritable",
        exit: 3,
      },
    };
  };
  try {
    mkdirSync(join(staged, BUNDLE_LOOPS_DIR), { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(staged, rel), body, { mode: 0o600 });
    writeFileSync(join(staged, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  } catch (e) {
    return unwritable(e);
  }
  const verified = await verifyTree(staged, org);
  if (!verified.ok) {
    rmSync(staged, { recursive: true, force: true });
    return {
      ok: false,
      failure: {
        slug: "gate-contract-mismatch",
        what: `the pulled bundle ${pulled.bundle_sha} does not survive the round trip to disk (${verified.failure.what})`,
        fix: "Update eris ('eris update'); if it persists, the bundle holds text this client cannot write as files: report it.",
        docs: "docs/ERRORS.md#gate-contract-mismatch",
        exit: 3,
      },
    };
  }
  // lift-candidate: atomic-dir-swap — stage dir, verify, rename into place, keep previous on failure
  const link = orgPath(home, org);
  try {
    let previous: string | null = null;
    try {
      const st = lstatSync(link);
      if (st.isSymbolicLink()) previous = readlinkSync(link);
      else renameSync(link, `${staged}.replaced`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const next = `${staged}.link`;
    symlinkSync(basename(staged), next);
    renameSync(next, link);
    if (previous !== null && previous !== basename(staged)) rmSync(join(root, basename(previous)), { recursive: true, force: true });
    rmSync(`${staged}.replaced`, { recursive: true, force: true });
  } catch (e) {
    return unwritable(e);
  }
  return { ok: true, value: staged };
}

/** The doctrine file through the org's link, as `doctrine path` prints it. */
export const linkedDoctrineFile = (home: string, org: string): string => join(orgPath(home, org), BUNDLE_DOCTRINE_FILE);
