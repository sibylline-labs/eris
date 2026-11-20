/**
 * prompt.ts — the prompt a loop session starts from: a generic header every loop reads its contract
 * from, then the org's loop body (docs/LOOP.md#the-prompt). A house rule (how to comment, which CI
 * runners, what a PR body cites) belongs in the org's loop body, never in this header.
 *
 * Header order: `Loop <slug> · target issue <ISSUE>`, then `Yak:`, `Report to:`, `Caller:`, `Model:`,
 * `Context:`, `Claim:` (each when given), then the `Hand-back:` line, the lines a build supplies
 * (`LoopDefaults.promptLines`, none in this build), a blank line, and the body. The build's lines come
 * after the `Hand-back:` line, so the generic contract reads the same whatever a build adds, and they
 * count toward the prompt's cap.
 */

import { RUNTIME } from "./claims";
import { usage } from "./failure";
import { BODY_MAX_BYTES } from "./names";

/** The header line that hands a loop its own claim id, the value its hand-back releases. */
export const claimLine = (issue: string, claimId: string): string => `Claim: ${claimId} — this loop holds ${issue}'s claim until its hand-back.`;

/** `eris loop hand-back`'s arguments for this loop: `<ISSUE>[ --claim <id>][ --report-to <KEY>]`. */
export const handBackArgs = (issue: string, claimId?: string, reportTo?: string): string =>
  issue + (claimId !== undefined && claimId !== "" ? ` --claim ${claimId}` : "") + (reportTo !== undefined && reportTo !== "" ? ` --report-to ${reportTo}` : "");

/** The line that tells a loop how to post its hand-back. */
export const handBackLine = (args: string, issue: string): string =>
  `Hand-back: post your hand-back once, with \`eris loop hand-back ${args} < <file>\` (the body on stdin): it releases ${issue}'s claim with the hand-back as its response, and comments wherever no claim holds.`;

export interface ComposePromptInput {
  readonly slug: string;
  readonly issue: string;
  readonly body: string;
  readonly context?: string | undefined;
  readonly yak?: string | undefined;
  readonly reportTo?: string | undefined;
  readonly caller?: string | undefined;
  readonly model?: string | undefined;
  readonly claimId?: string | undefined;
}

const given = (s: string | undefined): s is string => s !== undefined && s !== "";

/** The loop's prompt, with `extra` (a build's lines) after the `Hand-back:` line; over `BODY_MAX_BYTES` (one argv word) it is refused with `loop-usage`. */
export function composePrompt(input: ComposePromptInput, extra: ReadonlyArray<string> = []): string {
  const { slug, issue, body, context, yak, reportTo, caller, model, claimId } = input;
  const header = [`Loop ${slug} · target issue ${issue}`];
  if (given(yak)) header.push(`Yak: ${yak}`);
  if (given(reportTo)) header.push(`Report to: ${reportTo} — the hand-back command below also posts your hand-back on ${reportTo}.`);
  if (given(caller)) header.push(`Caller: ${caller}`);
  if (given(model)) header.push(`Model: ${model}`);
  if (given(context)) header.push(`Context: ${context}`);
  if (given(claimId)) header.push(claimLine(issue, claimId));
  header.push(handBackLine(handBackArgs(issue, claimId, reportTo), issue), ...extra);
  const prompt = `${header.join("\n")}\n\n${body}`;
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > BODY_MAX_BYTES) {
    usage(`the composed prompt for loop ${slug} on ${issue} is ${bytes} bytes; the cap is ${BODY_MAX_BYTES} (one argv word)`, "Shorten the loop body in the org's Gates settings, or the --context, then re-run.");
  }
  return prompt;
}

/**
 * Appended to a resumed Claude session's prompt: `claude --bg --resume` never wakes the model on a
 * `run_in_background` Bash completion, so the session idles forever waiting on it.
 */
export const NO_BACKGROUND_LINE =
  "Resumed session: never set Bash `run_in_background=true` (its completion does not wake a resumed session, so you would idle forever)." +
  " Run every command in the foreground and wait for it, with a `timeout` that fits.";

/** A resume's prompt: the continuation, the no-background rule for Claude, and the claim and hand-back lines when the session holds a claim. */
export const continuationPrompt = (prompt: string, held: { readonly issue: string; readonly claimId: string } | null, runtime: string): string => {
  const base = runtime === RUNTIME ? `${prompt}\n${NO_BACKGROUND_LINE}` : prompt;
  return held === null ? base : `${base}\n${claimLine(held.issue, held.claimId)}\n${handBackLine(handBackArgs(held.issue, held.claimId), held.issue)}`;
};
