/**
 * render.ts — a receipt's comment body, from its verdict's `.mdx` template: bodies are rendered by
 * code, never freehand.
 *
 * A template is markdown plus `{identifier}` expressions over the closed `ReceiptView` below; no JSX is
 * compiled (the tracker stores markdown). An identifier outside the view throws, so a template typo
 * fails the render rather than posting a blank. A line that is only an expression whose value is empty
 * is dropped, which is how optional fields disappear.
 *
 * The prose is the whole human part of the comment: the store keeps the record itself and appends a
 * footer naming it, so nothing here carries base64 or a marker. The templates are imported as text so
 * the compiled binary embeds them.
 */

/// <reference path="./templates/mdx.d.ts" />

import { citePosture, type GateArtifact, type GateDoctrine, type GateEvidence, type GateReceipt, type GateVerdict, isGateMediaEvidence, isGateReviewReportEvidence } from "eris/gates-contract";
import amended from "./templates/amended.mdx" with { type: "text" };
import blocking from "./templates/blocking.mdx" with { type: "text" };
import pass from "./templates/pass.mdx" with { type: "text" };
import skipped from "./templates/skipped.mdx" with { type: "text" };

export const TEMPLATES: Readonly<Record<GateVerdict, string>> = { PASS: pass, AMENDED: amended, BLOCKING: blocking, SKIPPED: skipped };

type ReceiptView = Readonly<Record<"gate" | "verdict" | "artifact" | "rubrics" | "doctrine" | "impact" | "authorized" | "reason" | "actor" | "recorded" | "evidence", string>>;

const EXPR = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const ONLY_EXPR = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

const short = (sha: string): string => sha.slice(0, 12);
const oneLine = (s: string): string => s.replace(/\r?\n/g, " ");
const encodeBlobPath = (p: string): string => p.split("/").map(encodeURIComponent).join("/");

function artifactLine(a: GateArtifact): string {
  const hash = `sha256 \`${short(a.sha256)}\``;
  if (a._tag !== "git") return `- Artifact: \`${a.path}\` (${hash})`;
  const commit = a.commit ?? (/^[0-9a-f]{40}$/.test(a.ref) ? a.ref : undefined);
  const path = commit !== undefined ? `[\`${a.path}\`](https://github.com/${a.repo}/blob/${commit}/${encodeBlobPath(a.path)})` : `\`${a.path}\``;
  return `- Artifact: ${path} in \`${a.repo}\` at \`${a.ref}\` (${hash})`;
}

/** A fence longer than any backtick run in the content, so the content cannot close it. */
function fenced(content: string, maxLines = 20): string {
  const lines = content.replace(/\n+$/, "").split("\n");
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) shown.push(`… ${lines.length - maxLines} more line(s) in the stored record`);
  const run = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(run + 1);
  return [`    ${fence}`, ...shown.map((l) => `    ${l}`), `    ${fence}`].join("\n");
}

/** A file name as image alt text: brackets and backslashes escaped, so the name cannot end the alt early. */
const altText = (name: string): string => name.replace(/[\\[\]]/g, (c) => `\\${c}`);

function evidenceLines(evidence: ReadonlyArray<GateEvidence>): string {
  if (evidence.length === 0) return "";
  const out = ["- Evidence:"];
  for (const e of evidence) {
    if (isGateMediaEvidence(e)) {
      const facts = `(${e.content_type}, ${e.bytes} B, sha256 \`${short(e.sha256)}\`)`;
      // A screenshot renders inline; a video stays a link.
      if (e.kind === "screenshot") out.push(`  - screenshot \`${e.name}\` ${facts}`, `    ![${altText(e.name)}](${e.asset_url})`);
      else out.push(`  - ${e.kind} [\`${e.name}\`](${e.asset_url}) ${facts}`);
    } else if (isGateReviewReportEvidence(e)) {
      out.push(`  - review-report${e.name !== undefined ? ` \`${e.name}\`` : ""} (sha256 \`${short(e.sha256)}\`)`);
    } else if (e.kind === "text") {
      out.push(`  - ${oneLine(e.content)}`);
    } else {
      out.push(`  - ${e.kind}${e.name !== undefined ? ` \`${e.name}\`` : ""} (sha256 \`${short(e.sha256)}\`)`, fenced(e.content));
    }
  }
  return out.join("\n");
}

function doctrineLine(d: GateDoctrine): string {
  if (d.posture !== undefined && d.name !== undefined) {
    return `- Doctrine: ${citePosture({ slug: d.posture, name: d.name, policy_sha256: d.policy_hash ?? null })} · stored snapshot \`${short(d.sha256)}\``;
  }
  return `- Doctrine: \`${d.path}\` (sha256 \`${short(d.sha256)}\`)`;
}

function sameArtifact(a: GateArtifact, b: GateArtifact): boolean {
  return a._tag === "git" && b._tag === "git"
    ? a.repo === b.repo && a.ref === b.ref && a.path === b.path && a.sha256 === b.sha256
    : a._tag === "file" && b._tag === "file" && a.path === b.path && a.sha256 === b.sha256;
}

/** The receipt's actor: `<session name> · <runtime>` (linked when it has a URL) for a session, `@<Name>` for a human, else the raw key. */
export function formatActor(r: Pick<GateReceipt, "actor" | "actor_info">): string {
  const info = r.actor_info;
  if (info === undefined) return r.actor;
  if (info.kind === "human") return `@${oneLine(info.name).replace(/^@+/, "")}`;
  const label = `${oneLine(info.name)} · ${oneLine(info.runtime ?? "claude")}`;
  const linked = info.url !== undefined ? `[${label}](${info.url})` : label;
  return info.launched_by !== undefined ? `${linked} (launched by ${oneLine(info.launched_by)})` : linked;
}

function view(r: GateReceipt, priors: ReadonlyArray<GateReceipt>): ReceiptView {
  const last = priors.at(-1);
  let priorImpact: GateReceipt["user_impact"];
  for (const p of priors) if (p.user_impact !== undefined) priorImpact = p.user_impact;
  const showArtifact = last === undefined || !sameArtifact(r.artifact, last.artifact);
  const showImpact = r.user_impact !== undefined && r.user_impact !== priorImpact;
  const showActor = last === undefined || r.actor !== last.actor || formatActor(r) !== formatActor(last);
  return {
    gate: r.gate,
    verdict: r.verdict,
    artifact: showArtifact ? artifactLine(r.artifact) : "",
    rubrics: r.rubrics !== undefined ? `- Rubrics: ${r.rubrics.join(", ")}` : "",
    doctrine: r.doctrine !== undefined ? doctrineLine(r.doctrine) : "",
    impact: showImpact ? `- User impact: ${r.user_impact}` : "",
    authorized: r.authorized !== undefined ? `- Authorized: ${oneLine(r.authorized)}` : "",
    reason: r.reason !== undefined ? `- Reason: ${oneLine(r.reason)}` : "",
    actor: showActor ? `- Actor: ${formatActor(r)}` : "",
    recorded: r.recorded_at,
    evidence: evidenceLines(r.evidence),
  };
}

/** Fills `template` from `v`; an identifier `v` does not carry throws. */
export function renderTemplate(template: string, v: Readonly<Record<string, string>>): string {
  const value = (name: string): string => {
    if (!Object.hasOwn(v, name)) throw new Error(`receipt template names {${name}}, which the receipt view does not carry`);
    return v[name]!;
  };
  const lines: string[] = [];
  for (const line of template.replace(/\n+$/, "").split("\n")) {
    const only = ONLY_EXPR.exec(line.trim());
    if (only !== null && value(only[1]!) === "") continue;
    lines.push(line.replace(EXPR, (_, name: string) => value(name)));
  }
  return lines.join("\n");
}

/** The receipt comment's prose; `priors` (oldest first) omit an unchanged artifact, impact and actor line. */
export function renderProse(r: GateReceipt, priors: ReadonlyArray<GateReceipt> = []): string {
  return renderTemplate(TEMPLATES[r.verdict], view(r, priors));
}
