/**
 * burden.ts — `eris gate check --burden <rubric>`: the evidence a change owes, derived from the
 * surfaces it crosses, never declared by the change itself.
 *
 * The rubric is a YAML map of surface to the evidence kinds it requires:
 *
 *   rubric: surface-burden@0      # optional label
 *   surfaces:
 *     auth: [test-run, e2e]
 *
 * The burden is the union of the kinds over the crossed surfaces (surfaces.ts says which). A kind
 * outside the receipt's evidence kinds refuses the rubric: a typo must never decode to a burden that
 * demands nothing.
 *
 * A gate can also owe a kind by what its own artifact holds (`owedBy`): a `define-future` over a
 * non-empty `eris.graph-target` delta owes a `screenshot` of the diff. That kind is owed by the
 * receipt itself, never paid by another gate's evidence.
 */

import { readFileSync } from "node:fs";
import * as Schema from "effect/Schema";
import { decodeResult, GATE_INLINE_KINDS, GATE_MEDIA_KINDS, GATE_REVIEW_REPORT_KIND, type GateEvidence } from "eris/gates-contract";
import { parse as parseYaml } from "yaml";
import { precondition } from "./failure";

export const EvidenceKind = Schema.Literals([...GATE_INLINE_KINDS, ...GATE_MEDIA_KINDS, GATE_REVIEW_REPORT_KIND]);
export type EvidenceKind = typeof EvidenceKind.Type;

export const BurdenRubric = Schema.Struct({
  rubric: Schema.optionalKey(Schema.String),
  surfaces: Schema.Record(Schema.String, Schema.NonEmptyArray(EvidenceKind)),
});
export type BurdenRubric = typeof BurdenRubric.Type;

function unreadable(file: string, why: string): never {
  return precondition(
    "gate-burden-unreadable",
    `--burden ${file}: ${why}`,
    `Point --burden at a YAML file with 'surfaces:', a map of surface to a non-empty list of evidence kinds (${[...GATE_INLINE_KINDS, ...GATE_MEDIA_KINDS].join(", ")}).`,
  );
}

export function readBurdenRubric(file: string): BurdenRubric {
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(file, "utf8"));
  } catch {
    return unreadable(file, "cannot read or parse the file");
  }
  const decoded = decodeResult(BurdenRubric, doc);
  return decoded._tag === "Success" ? decoded.success : unreadable(file, "not a map of surface to evidence kinds");
}

/** The kinds `surfaces` owe under `rubric`, sorted and distinct; a surface the rubric does not name owes nothing. */
export function burdenOf(rubric: BurdenRubric, surfaces: ReadonlyArray<string>): EvidenceKind[] {
  const kinds = new Set<EvidenceKind>();
  for (const s of surfaces) for (const k of Object.hasOwn(rubric.surfaces, s) ? rubric.surfaces[s]! : []) kinds.add(k);
  return [...kinds].sort();
}

/** The required kinds no item of `evidence` carries. */
export function unmet(required: ReadonlyArray<EvidenceKind>, evidence: ReadonlyArray<GateEvidence>): EvidenceKind[] {
  const have = new Set<string>(evidence.map((e) => e.kind));
  return required.filter((k) => !have.has(k));
}

/** Just enough of an `eris.graph-target` delta to tell empty from not. */
const Changes = Schema.Struct({ add: Schema.Array(Schema.Unknown), remove: Schema.Array(Schema.Unknown), change: Schema.Array(Schema.Unknown) });
const GraphTargetShape = Schema.Struct({ kind: Schema.Literal("eris.graph-target"), nodes: Changes, edges: Changes });

/** The kinds a passing `gate` receipt owes by its artifact's bytes: a `screenshot` for a `define-future` over a non-empty delta. */
export function owedBy(gate: string, artifact: Uint8Array): EvidenceKind[] {
  if (gate !== "define-future") return [];
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(artifact));
  } catch {
    return [];
  }
  const decoded = decodeResult(GraphTargetShape, doc);
  if (decoded._tag !== "Success") return [];
  const { nodes, edges } = decoded.success;
  const changes = [nodes, edges].reduce((n, f) => n + f.add.length + f.remove.length + f.change.length, 0);
  return changes > 0 ? ["screenshot"] : [];
}
