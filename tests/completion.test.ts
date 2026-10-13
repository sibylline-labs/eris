/**
 * `eris completion bash|zsh`: the scripts are generated from
 * src/cli/registry.ts, and the tab-press engine they carry is shell.
 *
 * Seams: the real `eris` shim (what a shell rc runs at startup), the emitter
 * called with an injected registry, and the emitted `_eris_completions`
 * function driven in a real shell with COMP_WORDS/COMP_CWORD, reading
 * COMPREPLY back. Tab presses run under /bin/bash, which is 3.2 on macOS: the
 * login shell the script has to work in, not the bash on PATH.
 *
 * Every fixture lives under the repo's gitignored `.scratch/` (scripts are
 * sourced and stubs exec'd from it, never from a temp dir), with its own HOME
 * so ~/.eris/settings.json cannot leak in.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { emitScript } from "../src/cli/commands/completion/emit";
import type { CompletionDomain, FlagName, Row } from "../src/cli/registry";
import { REGISTRY } from "./helpers/build-cli";
import { onPath } from "../src/cli/ts-verb";
import { checkoutOnly, ERIS, ERIS_BIN, oracleEnv } from "./helpers/blackbox";

setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, "..");
const OLD_BASH = "/bin/bash";
const HAS_ZSH = onPath("zsh", process.env) !== undefined;
let tmp: string;
let home: string;
let work: string;
let stubs: string;
let record: string;
let bashScript: string;
let zshScript: string;

function gitInit(dir: string): string {
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", dir]);
  return realpathSync(dir);
}

/** Recording stubs for everything a tab press must never run: the network
 *  clients and eris itself (whose verbs reach the network). */
function makeStubs(dir: string, log: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of ["curl", "wget", "eris", "bun", "gcloud", "node"]) {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> '${log}'\nexit 0\n`);
    chmodSync(p, 0o755);
  }
}

interface Press {
  cwd?: string;
  path?: string;
  env?: Record<string, string>;
  script?: string;
}

/** One tab press: source the script, set COMP_WORDS/COMP_CWORD, run the
 *  completion function, return COMPREPLY (one word per entry). */
function press(words: string[], o: Press = {}): string[] {
  const cword = words.length - 1;
  const quoted = words.map((w) => `'${w}'`).join(" ");
  const r = spawnSync(
    OLD_BASH,
    ["-c", `source '${o.script ?? bashScript}'; COMP_WORDS=(${quoted}); COMP_CWORD=${cword}; _eris_completions; printf '%s\\n' "\${COMPREPLY[@]-}"`],
    {
      cwd: o.cwd ?? work,
      env: { PATH: o.path ?? `${stubs}:${process.env.PATH}`, HOME: home, ...o.env },
      encoding: "utf8",
    },
  );
  expect({ words, stderr: r.stderr, status: r.status }).toEqual({ words, stderr: "", status: 0 });
  return r.stdout.split("\n").filter((l) => l !== "");
}

const sorted = (a: string[]): string[] => [...a].sort();

beforeAll(() => {
  mkdirSync(join(REPO, ".scratch"), { recursive: true });
  tmp = realpathSync(mkdtempSync(join(REPO, ".scratch", "completion-")));
  home = join(tmp, "home");
  mkdirSync(home);
  work = gitInit(join(tmp, "work"));
  record = join(tmp, "spawned.log");
  writeFileSync(record, "");
  stubs = join(tmp, "stubs");
  makeStubs(stubs, record);

  for (const shell of ["bash", "zsh"]) {
    const r = spawnSync(ERIS, ["completion", shell], { cwd: work, env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
    expect({ shell, status: r.status, stderr: r.stderr }).toEqual({ shell, status: 0, stderr: "" });
    expect(r.stdout).toContain("complete -F _eris_completions eris");
    writeFileSync(join(tmp, `eris.${shell}`), r.stdout);
  }
  bashScript = join(tmp, "eris.bash");
  zshScript = join(tmp, "eris.zsh");
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("eris completion: the command", () => {
  it("emits a bash script with no yq on PATH, under /bin/bash, exit 0 and nothing on stderr", () => {
    /** When completion runs the yq preflight (or any yq-needing import), a host without yq gets an empty script at every shell start. */
    // Only what the shim itself runs: bun, and dirname for its own directory.
    const bin = join(tmp, "no-yq-bin");
    mkdirSync(bin, { recursive: true });
    for (const tool of ["bun", "dirname"]) if (!existsSync(join(bin, tool))) symlinkSync(onPath(tool, process.env)!, join(bin, tool));
    const path = bin;
    expect(onPath("yq", { PATH: path })).toBeUndefined();
    // The shim is run under the oldest bash a host has; a compiled binary is run as itself.
    const launch = ERIS_BIN === null ? [OLD_BASH, ERIS] : [ERIS];
    const r = spawnSync(launch[0]!, [...launch.slice(1), "completion", "bash"], { env: { PATH: path, HOME: home, ...oracleEnv() }, encoding: "utf8" });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    expect(r.stdout).toContain("complete -F _eris_completions eris");
    writeFileSync(join(tmp, "no-yq.bash"), r.stdout);
    expect(spawnSync(OLD_BASH, ["-n", join(tmp, "no-yq.bash")]).status).toBe(0);
  });

  it("no shell prints the usage on stdout and exits 0; an unknown shell is refused with nothing on stdout", () => {
    /** When the dispatcher swaps streams or exit codes, `source <(eris completion fish)` silently sources an error message. */
    const usage = spawnSync(ERIS, ["completion"], { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
    expect(usage.status).toBe(0);
    expect(usage.stdout).toContain("Usage: eris completion <shell>");
    expect(usage.stdout).toContain("zsh");
    const fish = spawnSync(ERIS, ["completion", "fish"], { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
    expect({ status: fish.status, stdout: fish.stdout, stderr: fish.stderr }).toEqual({
      status: 1,
      stdout: "",
      stderr: "ERROR Unknown completion shell: fish (supported: bash, zsh)\n",
    });
    const extra = spawnSync(ERIS, ["completion", "bash", "extra"], { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
    expect({ status: extra.status, stdout: extra.stdout, stderr: extra.stderr }).toEqual({
      status: 1,
      stdout: "",
      stderr: "ERROR Unexpected arg 'extra' (usage: eris completion bash)\n",
    });
    const help = spawnSync(ERIS, ["completion", "zsh", "--help"], { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: eris completion zsh");
    expect(help.stdout).not.toContain("compdef");
  });

  it.skipIf(checkoutOnly("corrupts files in a copy of the checkout's tree; a binary's modules are fixed at build"))("emission is unaffected by broken siblings: every other TS verb and every plugin's handler code corrupt", () => {
    /** When emission imports (or sources) any other verb, a file mid-edit breaks every login shell and leaks parser errors into unrelated tools. */
    const tree = join(tmp, "tree");
    for (const part of ["eris", "src", "ts", "plugins", "package.json"]) {
      if (existsSync(join(REPO, part))) cpSync(join(REPO, part), join(tree, part), { recursive: true });
    }
    if (!existsSync(join(tree, "node_modules"))) symlinkSync(join(REPO, "node_modules"), join(tree, "node_modules"));
    const run = (...argv: string[]) => spawnSync(join(tree, "eris"), argv, { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
    const good = run("completion", "bash");
    expect({ status: good.status, stderr: good.stderr }).toEqual({ status: 0, stderr: "" });
    // The control: before the corruption, a sibling verb runs in this tree.
    expect(run("yak", "--help").status).toBe(0);

    const corrupt = (dir: string, ext: string, skip: (p: string) => boolean): number => {
      let n = 0;
      for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
        const p = join(e.parentPath, e.name);
        if (!e.isFile() || !p.endsWith(ext) || skip(p)) continue;
        writeFileSync(p, "<<<<<<< HEAD\nexport const = ;\nfoo() {\n");
        n++;
      }
      return n;
    };
    const verbs = join(tree, "src", "cli", "commands");
    expect(corrupt(verbs, ".ts", (p) => p === join(verbs, "completion.ts") || p.startsWith(join(verbs, "completion") + "/"))).toBeGreaterThan(0);
    // A plugin's manifest is read on every command line by design (docs/dev/PLUGINS.md); everything behind its handler thunk is not.
    expect(corrupt(join(tree, "plugins"), ".ts", (p) => p.endsWith("/index.ts"))).toBeGreaterThan(5);

    const bad = run("completion", "bash");
    expect({ status: bad.status, stderr: bad.stderr, same: bad.stdout === good.stdout }).toEqual({ status: 0, stderr: "", same: true });
    // The corruption is real: a sibling verb now fails to load.
    const yak = run("yak", "--help");
    expect(yak.status).not.toBe(0);
    expect(yak.stderr).toContain("Unexpected <<");
  });
});

describe("the emitted scripts", () => {
  it("bash parses under /bin/bash -n, and both scripts register the completion function", () => {
    /** When the generated tree or the engine text emits a syntax error, the shell rc that sources it errors on every start. */
    const b = spawnSync(OLD_BASH, ["-n", bashScript], { encoding: "utf8" });
    expect({ status: b.status, stderr: b.stderr }).toEqual({ status: 0, stderr: "" });
    for (const s of [bashScript, zshScript]) expect(readFileSync(s, "utf8")).toContain("complete -F _eris_completions eris");
    expect(readFileSync(zshScript, "utf8")).toContain("bashcompinit");
  });

  it.skipIf(!HAS_ZSH)("zsh parses the zsh script under zsh -n", () => {
    /** When the zsh prologue or the shared body stops parsing in zsh, every zsh start that sources it errors. */
    const z = spawnSync("zsh", ["-n", zshScript], { encoding: "utf8" });
    expect({ status: z.status, stderr: z.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("holds no bash-4-ism and names no network client or substrate", () => {
    /** When a bash-4 construct reaches the engine, macOS /bin/bash breaks on a path the drives below do not press; when a network name appears, a tab press could reach the plane. */
    const text = readFileSync(bashScript, "utf8");
    expect(text).toContain("_eris_completions()");
    expect(text).not.toMatch(/mapfile|declare -A|\$\{[A-Za-z_]+,,/);
    expect(text).not.toMatch(/curl|wget|https?:\/\//);
  });
});

describe("tab presses: the tree from the registry", () => {
  it("completes the groups at the first word, and a prefix narrows them", () => {
    /** When the generated group list drops a verb, `eris <TAB>` stops offering it. */
    const all = press(["eris", ""]);
    expect(all).toEqual(expect.arrayContaining(["completion", "yak", "--help"]));
    expect(press(["eris", "co"])).toEqual(["completion"]);
    expect(press(["eris", "y"])).toEqual(["yak"]);
  });

  it("yak issue --<TAB> offers exactly the flags its row declares", () => {
    /** When flags are looked up per group instead of per verb, a verb completes only --help or offers a flag that fails. */
    expect(sorted(press(["eris", "yak", "issue", "--"]))).toEqual([
      "--body",
      "--body-file",
      "--evidence",
      "--evidence-file",
      "--help",
      "--no-redact",
      "--repo",
      "--repro",
      "--summary",
    ]);
    expect(press(["eris", "completion", "bash", "--"])).toEqual(["--help"]);
  });

  it("a group with no verb typed yet completes its flags", () => {
    /** When the flag fallback breaks, `eris yak --<TAB>` (no verb typed) offers nothing. */
    expect(press(["eris", "yak", "--"])).toEqual(expect.arrayContaining(["--summary", "--no-redact", "--help"]));
    expect(press(["eris", "completion", "--"])).toEqual(["--help"]);
  });

  it("a group <TAB> offers its subs", () => {
    /** When a registry level is dropped, the second word of a group command completes nothing. */
    expect(sorted(press(["eris", "yak", ""]))).toEqual(["fatal", "issue", "suggest"]);
    expect(sorted(press(["eris", "completion", ""]))).toEqual(["bash", "zsh"]);
  });

  it("a tab press spawns no network client and no eris", () => {
    /** When the engine reaches for eris, curl or bun, every tab press can hit the network. */
    writeFileSync(record, "");
    press(["eris", ""]);
    press(["eris", "yak", "issue", "--"]);
    press(["eris", "yak", "issue", "--summary", "x", ""]);
    press(["eris", "completion", ""]);
    expect(readFileSync(record, "utf8")).toBe("");
  });
});

describe("the emitter: one registry edit is the whole change", () => {
  const b = (name: FlagName) => ({ name, takesValue: false });
  const v = (name: FlagName) => ({ name, takesValue: true });
  const f = (name: FlagName) => ({ name, takesValue: true, file: true });
  const reg: Record<string, Row> = {
    ...REGISTRY,
    frob: { impl: "ts", summary: "test verb", flags: [v("--zing"), f("--manifest")] },
    "frob zap": { summary: "test sub", flags: [b("--zoom")] },
    "frob zap deep": { summary: "test nested sub" },
    plain: { impl: "ts", summary: "test verb with operands and no subs", flags: [v("--level"), b("--quiet")], complete: [["alpha", "beta"], ["on", "off"], ["@file"]] },
  };

  it("a registry-only verb, sub, nested sub and flag complete in the emitted bash", () => {
    /** When the emitter reads anything but the registry it is given, a new verb needs a second edit to complete. */
    const script = join(tmp, "injected.bash");
    writeFileSync(script, emitScript("bash", reg));
    expect(press(["eris", "fro"], { script })).toEqual(["frob"]);
    expect(press(["eris", "frob", ""], { script })).toEqual(["zap"]);
    expect(press(["eris", "frob", "zap", ""], { script })).toEqual(["deep"]);
    expect(sorted(press(["eris", "frob", "zap", "--"], { script }))).toEqual(["--help", "--zoom"]);
    expect(press(["eris", "frob", "--zing", ""], { script })).toEqual([]);
    expect(press(["eris", "fro"])).toEqual([]);
  });

  it("a positional slot completes its words, and flags and their values are skipped when counting positionals", () => {
    /** When the value of a value flag is counted as a positional, every later slot completes the wrong domain. */
    const script = join(tmp, "slots.bash");
    writeFileSync(script, emitScript("bash", reg));
    expect(press(["eris", "plain", "--level", ""], { script })).toEqual([]);
    expect(sorted(press(["eris", "plain", "--level", "3", "--quiet", ""], { script }))).toEqual(["alpha", "beta"]);
    expect(sorted(press(["eris", "plain", "alpha", ""], { script }))).toEqual(["off", "on"]);
    expect(press(["eris", "plain", "alpha", "on", "./er"], { script, cwd: REPO })).toContain("./eris");
    expect(press(["eris", "plain", "alpha", "on", "x", ""], { script })).toEqual([]);
  });

  /** A domain whose words depend on the word typed in slot 0, shared by two rows. */
  const COLOR: CompletionDomain = {
    domain: "@color",
    helper: `# The tone typed in slot 0 picks the colours.
__eris_dom_color() {
  case "\${1:-}" in
    warm) echo "red orange" ;;
    *) echo "blue green" ;;
  esac
}
`,
  };
  const painted: Record<string, Row> = {
    paint: { impl: "ts", summary: "test verb whose second slot is a domain", complete: [["warm", "cool"], [COLOR, "clear"]] },
    tint: { impl: "ts", summary: "test verb sharing the domain", complete: [[COLOR]] },
  };

  it("a slot's domain completes the words its helper prints, given the words typed in the earlier slots", () => {
    /** When the emitter drops a domain's helper or calls it without the earlier slots' words, a slot whose words only the distribution can list (names for the env typed first) completes nothing or the wrong set: observed at a tab press on the emitted bash. */
    const script = join(tmp, "domain.bash");
    const text = emitScript("bash", { ...reg, ...painted });
    writeFileSync(script, text);
    expect(sorted(press(["eris", "paint", ""], { script }))).toEqual(["cool", "warm"]);
    expect(sorted(press(["eris", "paint", "warm", ""], { script }))).toEqual(["clear", "orange", "red"]);
    expect(sorted(press(["eris", "paint", "cool", ""], { script }))).toEqual(["blue", "clear", "green"]);
    expect(sorted(press(["eris", "tint", ""], { script }))).toEqual(["blue", "green"]);
    // Two rows, one domain: its helper is emitted once.
    expect(text.split("__eris_dom_color() {").length - 1).toBe(1);
    // PAIRED: a registry with no domain emits no helper text at all.
    expect(emitScript("bash", reg)).not.toContain("__eris_dom_");
  });

  it("the file flags the yak plugin declares complete file names in the real script", () => {
    /** When a row loses its `file` marker, or the composed registry never reaches the emitter, a file flag stops completing file names and nothing else fails. */
    for (const argv of [
      ["eris", "yak", "issue", "--body-file", "./er"],
      ["eris", "yak", "issue", "--evidence-file", "./er"],
    ]) expect({ argv, files: press(argv, { cwd: REPO }) }).toEqual({ argv, files: expect.arrayContaining(["./eris"]) });
  });

  it("a flag the rows mark `file` completes file names, and an unmarked value flag does not", () => {
    /** When the emitter takes its file flags from a list of its own instead of the rows it is given, a flag a plugin declares with `file: true` completes nothing: observed at a tab press on the emitted bash. */
    const script = join(tmp, "file-flag.bash");
    writeFileSync(script, emitScript("bash", reg));
    expect(press(["eris", "frob", "--manifest", "./er"], { script, cwd: REPO })).toContain("./eris");
    expect(press(["eris", "frob", "--zing", "./er"], { script, cwd: REPO })).toEqual([]);
  });

  it.skipIf(!HAS_ZSH)("the same registry edit completes in the emitted zsh, loaded through a real compinit + bashcompinit", () => {
    /** When the zsh wrapper diverges from the shared body, zsh users lose a verb bash users have. */
    const script = join(tmp, "injected.zsh");
    writeFileSync(script, emitScript("zsh", { ...reg, ...painted }));
    expect(spawnSync("zsh", ["-n", script]).status).toBe(0);
    const r = spawnSync(
      "zsh",
      [
        "-fc",
        `autoload -U +X compinit && compinit -u -d '${tmp}/zcompdump'
source '${script}'
setopt ksharrays
COMP_WORDS=(eris frob ''); COMP_CWORD=2; _eris_completions; print -r -- "\${COMPREPLY[@]}"
COMP_WORDS=(eris frob zap --); COMP_CWORD=3; _eris_completions; print -r -- "\${COMPREPLY[@]}"
COMP_WORDS=(eris plain ''); COMP_CWORD=2; _eris_completions; print -r -- "\${COMPREPLY[@]}"
COMP_WORDS=(eris paint warm ''); COMP_CWORD=3; _eris_completions; print -r -- "\${COMPREPLY[@]}"`,
      ],
      { cwd: work, env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" },
    );
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    const [verbs = "", flags = "", words = "", domain = ""] = r.stdout.split("\n");
    expect(verbs).toBe("zap");
    expect(flags.split(" ").sort()).toEqual(["--help", "--zoom"]);
    expect(words.split(" ").sort()).toEqual(["alpha", "beta"]);
    expect(domain.split(" ").sort()).toEqual(["clear", "orange", "red"]);
  });
});
