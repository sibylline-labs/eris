/**
 * `eris/outbound-scan`: the vendored gitleaks scan and the redaction pass it
 * runs before. Every secret-shaped value is assembled at runtime, so no
 * literal here trips a secret scanner.
 */

import { describe, expect, it } from "bun:test";
import { GITLEAKS_RULES } from "../packages/outbound-scan/src/gitleaks-rules";
import { prepareOutbound, REDACTION_CLASSES, scanSecrets, scanStrings } from "../packages/outbound-scan/src/index";
import { translate } from "../scripts/vendor-gitleaks";

const fill = (n: number, alphabet: string) => alphabet.repeat(Math.ceil(n / alphabet.length)).slice(0, n);
export const GHP = ["ghp", "Zq8Lr2Vm5Nx7Pk1Ws4Ty6Hb9Jd3Gf0Ca8Ee2"].join("_");
const SECRETS: Record<string, string> = {
  "github-pat": GHP,
  "github-fine-grained-pat": ["github", "pat", `11ABCDEFG0${fill(72, "Zq8Lr2Vm5N")}`].join("_"),
  "aws-access-token": ["AKIA", "Q3VZ7XK2M4N6P5R2"].join(""),
  "slack-bot-token": ["xoxb", "1234567890", "1234567890123", "Zq8Lr2Vm5Nx7Pk1Ws4Ty6Hb9"].join("-"),
  "private-key": `-----BEGIN RSA ${"PRIVATE"} KEY-----\n${fill(200, "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0t")}\n-----END RSA PRIVATE KEY-----`,
  "stripe-access-token": ["sk", "live", "Zq8Lr2Vm5Nx7Pk1Ws4Ty6Hb9"].join("_"),
};

describe("the vendored gitleaks rules", () => {
  it("all compile under this bun, with no lookbehind", () => {
    /** When the generator lets through a pattern this bun cannot compile, the scan throws on the first input holding its keyword; a lookbehind makes the whole pattern interpreted, ten times slower (rules/regex-no-lookbehind.yml). Observed at every generated rule. */
    expect(GITLEAKS_RULES.length).toBeGreaterThan(200);
    for (const r of GITLEAKS_RULES) {
      expect({ id: r.id, lookbehind: /\(\?<[=!]/.test(r.source) }).toEqual({ id: r.id, lookbehind: false });
      expect(() => new RegExp(r.source, r.flags)).not.toThrow();
    }
  });

  it("translates RE2's inline flags to the span RE2 applies them to", () => {
    /** When a mid-pattern `(?i)` is dropped or widened to the whole pattern, a rule misses a mixed-case secret or blocks text it should not; observed at the translation of each shape. */
    expect(translate("(?i)abc")).toEqual({ source: "abc", flags: "i" });
    expect(translate("ab(?i)cd")).toEqual({ source: "ab(?i:cd)", flags: "" });
    expect(translate("x(?:a(?i)b|c)d")).toEqual({ source: "x(?:a(?i:b|c))d", flags: "" });
    expect(translate("(?P<k>[[:alnum:]]+)\\z")).toEqual({ source: "(?<k>[a-zA-Z0-9]+)$", flags: "" });
  });
});

describe("the secret scan (escape catalogue)", () => {
  it("finds each gitleaks-shaped secret, alone, mid-sentence, quoted, in a URL and at the field's end", () => {
    /** When a shape slips past the scan, `eris socrates` sends a live credential to the endpoint; observed at the rule ids each shape fires. */
    for (const [rule, secret] of Object.entries(SECRETS)) {
      for (const text of [secret, `we decided ${secret} today`, `\`${secret}\``, `the end: ${secret}`]) {
        expect({ rule, text, fired: scanSecrets({ f: text }).map((h) => h.rule) }).toMatchObject({ rule, text, fired: expect.arrayContaining([rule]) });
      }
    }
    expect(scanSecrets({ source: `https://x.test/p?t=${GHP}` })).toEqual([{ field: "source", rule: "github-pat" }]);
  });

  it("matches a case-insensitive rule in mixed case", () => {
    /** When the `i` flag is lost in translation, a rule written `(?i)` misses an upper-case secret; observed with a rule whose pattern starts `(?i)`, given upper case. */
    const rule = GITLEAKS_RULES.find((r) => r.id === "digitalocean-refresh-token");
    expect(rule?.flags).toBe("i");
    const secret = ["DOR", "V1", fill(64, "0A1B2C3D4E5F6789")].join("_");
    expect(scanSecrets({ f: `${secret} ` }).map((h) => h.rule)).toContain("digitalocean-refresh-token");
  });

  it("flags none of: prose about keys, a redaction marker, a PR URL, a commit SHA, our own sib_ token", () => {
    /** When ordinary decision text trips a rule nothing can override, a candidate can never be submitted; observed at the hits for each. */
    const sib = ["sib", "01HZX3K5Q8W2N4R6T8V0Y2B4D6", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
    for (const text of [
      "rotate the api key and the token when the secret leaks",
      "«redacted:github-token»",
      "https://github.com/o/r/pull/21 at b5cf3ba0b86f4520dea57c80a137c1928005b753",
      `ERIS_TOKEN=${sib}`,
    ]) {
      expect({ text, hits: scanSecrets({ f: text }) }).toEqual({ text, hits: [] });
    }
  });

  it("walks every string leaf of a request body and names its path", () => {
    /** When the boundary guard reads only named fields, a field added to the body later is sent unscanned; observed at a nested leaf. */
    expect(scanStrings({ schema_version: "1.0.0", candidate: { evidence: [{ text: GHP }] } })).toEqual([{ field: "candidate.evidence.0.text", rule: "github-pat" }]);
  });
});

describe("prepareOutbound", () => {
  it("refuses a secret before any redaction runs, whichever classes are allowed", () => {
    /** When an override reaches the secret scan, `--allow-redaction` sends a gitleaks-shaped token; observed with every class allowed. */
    expect(prepareOutbound({ statement: `x ${GHP}` }, new Set(REDACTION_CLASSES))).toEqual({ kind: "secret", hits: [{ field: "statement", rule: "github-pat" }] });
  });

  it("redacts our classes, and leaves an allowed class's text as written, reporting it as an override", () => {
    /** When an allowed class is still redacted the override is dead; when it is not reported, no vendor yak is filed for it. Observed at the fields and the override list. */
    const sib = ["sib", "01HZX3K5Q8W2N4R6T8V0Y2B4D6", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
    const fields = { title: "t", statement: `token ${sib}`, project: undefined };
    expect(prepareOutbound(fields)).toEqual({
      kind: "clean",
      fields: { title: "t", statement: "token «redacted:sib-token»", project: undefined },
      redactions: { count: 1, classes: ["sib-token"] },
      overrides: [],
    });
    expect(prepareOutbound(fields, new Set(["sib-token"] as const))).toEqual({
      kind: "clean",
      fields,
      redactions: { count: 0, classes: [] },
      overrides: [{ class: "sib-token", field: "statement", count: 1 }],
    });
  });
});
