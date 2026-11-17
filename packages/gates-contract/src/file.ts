/**
 * file.ts — reads a doctrine file for its postures and their `policy:` blocks.
 *
 * The grammar: `active: <slug>`, then `## <slug>` sections of a Name line and `- ` bullets. A
 * posture's policy is a fenced ```` ```yaml ```` block anywhere in its section whose YAML has a
 * top-level `policy:` key. A reader that ends a section's body at the first non-bullet line never
 * sees the fence, so it neither injects nor rewrites it.
 *
 * Every problem carries the 1-based line it came from.
 */

import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { decodeResult } from "./decode";
import { DoctrinePolicy } from "./policy";

export interface Posture {
  readonly slug: string;
  readonly name: string;
  readonly line: number;
  /** The `## <slug>` section's markdown text (trimmed, trailing newline), for posture snapshots. */
  readonly section: string;
  readonly policy: DoctrinePolicy | null;
  /** sha256 of the policy block's YAML text (the `<hash>` in `doctrine:<name>@<hash>`), or null with no policy. */
  readonly policy_sha256: string | null;
}

export interface DoctrineProblem {
  readonly line: number;
  readonly message: string;
}

export interface DoctrineRead {
  readonly active: string | null;
  readonly postures: readonly Posture[];
  readonly problems: readonly DoctrineProblem[];
}

const ACTIVE = /^active:\s*(\S+)\s*$/;
const HEADING = /^##\s+(\S+)\s*$/;
const FENCE_OPEN = /^```ya?ml\s*$/;
const FENCE_CLOSE = /^```\s*$/;
const BARE_POLICY = /^policy:\s*$/;

interface Section {
  slug: string;
  name: string;
  line: number;
  body: { text: string; line: number }[];
}

function sections(lines: readonly string[]): { active: string | null; sections: Section[] } {
  let active: string | null = null;
  const out: Section[] = [];
  lines.forEach((text, i) => {
    const h = HEADING.exec(text);
    if (h !== null) {
      out.push({ slug: h[1]!, name: lines[i + 1] ?? "", line: i + 1, body: [] });
      return;
    }
    const last = out.at(-1);
    if (last === undefined) {
      const a = ACTIVE.exec(text);
      if (a !== null && active === null) active = a[1]!;
      return;
    }
    last.body.push({ text, line: i + 1 });
  });
  return { active, sections: out };
}

/** The section's fenced `policy:` value, undecoded, or the problems that stopped it being read. */
function fencedPolicy(s: Section): { found: { line: number; yaml: string; value: unknown } | null; problems: DoctrineProblem[] } {
  const problems: DoctrineProblem[] = [];
  const blocks: { line: number; yaml: string }[] = [];
  let open: { line: number; lines: string[] } | null = null;
  for (const { text, line } of s.body) {
    if (open === null) {
      if (FENCE_OPEN.test(text)) open = { line, lines: [] };
      else if (BARE_POLICY.test(text)) problems.push({ line, message: `${s.slug}: a policy: block must sit in a \`\`\`yaml fence` });
      continue;
    }
    if (FENCE_CLOSE.test(text)) {
      blocks.push({ line: open.line, yaml: open.lines.join("\n") });
      open = null;
    } else open.lines.push(text);
  }
  if (open !== null) problems.push({ line: open.line, message: `${s.slug}: unclosed \`\`\`yaml fence` });

  const found: { line: number; yaml: string; value: unknown }[] = [];
  for (const b of blocks) {
    let doc: unknown;
    try {
      doc = parseYaml(b.yaml);
    } catch (e) {
      problems.push({ line: b.line, message: `${s.slug}: invalid YAML: ${(e as Error).message.split("\n")[0]}` });
      continue;
    }
    if (doc !== null && typeof doc === "object" && "policy" in doc) found.push({ line: b.line, yaml: b.yaml, value: (doc as { policy: unknown }).policy });
  }
  if (found.length > 1) problems.push({ line: found[1]!.line, message: `${s.slug}: more than one policy: block` });
  return { found: problems.length > 0 ? null : (found[0] ?? null), problems };
}

/** The section's policy, or the problems that stopped it decoding. */
function policyOf(s: Section): { policy: DoctrinePolicy | null; sha256: string | null; problems: DoctrineProblem[] } {
  const { found: first, problems } = fencedPolicy(s);
  if (first === null) return { policy: null, sha256: null, problems };

  const decoded = decodeResult(DoctrinePolicy, first.value);
  if (decoded._tag === "Success") return { policy: decoded.success, sha256: createHash("sha256").update(first.yaml).digest("hex"), problems };
  for (const issue of decoded.failure.issues) {
    const at = issue.path.length > 0 ? `policy.${issue.path.join(".")}` : "policy";
    problems.push({ line: first.line, message: `${s.slug}: ${at}: ${issue.message}` });
  }
  return { policy: null, sha256: null, problems };
}

function sectionText(s: Section): string {
  let end = s.body.length;
  while (end > 0 && s.body[end - 1]!.text.trim() === "") end -= 1;
  return [`## ${s.slug}`, ...s.body.slice(0, end).map((b) => b.text)].join("\n") + "\n";
}

export function readDoctrine(text: string): DoctrineRead {
  const { active, sections: secs } = sections(text.split(/\r?\n/));
  const problems: DoctrineProblem[] = [];
  const postures = secs.map((s) => {
    const r = policyOf(s);
    problems.push(...r.problems);
    return { slug: s.slug, name: s.name, line: s.line, section: sectionText(s), policy: r.policy, policy_sha256: r.sha256 };
  });
  if (active !== null && !secs.some((s) => s.slug === active)) problems.push({ line: 1, message: `active: ${active} names no ## section` });
  return { active, postures, problems };
}

/** A posture as a policy bundle carries it: its name line, its `- ` bullets, and its fence's raw `policy:` value. */
export interface BundlePosture {
  readonly slug: string;
  readonly name: string;
  readonly bullets: readonly string[];
  /** The fence's `policy:` value as YAML parsed it, undecoded; undefined when the section has none. */
  readonly policy: unknown;
}

export interface BundleSectionsRead {
  readonly active: string | null;
  readonly postures: readonly BundlePosture[];
  readonly problems: readonly DoctrineProblem[];
}

const BULLET = /^-\s(.*)$/;

/**
 * Read a doctrine file the way a policy bundle holds it (bundle.ts `bundleFromFiles`): the bullets
 * are the `- ` lines straight after the name line, and the policy is left for the bundle's own
 * Schema to decode. Fence problems are the ones `readDoctrine` reports.
 */
export function readBundleSections(text: string): BundleSectionsRead {
  const { active, sections: secs } = sections(text.split(/\r?\n/));
  const problems: DoctrineProblem[] = [];
  const postures = secs.map((s): BundlePosture => {
    const bullets: string[] = [];
    for (let i = 1; i < s.body.length; i++) {
      const m = BULLET.exec(s.body[i]!.text);
      if (m === null) break;
      bullets.push(m[1]!);
    }
    const r = fencedPolicy(s);
    problems.push(...r.problems);
    return { slug: s.slug, name: s.name, bullets, policy: r.found?.value };
  });
  if (active !== null && !secs.some((s) => s.slug === active)) problems.push({ line: 1, message: `active: ${active} names no ## section` });
  return { active, postures, problems };
}
