/**
 * domain.ts — the completion domains a row's slots carry (`CompletionDomain`,
 * src/cli/registry.ts): the function a domain names, and the check composition
 * (src/cli/compose.ts) runs on a slot's words and on a domain's helper text
 * before the emitter (./emit.ts) writes them into the script.
 *
 * The script is sourced by every shell that loads eris completion, and a helper
 * sits between core's own definitions in it. The check holds what that framing
 * needs:
 *
 *   - outside a function, only definitions, comments and blank lines, so
 *     sourcing the script runs nothing;
 *   - every function it defines is named `__eris_dom_…`, never one of core's
 *     (`_eris_completions`, `__eris_comp_…`), and none is defined inside another;
 *   - every quote, `$( )`, `${ }` and brace group it opens is closed, and nothing
 *     follows a body's closing brace on its line, so no core text is swallowed;
 *   - no heredoc and no backtick substitution, whose extent this scan does not
 *     follow;
 *   - no control character but tab and newline, no bidirectional override, and
 *     a final newline.
 *
 * It is a scanner over quotes, expansions, substitutions and brace groups, not
 * a shell parser: it may refuse unusual valid shell, and composition then names
 * the line. Pure and import-free, because composition runs on every command line.
 */

import type { CompletionDomain, SlotWord } from "../../registry";

/** A literal slot word: the emitted script embeds it inside double quotes and a case label. */
export const WORD = /^[A-Za-z0-9_][A-Za-z0-9_?-]*$/;

const DOMAIN_NAME = /^@[a-z][a-z0-9_]*$/;
const PREFIX = "__eris_dom_";
const HELPER_FN = /^__eris_dom_[A-Za-z0-9_]+$/;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/;
/** `name() {`, then a blank: the only thing a helper may start outside a function. */
const HEADER = /([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(\)[ \t]*\{(?=[ \t\n])/y;
/** What may follow a body's closing brace on its line. */
const AFTER_BODY = /[ \t]*(#[^\n]*)?\n/y;
/** A function definition starting at a word: `name()` or the `function` keyword. */
const NESTED_DEF = /(?:[A-Za-z_][A-Za-z0-9_]*[ \t]*\(\)|function[ \t])/y;

/** The function the emitted slot calls for `domain`. */
export function domainFunction(domain: string): string {
  return `${PREFIX}${domain.slice(1)}`;
}

/** Why `word` cannot stand in a slot, else null. Its helper is `scanHelper`'s. */
export function slotWordRefusal(word: SlotWord): string | null {
  if (typeof word === "string") {
    return word === "@file" || WORD.test(word) ? null : `'${word}' is not a completion word (letters, digits, '_', '?', '-'), '@file' or a domain`;
  }
  const d = word as Partial<CompletionDomain> | null;
  if (typeof d !== "object" || d === null || typeof d.domain !== "string" || typeof d.helper !== "string") {
    return `${JSON.stringify(word)} is neither a completion word nor a domain ({ domain, helper })`;
  }
  if (d.domain === "@file") return "'@file' is built in: write it as the word '@file'";
  if (!DOMAIN_NAME.test(d.domain)) return `domain '${d.domain}' is not a domain name ('@', then lower-case letters, digits, '_')`;
  return null;
}

export type HelperScan = { readonly ok: true; readonly functions: readonly string[] } | { readonly ok: false; readonly why: string };

const lineAt = (text: string, at: number): number => text.slice(0, at).split("\n").length;

/** A word boundary before a reserved word, a comment or a definition. */
const BOUNDARY = new Set([undefined, " ", "\t", "\n", ";", "&", "|", "(", ")"]);
/** What may precede a closing `}` (ignoring blanks) for it to be the reserved word. */
const CLOSES = new Set([";", "\n", "&"]);

/** Where the scan is: code (a body, or inside `$( )`), `${ }`, a double, single or `$'…'` quote. */
type Frame = { kind: "code"; readonly sub: boolean; braces: number; parens: number } | { kind: "param" } | { kind: "dq" } | { kind: "sq" } | { kind: "ansi" };

/**
 * One function body, from just after its opening `{`: the index just past its
 * closing `}`, or why it cannot be framed.
 */
function scanBody(text: string, start: number): number | string {
  const stack: Frame[] = [{ kind: "code", sub: false, braces: 1, parens: 0 }];
  /** The last character before `j` that is not a blank: a newline at the body's start. */
  const prevBlank = (j: number): string => {
    let k = j - 1;
    while (k >= start && (text[k] === " " || text[k] === "\t")) k--;
    return k >= start ? text[k]! : "\n";
  };
  for (let j = start; j < text.length; j++) {
    const c = text[j]!;
    const top = stack[stack.length - 1]!;
    const at = () => lineAt(text, j);
    if (top.kind === "sq") {
      if (c === "'") stack.pop();
      continue;
    }
    if (c === "\\") {
      j++;
      continue;
    }
    if (top.kind === "ansi") {
      if (c === "'") stack.pop();
      continue;
    }
    if (c === "`") return `uses a backtick substitution (line ${at()}): use $( ) instead`;
    if (c === "$" && text[j + 1] === "(") {
      stack.push({ kind: "code", sub: true, braces: 0, parens: 0 });
      j++;
      continue;
    }
    if (c === "$" && text[j + 1] === "{") {
      stack.push({ kind: "param" });
      j++;
      continue;
    }
    if (top.kind === "dq") {
      if (c === '"') stack.pop();
      continue;
    }
    if (c === "'" && top.kind === "code" && text[j - 1] === "$") {
      stack.push({ kind: "ansi" });
      continue;
    }
    if (c === "'") {
      stack.push({ kind: "sq" });
      continue;
    }
    if (c === '"') {
      stack.push({ kind: "dq" });
      continue;
    }
    if (top.kind === "param") {
      if (c === "}") stack.pop();
      continue;
    }
    // Code: a body, or the inside of a `$( )`.
    const wordStart = BOUNDARY.has(text[j - 1]) || j === start;
    if (c === "#" && wordStart) {
      j = text.indexOf("\n", j) - 1;
      continue;
    }
    if (c === "<" && text[j + 1] === "<") {
      if (text[j + 2] !== "<") return `uses a heredoc (line ${at()}): its body is text the script's framing cannot see`;
      j += 2;
      continue;
    }
    if (wordStart) {
      NESTED_DEF.lastIndex = j;
      if (NESTED_DEF.test(text)) return `defines a function inside a function (line ${at()})`;
    }
    if (c === "(") top.parens++;
    else if (c === ")") {
      if (top.parens > 0) top.parens--;
      else if (top.sub) stack.pop();
    } else if (c === "{" && wordStart && /[ \t\n]/.test(text[j + 1] ?? "")) top.braces++;
    else if (c === "}" && top.braces > 0 && CLOSES.has(prevBlank(j))) {
      top.braces--;
      if (!top.sub && top.braces === 0) return j + 1;
    }
  }
  return stack.length > 1 ? "ends inside a quote, expansion or substitution" : "ends inside a function body";
}

/** The functions `text` defines, or why it cannot be emitted as a domain helper. */
export function scanHelper(text: string): HelperScan {
  const fail = (why: string): HelperScan => ({ ok: false, why });
  if (!text.endsWith("\n")) return fail("does not end with a newline");
  const control = CONTROL.exec(text);
  if (control !== null) return fail(`carries a control character (line ${lineAt(text, control.index)})`);
  const functions: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    if (c === "#") {
      i = text.indexOf("\n", i) + 1;
      continue;
    }
    HEADER.lastIndex = i;
    const head = HEADER.exec(text);
    if (head === null) return fail(`runs a command when sourced (line ${lineAt(text, i)}): outside a function only definitions, comments and blank lines may sit`);
    const name = head[1]!;
    if (!HELPER_FN.test(name)) return fail(`defines '${name}' (line ${lineAt(text, i)}), outside the ${PREFIX} namespace`);
    const end = scanBody(text, HEADER.lastIndex);
    if (typeof end === "string") return fail(end);
    AFTER_BODY.lastIndex = end;
    if (!AFTER_BODY.test(text)) return fail(`puts text after a function's closing brace (line ${lineAt(text, end)})`);
    functions.push(name);
    i = AFTER_BODY.lastIndex;
  }
  return { ok: true, functions };
}
