/**
 * `~/.eris/settings.json` — fills unset variables, the caller's environment wins,
 * and nothing about the file can stop a command (fail-open).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySettings, readSettings, settingsPath } from "../src/runtime/settings";
import { ERIS, oracleEnv } from "./helpers/blackbox";

let tmp: string;
beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "eris-settings-")));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function home(name: string, body?: string): string {
  const h = join(tmp, name);
  mkdirSync(join(h, ".eris"), { recursive: true });
  if (body !== undefined) writeFileSync(join(h, ".eris", "settings.json"), body);
  return h;
}

function apply(env: Record<string, string | undefined>): { env: Record<string, string | undefined>; warnings: string[] } {
  const warnings: string[] = [];
  applySettings(env, (m) => warnings.push(m));
  return { env, warnings };
}

describe("applySettings", () => {
  it("fills an unset variable and leaves a set one — an empty one included — alone", () => {
    const h = home("fill", JSON.stringify({ env: { WIDGET_HOME: "/from/settings", A: "a", B: "b" } }));
    const { env, warnings } = apply({ HOME: h, A: "caller", B: "" });
    expect(env.WIDGET_HOME).toBe("/from/settings");
    expect(env.A).toBe("caller");
    expect(env.B).toBe("");
    expect(warnings).toEqual([]);
  });

  it("is silent with no file, and with a file carrying no env", () => {
    expect(apply({ HOME: home("none") })).toEqual({ env: { HOME: join(tmp, "none") }, warnings: [] });
    const h = home("noenv", "{}");
    expect(apply({ HOME: h })).toEqual({ env: { HOME: h }, warnings: [] });
  });

  it("warns once and applies nothing for malformed JSON, a non-object, or a non-object env", () => {
    for (const [name, body] of [["bad", "{nope"], ["arr", "[]"], ["envarr", '{"env":["X"]}']] as const) {
      const h = home(name, body);
      const { env, warnings } = apply({ HOME: h });
      expect(env).toEqual({ HOME: h });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(settingsPath({ HOME: h }));
    }
  });

  it("skips non-strings and the denied names, keeping the rest", () => {
    const h = home("deny", JSON.stringify({
      env: { BUN_CONFIG_VERBOSE_FETCH: "curl", _ERIS_SHIM_X: "1", N: 3, OK: "yes" },
      unset: ["_ERIS_SHIM_DIR", "GONE"],
    }));
    const warnings: string[] = [];
    const s = readSettings(settingsPath({ HOME: h }), (m) => warnings.push(m));
    expect(s.env).toEqual({ OK: "yes" });
    expect(s.unset).toEqual(["GONE"]);
    expect(warnings).toHaveLength(4);
    expect(warnings.join("\n")).toContain("env.BUN_CONFIG_VERBOSE_FETCH is not settable here");
    expect(warnings.join("\n")).toContain("env.N is not a string");
    expect(warnings.join("\n")).toContain("unset _ERIS_SHIM_DIR is not allowed here");
  });

  it("source + env + unset reproduce `set -a; source f; env -u X NAME=$REF …`", () => {
    const h = home("source");
    const creds = join(h, "creds");
    writeFileSync(creds, [
      "# a comment",
      "",
      "API_A_TOKEN=tok-a",
      "export API_B_TOKEN='tok b $NOT_EXPANDED'",
      'QUOTED="q-${API_A_TOKEN}"',
      "TRAILING=v # comment",
      "SERVICE_READ_TOKEN=from-file",
      "BUN_CONFIG_VERBOSE_FETCH=curl",
      "not a line",
      "",
    ].join("\n"));
    writeFileSync(join(h, ".eris", "settings.json"), JSON.stringify({
      source: ["~/creds", "~/missing"],
      env: { API_TOKEN: "${API_A_TOKEN}", API_URL: "https://settings", EMPTY_REF: "${NOPE}" },
      unset: ["SERVICE_READ_TOKEN"],
    }));
    const { env, warnings } = apply({ HOME: h, API_URL: "https://caller", SERVICE_READ_TOKEN: "from-profile" });
    expect(env).toEqual({
      HOME: h,
      API_URL: "https://caller",
      API_A_TOKEN: "tok-a",
      API_B_TOKEN: "tok b $NOT_EXPANDED",
      QUOTED: "q-tok-a",
      TRAILING: "v",
      API_TOKEN: "tok-a",
      EMPTY_REF: "",
    });
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toContain(`${creds}: BUN_CONFIG_VERBOSE_FETCH is not settable here`);
    expect(warnings.join("\n")).toContain(`${creds}:9: not a KEY=value line`);
    expect(warnings.join("\n")).toContain(`source ${join(h, "missing")}: ENOENT`);
    // No warning carries a value.
    expect(warnings.join("\n")).not.toContain("tok-a");
  });

  it("a caller variable is visible to ${} expansion", () => {
    const h = home("ref", JSON.stringify({ env: { API_TOKEN: "${API_EDITOR_TOKEN}" } }));
    expect(apply({ HOME: h, API_EDITOR_TOKEN: "m" }).env.API_TOKEN).toBe("m");
  });

  it("an unset name expands to empty, even when it names an Object.prototype member", () => {
    /** When a reference is looked up as env[NAME], `${constructor}` and `${__proto__}` resolve to inherited objects and expand to function source or "[object Object]" instead of "" — observed at applySettings's expansion. */
    const h = home(
      "proto-ref",
      JSON.stringify({ env: { A: "${constructor}", B: "$toString", C: "${__proto__}", D: "${OWN}" } }),
    );
    const { env } = apply({ HOME: h, OWN: "x" });
    expect({ A: env.A, B: env.B, C: env.C, D: env.D }).toEqual({ A: "", B: "", C: "", D: "x" });
  });

  it("warns on an unreadable file rather than failing", () => {
    if (process.getuid?.() === 0) return; // root reads a 000 file
    const h = home("unreadable", '{"env":{"X":"1"}}');
    chmodSync(join(h, ".eris", "settings.json"), 0o000);
    const { env, warnings } = apply({ HOME: h });
    expect(env.X).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
});

describe("through the entrypoint", () => {
  /** A yak report from `h`, whose settings point it at one loopback Actor (and, with `callerUrl`, the caller's environment at another): what each received. */
  async function report(h: string, callerUrl = false): Promise<{ status: number; stderr: string; settings: string[]; caller: string[] }> {
    const seen = { settings: [] as string[], caller: [] as string[] };
    const actor = (into: string[]) =>
      Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (into.push(req.headers.get("authorization") ?? ""), new Response("{}", { status: 503 })) });
    const fromSettings = actor(seen.settings);
    const fromCaller = actor(seen.caller);
    try {
      writeFileSync(join(h, ".eris", "settings.json"), JSON.stringify({ env: { ERIS_YAKS_URL: `http://127.0.0.1:${fromSettings.port}`, ERIS_YAKS_TOKEN: "from-settings" } }));
      const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: h, ...oracleEnv() };
      if (callerUrl) env.ERIS_YAKS_URL = `http://127.0.0.1:${fromCaller.port}`;
      const p = Bun.spawn([ERIS, "yak", "issue", "--summary", "s", "--body", "b"], { cwd: h, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stderr, status] = await Promise.all([new Response(p.stderr).text(), p.exited]);
      return { status, stderr, ...seen };
    } finally {
      fromSettings.stop(true);
      fromCaller.stop(true);
    }
  }

  it("fills the running verb's environment, and the caller's value beats it", async () => {
    /** When settings stop reaching the process before routing, a verb configured only in ~/.eris/settings.json runs unconfigured; when they beat the caller, an explicit variable is silently overridden — observed at which loopback Actor the report reached. */
    const filled = await report(home("e2e"));
    expect({ status: filled.status, settings: filled.settings, caller: filled.caller }).toEqual({ status: 0, settings: ["Bearer from-settings"], caller: [] });
    const beaten = await report(home("e2e-caller"), true);
    expect({ status: beaten.status, settings: beaten.settings, caller: beaten.caller }).toEqual({ status: 0, settings: [], caller: ["Bearer from-settings"] });
  }, 20_000);

  it("a malformed file warns and the command still runs", () => {
    /** When a bad settings file stops a command, one typo locks the operator out of every verb, the help that names the fix included. */
    const h = home("e2e-bad", "{nope");
    const r = spawnSync(ERIS, ["--help"], { cwd: h, env: { PATH: process.env.PATH ?? "", HOME: h, ...oracleEnv() }, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: eris");
    expect(r.stderr).toContain(`WARN ignoring ${join(h, ".eris", "settings.json")}: not valid JSON`);
  });
});
