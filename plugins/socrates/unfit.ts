/**
 * unfit.ts — the evidence `eris socrates submit --unfit --evidence-file` sends with its hypothesis.
 *
 * Invariants:
 *   - The file (or stdin, for `-`) is read whole and decoded through the contract's
 *     `SocratesUnfitEvidenceList`: a JSON array of at most five `{kind, provenance, content}`
 *     entries. Anything else is refused (`socrates-evidence-file-invalid`) before a request is made.
 *   - A terminal on stdin is refused rather than waited on: a forgotten pipe fails at once.
 *   - Nothing is scanned here. The caller runs every entry's text through `eris/outbound-scan`
 *     before it leaves the machine.
 */

import type { VerbContext } from "../../src/cli/plugin";
import { issues } from "./answers";
import { fail, printable, type SocratesDeps } from "./client";
import { SocratesUnfitEvidenceList, type SocratesUnfitEvidence } from "./socrates-contract.v1";

const FIX = "pass a JSON array of at most 5 {kind, provenance, content} entries: kind is code, doc or session_utterance, provenance an http(s) URL or repo@sha:path#L<n>";

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The evidence entries in `path` (`-` is stdin), as the contract decodes them. */
export async function readEvidenceFile(ctx: VerbContext, deps: SocratesDeps, path: string): Promise<SocratesUnfitEvidence[]> {
  const from = path === "-" ? "stdin" : printable(path);
  let text: string;
  if (path === "-") {
    if ((deps.isStdinTTY ?? (() => Boolean(process.stdin.isTTY)))()) {
      fail(ctx, "socrates-evidence-file-invalid", "--evidence-file - reads stdin, but stdin is a terminal", "pipe the JSON in, e.g. cat evidence.json | eris socrates submit ... --evidence-file -");
    }
    try {
      text = await (deps.readStdin ?? readStdinText)();
    } catch (err) {
      fail(ctx, "socrates-evidence-file-invalid", `cannot read stdin: ${printable((err as Error).message)}`, FIX);
    }
  } else {
    try {
      text = await (deps.readFile ?? ((p) => Bun.file(p).text()))(path);
    } catch (err) {
      fail(ctx, "socrates-evidence-file-invalid", `cannot read ${from}: ${printable((err as Error).message)}`, FIX);
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail(ctx, "socrates-evidence-file-invalid", `${from} is not JSON`, FIX);
  }
  const parsed = SocratesUnfitEvidenceList.safeParse(raw);
  if (!parsed.success) fail(ctx, "socrates-evidence-file-invalid", `${from} does not match the contract (${printable(issues(parsed.error, "evidence"))})`, FIX);
  return parsed.data;
}
