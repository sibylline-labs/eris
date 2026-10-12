/**
 * emit.ts — the bash and zsh completion scripts.
 *
 * The command tree is generated from the registry it is handed: groups,
 * subs, nested subs, each path's long flags, which flags take a value and
 * which of those values are file names (`file` on the flag's row). A verb added
 * to src/cli/registry.ts, or declared by a plugin, completes with no other edit.
 *
 * The rest is the tab-press engine, which is shell by nature and is emitted
 * as text. Its contract (docs/COMPLETION.md):
 *   - a tab press never runs eris and never touches the network;
 *   - bash-3.2-clean (macOS /bin/bash) and shared verbatim by the zsh route,
 *     which loads it through bashcompinit.
 *
 * This runs on every shell start (`source <(eris completion bash)`): it
 * imports the registry and nothing else, so no other verb's source, Bash or
 * TS, is on its path.
 */

import { REGISTRY, type Row } from "../../registry";

export type Shell = "bash" | "zsh";
type Registry = Readonly<Record<string, Row>>;

/** The positional slots of a command path, one entry per slot: `@file` is
 *  file names, any other token a literal word. */
export type Slots = Readonly<Record<string, readonly (readonly string[])[]>>;

/** Core's positional slots with a completable domain, by command path. A path
 *  with no entry completes no positionals. */
export const SLOTS: Slots = {};

/** A word the emitted script embeds inside double quotes and a case label. */
const WORD = /^[A-Za-z0-9_][A-Za-z0-9_?-]*$/;
const FLAG = /^--[a-z][a-z0-9-]*$/;

function safe(word: string, re: RegExp, what: string): string {
  if (!re.test(word)) throw new Error(`completion: ${what} '${word}' is not shell-safe`);
  return word;
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const uniqSorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort(byCodePoint);

/** The lookup key the engine builds for a command path: words joined by `__`. */
const keyOf = (path: string): string => path.split(" ").join("__");

function subsIn(reg: Registry, path: string): string[] {
  const depth = path.split(" ").length + 1;
  return Object.keys(reg)
    .filter((k) => k.startsWith(`${path} `) && k.split(" ").length === depth)
    .map((k) => safe(k.split(" ")[depth - 1]!, WORD, "verb"));
}

function flagNames(row: Row | undefined): string[] {
  return (row?.flags ?? []).map((f) => safe(f.name, FLAG, "flag"));
}

function caseFn(name: string, arms: readonly [string, string][], fallback: string): string {
  const body = arms.map(([label, action]) => `    ${label}) ${action} ;;\n`).join("");
  return `${name}() {\n  case "$1" in\n${body}    *) ${fallback} ;;\n  esac\n}\n`;
}

function predicateFn(name: string, subject: string, labels: readonly string[]): string {
  const arm = labels.length > 0 ? `    ${labels.join("|")}) return 0 ;;\n` : "";
  return `${name}() {\n  case ${subject} in\n${arm}  esac\n  return 1\n}\n`;
}

/** The generated half: the tree, the flags and the positional slots. */
function generated(reg: Registry, slots: Slots): { tree: string; argv: string } {
  const paths = Object.keys(reg);
  const groups = uniqSorted(paths.filter((p) => !p.includes(" ")).map((g) => safe(g, WORD, "group")));

  const verbArms: [string, string][] = [];
  for (const path of [...paths].sort(byCodePoint)) {
    const subs = subsIn(reg, path);
    if (subs.length > 0) verbArms.push([keyOf(path), `echo "${uniqSorted(subs).join(" ")}"`]);
  }

  // A path offers its own flags; a group's own key, used before a verb is
  // typed (and for a verb the registry does not know), offers the union of
  // every row under it.
  const flagArms: [string, string][] = [];
  for (const path of [...paths].sort(byCodePoint)) {
    const own = path.includes(" ") ? flagNames(reg[path]) : paths.filter((p) => p === path || p.startsWith(`${path} `)).flatMap((p) => flagNames(reg[p]));
    flagArms.push([keyOf(path), `echo "${uniqSorted([...own, "--help"]).join(" ")}"`]);
  }

  const valueFlags = uniqSorted(paths.flatMap((p) => (reg[p]!.flags ?? []).filter((f) => f.takesValue).map((f) => safe(f.name, FLAG, "flag"))));
  // Registry order, first seen: core's rows precede a plugin's, and the emitted
  // case arm lists them in that order.
  const fileFlags = [...new Set(paths.flatMap((p) => (reg[p]!.flags ?? []).filter((f) => f.takesValue && f.file === true).map((f) => safe(f.name, FLAG, "flag"))))];

  const slotArms: [string, string][] = [];
  const fileSlots: string[] = [];
  for (const path of Object.keys(slots).sort(byCodePoint)) {
    if (!Object.hasOwn(reg, path)) continue;
    slots[path]!.forEach((slot, n) => {
      const label = `"${keyOf(path)} ${n}"`;
      if (slot.includes("@file")) {
        fileSlots.push(label);
        return;
      }
      const words = slot.map((t) => safe(t, WORD, "slot word"));
      slotArms.push([label, `echo "${words.join(" ")}"`]);
    });
  }

  const tree =
    `__eris_comp_groups() {\n  echo "${groups.join(" ")}"\n}\n\n` +
    `${caseFn("__eris_comp_verbs", verbArms, 'echo ""')}\n` +
    `${caseFn("__eris_comp_flags", flagArms, 'echo ""')}\n`;
  const argv =
    "# Flags whose next word is a user-supplied value (never completed as a\n# positional), and the ones whose value is a file name.\n" +
    `${predicateFn("__eris_comp_valflag", '"$1"', valueFlags)}\n` +
    `${predicateFn("__eris_comp_fileflag", '"$1"', fileFlags)}\n` +
    '# The positional slots: __eris_comp_slot <key> <n> prints the words for\n# slot n of the command <key>; __eris_comp_fileslot says it is a file.\n' +
    `__eris_comp_slot() {\n  case "$1 $2" in\n${slotArms.map(([l, a]) => `    ${l}) ${a} ;;\n`).join("")}  esac\n  return 0\n}\n\n` +
    `${predicateFn("__eris_comp_fileslot", '"$1 $2"', fileSlots)}\n`;
  return { tree, argv };
}

const BASH_HEADER = `# eris bash completion — generated by 'eris completion bash'.
# The command tree below is a snapshot of the eris verb registry
# (src/cli/registry.ts) at emission time; re-emit after upgrading eris, or
# source via process substitution so it regenerates at shell startup. Works on
# bash 3.2+ (macOS /bin/bash). See docs/COMPLETION.md.
`;

const ZSH_HEADER = `# eris zsh completion — generated by 'eris completion zsh'.
# Route: bashcompinit wrapping the shared bash completion body (the engine
# sets the ksharrays localoption so COMP_WORDS indexing matches bash). The
# command tree below is a snapshot of the eris verb registry at emission
# time; source via process substitution so it regenerates at shell startup.
# See docs/COMPLETION.md.
if [ -z "\${ZSH_VERSION:-}" ]; then
  echo "eris: this completion script is for zsh — use 'eris completion bash' for bash" >&2
  return 1 2>/dev/null || exit 1
fi
if ! command -v compdef >/dev/null 2>&1; then
  autoload -U +X compinit && compinit
fi
autoload -U +X bashcompinit && bashcompinit
`;

/** The tab-press entry point. */
const ENGINE = `_eris_completions() {
  # Under zsh/bashcompinit, give this function bash's 0-based array
  # indexing; under bash the command doesn't exist and is silenced.
  setopt localoptions ksharrays 2>/dev/null || :

  local cur prev group verb sub key words
  local i w p np
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev=""
  [ "$COMP_CWORD" -ge 1 ] && prev="\${COMP_WORDS[COMP_CWORD-1]}"

  # A value-taking flag right before the cursor: complete files for the
  # file-valued ones, otherwise stay silent while the user types the value.
  if __eris_comp_valflag "$prev"; then
    __eris_comp_fileflag "$prev" && COMPREPLY=( $(compgen -f -- "$cur") )
    return 0
  fi

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$(__eris_comp_groups) --help" -- "$cur") )
    return 0
  fi

  group="\${COMP_WORDS[1]}"

  # Walk the words after the group (before the cursor): the first positional
  # is the verb (verb-ful groups only), the next is the nested sub when the
  # verb is itself a group, the rest are counted as arguments. Flags and the
  # values of value-taking flags are skipped.
  verb=""; sub=""; np=0
  i=2
  while [ "$i" -lt "$COMP_CWORD" ]; do
    w="\${COMP_WORDS[i]}"
    p="\${COMP_WORDS[i-1]}"
    if __eris_comp_valflag "$p"; then i=$((i + 1)); continue; fi
    case "$w" in
      -*) i=$((i + 1)); continue ;;
    esac
    if [ -z "$verb" ] && [ -n "$(__eris_comp_verbs "$group")" ]; then
      verb="$w"
    elif [ -n "$verb" ] && [ -z "$sub" ] && [ "$np" -eq 0 ] && [ -n "$(__eris_comp_verbs "\${group}__\${verb}")" ]; then
      sub="$w"
    else
      np=$((np + 1))
    fi
    i=$((i + 1))
  done
  key="$group"
  [ -n "$verb" ] && key="\${key}__\${verb}"
  [ -n "$sub" ] && key="\${key}__\${sub}"

  # Flags of the deepest known path; else the group's whole set.
  case "$cur" in
    -*)
      words=$(__eris_comp_flags "$key")
      [ -n "$words" ] || words=$(__eris_comp_flags "$group")
      [ -n "$words" ] || words="--help"
      COMPREPLY=( $(compgen -W "$words" -- "$cur") )
      return 0
      ;;
  esac

  # Verb position of a verb-ful group.
  if [ -z "$verb" ] && [ -n "$(__eris_comp_verbs "$group")" ]; then
    COMPREPLY=( $(compgen -W "$(__eris_comp_verbs "$group")" -- "$cur") )
    return 0
  fi

  # Nested sub position (\`eris <group> <verb> <TAB>\`).
  if [ -n "$verb" ] && [ -z "$sub" ]; then
    words=$(__eris_comp_verbs "\${group}__\${verb}")
    if [ -n "$words" ]; then
      COMPREPLY=( $(compgen -W "$words" -- "$cur") )
      return 0
    fi
  fi

  # Positional slots with a known domain. Everything else intentionally
  # offers nothing (silent degradation).
  if __eris_comp_fileslot "$key" "$np"; then
    COMPREPLY=( $(compgen -f -- "$cur") )
    return 0
  fi
  words=$(__eris_comp_slot "$key" "$np")
  [ -n "$words" ] && COMPREPLY=( $(compgen -W "$words" -- "$cur") )
  return 0
}

complete -F _eris_completions eris
`;

/** The full script for `shell`, generated from `reg` and `slots`.
 *  Deterministic: the same registry emits the same bytes. */
export function emitScript(shell: Shell, reg: Registry = REGISTRY, slots: Slots = SLOTS): string {
  const { tree, argv } = generated(reg, slots);
  return `${shell === "zsh" ? ZSH_HEADER : BASH_HEADER}${tree}${argv}${ENGINE}`;
}
