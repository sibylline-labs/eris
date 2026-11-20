/**
 * The prompt a loop session starts from (plugins/loop/prompt.ts): a generic header every loop reads
 * its contract from, then the org's loop body. House rules belong in the org's loop body, never here.
 *
 * The seam is `composePrompt`; the expected text is written out by hand from the header's contract
 * (docs/LOOP.md#the-prompt), not generated from the code.
 */

import { describe, expect, it } from "bun:test";
import { LoopFailure } from "../plugins/loop/failure";
import { composePrompt, continuationPrompt, NO_BACKGROUND_LINE } from "../plugins/loop/prompt";

describe("composePrompt", () => {
  it("writes every header line that was given, in order, then the body", () => {
    /** When a header line is dropped or reordered, the session cannot find its claim id or hand-back command, so its claim is held until the gateway's expiry: observed on the whole prompt text. */
    const p = composePrompt({
      slug: "one-shot",
      issue: "ABC-7",
      body: "# One shot\n\nDo it.\n",
      yak: "01HZX3K5Q8W2N4R6T8V0Y2B4D7",
      reportTo: "ABC-1",
      caller: "lead",
      model: "sonnet",
      context: "one line",
      claimId: "claim-0001",
    });
    expect(p).toBe(
      [
        "Loop one-shot · target issue ABC-7",
        "Yak: 01HZX3K5Q8W2N4R6T8V0Y2B4D7",
        "Report to: ABC-1 — the hand-back command below also posts your hand-back on ABC-1.",
        "Caller: lead",
        "Model: sonnet",
        "Context: one line",
        "Claim: claim-0001 — this loop holds ABC-7's claim until its hand-back.",
        "Hand-back: post your hand-back once, with `eris loop hand-back ABC-7 --claim claim-0001 --report-to ABC-1 < <file>` (the body on stdin): it releases ABC-7's claim with the hand-back as its response, and comments wherever no claim holds.",
        "",
        "# One shot",
        "",
        "Do it.",
        "",
      ].join("\n"),
    );
  });

  it("writes only the target and hand-back lines when nothing else was given", () => {
    /** When an absent operand prints as an empty or 'undefined' line, the session reads a contract field that is not there: observed on the whole prompt text. */
    expect(composePrompt({ slug: "fixer", issue: "ABC-7", body: "B" })).toBe(
      "Loop fixer · target issue ABC-7\nHand-back: post your hand-back once, with `eris loop hand-back ABC-7 < <file>` (the body on stdin): it releases ABC-7's claim with the hand-back as its response, and comments wherever no claim holds.\n\nB",
    );
  });

  it("refuses a prompt over one argv word's cap", () => {
    /** When an oversized prompt reaches `claude --bg`, the exec fails (E2BIG) after the claim was taken: observed on the refusal's slug. */
    let slug = "";
    try {
      composePrompt({ slug: "fixer", issue: "ABC-7", body: "x".repeat(256 * 1024) });
    } catch (e) {
      if (!(e instanceof LoopFailure)) throw e;
      slug = e.failure.slug;
    }
    expect(slug).toBe("loop-usage");
  });

  // admits: algorithmic: runtime-keyed prompt branching and foreground-only text for resumed Claude sessions (claimed and claimless) while leaving non-Claude runtimes byte-identical; no type enforces prompt text.
  it("appends the no-background line for claude (claimed and claimless), and leaves other runtimes unchanged", () => {
    /** When a resumed Claude session is not told to avoid run_in_background=true, it idles forever waiting on a completion that never wakes it; when another runtime gets the Claude-specific line, its prompt drifts: observed on the continuation text for both runtimes. */
    expect(NO_BACKGROUND_LINE).toContain("run_in_background=true");
    expect(continuationPrompt("Carry on.", { issue: "ABC-7", claimId: "claim-0002" }, "claude")).toBe(
      `Carry on.\n${NO_BACKGROUND_LINE}\nClaim: claim-0002 — this loop holds ABC-7's claim until its hand-back.\nHand-back: post your hand-back once, with \`eris loop hand-back ABC-7 --claim claim-0002 < <file>\` (the body on stdin): it releases ABC-7's claim with the hand-back as its response, and comments wherever no claim holds.`,
    );
    expect(continuationPrompt("Carry on.", null, "claude")).toBe(`Carry on.\n${NO_BACKGROUND_LINE}`);
    expect(continuationPrompt("Carry on.", { issue: "ABC-7", claimId: "claim-0002" }, "other")).toBe(
      "Carry on.\nClaim: claim-0002 — this loop holds ABC-7's claim until its hand-back.\nHand-back: post your hand-back once, with `eris loop hand-back ABC-7 --claim claim-0002 < <file>` (the body on stdin): it releases ABC-7's claim with the hand-back as its response, and comments wherever no claim holds.",
    );
    expect(continuationPrompt("Carry on.", null, "other")).toBe("Carry on.");
  });
});
