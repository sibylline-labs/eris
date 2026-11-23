/**
 * shape.ts — the evidence a passing receipt must carry for gates whose verdict alone proves too
 * little. A merged change is not done until it is live: a `zero-downtime` receipt names both skew
 * directions and what enforces the deploy order, a `first-contact` receipt names one real delivery
 * from the real sender, and a `deployed` receipt ties every deployed version to the merge plus a
 * smoke pass.
 *
 * Lines come from the receipt's text evidence and its artifact, trimmed of a list bullet and
 * backticks, keys matched case-insensitively at the line start. A gate with no shape here is
 * judged on its verdict alone.
 */

/** The gate a declared ingress owes, whatever the user-impact class. */
export const FIRST_CONTACT = "first-contact";
/** The evidence line that declares a new public ingress on any receipt of the issue. */
export const INGRESS_LINE = /^ingress:\s*\S/i;
/** How a deploy order is enforced: a deploy-path preflight, a caller-side fallback, or one atomic deploy unit. */
export const ENFORCEMENTS = ["preflight", "fallback", "atomic"] as const;

const HEX = /\b([0-9a-f]{7,40})\b/i;

/** A line with its bullet, surrounding backticks and whitespace removed. */
function clean(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/`/g, "")
    .trim();
}

/** Every candidate line: the text evidence, then the artifact's lines. */
export function evidenceLines(texts: ReadonlyArray<string>, bytes?: Uint8Array): string[] {
  const artifact = bytes === undefined ? [] : new TextDecoder().decode(bytes).split("\n");
  return [...texts.flatMap((t) => t.split("\n")), ...artifact].map(clean).filter((l) => l !== "");
}

/** The value after `key:` on each line that starts with it (case-insensitive), non-empty only. */
function values(lines: ReadonlyArray<string>, key: string): string[] {
  const lower = `${key.toLowerCase()}:`;
  return lines.filter((l) => l.toLowerCase().startsWith(lower)).map((l) => l.slice(lower.length).trim()).filter((v) => v !== "");
}

const missing = (key: string) => `no '${key}:' line`;

function zeroDowntime(lines: ReadonlyArray<string>): string[] {
  const gaps: string[] = [];
  for (const key of ["skew old->new", "skew new->old"]) if (values(lines, key).length === 0) gaps.push(missing(key));
  const enforced = values(lines, "enforced-by");
  if (enforced.length === 0) gaps.push(missing("enforced-by"));
  else if (!enforced.some((v) => (ENFORCEMENTS as readonly string[]).includes(v.split(/[\s(:,]/)[0]!.toLowerCase()))) {
    gaps.push(`'enforced-by:' names none of ${ENFORCEMENTS.join(", ")} (a stated deploy order is not enforcement)`);
  }
  return gaps;
}

function firstContact(lines: ReadonlyArray<string>): string[] {
  return ["delivery", "status", "log", "effect"].filter((k) => values(lines, k).length === 0).map(missing);
}

function deployed(lines: ReadonlyArray<string>): string[] {
  if (values(lines, "deploy").some((v) => /^none\b\s*\S/i.test(v))) return [];
  const gaps: string[] = [];
  const merge = values(lines, "merge").map((v) => HEX.exec(v)?.[1]?.toLowerCase()).find((v) => v !== undefined);
  if (merge === undefined) gaps.push(`${missing("merge")} carrying the merge SHA`);
  const versions = values(lines, "version");
  if (versions.length === 0) gaps.push(missing("version"));
  for (const v of versions) {
    const parts = v.split(/\s+/);
    const sha = parts.at(-1)!.toLowerCase();
    const unit = parts.slice(0, -1).join(" ") || "(unnamed)";
    if (!/^[0-9a-f]{7,40}$/.test(sha)) gaps.push(`version ${v} ends in no SHA`);
    else if (merge !== undefined && !(merge.startsWith(sha) || sha.startsWith(merge))) gaps.push(`version ${unit} ${sha} is not the merge ${merge}`);
  }
  if (!values(lines, "smoke").some((v) => /^pass\b/i.test(v))) gaps.push("no 'smoke: pass' line");
  return gaps;
}

const SHAPES: Readonly<Record<string, (lines: ReadonlyArray<string>) => string[]>> = {
  "zero-downtime": zeroDowntime,
  [FIRST_CONTACT]: firstContact,
  deployed,
};

/** Why a passing receipt for `gate` lacks its shape, or null (met, or the gate has no shape). */
export function shapeGap(gate: string, texts: ReadonlyArray<string>, bytes?: Uint8Array): string | null {
  const shape = SHAPES[gate];
  if (shape === undefined) return null;
  const gaps = shape(evidenceLines(texts, bytes));
  return gaps.length === 0 ? null : gaps.join("; ");
}
