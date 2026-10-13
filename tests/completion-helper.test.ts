/**
 * The helper check (src/cli/commands/completion/domain.ts): a completion
 * domain's shell text is written into the script every shell sources at start,
 * so a text the check accepts must define exactly its one function and run
 * nothing, in bash and in zsh.
 *
 * Seams: `scanHelper`, the check composition runs on every helper and library
 * text; `composeCli` for a domain's library; and the accepted texts sourced by
 * a real bash and zsh in an empty directory.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emitScript } from "../src/cli/commands/completion/emit";
import { scanHelper } from "../src/cli/commands/completion/domain";
import { composeCli, PluginCompositionError } from "../src/cli/compose";
import type { ErisPlugin } from "../src/cli/plugin";
import { type CompletionDomain, REGISTRY } from "../src/cli/registry";
import { HANDLERS } from "../src/main";
import { REPO } from "./helpers/blackbox";
import { FX_ENV, FX_GATE, FX_KEY, FX_VAR, LIBRARY } from "./fixtures/completion-library";

const fn = (name: string, body = "  echo x") => `${name}() {\n${body}\n}\n`;
const x = (body: string) => fn("__eris_dom_x", body);

/** [name, helper text, the refusal it must get]. Each is shell the check cannot frame as both shells do, or text outside the one function. */
const REFUSED: [string, string, RegExp][] = [
  ["the review's payload: an escaped $ before a quote", "__eris_dom_x() {\n  echo \\$'\\' ; } ; touch PWNED ; __eris_dom_y() { echo ' \\'\n}\n", /backslash outside quotes \(line 2\)/],
  ["a backslash before a single quote inside single quotes", x("  echo 'a\\'"), /backslash before something other than a letter or digit \(line 2\)/],
  ["a backslash before a double quote", x('  echo "a\\"b"'), /backslash before something other than a letter or digit/],
  ["a backslash before $ inside double quotes", x('  echo "\\$x"'), /backslash before something other than a letter or digit/],
  ["a backslash before a backslash", x("  echo 'a\\\\'"), /backslash before something other than a letter or digit/],
  ["a backslash outside quotes", x("  echo a\\ b"), /backslash outside quotes/],
  ["a line continuation", x("  echo a \\\n    b"), /backslash outside quotes/],
  ["an ANSI-C quote", x("  echo $'x'"), /uses \$', which the shells read differently/],
  ["a locale quote", x('  echo $"x"'), /uses \$", which the shells read differently/],
  ["an old arithmetic expansion", x("  echo $[1]"), /uses \$\[, which the shells read differently/],
  ["a heredoc", x("  cat <<EOF\n}\nEOF"), /heredoc or here-string \(line 2\)/],
  ["a here-string", x("  cat <<< x"), /heredoc or here-string/],
  ["a backtick", x("  echo `date`"), /uses a backtick/],
  ["a backtick inside single quotes", x("  echo '`'"), /uses a backtick/],
  ["a comment in the body", x("  echo x # note"), /has a comment or a bare '#'/],
  ["a comment line before the definition", `# note\n${x("  echo x")}`, /must be exactly one definition/],
  ["a blank line before the definition", `\n${x("  echo x")}`, /must be exactly one definition/],
  ["a definition outside the namespace", fn("_eris_completions"), /must be exactly one definition/],
  ["a nested definition", x("  __eris_dom_y() { :; }"), /defines a function inside a function \(line 2\)/],
  ["a nested definition with blanks in its parentheses", x("  __eris_dom_y ( ) { :; }"), /defines a function inside a function/],
  ["a nested definition by keyword", x("  function __eris_dom_y { :; }"), /defines a function inside a function/],
  ["a '}' word in argument position", x("  echo }"), /'}' word that does not close a group/],
  ["a '}' word closing nothing inside $( )", x("  y=$(echo a; })"), /'}' word that does not close a group/],
  ["a '}' word followed by a redirection", x("  { echo a;}>/dev/null"), /'}' word that does not close a group/],
  ["a '{' word in argument position", x("  echo { a"), /'\{' word outside command position/],
  ["a '{' word after a keyword", x("  if :; then { :; }; fi"), /'\{' word outside command position/],
  ["text after the closing brace on its line", "__eris_dom_x() { echo x; } ; echo y\n", /puts text after the function's closing brace \(line 1\)/],
  ["text after a ';}' close", "__eris_dom_x() { echo x;}; echo y\n", /puts text after the function's closing brace/],
  ["a second line after the closing brace", `${x("  echo x")}echo y\n`, /puts text after the function's closing brace \(line 3\)/],
  ["a trailing blank line", `${x("  echo x")}\n`, /puts text after the function's closing brace/],
  ["two functions in one text", `${x("  echo x")}${fn("__eris_dom_y")}`, /puts text after the function's closing brace \(line 3\)/],
  ["a quote inside ${ }", x(`  echo "\${y:-'}'}"`), /\$\{ \} holding more than a name/],
  ["a nested ${ }", x("  echo ${y:-${z}}"), /\$\{ \} holding more than a name/],
  ["case inside $( )", x("  y=$(case a in a) echo a ;; esac)"), /uses case inside \$\( \)/],
  ["an unbalanced parenthesis in a quote inside $( )", x('  y=$(echo ")")'), /unbalanced parenthesis in a quote inside \$\( \)/],
  ["a character outside printable ASCII", x("  echo café"), /outside printable ASCII \(line 2\)/],
  ["a bidirectional override", x("  echo \u202e"), /outside printable ASCII/],
  ["a control character", x("  echo \x1b[31m"), /outside printable ASCII/],
  ["no final newline", "__eris_dom_x() {\n  echo x\n}", /does not end with a newline/],
  ["an unclosed quote", x('  echo "open'), /ends inside a quote, expansion or substitution/],
  ["an unclosed substitution, which takes the closing brace", x("  echo $(ls"), /'}' word that does not close a group after ';' or a newline \(line 3\)/],
  ["an unclosed group", "__eris_dom_x() {\n  { echo x\n}\n", /ends inside the function body/],
];

/** [name, the texts sourced together, the functions they define]. Shapes real distributions write. */
const ACCEPTED: [string, string[], string[]][] = [
  ["a case on the earlier slot's word", [`__eris_dom_demo_name() {\n  case "\${1:-}" in\n    loud) echo "ADA GRACE" ;;\n    *) echo "ada grace" ;;\n  esac\n}\n`], ["__eris_dom_demo_name"]],
  ["a one-line body closed by ';}'", ["__eris_dom_x() { echo x;}\n"], ["__eris_dom_x"]],
  ["a group, a substitution and a parameter default", [x('  { y=$(printf \'%s\\n\' "${1:-none}" | tr \'a\' \'b\'); } 2>/dev/null\n  [ -n "$y" ] && echo "$y"')], ["__eris_dom_x"]],
  ["a library of shared functions and four domains on it", [...LIBRARY, FX_ENV.helper, FX_KEY.helper, FX_GATE.helper, FX_VAR.helper], [
    "__eris_dom_fx_cache_dir", "__eris_dom_fx_env", "__eris_dom_fx_gate", "__eris_dom_fx_git_top", "__eris_dom_fx_key", "__eris_dom_fx_leaf_file",
    "__eris_dom_fx_mtime", "__eris_dom_fx_names", "__eris_dom_fx_root_file", "__eris_dom_fx_service", "__eris_dom_fx_static", "__eris_dom_fx_var",
  ]],
];

describe("the helper check refuses what it cannot frame", () => {
  it.each(REFUSED)("%s", (_name, text, why) => {
    /** When the check accepts a text whose function ends somewhere else in bash or zsh than where the scan thinks, sourcing `eris completion` runs the rest as top-level commands in every shell that loads it: observed at the refusal. */
    const scan = scanHelper(text);
    expect(scan.ok).toBe(false);
    if (!scan.ok) expect(scan.why).toMatch(why);
  });
});

describe("an accepted helper defines its functions and runs nothing when sourced", () => {
  const scratch = join(REPO, ".scratch", `helper-${process.pid}`);
  beforeAll(() => mkdirSync(scratch, { recursive: true }));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  /** The functions sourcing `file` adds, and the files it leaves in an empty cwd. */
  const source = (shell: "bash" | "zsh", file: string, cwd: string) => {
    const list = shell === "bash" ? "compgen -A function | sort" : "print -rl -- ${(ok)functions}";
    const argv = shell === "bash" ? ["--norc", "--noprofile", "-c"] : ["-f", "-c"];
    const r = spawnSync(shell, [...argv, `${list} > "$2"; . "$1"; ${list} > "$3"`, shell, file, join(scratch, `${shell}-before`), join(scratch, `${shell}-after`)], {
      cwd,
      env: { PATH: process.env.PATH, HOME: cwd },
      encoding: "utf8",
    });
    expect({ shell, status: r.status, stderr: r.stderr }).toEqual({ shell, status: 0, stderr: "" });
    const read = (f: string) => new Set(spawnSync("cat", [join(scratch, f)], { encoding: "utf8" }).stdout.split("\n").filter(Boolean));
    const before = read(`${shell}-before`);
    return { added: [...read(`${shell}-after`)].filter((f) => !before.has(f)).sort(), left: readdirSync(cwd) };
  };

  it.each(ACCEPTED)("%s", (name, texts, functions) => {
    /** When the check accepts a text that runs a command, or defines a function other than its own, sourcing completion does work or replaces a function in every shell that loads it: observed by sourcing the accepted texts in bash and zsh from an empty directory. */
    for (const t of texts) expect({ t, ok: scanHelper(t).ok }).toEqual({ t, ok: true });
    const file = join(scratch, `${name.replace(/\W+/g, "-")}.sh`);
    writeFileSync(file, texts.join("\n"));
    for (const shell of ["bash", "zsh"] as const) {
      const cwd = join(scratch, `cwd-${shell}-${name.replace(/\W+/g, "-")}`);
      mkdirSync(cwd);
      expect({ shell, ...source(shell, file, cwd) }).toEqual({ shell, added: functions, left: [] });
    }
  });
});

describe("a domain's library", () => {
  const plugin = (name: string, ...domains: CompletionDomain[]): ErisPlugin => ({
    name,
    rows: { [`g${name}`]: { impl: "ts", summary: "s", complete: domains.map((d) => [d]) } },
    handlers: { [`g${name}`]: HANDLERS.completion! },
  });

  it("is checked text by text, shared across domains and plugins, and emitted once", () => {
    /** When a library text skips the check, or two domains sharing a library emit it twice or with different text, the script runs a command, or one plugin's slot calls another's function: observed at composeCli and at the emitted script. */
    const cli = composeCli(REGISTRY, HANDLERS, [plugin("a", FX_ENV, FX_KEY), plugin("b", FX_GATE, FX_VAR)]);
    const script = emitScript("bash", cli.registry);
    for (const text of [...LIBRARY, FX_ENV.helper, FX_VAR.helper]) expect(script.split(text).length - 1).toBe(1);
    const bad: CompletionDomain = { ...FX_ENV, domain: "@fx_bad", helper: fn("__eris_dom_fx_bad"), library: [...LIBRARY.slice(1), `${LIBRARY[0]}echo y\n`] };
    expect(() => composeCli(REGISTRY, HANDLERS, [plugin("a", bad)])).toThrow(
      new PluginCompositionError("plugin 'a': domain '@fx_bad': its library text 7 puts text after the function's closing brace (line 3): one function per helper text"),
    );
    const clash: CompletionDomain = { domain: "@fx_other", helper: fn("__eris_dom_fx_other"), library: [fn("__eris_dom_fx_static", "  echo other")] };
    expect(() => composeCli(REGISTRY, HANDLERS, [plugin("a", FX_ENV), plugin("b", clash)])).toThrow(
      new PluginCompositionError("plugin 'b': domain '@fx_other': its library text 0 defines '__eris_dom_fx_static', which plugin 'a' defines with other text"),
    );
    const own: CompletionDomain = { domain: "@fx_own", helper: fn("__eris_dom_fx_own"), library: [fn("__eris_dom_fx_own")] };
    expect(() => composeCli(REGISTRY, HANDLERS, [plugin("a", own)])).toThrow(
      new PluginCompositionError("plugin 'a': domain '@fx_own': its library defines __eris_dom_fx_own, which is its helper's"),
    );
  });
});
