/**
 * scrub-check.ts — fail when the tree carries something a public repo must not:
 * a private organisation reference, an internal host, a secret-store path, a
 * personal email, a tracker, register, review or private-document label, a
 * commit SHA from outside this repository, or a token-shaped literal that a
 * secret scanner would flag.
 *
 *   bun scripts/scrub-check.ts                    scan every tracked or
 *                                                 untracked, not-ignored file,
 *                                                 as it is in the working tree
 *   bun scripts/scrub-check.ts --history          also scan every blob and
 *                                                 commit message reachable
 *                                                 from HEAD; refuses a shallow
 *                                                 clone, whose history is cut
 *   bun scripts/scrub-check.ts --denylist FILE    also flag each term in FILE
 *
 * Exits 1 and prints `path:line: [rule] text` for each hit; exits 0 when clean;
 * exits 2 when it cannot scan what was asked.
 *
 * Every rule here is a generic pattern. Names a maintainer wants kept out go in
 * a denylist file kept outside this repository: one term per line, `#` starts a
 * comment. A term matches case-insensitively as a whole word, not inside a
 * longer run of letters and digits, so `acme` flags `ACME_TOKEN` and `acme-api`
 * but not `acmeish`. CI runs without a denylist.
 *
 * Test fixtures that need a token-shaped value build it at runtime by string
 * concatenation, so the source never holds the literal a scanner matches.
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const SELF = "scripts/scrub-check.ts";

/** Files allowed to name the public contact domain and the copyright holder. */
const CONTACT_FILES = new Set(["README.md", "CONTRIBUTING.md", "SECURITY.md"]);
const LICENCE_FILES = new Set(["LICENSE", "NOTICE"]);
/** The public mailboxes, allowed only in the contact files. */
const CONTACT_ADDRESSES = new Set(["security@sibylline.group", "support@sibylline.group"]);

/** Generated files whose content another file already carries. */
const SKIP = new Set(["bun.lock"]);

/** Example domains a fixture may use in an email address (RFC 2606, RFC 6761). */
const EXAMPLE_DOMAIN = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i;

/** Public standards written `ABC-123`, and `ABC` itself as the placeholder; any other such label is a tracker key. */
const STANDARD_PREFIXES = new Set(["ABC", "RFC", "UTF", "SHA", "ISO", "CVE", "CWE", "EIP", "ERC"]);

/** The SHAs a file may cite: this repository's own commits and the workflows' action pins. */
export type KnownShas = ReadonlySet<string>;

type Rule = { id: string; re: RegExp; allow?: (match: RegExpExecArray, path: string, line: string, known: KnownShas) => boolean };

const RULES: Rule[] = [
  {
    // The public org (`sibylline-labs`) is fine anywhere; the contact domain only
    // in the contact files; the copyright holder only in the licence files. A commit
    // message (`path` empty) may also run the org into the next word: GitHub's
    // default merge message names the head branch, whose slug drops the `/` of an
    // `org/repo` it quotes (`sibylline-labsyak`).
    id: "private-org",
    re: /sibylline/gi,
    allow: (m, path, line) => {
      const rest = line.slice(m.index + m[0].length);
      if (/^-labs\b/i.test(rest)) return true;
      if (/^-labs\w/i.test(rest)) return path === "";
      if (/^\.group\b/i.test(rest)) return CONTACT_FILES.has(path);
      if (/^ labs\b/i.test(rest)) return LICENCE_FILES.has(path);
      return false;
    },
  },
  { id: "tracker-workspace", re: /linear\.app\//gi },
  { id: "internal-host", re: /\.svc\.cluster\.local|workers\.dev|\.run\.app\b|\.cloudfunctions\.net|\.appspot\.com/gi },
  { id: "bucket-path", re: /\b(gs|s3):\/\//gi },
  {
    id: "secret-store-path",
    re: /projects\/[^/\s]+\/secrets|secretmanager\.googleapis|gcloud secrets|keyRings\/|cryptoKeys\/|vault:\/\/|secret\/data\//gi,
  },
  {
    id: "email",
    re: /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/g,
    allow: (m, path) => {
      const [whole, domain] = m;
      if (whole.startsWith("git@")) return true;
      if (EXAMPLE_DOMAIN.test(domain!)) return true;
      return CONTACT_ADDRESSES.has(whole.toLowerCase()) && CONTACT_FILES.has(path);
    },
  },
  { id: "tracker-label", re: /\b([A-Z]{2,6})-\d+\b/g, allow: (m) => STANDARD_PREFIXES.has(m[1]!) },
  { id: "requirements-label", re: /\bPRD-[A-Z0-9]/g },
  // A decision, requirement, finding or review label from a private register:
  // D42, R97, F31, F7q, M58, Decision Z, Claim 64, round-7 #9.
  { id: "register-label", re: /\b[DRFM]\d{1,2}[a-z]?\b|\bDecision [A-Z]\b|\bClaim \d+\b/g },
  { id: "review-round", re: /\bround-\d\b/gi },
  { id: "private-pr", re: /\bPR #\d+/g },
  // A section or phase of a plan the reader cannot open. A `§N` or `§N.M` alone is
  // fine: docs/OUTPUT-CONTRACT.md numbers its sections that way.
  { id: "private-plan", re: /\bplan\b[^.\n]{0,4}§|\bPhase[- ]\d\b|\bthe plan(?:'s)?\b|dispatch prompt|task handoff/gi },
  // A section of a document this repo does not hold: a lettered `§0b` / `§0b.5`,
  // or a named `§ Gotchas` / `§Repro`. Link a public section by its anchor instead.
  { id: "private-section", re: /§\s*\d+[a-z]\b|§\s?[A-Z][a-z]+/g },
  {
    // A commit SHA, abbreviated (7-12) or full (40), cited as provenance. One this repo can
    // resolve, or a workflow's action pin, is fine; any other names a commit the
    // reader cannot open.
    id: "private-sha",
    re: /(?<![-0-9A-Za-z])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])(?:[0-9a-f]{40}|[0-9a-f]{7,12})(?![-0-9A-Za-z])/g,
    allow: (m, _path, _line, known) => {
      const sha = m[0];
      for (const k of known) if (k.startsWith(sha)) return true;
      return false;
    },
  },
  {
    id: "token-shaped",
    re: new RegExp(
      [
        String.raw`\bgh[pousr]_[A-Za-z0-9]{36,}`,
        String.raw`\bgithub_pat_[A-Za-z0-9_]{22,}`,
        String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`,
        String.raw`aws_secret_access_key\W{1,4}[A-Za-z0-9/+]{40}\b`,
        String.raw`\bxox[baprs]-[0-9A-Za-z-]{10,}`,
        String.raw`\b[sr]k_(?:live|test)_[0-9A-Za-z]{10,}`,
        String.raw`\bsk-[A-Za-z0-9_-]{20,}`,
        String.raw`\bAIza[0-9A-Za-z_-]{35}`,
        String.raw`\beyJ[A-Za-z0-9_-]{10,}`,
        String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
      ].join("|"),
      "g",
    ),
  },
];

/** The denylist rule for `terms`: each a case-insensitive whole-word match. */
export function denylistRule(terms: readonly string[]): Rule | undefined {
  const words = terms.map((t) => t.trim()).filter((t) => t !== "" && !t.startsWith("#"));
  if (words.length === 0) return undefined;
  const alternation = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return { id: "denylist", re: new RegExp(`(?<![A-Za-z0-9])(?:${alternation})(?![A-Za-z0-9])`, "gi") };
}

export type Hit = { where: string; rule: string; text: string };

export interface ScanOptions {
  /** Where a hit is reported (default: `path`). */
  where?: string;
  /** SHAs a file may cite (default: none). */
  known?: KnownShas;
  /** Extra rules, e.g. the denylist. */
  extra?: readonly Rule[];
  /** Skip the built-in rules (this script's own source holds their patterns). */
  extraOnly?: boolean;
}

/** Every hit in one file's text. `path` is repo-relative, or empty for a commit message (it decides the allowlists). */
export function scan(path: string, text: string, opts: ScanOptions = {}): Hit[] {
  const { where = path, known = new Set<string>(), extra = [], extraOnly = false } = opts;
  const rules = extraOnly ? extra : [...RULES, ...extra];
  const hits: Hit[] = [];
  text.split("\n").forEach((line, i) => {
    const at = `${where}:${i + 1}`;
    for (const rule of rules) {
      for (const m of line.matchAll(rule.re)) {
        if (!rule.allow?.(m as RegExpExecArray, path, line, known)) hits.push({ where: at, rule: rule.id, text: line.trim() });
      }
    }
  });
  return hits;
}

function git(...args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** This repository's commits reachable from HEAD, plus every `uses: owner/action@<sha>` pin. */
function knownShas(): Set<string> {
  const known = new Set(git("rev-list", "HEAD").split("\n").filter(Boolean));
  const dir = ".github/workflows";
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      for (const m of readFileSync(join(dir, f), "utf8").matchAll(/\buses:\s*\S+@([0-9a-f]{40})\b/g)) known.add(m[1]!);
    }
  }
  return known;
}

const isText = (buf: Buffer) => !buf.subarray(0, 8000).includes(0);

function scanTree(known: KnownShas, extra: readonly Rule[]): Hit[] {
  return git("ls-files", "-z", "--cached", "--others", "--exclude-standard")
    .split("\0")
    // Regular files only, never through a symlink: a link to a directory cannot be
    // read, and a link's target may sit outside the tree this gate speaks for.
    .filter((p) => p && !SKIP.has(p) && lstatSync(p, { throwIfNoEntry: false })?.isFile())
    .flatMap((p) => {
      const buf = readFileSync(p);
      return isText(buf) ? scan(p, buf.toString("utf8"), { known, extra, extraOnly: p === SELF }) : [];
    });
}

/** Every blob and commit message reachable from HEAD, once each. */
function scanHistory(known: KnownShas, extra: readonly Rule[]): Hit[] {
  const hits: Hit[] = [];
  const seen = new Set<string>();
  for (const row of git("rev-list", "--objects", "HEAD").split("\n")) {
    const [sha, path] = row.split(" ");
    if (!sha || !path || seen.has(sha) || SKIP.has(path)) continue;
    seen.add(sha);
    if (git("cat-file", "-t", sha).trim() !== "blob") continue;
    const text = git("cat-file", "-p", sha);
    if (!text.includes("\0")) hits.push(...scan(path, text, { where: `${sha.slice(0, 10)}:${path}`, known, extra, extraOnly: path === SELF }));
  }
  for (const commit of git("rev-list", "HEAD").split("\n").filter(Boolean)) {
    hits.push(...scan("", git("log", "-1", "--format=%B", commit), { where: `commit ${commit.slice(0, 10)}`, known, extra }));
  }
  return hits;
}

function main(): number {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { history: { type: "boolean", default: false }, denylist: { type: "string" } },
    strict: true,
  });
  if (values.history && git("rev-parse", "--is-shallow-repository").trim() === "true") {
    console.error("scrub-check: this clone is shallow, so --history cannot see every commit; fetch the full history (actions/checkout: fetch-depth: 0)");
    return 2;
  }
  const extra: Rule[] = [];
  if (values.denylist !== undefined) {
    if (!existsSync(values.denylist)) {
      console.error(`scrub-check: no denylist at ${values.denylist}`);
      return 2;
    }
    const rule = denylistRule(readFileSync(values.denylist, "utf8").split("\n"));
    if (rule) extra.push(rule);
  }
  const known = knownShas();
  const hits = values.history ? [...scanTree(known, extra), ...scanHistory(known, extra)] : scanTree(known, extra);
  for (const h of hits) console.log(`${h.where}: [${h.rule}] ${h.text}`);
  console.error(hits.length ? `scrub-check: ${hits.length} hit(s)` : "scrub-check: clean");
  return hits.length ? 1 : 0;
}

if (import.meta.main) process.exit(main());
