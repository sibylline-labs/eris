/**
 * The router table and the global pre-pass.
 *
 * The table is derived from src/cli/registry.ts: every group is `ts`, and a
 * verb the table does not know is `unknown` (the router's own
 * "Unknown command" refusal). The TS pre-pass (src/cli/output.ts) must accept,
 * refuse and strip exactly as the Bash pre-pass it replaced did, whose
 * answers are frozen in tests/fixtures/yaml-parity/oracle-goldens.json.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { GlobalFlagError, locateVerb, parseGlobal } from "../src/cli/args";
import { implOf, JSON_SURFACES, REGISTRY, route, subsOf, TABLE, UNSUPPORTED_FIX } from "./helpers/build-cli";
import { bashRepo } from "./helpers/frozen-oracle";
import { ERIS } from "./helpers/blackbox";

const REPO = resolve(import.meta.dir, "..");

describe("router table", () => {
  it("every group is ts", () => {
    /** When a group routes to anything else, it reaches nothing: there is no Bash dispatcher left. */
    const groups = Object.keys(TABLE).filter((k) => !k.includes(" "));
    for (const g of groups) expect({ g, impl: TABLE[g] }).toEqual({ g, impl: "ts" });
    expect(groups).toEqual(expect.arrayContaining(["", "-h", "--help", "--version", "completion", "update", "yak"]));
  });

  it("the table derived from the registry is the routing table it replaced", () => {
    /** When the derivation drops, adds or flips a row, a verb silently changes implementation. A deliberate flip edits its rows here. */
    expect(TABLE).toEqual({
      "": "ts",
      "-h": "ts",
      "--help": "ts",
      "--version": "ts",
      completion: "ts",
      "completion bash": "ts",
      "completion zsh": "ts",
      login: "ts",
      logout: "ts",
      socrates: "ts",
      "socrates classify": "ts",
      "socrates submit": "ts",
      update: "ts",
      yak: "ts",
      "yak fatal": "ts",
      "yak issue": "ts",
      "yak suggest": "ts",
    });
  });

  it("every registry row, nested ones included, routes to the implementation the registry gives it", () => {
    /** The router reads two words: a nested row naming its own impl, or a sub the derivation dropped, would claim an impl route() never picks. */
    for (const path of Object.keys(REGISTRY)) {
      const kind = route(path.split(" ")).kind;
      expect({ path, kind }).toEqual({ path, kind: implOf(path) });
    }
  });

  it("the whole yak group runs in TypeScript, its usage and unknown subs included", () => {
    /** When a yak sub routes anywhere else, it reaches no dispatcher at all. */
    for (const sub of ["issue", "suggest", "fatal", "--help", "frobnicate"]) {
      expect(route(["yak", sub])).toEqual({ kind: "ts", verb: "yak" });
    }
    expect(route(["yak"])).toEqual({ kind: "ts", verb: "yak" });
    expect(route(["--output", "json", "yak", "issue"])).toEqual({ kind: "ts", verb: "yak" });
  });

  it("the whole completion group runs in TypeScript, its usage and unknown subs included", () => {
    /** When a sub stops routing to the group's dispatcher, it is refused as an unknown command. */
    for (const sub of ["bash", "zsh", "--help", "frobnicate"]) {
      expect(route(["completion", sub])).toEqual({ kind: "ts", verb: "completion" });
    }
    expect(route(["completion"])).toEqual({ kind: "ts", verb: "completion" });
    expect(route(["--output", "json", "completion", "bash"])).toEqual({ kind: "ts", verb: "completion" });
  });
});

describe("route()", () => {
  const table = { ...TABLE, audit: "ts" as const, config: "ts" as const, "config show": "ts" as const, migrate: "ts" as const };

  it("the longer key wins, and an unlisted verb is unknown", () => {
    /** When an unlisted verb routes to a handler, `eris confgi sync prod` runs something other than a refusal. */
    expect(route(["config", "show", "dev", "K"], table)).toEqual({ kind: "ts", verb: "config" });
    // A group's TS dispatcher owns its own unknown-sub refusal.
    expect(route(["config", "frobnicate", "dev"], table)).toEqual({ kind: "ts", verb: "config" });
    expect(route(["migrate", "frobnicate"], table)).toEqual({ kind: "ts", verb: "migrate" });
    expect(route(["frobnicate"], table)).toEqual({ kind: "unknown", verb: "frobnicate" });
    expect(route(["--output", "json", "frobnicate"], table)).toEqual({ kind: "unknown", verb: "frobnicate" });
    // The bare program and the top-level usage are TS.
    expect(route([], table)).toEqual({ kind: "ts", verb: "" });
    expect(route(["--help"], table)).toEqual({ kind: "ts", verb: "--help" });
  });

  it("finds the verb past the global flag, wherever it sits", () => {
    expect(route(["--output", "json", "audit", "x"], table)).toEqual({ kind: "ts", verb: "audit" });
    expect(route(["--output=text", "audit"], table)).toEqual({ kind: "ts", verb: "audit" });
    expect(route(["--", "audit"], table)).toEqual({ kind: "ts", verb: "audit" });
    expect(locateVerb(["x", "--", "--output", "json"])).toEqual(["x", "--output", "json"]);
  });
});

describe("global pre-pass matches the frozen Bash answers", () => {
  // The recorded script, verbatim: it is part of each golden's key.
  const BASH_PARSE = `source lib/output.sh
output::parse_global "$@"
printf '%s\\n' "$ERIS_OUTPUT"
printf '<%s>' "\${ERIS_ARGV[@]}"`;

  it("parses, strips and refuses the flag identically", () => {
    const cases: string[][] = [
      [],
      ["audit", "x"],
      ["--output", "json", "node", "show"],
      ["node", "show", "--output=text"],
      ["--output", "text", "--output", "json", "vars"],
      ["--output=bogus", "a"],
      ["--output", "bogus\u0007x", "a"],
      ["--output", "", "a"],
      ["a", "--output"],
      ["--output=", "a"],
      ["a", "--", "--output", "json"],
      ["--", "--"],
    ];
    for (const argv of cases) {
      // The Bash pre-pass's answer, frozen (tests/helpers/frozen-oracle.ts).
      const b = bashRepo(BASH_PARSE, argv);
      let ts: { status: number; stdout: string; stderr: string };
      try {
        const p = parseGlobal(argv, REPO);
        ts = { status: 0, stdout: `${p.format}\n${p.argv.map((a) => `<${a}>`).join("") || "<>"}`, stderr: "" };
      } catch (e) {
        if (!(e instanceof GlobalFlagError)) throw e;
        ts = { status: 1, stdout: "", stderr: e.block };
      }
      expect({ argv, ...ts }).toEqual({ argv, status: b.status ?? -1, stdout: b.stdout, stderr: b.stderr });
    }
  });


});

/** Every `--output json` surface in the registry, as `group` or `group sub`. */
function jsonSurfaceNames(): Set<string> {
  return new Set(Object.entries(JSON_SURFACES).flatMap(([g, s]) => (s === true ? [g] : s.map((x) => `${g} ${x}`))));
}

describe("the --output json surfaces, from the registry", () => {
  it("the allow-list derived from the registry's json rows is the list it replaced", () => {
    /** When a json row is dropped or added by mistake, a machine caller is refused (or handed human text) on a surface that changed silently. */
    expect(JSON_SURFACES).toEqual({
      "--version": true,
      socrates: ["submit", "classify"],
      update: true,
      yak: ["fatal", "issue", "suggest"],
    });
  });

  it("the refusal's fix text names every json surface, and names nothing that is not one", () => {
    /** The fix text is prose; when a json row is added or removed it must be edited too, or the refusal sends callers to the wrong surfaces. */
    const named = new Set<string>();
    for (const m of UNSUPPORTED_FIX.matchAll(/^  eris ([a-z-]+)(?: (\S+))?/gm)) {
      const g = m[1]!;
      const subs = (m[2] ?? "").split("|").filter((s) => subsOf(g).includes(s));
      if (subs.length === 0) named.add(g);
      for (const s of subs) named.add(`${g} ${s}`);
    }
    const surfaces = jsonSurfaceNames();
    expect([...named].sort()).toEqual([...surfaces].sort());
    expect(surfaces.size).toBeGreaterThan(0);
  });

  it("`eris --help` names every json surface, and names nothing that is not one", () => {
    /** The help block is prose (src/cli/commands/usage.ts); when a json row is added or removed it must be edited too, or a machine caller reading `eris --help` is told the wrong surfaces. */
    const r = spawnSync(ERIS, ["--help"], {
      cwd: REPO,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const listed = /accepted by: (.+?)\. Any other verb refuses/.exec(r.stdout.replace(/\s+/g, " "))?.[1];
    expect(listed).toBeDefined();
    const named = new Set<string>();
    for (const item of listed!.split(", ")) {
      const [g = "", subs] = item.split(" ");
      if (subs === undefined) named.add(g);
      else for (const s of subs.split("|")) named.add(`${g} ${s}`);
    }
    expect([...named].sort()).toEqual([...jsonSurfaceNames()].sort());
  });
});
