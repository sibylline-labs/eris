/**
 * domain.ts — the completion domains a row's slots carry (`CompletionDomain`,
 * src/cli/registry.ts): the function a domain names, and the check composition
 * (src/cli/compose.ts) runs on a slot's words and on every helper text before
 * the emitter (./emit.ts) writes them into the script.
 *
 * The script is sourced by every shell that loads eris completion (bash, and
 * zsh through bashcompinit), and a helper sits between core's own definitions
 * in it. Sourcing must define the helper's one function and run nothing, so the
 * check must find where that function ends exactly as both shells do. It does
 * not model shell quoting: it accepts a subset whose framing bash and zsh agree
 * on and refuses everything else, naming the line:
 *
 *   - the text is exactly one definition, `__eris_dom_<name>() {`, whose body
 *     closes at its final `}`, then a newline: nothing before it, nothing after;
 *   - printable ASCII, tab and newline only; no comment, no backtick, no heredoc
 *     or here-string, no `$'…'`, `$"…"` or `$[…]`, no function defined inside;
 *   - a backslash only inside quotes, and only before a letter or digit;
 *   - `${ }` holds a name and its operators only (no quote, nesting or `( )`);
 *   - `{` and `}` as words only where both shells read them as a group's braces:
 *     `{` in command position, `}` after `;` or a newline, closing one the scan
 *     opened (zsh reads a lone `}` as a closing brace anywhere on a line);
 *   - inside `$( )`, no `case` and no unbalanced parenthesis inside a quote,
 *     which older bash can read as the substitution's end.
 *
 * A helper that is valid shell may still be refused; rewrite it into the
 * subset. Pure and import-free, because composition runs on every command line.
 */

import type { CompletionDomain, SlotWord } from "../../registry";

/** A literal slot word: the emitted script embeds it inside double quotes and a case label. */
export const WORD = /^[A-Za-z0-9_][A-Za-z0-9_?-]*$/;

const DOMAIN_NAME = /^@[a-z][a-z0-9_]*$/;
const PREFIX = "__eris_dom_";
/** The one header a helper starts with: `name() {`, then a blank or newline. */
const HEADER = /^(__eris_dom_[A-Za-z0-9_]+)\(\)[ \t]*\{(?=[ \t\n])/;
/** Anything but printable ASCII, tab and newline. */
const OUTSIDE_ASCII = /[^\t\n\x20-\x7e]/;
/** Characters that end a shell word. */
const META = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"]);
/** What `${` … `}` may hold: a name, `$name`, and the operators on it. */
const PARAM_CHAR = /[A-Za-z0-9_:=+?#%/*@!.,~^\-[\] \t]/;
/** What may follow `$` inside `${ }`: a name or a special parameter. */
const PARAM_DOLLAR = /[A-Za-z0-9_@*#?!$-]/;

/** The function the emitted slot calls for `domain`. */
export function domainFunction(domain: string): string {
  return `${PREFIX}${domain.slice(1)}`;
}

/** Every helper text a domain carries: its library, then its own function. */
export function helperTexts(d: CompletionDomain): readonly string[] {
  return [...(d.library ?? []), d.helper];
}

/** Why `word` cannot stand in a slot, else null. Its helper texts are `scanHelper`'s. */
export function slotWordRefusal(word: SlotWord): string | null {
  if (typeof word === "string") {
    return word === "@file" || WORD.test(word) ? null : `'${word}' is not a completion word (letters, digits, '_', '?', '-'), '@file' or a domain`;
  }
  const d = word as Partial<CompletionDomain> | null;
  if (typeof d !== "object" || d === null || typeof d.domain !== "string" || typeof d.helper !== "string") {
    return `${JSON.stringify(word)} is neither a completion word nor a domain ({ domain, helper })`;
  }
  if (d.library !== undefined && (!Array.isArray(d.library) || !d.library.every((t) => typeof t === "string"))) {
    return `domain '${d.domain}': library must be a list of helper texts`;
  }
  if (d.domain === "@file") return "'@file' is built in: write it as the word '@file'";
  if (!DOMAIN_NAME.test(d.domain)) return `domain '${d.domain}' is not a domain name ('@', then lower-case letters, digits, '_')`;
  return null;
}

/** The one function a helper text defines, or why it cannot be emitted. */
export type HelperScan = { readonly ok: true; readonly function: string } | { readonly ok: false; readonly why: string };

const lineAt = (text: string, at: number): number => text.slice(0, at).split("\n").length;

/** Where the scan is: code (the body, or inside `$( )`), `${ }`, or a double or single quote. */
type Frame =
  | { kind: "code"; readonly sub: boolean; readonly start: number; braces: number; parens: number }
  | { kind: "param" }
  | { kind: "dq" | "sq"; readonly inSub: boolean; parens: number };

class Refusal extends Error {}

/** The body from just after its opening `{`: the index just past its closing `}`. Throws a Refusal. */
function scanBody(text: string, start: number): number {
  const stack: Frame[] = [{ kind: "code", sub: false, start, braces: 1, parens: 0 }];
  const inSub = () => stack.some((f) => f.kind === "code" && f.sub);
  const refuse = (j: number, why: string): never => {
    throw new Refusal(`${why} (line ${lineAt(text, j)})`);
  };
  /** The last non-blank character before `j` in a code frame starting at `from`; "" at the frame's start. */
  const prevWord = (j: number, from: number): string => {
    let k = j - 1;
    while (k >= from && (text[k] === " " || text[k] === "\t")) k--;
    return k >= from ? text[k]! : "";
  };
  const backslash = (j: number) => {
    if (!/[A-Za-z0-9]/.test(text[j + 1] ?? "")) refuse(j, "has a backslash before something other than a letter or digit");
  };
  for (let j = start; j < text.length; j++) {
    const c = text[j]!;
    const next = text[j + 1];
    const top = stack[stack.length - 1]!;
    if (c === "`") refuse(j, "uses a backtick: use $( ) instead");
    if (top.kind === "sq") {
      if (c === "'") {
        if (top.parens !== 0) refuse(j, "has an unbalanced parenthesis in a quote inside $( )");
        stack.pop();
      } else if (c === "\\") backslash(j);
      else if (top.inSub && (c === "(" || c === ")")) top.parens += c === "(" ? 1 : -1;
      continue;
    }
    if (top.kind === "param") {
      if (c === "}") stack.pop();
      else if (c === "$" && PARAM_DOLLAR.test(next ?? "")) j++;
      else if (!PARAM_CHAR.test(c)) refuse(j, "has a ${ } holding more than a name and its operators");
      continue;
    }
    if (c === "$" && next === "$") {
      j++;
      continue;
    }
    if (c === "$" && (next === "'"|| next === '"' || next === "[")) refuse(j, `uses $${next}, which the shells read differently`);
    if (c === "$" && next === "(") {
      stack.push({ kind: "code", sub: true, start: j + 2, braces: 0, parens: 0 });
      j++;
      continue;
    }
    if (c === "$" && next === "{") {
      stack.push({ kind: "param" });
      j++;
      continue;
    }
    if (top.kind === "dq") {
      if (c === '"') {
        if (top.parens !== 0) refuse(j, "has an unbalanced parenthesis in a quote inside $( )");
        stack.pop();
      } else if (c === "\\") backslash(j);
      else if (top.inSub && (c === "(" || c === ")")) top.parens += c === "(" ? 1 : -1;
      continue;
    }
    // Code: the body, or the inside of a `$( )`.
    const code = top as Extract<Frame, { kind: "code" }>;
    if (c === "\\") refuse(j, "has a backslash outside quotes");
    if (c === "'" || c === '"') {
      stack.push({ kind: c === "'" ? "sq" : "dq", inSub: inSub(), parens: 0 });
      continue;
    }
    if (c === "#" && text[j - 1] !== "$") refuse(j, "has a comment or a bare '#': keep comments in the TypeScript beside it");
    if (c === "<" && next === "<") refuse(j, "uses a heredoc or here-string");
    const wordStart = j === code.start || META.has(text[j - 1]!);
    const wordEnd = (k: number) => k >= text.length || META.has(text[k]!);
    if (wordStart && /^function[ \t]/.test(text.slice(j, j + 9))) refuse(j, "defines a function inside a function");
    if (wordStart && code.sub && /^case\b/.test(text.slice(j, j + 5))) refuse(j, "uses case inside $( )");
    if (c === "(") {
      if (/^\([ \t]*\)/.test(text.slice(j))) refuse(j, "defines a function inside a function");
      code.parens++;
    } else if (c === ")") {
      if (code.parens > 0) code.parens--;
      else if (code.sub) stack.pop();
    } else if (c === "{" && wordStart && wordEnd(j + 1)) {
      const before = prevWord(j, code.start);
      const twoBefore = text.slice(0, j).trimEnd();
      if (!/[ \t\n]/.test(next ?? "") || !["", "\n", ";", "&", "|", "("].includes(before) || twoBefore.endsWith(";;")) {
        refuse(j, "has a '{' word outside command position");
      }
      code.braces++;
    } else if (c === "}" && wordStart && wordEnd(j + 1)) {
      const before = prevWord(j, code.start);
      const twoBefore = text.slice(0, j).trimEnd();
      if (!["\n", ";"].includes(before) || twoBefore.endsWith(";;") || !/[ \t\n;]/.test(next ?? "") || code.braces === 0) {
        refuse(j, "has a '}' word that does not close a group after ';' or a newline");
      }
      code.braces--;
      if (!code.sub && code.braces === 0) return j + 1;
    }
  }
  return refuse(text.length - 1, stack.length > 1 ? "ends inside a quote, expansion or substitution" : "ends inside the function body");
}

/** The one function `text` defines, or why it cannot be emitted as a helper. */
export function scanHelper(text: string): HelperScan {
  const fail = (why: string): HelperScan => ({ ok: false, why });
  if (!text.endsWith("\n")) return fail("does not end with a newline");
  const odd = OUTSIDE_ASCII.exec(text);
  if (odd !== null) return fail(`carries a character outside printable ASCII (line ${lineAt(text, odd.index)})`);
  const head = HEADER.exec(text);
  if (head === null) {
    return fail(`must be exactly one definition, starting at its first character with '${PREFIX}<name>() {'`);
  }
  try {
    const end = scanBody(text, head[0].length);
    if (end !== text.length - 1) return fail(`puts text after the function's closing brace (line ${lineAt(text, end)}): one function per helper text`);
  } catch (e) {
    if (e instanceof Refusal) return fail(e.message);
    throw e;
  }
  return { ok: true, function: head[1]! };
}
