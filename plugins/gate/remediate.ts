/**
 * remediate.ts — judging a doctrine remediation loop in `eris gate check`: pure state machine and
 * row grader live in `eris/gates-contract`, this module adds `gitSurfaceBar` (git diff check).
 */

import {
  type DatedReport,
  type Finding,
  handOffStands,
  independence,
  latestReport,
  REMEDIATE_GATE,
  type RemediateRow,
  remediateRow,
  remediationSpan,
  type RemediationState,
  reportsOf,
  ReviewReportLike,
  ROUND_EVIDENCE,
  type Round,
  RoundRecord,
  roundOf,
  stateOf,
  type SurfaceBar,
  WIDER_PATH,
} from "eris/gates-contract";
import { type Git, ok } from "./git";

export {
  type DatedReport,
  type Finding,
  handOffStands,
  independence,
  latestReport,
  REMEDIATE_GATE,
  type RemediateRow,
  remediateRow,
  remediationSpan,
  type RemediationState,
  reportsOf,
  ReviewReportLike,
  ROUND_EVIDENCE,
  type Round,
  RoundRecord,
  roundOf,
  stateOf,
  type SurfaceBar,
  WIDER_PATH,
};

const HEX_SHA = /^[0-9a-f]{7,64}$/i;

/**
 * The conservative bar: any change to `.claude/surfaces.yml` or a review skill directory between
 * the span's ends needs a human, whichever dimension it changes. A diff git cannot compute (an
 * invalid or unknown sha) is wider too: it fails closed.
 */
export function gitSurfaceBar(g: Git, cwd: string): SurfaceBar {
  return {
    wider: async (span) => {
      const fail = [`git diff ${span.base.slice(0, 12)}..${span.head.slice(0, 12)} failed in ${cwd}; a human signs the remediation diff`];
      if (!HEX_SHA.test(span.base) || !HEX_SHA.test(span.head)) return fail;
      const res = await g.run(["git", "-C", cwd, "diff", "--name-only", `${span.base}..${span.head}`, "--"], { timeoutMs: 30_000 });
      if (!ok(res)) return fail;
      return res.stdout
        .toString("utf8")
        .split("\n")
        .filter((p) => p !== "" && WIDER_PATH.test(p));
    },
  };
}
