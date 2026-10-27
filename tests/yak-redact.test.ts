/**
 * Tests for plugins/yak/yak-redact.ts — the Yak submission redaction pass.
 *
 * A pure text-transformation pass, applied to `summary` / `body` / `evidence`
 * before key derivation so the Actor's re-derived key agrees with
 * the client's. Every match becomes `«redacted:<class>»`; the count and class
 * breakdown are for stderr — this file only asserts the pure function's
 * contract (`text`, `counts`, `total`), never a rendering concern.
 *
 * TWO HALVES, and the second is the one that matters more:
 *
 *   1. POSITIVE — one realistic case per RedactionClass, asserting the secret
 *      material is gone from `text` AND `counts[class]` reflects it.
 *
 *   2. NEGATIVE — ordinary yak prose that must survive BYTE-IDENTICAL. A scrub
 *      that eats the report is worse than no scrub: the whole point of this
 *      pass is that an agent's honest description of what broke survives
 *      intact. This half is what stops a class regex from being "technically
 *      correct, practically useless."
 *
 * Plus: idempotence (the marker is never re-matched), and a ReDoS guard — this
 * runs on agent-authored text of arbitrary shape, so no class regex may carry
 * nested/ambiguous quantifiers that blow up on pathological input.
 */

import { describe, it, expect } from "bun:test";
import { redact, redactDeep, formatRedactionSummary, type RedactionClass, type RedactionResult } from "../plugins/yak/yak-redact";

// --- helpers -------------------------------------------------------------------

// Token-shaped fixtures are assembled at runtime, so the source holds no literal
// a secret scanner matches. Every value is invented to the class's shape, except
// AWS_KEY_ID and AWS_SECRET, which are AWS's own published documentation examples.
const PRIVATE_KEY_MARK = "PRIVATE" + " KEY-----";
const BEGIN_RSA = `-----BEGIN RSA ${PRIVATE_KEY_MARK}`;
const END_RSA = `-----END RSA ${PRIVATE_KEY_MARK}`;
const BEGIN_PK = `-----BEGIN ${PRIVATE_KEY_MARK}`;
const END_PK = `-----END ${PRIVATE_KEY_MARK}`;
const AWS_KEY_ID = "AKIA" + "IOSFODNN7EXAMPLE";
const GH_TOKEN = "ghp" + "_" + "0123456789abcdefghijABCDEFGHIJ012345";
const SLACK_TOKEN = "xoxb" + "-123456789012-123456789012-abcdefGHIJKLmnopQRSTuvwx";
const LIVE_SK = "sk_" + "live_abcdefghijklmnop";
const TEST_SK = "sk_" + "test_abcdefghijklmnop";
const GOOGLE_KEY = "AI" + "za" + "Example-Key_" + "Q".repeat(23);
const ANTHROPIC_KEY = "sk-" + "ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/" + "bPxRfiCYEXAMPLEKEY";
const AWS_SESSION = "IQoJb3JpZ2luX2Vj" + "EXAMPLEtoken";
/** A `sib_` service token is `sib_<26-char ULID>_<43-char base64url secret>`.
 *  Both parts are invented to that shape; the secret is sliced so its length is
 *  43 by construction. */
const SIB_ULID = "01HZXK3M5N7P9Q2R4S6T8V0WXY";
const SIB_SECRET = "ExampleSecret_notReal-0123456789abcdefghijklmnopqrstuvwxyz".slice(0, 43);
const sibToken = (secret: string = SIB_SECRET) => "sib" + "_" + SIB_ULID + "_" + secret;
const SIB_TOKEN = sibToken();
/** An sk- key 36 chars past `SK_KEY_RE`'s 120-char body cap, so that pass leaves a tail. */
const OVERLONG_SK = "sk-" + "proj-" + "Z".repeat(156);
/** Plaintext that must never survive after a marker. */
const TAIL = "PLAINTAILsecret";
/** An HS256 header, the payload {"sub":"example-user","name":"Example User"}, and an
 *  invented signature segment. */
const JWT =
  "ey" + "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "ey" + "JzdWIiOiJleGFtcGxlLXVzZXIiLCJuYW1lIjoiRXhhbXBsZSBVc2VyIn0." +
  "ExampleSignature_notAnHmac-0123456789abcd";

/** Every class present with a fresh zero, so a forgotten counts[x]++ shows up
 *  as a shape mismatch rather than a silently-absent key. */
const ALL_CLASSES: RedactionClass[] = [
  "pem",
  "jwt",
  "sib-token",
  "aws-key",
  "github-token",
  "slack-token",
  "google-api-key",
  "sk-key",
  "auth-header",
  "gcp-private-key",
  "conn-string",
  "assignment",
];

function assertZeroExcept(result: RedactionResult, ...classes: RedactionClass[]) {
  for (const c of ALL_CLASSES) {
    if (classes.includes(c)) continue;
    expect(result.counts[c]).toBe(0);
  }
}

// --- 1. positive: one case per class --------------------------------------------

describe("redact() — positive corpus, one class each", () => {
  it("when a PEM private-key block is present, it goes red — observed at redact().text", () => {
    const pem = [
      BEGIN_RSA,
      "MIIEpAIBAAKCAQEAexampleRsaBodyLineOneNotARealKey+0123456789/abcdef",
      "exampleRsaBodyLineTwoNotARealKey+ABCDEFGHIJKLMNOPQRSTUVWXYZ/0123",
      END_RSA,
    ].join("\n");
    const body = `see attached\n${pem}\nthanks`;
    const result = redact(body);
    expect(result.text).not.toContain("MIIEpAIBAAKCAQEA");
    expect(result.text).toContain("«redacted:pem»");
    expect(result.counts.pem).toBe(1);
    expect(result.total).toBe(1);
    assertZeroExcept(result, "pem");
  });

  it("when a JWT is present, it goes red — observed at redact().text", () => {
    const jwt = JWT;
    const result = redact(`the request carried ${jwt} on the wire`);
    expect(result.text).not.toContain(jwt);
    expect(result.text).toContain("«redacted:jwt»");
    expect(result.counts.jwt).toBe(1);
    assertZeroExcept(result, "jwt");
  });

  it("when a sib_ service token is present, it goes red — observed at redact().text", () => {
    const result = redact(`rotated ${SIB_TOKEN} twice today`);
    expect(result.text).toBe("rotated «redacted:sib-token» twice today");
    expect(result.counts["sib-token"]).toBe(1);
    expect(result.total).toBe(1);
    assertZeroExcept(result, "sib-token");
  });

  it("when a sib_ token is the value of a governed name, it is classified once as sib-token, not as assignment", () => {
    // The generic `assignment` pass would otherwise claim `ERIS_TOKEN=<value>`
    // and leave the more specific class uncounted.
    const result = redact(`ERIS_TOKEN=${SIB_TOKEN}`);
    expect(result.text).toBe("ERIS_TOKEN=«redacted:sib-token»");
    expect(result.counts["sib-token"]).toBe(1);
    assertZeroExcept(result, "sib-token");
  });

  it("when a sib_ token's secret embeds another class's shape, the whole token is redacted as sib-token", () => {
    // Pre-fix: the `sk-key` pass (`\bsk-` holds after the `-`) and the
    // `github-token` pass (no leading boundary) ran first, replaced only the
    // embedded run, and shipped `sib_<orgId>_<head>` in plaintext:
    // `sib_01HZ…_aaaaaaaa-«redacted:sk-key»`.
    const secrets: Array<[string, string]> = [
      ["an -sk- run followed by 20+ chars", "aaaaaaaa" + "-sk" + "-" + "B".repeat(31)],
      ["a ghp_ run", "abc" + GH_TOKEN],
    ];
    for (const [label, secret] of secrets) {
      expect(secret.length, label).toBe(43);
      const result = redact(`rotated ${sibToken(secret)} today`);
      expect(result.text, label).toBe("rotated «redacted:sib-token» today");
      expect(result.text, label).not.toContain(SIB_ULID);
      expect(result.text, label).not.toContain(secret.slice(0, 8));
      expect(result.counts["sib-token"], label).toBe(1);
      assertZeroExcept(result, "sib-token");
    }
  });

  it("when a sib_ token is lower-cased, the whole token is still redacted", () => {
    // A deliberate widening of the issuer's shape (see SIB_TOKEN_RE): an
    // upper-case-only ULID would leave a lower-cased paste, org id and all, in
    // the report.
    const token = "sib" + "_" + SIB_ULID.toLowerCase() + "_" + SIB_SECRET;
    const result = redact(`rotated ${token} today`);
    expect(result.text).toBe("rotated «redacted:sib-token» today");
    expect(result.counts["sib-token"]).toBe(1);
    assertZeroExcept(result, "sib-token");
  });

  it("when a sibdc_ device code is pasted, the whole code is redacted as sibdc-code, even when its secret embeds another class's shape", () => {
    // A device code is `sibdc_<8-char user code>_<43 base64url>`, and once its
    // login is approved it is the one thing that redeems the minted bearer, so a
    // yak that quotes `eris login` debug output would hand that bearer to whoever
    // polls first. Its secret can embed `-sk-` or `ghp_` (file header, reason 3).
    const secrets: Array<[string, string]> = [
      ["a plain secret", SIB_SECRET],
      ["an -sk- run followed by 20+ chars", "aaaaaaaa" + "-sk" + "-" + "B".repeat(31)],
      ["a ghp_ run", "abc" + GH_TOKEN],
    ];
    for (const [label, secret] of secrets) {
      for (const userCode of ["BCDFGHJK", "bcdfghjk"]) {
        const code = "sibdc" + "_" + userCode + "_" + secret;
        const result = redact(`device_code=${code} polled`);
        expect(result.text, label).toBe("device_code=«redacted:sibdc-code» polled");
        expect(result.counts["sibdc-code"], label).toBe(1);
        assertZeroExcept(result, "sibdc-code");
      }
    }
  });

  it("when text is glued straight onto a sib_ token, the token is redacted and the glued-on text is left to the later passes", () => {
    // Pre-fix: the secret ran `{43,256}`, so it swallowed the letters glued
    // after a token, the anchor a later pass needs, and that pass's secret
    // shipped: `<token>Authorization: Basic <cred>` gave
    // `«redacted:sib-token»: Basic <cred>`. The issuer only makes 43-char secrets.
    const cases: Array<[string, string, string, RedactionClass]> = [
      ["Authorization header", `${SIB_TOKEN}Authorization: Basic dXNlcjpleGFtcGxlLXBhc3M=`, "«redacted:sib-token»«redacted:auth-header»", "auth-header"],
      ["governed name", `${SIB_TOKEN}PASSWORD=hunter2-super-secret`, "«redacted:sib-token»PASSWORD=«redacted:assignment»", "assignment"],
    ];
    for (const [label, input, expected, cls] of cases) {
      const result = redact(input);
      expect(result.text, label).toBe(expected);
      expect(result.counts["sib-token"], label).toBe(1);
      expect(result.counts[cls], label).toBe(1);
      assertZeroExcept(result, "sib-token", cls);
    }
  });

  it("when an AWS access key id is present, it goes red — observed at redact().text", () => {
    const key = AWS_KEY_ID;
    const result = redact(`credentials: ${key}`);
    expect(result.text).not.toContain(key);
    expect(result.text).toContain("«redacted:aws-key»");
    expect(result.counts["aws-key"]).toBe(1);
    assertZeroExcept(result, "aws-key");
  });

  it("when an aws_secret_access_key assignment is present, it goes red — observed at redact().text", () => {
    const secret = AWS_SECRET;
    const result = redact(`aws_secret_access_key = ${secret}`);
    expect(result.text).not.toContain(secret);
    expect(result.text).toContain("«redacted:aws-key»");
    expect(result.counts["aws-key"]).toBe(1);
    assertZeroExcept(result, "aws-key");
  });

  it("when a GitHub token is present, it goes red — observed at redact().text", () => {
    const tok = GH_TOKEN;
    const result = redact(`auth: ${tok}`);
    expect(result.text).not.toContain(tok);
    expect(result.text).toContain("«redacted:github-token»");
    expect(result.counts["github-token"]).toBe(1);
    assertZeroExcept(result, "github-token");
  });

  it("when a Slack token is present, it goes red — observed at redact().text", () => {
    const tok = SLACK_TOKEN;
    const result = redact(`slack: ${tok}`);
    expect(result.text).not.toContain(tok);
    expect(result.text).toContain("«redacted:slack-token»");
    expect(result.counts["slack-token"]).toBe(1);
    assertZeroExcept(result, "slack-token");
  });

  it("when a Google API key is present, it goes red — observed at redact().text", () => {
    const key = GOOGLE_KEY;
    const result = redact(`key=${key}`);
    expect(result.text).not.toContain(key);
    expect(result.text).toContain("«redacted:google-api-key»");
    expect(result.counts["google-api-key"]).toBe(1);
    assertZeroExcept(result, "google-api-key");
  });

  it("when an sk- style secret key is present, it goes red — observed at redact().text", () => {
    const key = `${ANTHROPIC_KEY}ABCDEFGHIJ`;
    const result = redact(`the client used ${key} to call the API`);
    expect(result.text).not.toContain(key);
    expect(result.text).toContain("«redacted:sk-key»");
    expect(result.counts["sk-key"]).toBe(1);
    assertZeroExcept(result, "sk-key");
  });

  it("when an Authorization: Bearer header is present, it goes red — observed at redact().text", () => {
    const header = "Authorization: Bearer abc123.def456.ghi789";
    const result = redact(`request failed with header ${header} attached`);
    expect(result.text).not.toContain("abc123.def456.ghi789");
    expect(result.text).toContain("«redacted:auth-header»");
    expect(result.counts["auth-header"]).toBe(1);
    assertZeroExcept(result, "auth-header");
  });

  it("when an Authorization: Basic header is present, it goes red — observed at redact().text", () => {
    // Pre-fix: AUTH_HEADER_RE only knew Bearer|Token, so this fell through
    // to the generic `assignment` pass, which eats only the scheme word
    // ("AUTH" is a governed name) and ships the base64 credential verbatim:
    // `Authorization: «redacted:assignment» dXNlcjpleGFtcGxlLXBhc3M=`.
    const header = "Authorization: Basic dXNlcjpleGFtcGxlLXBhc3M=";
    const result = redact(`request failed with header ${header} attached`);
    expect(result.text).not.toContain("dXNlcjpleGFtcGxlLXBhc3M=");
    expect(result.text).toContain("«redacted:auth-header»");
    expect(result.counts["auth-header"]).toBe(1);
    assertZeroExcept(result, "auth-header");
  });

  it("when an Authorization: Bearer credential is a token another class already redacted, the scheme survives and the token is counted once — observed at redact().text and counts", () => {
    // Pre-fix: the token class (github-token, sib-token, jwt) ran first and left
    // `Authorization: Bearer «redacted:<class>»`; AUTH_HEADER_RE's credential
    // group then matched that marker as the credential, so the whole header
    // collapsed to `«redacted:auth-header»` (scheme lost) and BOTH classes were
    // counted.
    const cases: Array<[RedactionClass, string]> = [
      ["github-token", GH_TOKEN],
      ["sib-token", SIB_TOKEN],
      ["jwt", JWT],
    ];
    for (const [cls, token] of cases) {
      const result = redact(`Authorization: Bearer ${token}`);
      expect(result.text, cls).toBe(`Authorization: Bearer «redacted:${cls}»`);
      expect(result.counts[cls], cls).toBe(1);
      expect(result.total, cls).toBe(1);
      assertZeroExcept(result, cls);
      // the marker left behind is not re-matched by a second pass.
      const again = redact(result.text);
      expect(again.text, cls).toBe(result.text);
      expect(again.total, cls).toBe(0);
    }
  });

  it("when a GCP service-account private_key JSON value is present, it goes red — observed at redact().text", () => {
    const json =
      '{"type":"service_account","project_id":"demo",' +
      `"private_key":"${BEGIN_PK}\\nMIIEvQIBADANBgkqhkiG\\n${END_PK}\\n",` +
      '"client_email":"svc@demo.iam.example.com"}';
    const result = redact(`sa file contents: ${json}`);
    expect(result.text).not.toContain("MIIEvQIBADANBgkqhkiG");
    expect(result.text).toContain("«redacted:gcp-private-key»");
    expect(result.counts["gcp-private-key"]).toBe(1);
    // the JSON-embedded PEM is consumed by the more specific class, not the
    // generic PEM pass — same content must not be double-counted.
    expect(result.counts.pem).toBe(0);
    assertZeroExcept(result, "gcp-private-key");
  });

  it("when a connection string with an inline password is present, it goes red — observed at redact().text", () => {
    const conn = "postgres://dbuser:hunter2pw@db.internal.example.com:5432/app";
    const result = redact(`DATABASE_URL was ${conn} in the failing env`);
    expect(result.text).not.toContain("hunter2pw");
    expect(result.text).toContain("«redacted:conn-string»");
    expect(result.counts["conn-string"]).toBe(1);
    assertZeroExcept(result, "conn-string");
  });

  it("when an Authorization credential runs on past an earlier class's marker, the whole header is redacted and no tail survives", () => {
    // Pre-fix: AUTH_HEADER_RE's `(?!«redacted:)` guard declined any credential
    // that STARTED with a marker. A token that ran past its class's length cap,
    // or was followed by `.`, `:`, `%` or another character outside its
    // alphabet, left the rest of the credential after the marker, and the guard
    // shipped it: `Authorization: Bearer «redacted:sk-key»<36 plaintext chars>`.
    // It also shipped a raw key in the scheme position whenever a marker
    // followed it.
    const cases: Array<[string, string, RedactionClass[]]> = [
      ["sk- key past its 120-char cap", `Authorization: Bearer ${OVERLONG_SK}`, ["sk-key", "auth-header"]],
      ["GitHub token in a token:x-oauth pair", `Authorization: token ${GH_TOKEN}:x-oauth-${TAIL}`, ["github-token", "auth-header"]],
      ...[".", "-", "_", "=", ":", "%"].map((d): [string, string, RedactionClass[]] => [
        `GitHub token followed by '${d}'`,
        `Authorization: Bearer ${GH_TOKEN}${d}${TAIL}`,
        ["github-token", "auth-header"],
      ]),
      ["bare marker run into plaintext", `Authorization: Bearer «redacted:github-token»${TAIL}`, ["auth-header"]],
      // A raw key sent with no scheme word sits where the scheme would.
      ["raw key in the scheme position, then a marker", `Authorization: ${LIVE_SK} ${JWT}`, ["jwt", "auth-header"]],
    ];
    for (const [label, input, classes] of cases) {
      const result = redact(input);
      expect(result.text, label).toBe("«redacted:auth-header»");
      for (const c of classes) expect(result.counts[c], label).toBe(1);
      assertZeroExcept(result, ...classes);
    }
    const proxy = redact(`Proxy-Authorization: Basic «redacted:sib-token»${TAIL}`);
    expect(proxy.text).toBe("Proxy-«redacted:auth-header»");
    expect(proxy.total).toBe(1);
  });

  it("when a connection-string password is an earlier class's marker, alone or with a tail, the whole span is redacted and nothing around it survives", () => {
    // Pre-fix: CONN_STRING_RE's `(?!«redacted:)` guard declined any password
    // that STARTED with a marker, so whatever followed the token inside the
    // password shipped: `postgres://user:«redacted:github-token»%21<plaintext>@db…`,
    // as did a password that carried an unescaped `@` after the token. Even an
    // exact-marker password cannot be declined: the scheme and host runs take
    // whatever is pasted against them, so declining shipped that too.
    const cases: Array<[string, string, RedactionClass[]]> = [
      ["exact marker", `postgres://user:${SIB_TOKEN}@db.example.com:5432/app`, ["sib-token", "conn-string"]],
      ["exact marker, key pasted against the host", `postgres://user:${GH_TOKEN}@db${TAIL}/app`, ["github-token", "conn-string"]],
      ["exact marker, key pasted against the scheme", `${TAIL}postgres://user:${GH_TOKEN}@db/app`, ["github-token", "conn-string"]],
      ["GitHub token then a percent-escape", `postgres://user:${GH_TOKEN}%21${TAIL}@db.example.com/app`, ["github-token", "conn-string"]],
      ["sib_ token then a dotted tail", `postgres://user:${sibToken(SIB_SECRET + "." + TAIL)}@db.example.com/app`, ["sib-token", "conn-string"]],
      ["bare marker run into plaintext", `postgres://user:«redacted:sib-token»${TAIL}@db.example.com/app`, ["conn-string"]],
      // A URL parser splits userinfo at the LAST `@`, so `@<rest>` is password.
      ["GitHub token then an unescaped '@'", `postgres://user:${GH_TOKEN}@${TAIL}@db.example.com/app`, ["github-token", "conn-string"]],
    ];
    for (const [label, input, classes] of cases) {
      const result = redact(input);
      expect(result.text, label).toBe("«redacted:conn-string»/app");
      for (const c of classes) expect(result.counts[c], label).toBe(1);
      assertZeroExcept(result, ...classes);
    }
  });

  it("when a key-name assignment (NAME=value) is present, it goes red — observed at redact().text", () => {
    const result = redact("SECRET_KEY=s3cr3t-material-do-not-share");
    expect(result.text).not.toContain("s3cr3t-material-do-not-share");
    expect(result.text).toContain("«redacted:assignment»");
    expect(result.counts.assignment).toBe(1);
    assertZeroExcept(result, "assignment");
  });

  it("when a key-name assignment (NAME: value) is present in YAML style, it goes red — observed at redact().text", () => {
    const result = redact("password: hunter2-super-secret");
    expect(result.text).not.toContain("hunter2-super-secret");
    expect(result.text).toContain("«redacted:assignment»");
    expect(result.counts.assignment).toBe(1);
    assertZeroExcept(result, "assignment");
  });

  it("redacts every governed assignment NAME, not just a sample", () => {
    const names = [
      "SECRET",
      "TOKEN",
      "PASSWORD",
      "PASSWD",
      "PRIVATE_KEY",
      "API_KEY",
      "CREDENTIAL",
      "ACCESS_KEY",
      "CLIENT_SECRET",
      "MNEMONIC",
      "SEED",
      "SESSION",
      "COOKIE",
      "AUTH",
    ];
    for (const name of names) {
      const result = redact(`${name}=abcdef0123456789`);
      expect(result.counts.assignment).toBe(1);
      expect(result.text).not.toContain("abcdef0123456789");
    }
  });

  it("redacts a governed word appearing as a SUFFIX or INFIX of a longer identifier, not just a prefix", () => {
    // Pre-fix: ASSIGNMENT_RE anchored the governed word to the start of the
    // name, so `\bTOKEN` never matched the `TOKEN` in `GITHUB_TOKEN` — `_` is
    // a `\w` character, so there is no `\b` between `_` and `T`. This is the
    // DOMINANT real-world shape (`*_TOKEN`/`*_SECRET`/`*_API_KEY`), and every
    // one of these names shipped plaintext on the wire before the fix,
    // including `ERIS_YAKS_TOKEN` — this CLI's own bearer token.
    const cases: Array<[string, string]> = [
      ["DATABASE_PASSWORD", "hunter2-actual-db-password"],
      ["AUTH_PROVIDER_API_KEY", LIVE_SK],
      ["PAYMENTS_API_PRIVATE_KEY", "tk-priv-abcdefghijklmnop"],
      ["ACME_CLIENT_SECRET", "cs-abcdefghijklmnopqrstuv"],
      ["BUNDLER_API_KEY", "pk-abcdefghijklmnopqrstuv"],
      ["INGEST_TOKEN", "ingtok-abcdefghijklmnopqr"],
      ["ERIS_YAKS_TOKEN", "eyt-abcdefghijklmnopqrstu"],
    ];
    for (const [name, value] of cases) {
      const result = redact(`${name}=${value}`);
      expect(result.text).not.toContain(value);
      expect(result.text).toContain("«redacted:assignment»");
      expect(result.counts.assignment).toBe(1);
    }
  });

  it("redacts a secret-shaped value under a prose-colliding name, and any value under a credential name", () => {
    // Fails if the secret-shape requirement reaches too far: a real
    // session id or cookie under AUTH/SESSION/SEED/COOKIE ships in plaintext, or
    // a short password under PASSWORD/TOKEN/SECRET stops being redacted.
    // Observed at redact().text and counts.assignment.
    const cases: Array<[string, string]> = [
      ["session", "x9y8z7w6"],
      ["authorized", "abcdefghijklmnopqr"],
      ["seed", "4815162342"],
      ["cookie", "sid=abcdef0123456789"],
      ["password", "hunter2"],
      ["token", "brief"],
      ["SECRET", "enabled"],
      ["SEED", "1234"],
      ["BASIC_AUTH_PASS", "correcthorse"],
      ["SESSION_KEY", "abcdefghijklmno"],
    ];
    for (const [name, value] of cases) {
      const result = redact(`${name}: ${value} trailing`);
      expect(result.text, name).toBe(`${name}: «redacted:assignment» trailing`);
      expect(result.counts.assignment, name).toBe(1);
    }
  });

  it("redacts a prose-colliding value whole when an earlier marker inside it has a tail", () => {
    // Fails if a marker is discounted from a value's secret shape even when
    // text runs on past it: the tail of an over-long key (SK_KEY_RE stops at
    // 120 chars) ships under `session:`. Observed at both passes' text.
    const tail = "hJkLmNoPqR";
    const input = `session: s.sk-proj-${"a1B2".repeat(30)}${tail} trailing`;
    const once = redact(input);
    expect(once.text).toBe("session: «redacted:assignment» trailing");
    const again = redact(once.text);
    expect(again.text).toBe(once.text);
    expect(again.total).toBe(0);
  });

  it("redacts a credential assignment that sits inside a declined prose-colliding value", () => {
    // Fails if a declined `auth:`/`seed:`/`cookie:` match swallows the text
    // after it: the scan must resume inside the declined value, or the
    // credential assignment there ships in plaintext. Also fails if the inner
    // marker grows the outer value into secret shape, so a second redact()
    // (the server re-redacts client output) swallows it: observed at the
    // second pass's text and total.
    const cases: Array<[string, string]> = [
      ["auth:token=hunter", "auth:token=«redacted:assignment»"],
      ["seed:password=hunter", "seed:password=«redacted:assignment»"],
      ["cookie: secret=abcdefg", "cookie: secret=«redacted:assignment»"],
      ["GET /cb?auth=ok&token=hunter", "GET /cb?auth=ok&token=«redacted:assignment»"],
    ];
    for (const [input, expected] of cases) {
      const result = redact(input);
      expect(result.text, input).toBe(expected);
      expect(result.counts.assignment, input).toBe(1);
      const again = redact(result.text);
      expect(again.text, input).toBe(expected);
      expect(again.total, input).toBe(0);
    }
  });

  it("redacts the lowercase aws_session_token shape, case-insensitively", () => {
    const value = AWS_SESSION;
    const result = redact(`aws_session_token: ${value}`);
    expect(result.text).not.toContain(value);
    expect(result.text).toContain("«redacted:assignment»");
    expect(result.counts.assignment).toBe(1);
  });

  it("redacts a HYPHENATED two-word governed name — the HTTP-header/YAML spelling", () => {
    // One separator over from the suffix/infix miss above:
    // API_KEY/PRIVATE_KEY/ACCESS_KEY/CLIENT_SECRET are literal strings with a
    // hardcoded underscore, so `x-api-key`/`private-key` — the standard
    // HTTP-header and YAML-config spelling — broke into non-governed halves
    // ("api"/"key", "private"/"key" — neither alone is a governed word) and
    // shipped in plaintext. Unlike the single-word governed terms (SECRET,
    // TOKEN, AUTH, …), which already matched a hyphenated neighbor by
    // accident (they stand alone as their own hyphen-bounded identifier),
    // the two-word phrases need the internal separator widened to `[_-]`.
    const cases: Array<[string, string]> = [
      ["x-api-key", "abcdef0123456789"],
      ["api-key", "abcdef0123456789"],
      ["private-key", "abcdef0123456789"],
      ["x-access-key", "abcdef0123456789"],
      ["x-client-secret", "abcdef0123456789"],
    ];
    for (const [name, value] of cases) {
      const result = redact(`${name}: ${value}`);
      expect(result.text).not.toContain(value);
      expect(result.text).toContain("«redacted:assignment»");
      expect(result.counts.assignment).toBe(1);
    }
  });

  it("redacts a JSON-quoted governed name — the ~/.eris/yaks.json shape (JSON-name fix)", () => {
    // A quoted key puts a `"`/`'` between
    // the identifier and the operator, so the old unquoted-only NAME group
    // never even started a match — `{"token": "…"}`, i.e. exactly
    // ~/.eris/yaks.json's own shape, shipped in plaintext. It survived the
    // corpus only because the one existing JSON fixture happened to hit the
    // hardcoded `"private_key"` GCP rule first — a fixture passing for a
    // reason other than the one it appeared to test.
    const cases: Array<[string, string, string]> = [
      // [input, secretValue, label]
      [
        '{"url": "https://example.com/v0/yaks", "token": "yk_live_9f3a2b8c1d4e5f6a"}',
        "yk_live_9f3a2b8c1d4e5f6a",
        "~/.eris/yaks.json shape, double-quoted, compact",
      ],
      [
        '{"api_key": "abcdef1234567890abcdef"}',
        "abcdef1234567890abcdef",
        "double-quoted key, no surrounding fields",
      ],
      [
        '{ "client_secret" : "shhhhhhhhhhhhhhhh" }',
        "shhhhhhhhhhhhhhhh",
        "arbitrary whitespace around the colon",
      ],
      [
        '"password": "hunter2hunter2hunter2"',
        "hunter2hunter2hunter2",
        "bare quoted-name pair, not wrapped in braces",
      ],
    ];
    for (const [input, secret, label] of cases) {
      const result = redact(input);
      expect(result.text, label).not.toContain(secret);
      expect(result.text, label).toContain("«redacted:assignment»");
      expect(result.counts.assignment, label).toBe(1);
    }
  });

  it("redacts a governed name in a pretty-printed multi-line JSON object", () => {
    const body = [
      "{",
      '  "url": "https://example.com/v0/yaks",',
      '  "token": "yk_live_9f3a2b8c1d4e5f6a"',
      "}",
    ].join("\n");
    const result = redact(body);
    expect(result.text).not.toContain("yk_live_9f3a2b8c1d4e5f6a");
    expect(result.text).toContain("«redacted:assignment»");
    expect(result.counts.assignment).toBe(1);
    // structure survives — this is a scrub of the VALUE, not a shredder.
    expect(result.text).toContain('"url": "https://example.com/v0/yaks"');
  });

  it("redacts a governed name nested inside an outer JSON object", () => {
    const body = '{"config": {"nested": true, "client_secret": "nested-secret-value-xyz"}}';
    const result = redact(body);
    expect(result.text).not.toContain("nested-secret-value-xyz");
    expect(result.text).toContain("«redacted:assignment»");
    expect(result.counts.assignment).toBe(1);
    expect(result.text).toContain('"nested": true');
  });

  it("redacts a single-quoted governed name — JS object literal / YAML style", () => {
    const body = `{ 'api_key': '${TEST_SK}' }`;
    const result = redact(body);
    expect(result.text).not.toContain(TEST_SK);
    expect(result.text).toContain("«redacted:assignment»");
    expect(result.counts.assignment).toBe(1);
  });

  it("redacts every governed name in a JSON array of objects", () => {
    const body = '[{"token": "first-secret-value-aaa"}, {"token": "second-secret-value-bbb"}]';
    const result = redact(body);
    expect(result.text).not.toContain("first-secret-value-aaa");
    expect(result.text).not.toContain("second-secret-value-bbb");
    expect(result.counts.assignment).toBe(2);
  });

  it("fully consumes a long JSON-quoted value — no run of the secret survives (JSON-name fix)", () => {
    const secret = "abc123XYZ".repeat(1112).slice(0, 10_000); // 10,000 non-whitespace chars
    const result = redact(`{"client_secret": "${secret}"}`);
    expect(result.text).not.toContain(secret);
    expect(result.text).not.toContain(secret.slice(5_000, 5_100));
    expect(result.text).not.toContain(secret.slice(9_000));
    expect(result.text).toContain("«redacted:assignment»");
    expect(result.counts.assignment).toBe(1);
  });

  it("does not swallow the closing brace or a following key past an unquoted JSON-ish value", () => {
    // If the unquoted-value alternative doesn't exclude `,`/`}`/`]`, it
    // greedily eats everything up to the next whitespace — including JSON
    // structural characters and the NEXT key entirely.
    const body = '{"token":abcdef0123456789,"user":"alice"}';
    const result = redact(body);
    expect(result.text).not.toContain("abcdef0123456789");
    expect(result.text).toContain("«redacted:assignment»");
    // the following key/value survives untouched — the match did not eat
    // past the comma.
    expect(result.text).toContain('"user":"alice"}');
  });

  it("redacts a value up to the field max — no plaintext run of the secret survives, even at 10,000 chars", () => {
    // Pre-fix: the value alternative was bounded to {1,4096}. A 10,000-char
    // value was only PARTIALLY replaced — the first 4,096 chars became the
    // marker, and the remaining 5,904 chars survived as plaintext directly
    // after it. That is worse than no redaction: it *looks* handled.
    const secret = "abc123XYZ".repeat(1112).slice(0, 10_000); // 10,000 non-whitespace chars
    expect(secret.length).toBe(10_000);
    const result = redact(`SECRET_KEY=${secret}`);
    expect(result.text).not.toContain(secret);
    // no partial run survives either — check chunks from the middle and the
    // tail, i.e. past the OLD 4,096-char bound, which is exactly where the
    // pre-fix bug left plaintext behind.
    expect(result.text).not.toContain(secret.slice(5_000, 5_100));
    expect(result.text).not.toContain(secret.slice(9_000));
    expect(result.text).toContain("«redacted:assignment»");
    expect(result.counts.assignment).toBe(1);
    assertZeroExcept(result, "assignment");
  });

  it("when an assignment value runs on past an earlier class's marker, the whole value is redacted and no tail survives", () => {
    // Pre-fix: ASSIGNMENT_RE's `(?!['"]?«redacted:)` guard declined any value
    // that STARTED with a marker, so a token cut short by its class's length
    // cap left its tail as plaintext: `SECRET_KEY=«redacted:sk-key»<36 chars>`.
    const cases: Array<[string, string, string, RedactionClass[]]> = [
      ["unquoted, token past its cap", `SECRET_KEY=${OVERLONG_SK}`, "SECRET_KEY=«redacted:assignment»", ["sk-key", "assignment"]],
      ["unquoted, bare marker run into plaintext", `SECRET_KEY=«redacted:sk-key»${TAIL}`, "SECRET_KEY=«redacted:assignment»", ["assignment"]],
      ["quoted, token past its cap", `{"api_key": "${OVERLONG_SK}"}`, '{"api_key": «redacted:assignment»}', ["sk-key", "assignment"]],
      ["quoted, marker then plaintext", `{"api_key": '«redacted:sk-key»${TAIL}'}`, '{"api_key": «redacted:assignment»}', ["assignment"]],
    ];
    for (const [label, input, expected, classes] of cases) {
      const result = redact(input);
      expect(result.text, label).toBe(expected);
      for (const c of classes) expect(result.counts[c], label).toBe(1);
      assertZeroExcept(result, ...classes);
    }
  });

  it("when an assignment value that starts with an earlier class's marker runs straight into another assignment, that one is still redacted", () => {
    // Pre-fix: the marker-plus-tail value ran on to the next whitespace, through
    // an adjacent `"name": ` or `name: ` and into its value, so that assignment
    // never got its own match and its value shipped:
    // `auth: «redacted:assignment» "Basic <secret> <secret>"`. Declining the
    // whole marker-led value had hidden this. The pass now redacts both
    // readings of the run: as one value, and as the assignments inside it.
    const sk130 = "sk-" + "Q".repeat(130);
    const cases: Array<[string, string, string, RedactionClass]> = [
      [
        "a quoted JSON name",
        `auth: ${sk130}"authorization": "Basic ${TAIL} ${TAIL}"`,
        "auth: «redacted:assignment» «redacted:assignment»",
        "sk-key",
      ],
      [
        "an unquoted name",
        `API_KEY: ${sk130}\`auth: "Basic ${TAIL} ${TAIL}"`,
        "API_KEY: «redacted:assignment» «redacted:assignment»",
        "sk-key",
      ],
      // The swallowed assignment's own value runs on past a marker too.
      [
        "a name whose value runs on past a marker",
        `auth: ${GH_TOKEN}.'token: «redacted:sib-token»${TAIL}`,
        "auth: «redacted:assignment» «redacted:assignment»",
        "github-token",
      ],
    ];
    for (const [label, input, expected, token] of cases) {
      const result = redact(input);
      expect(result.text, label).toBe(expected);
      expect(result.counts[token], label).toBe(1);
      expect(result.counts.assignment, label).toBe(2);
      assertZeroExcept(result, token, "assignment");
    }
  });
});

// --- 2. negative: ordinary prose must survive byte-identical -------------------

describe("redact() — negative corpus, prose must survive untouched", () => {
  const proseCases: Array<[string, string]> = [
    [
      "auth-token-missing narrative",
      "the auth token was missing from the environment so the hook failed",
    ],
    [
      "PASSWORD_RESET_ENABLED narrative",
      "I set PASSWORD_RESET_ENABLED to true",
    ],
    [
      "docs anchor link",
      "see docs/ERRORS.md#ingest-token-unset for the slug",
    ],
    [
      "generic mention of secret as an English word",
      "the deployment secret rotation job ran fine, nothing to report here",
    ],
    [
      "generic mention of key as an English word",
      "the key insight from this session was that the hook fires before config is loaded",
    ],
    // --- rebuilt from strings that ACTUALLY broke an earlier version,
    // not from cases pre-selected to pass. The original corpus proved only
    // that "prose without an operator survives" — true by construction,
    // since every original case avoided a `NAME:`/`NAME=` shape entirely.
    // These exercise SK_KEY_RE's word-boundary fix and ASSIGNMENT_RE's
    // minimum-unquoted-value-length fix against the exact strings that
    // broke pre-fix.
    [
      "sk- mid-word in a hyphenated English compound (risk-)",
      "This is a risk-assessment-methodology for agent tasks",
    ],
    [
      "sk- mid-word in a hyphenated path segment (disk-)",
      "at /Users/x/disk-cache-manager-impl/foo.ts:42",
    ],
    [
      "sk- mid-word in a hyphenated English compound (task-)",
      "the task-scheduler-daemon restarted twice during the run",
    ],
    [
      "NAME: <1-char value> progress narrative — too short to be a credential",
      "Session: 3 of 4 workers failed to start",
    ],
    // --- rebuilt again for the JSON-name fix: a quoted rule must not start
    // eating ordinary quoted PROSE just because it contains "token"/"secret"
    // as an English word. The identifier char class has no space in it, so
    // a multi-word sentence can never satisfy the quoted-NAME alternative —
    // only a single hyphen/underscore-joined TOKEN sitting alone between two
    // matching quote characters can.
    [
      "a quoted English sentence containing the word 'token', not a JSON key",
      "\"the auth token was missing from the environment so the hook failed\"",
    ],
    [
      "a quoted English sentence containing the word 'secret', not a JSON key",
      "'the deployment secret rotation job ran fine, nothing to report here'",
    ],
    [
      "a file reference using the word.ext: description shape this file's own comments use",
      "yak-redact.ts: the redaction pass",
    ],
    // --- sib-token is contract-shaped (ULID + 43-char secret), not a generic
    // `sib_` + run: each of these shares the prefix and none is a token.
    [
      "the bare sib_ prefix named as a word",
      "the sib_ prefix marks a service credential format",
    ],
    [
      "a sib_-prefixed snake_case identifier in prose",
      "see the sib_service_token_rotation_policy doc for the cadence",
    ],
    [
      "a sib_ org id with no secret segment",
      `the failing request carried org ${"sib" + "_" + SIB_ULID} only`,
    ],
    // --- yak bodies the assignment rule mangled: an
    // English word ending in `:` that merely CONTAINS a prose-colliding governed
    // word (AUTH, SESSION, SEED, COOKIE), followed by a word that is not
    // secret-shaped.
    [
      "a commit-skill grant phrase: authorized: /pls",
      "the only accepted grants are 'authorized: /pls', '/close-out'",
    ],
    [
      "a commit-skill grant phrase: authorized: brief <issue>",
      "re-ran with 'authorized: brief ABC-2889'",
    ],
    [
      "a session label followed by a verb",
      "End-to-end probe from the TPM session: filing the eris pull request",
    ],
    [
      "a seed label followed by an English word",
      "the fixture seed: deterministic, so replays match",
    ],
  ];

  for (const [label, text] of proseCases) {
    it(`"${label}" survives byte-identical`, () => {
      const result = redact(text);
      expect(result.text).toBe(text);
      expect(result.total).toBe(0);
    });
  }

  it("a full realistic yak body paragraph survives byte-identical", () => {
    const body = [
      "Ran `eris config pull local` from services/api and it hung for about 90",
      "seconds before failing with `key-unregistered`. I checked whether the",
      "auth token was missing from the environment so the hook failed, but",
      "ERIS_YAKS_TOKEN and INGEST_TOKEN were both unset on purpose — I set",
      "PASSWORD_RESET_ENABLED to true earlier in this session for an unrelated",
      "test and don't think it's related. See docs/ERRORS.md#ingest-token-unset",
      "for the slug this matches. No credentials were involved, just a slow",
      "config walk. The session key rotated normally afterwards.",
    ].join("\n");
    const result = redact(body);
    expect(result.text).toBe(body);
    expect(result.total).toBe(0);
    for (const c of ALL_CLASSES) {
      expect(result.counts[c]).toBe(0);
    }
  });
});

// --- 2b. documented trade-off: ambiguous NAME: value shapes ---------------------
//
// `seed: 4815162342 (deterministic replay)` and `- SECRET_SCANNING: enabled`
// are syntactically indistinguishable from a real `SEED=<wallet-seed>` or
// `CLIENT_SECRET: <credential>` assignment — this pass has no semantic model
// of "this NAME is a log field, that NAME is a credential," and the
// minimum-unquoted-value-length fix (>= 4 chars) only removes the CHEAPEST
// false positives (single-digit/short values like `Session: 3`), not this
// class. See plugins/yak/yak-redact.ts's file header, "THE NAME: VALUE
// TRADE-OFF", for the reasoning: a false positive here costs one line's
// readability; a miss costs a leaked credential. These are pinned as
// INTENDED behavior — a future reader should see this was decided, not
// missed, and should not "fix" it back to a miss without re-opening that
// trade-off deliberately.
describe("redact() — documented trade-off: ambiguous NAME: value shapes are redacted, not left ambiguous", () => {
  it("a deterministic-replay seed line is redacted like a real seed would be", () => {
    const result = redact("seed: 4815162342 (deterministic replay)");
    expect(result.counts.assignment).toBe(1);
    expect(result.text).toContain("«redacted:assignment»");
    // the parenthetical survives — the value alternative is a bounded
    // non-whitespace run, so only "4815162342" is consumed, not the rest of
    // the line.
    expect(result.text).toContain("(deterministic replay)");
  });

  it("a feature-toggle name containing a governed word is redacted like a real one would be", () => {
    const result = redact("- SECRET_SCANNING: enabled");
    expect(result.counts.assignment).toBe(1);
    expect(result.text).toContain("«redacted:assignment»");
  });
});

// --- 3. idempotence & marker safety ---------------------------------------------

describe("redact() — idempotence", () => {
  it("redacting twice equals redacting once", () => {
    const body = "SECRET_KEY=abc123 and Authorization: Bearer xyz789 in the same line";
    const once = redact(body);
    const twice = redact(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.total).toBe(0);
    for (const c of ALL_CLASSES) {
      expect(twice.counts[c]).toBe(0);
    }
  });

  it("the marker itself is never re-matched: every class's exact marker, as a value, a quoted value or a credential", () => {
    // Goes red when a guard's marker grammar no longer covers a class name
    // (a class renamed outside `[a-z-]{1,40}`), or a guard stops declining an
    // exact marker: the marker is then reclassified and counted a second time.
    for (const cls of ALL_CLASSES) {
      const m = `«redacted:${cls}»`;
      const texts = [
        `context: ${m} appeared in a prior redaction pass`,
        `SECRET_KEY=${m}, next`,
        `{"api_key": "${m}"}`,
        `token: '${m}'`,
        `Authorization: Bearer ${m}`,
        `Proxy-Authorization: Basic ${m} trailing`,
      ];
      for (const text of texts) {
        const result = redact(text);
        expect(result.text, text).toBe(text);
        expect(result.total, text).toBe(0);
      }
    }
  });

  it("a QUOTED, already-redacted value under a governed key is not re-redacted and reclassified as 'assignment' (JSON-name fix regression)", () => {
    // The old `(?!«redacted:)` guard only saw a bare marker glyph directly
    // after the operator — the unquoted case. Once ASSIGNMENT_RE could also
    // match a QUOTED value, an earlier, more specific pass's marker sitting
    // inside its ORIGINAL quotes (`"api_key": "«redacted:sk-key»"` — the
    // sk-key pass only ever replaces what's INSIDE the quotes, never the
    // quotes themselves) satisfied the quoted-value alternative whole,
    // because the guard never looked past the opening `"`. The result:
    // every class that can appear as a governed key's JSON/YAML value
    // silently downgraded to the generic `assignment` classification on a
    // SINGLE pass through `redact()` — not just on a second call.
    const sk = redact(`{"api_key": "${ANTHROPIC_KEY}"}`);
    expect(sk.text).toBe('{"api_key": "«redacted:sk-key»"}');
    expect(sk.counts["sk-key"]).toBe(1);
    expect(sk.counts.assignment).toBe(0);

    const jwt = JWT;
    const jwtResult = redact(`{"session_token": "${jwt}"}`);
    expect(jwtResult.counts.jwt).toBe(1);
    expect(jwtResult.counts.assignment).toBe(0);
  });
});

// --- 3b. redaction can grow a string past a caller's bound --------
//
// `«redacted:assignment»` is a fixed-length marker. Replacing a value SHORTER
// than the marker makes `redact()`'s OUTPUT LONGER than its INPUT — a summary
// that was exactly at `YAK_SUMMARY_MAX_LENGTH` before redaction can exceed it
// after. This is a real, structural property of any marker-based redaction
// scheme, not a bug in the regexes above, and it is NOT fully solved in this
// module: `redact()` is pure text transformation with no notion of a field's
// max length (that constant lives in @sibylline-labs/yak-contract, a module this file
// deliberately does not import — file header, "PURE"/"VALUE BOUND"). The test
// below PINS the phenomenon so it is a known, asserted property rather than a
// surprise; the actual fix — re-validating (or re-deriving a warning from)
// length AFTER redact() runs, not just before — belongs to whichever caller
// owns the field bound, i.e. yak-submit.ts's submission pipeline (step 5,
// local schema validation), not this module.
describe("redact() — marker length vs. replaced-value length (documented, not resolved here)", () => {
  it("a short redacted value can make the surrounding text LONGER than the input", () => {
    const input = "replay token: 4815 (deterministic)"; // value "4815" is 4 chars — the
    // minimum for the unquoted alternative — well short of the marker's length.
    // A credential name, since `seed` alone needs a secret-shaped value.
    const result = redact(input);
    expect(result.counts.assignment).toBe(1);
    expect(result.text.length).toBeGreaterThan(input.length);
  });
});

// --- 4. ReDoS guard --------------------------------------------------------------

describe("redact() — pathological input does not hang", () => {
  it("50KB of 'a=' repeats completes fast", () => {
    const pathological = "a=".repeat(25_000); // 50,000 bytes
    const start = performance.now();
    const result = redact(pathological);
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(2000);
    expect(result.total).toBe(0);
  });

  it("a keyword-dense pathological input (TOKEN= repeated) completes fast", () => {
    const pathological = "TOKEN=".repeat(10_000);
    const start = performance.now();
    const result = redact(pathological);
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(2000);
    // every "TOKEN=" is immediately followed by the next "TOKEN=" token,
    // which is itself a valid (if silly) unquoted value — assert it does not
    // hang, not a specific count.
    expect(result.total).toBeGreaterThanOrEqual(0);
  });

  it("a long run of unterminated PEM BEGIN markers with no END completes fast", () => {
    const pathological = `${BEGIN_RSA}\n`.repeat(2_000) + "x".repeat(20_000);
    const start = performance.now();
    redact(pathological);
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("200KB adversarial to ASSIGNMENT_RE's bounded-affix NAME group completes in well under 70ms", () => {
    // Stresses the `[A-Za-z0-9_]{0,60}WORD[A-Za-z0-9_]{0,60}`
    // construction specifically: many short, space-separated identifiers,
    // most of which are near-misses of a governed word (close enough to
    // force the alternation check, never long enough to actually match),
    // so the greedy-prefix-then-backtrack path in the file header's
    // complexity argument is exercised at every `\b` position across the
    // whole 200KB, not just the handful of real matches in the other
    // pathological-input tests.
    const nearMisses = ["TOKE", "SECRE", "PASSWOR", "CREDENTIA", "SESSIO", "COOKI", "AUT"];
    const chunk = nearMisses.map((w) => `${w}_${w}_value`).join(" ") + " ";
    const pathological = chunk.repeat(Math.ceil(200_000 / chunk.length));
    const start = performance.now();
    const result = redact(pathological);
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(70);
    expect(result.total).toBe(0);
  });

  it("200KB of maximal \\b-boundary density (hyphen-separated single chars) stays linear, not exponential", () => {
    // The hyphen fix added `-` to ASSIGNMENT_RE's prefix/suffix
    // class, but `-` is NOT a `\w` character, so `\b` still fires at every
    // hyphen/letter transition — a hyphen-dense input now creates far MORE
    // candidate starting positions than the same input did before the fix
    // (previously a hyphen just stopped prefix consumption; now it's a
    // fresh `\b` boundary the engine tries a match from). "a-".repeat(n) is
    // close to the worst case for boundary DENSITY: one single-char
    // identifier, and one fresh match attempt, every 2 bytes.
    //
    // This is NOT exponential — scaling asserts LINEAR growth directly,
    // which is the actual safety property (a merely higher constant factor
    // is fine; a changed complexity CLASS is not). The 1000ms ceiling at
    // 200KB matches this file's other worst-case ReDoS margins (2000ms at
    // 50-60KB) rather than the tighter 70ms used above, because this
    // pattern is deliberately denser than realistic near-miss prose.
    const at100k = "a-".repeat(50_000); // 100,000 bytes
    const at200k = "a-".repeat(100_000); // 200,000 bytes

    const t1 = performance.now();
    const r1 = redact(at100k);
    const ms100k = performance.now() - t1;

    const t2 = performance.now();
    const r2 = redact(at200k);
    const ms200k = performance.now() - t2;

    expect(ms200k).toBeLessThan(1000);
    expect(r1.total).toBe(0);
    expect(r2.total).toBe(0);
    // doubling the input should roughly double the time (allow generous
    // slack for GC/JIT noise) — an exponential blowup would instead show
    // as an order-of-magnitude jump, not a ~2x one.
    expect(ms200k).toBeLessThan(Math.max(ms100k * 6, 50));
  });
});

// --- 5. redactDeep() — nested JSON-ish provenance ------------------------------

describe("redactDeep() — nested value redaction for provenance", () => {
  it("redacts a secret nested inside an object/array tree and accumulates one result", () => {
    const provenance = {
      execution: { entrypoint: "cli" },
      git: {
        origin_url: `https://x-access-token:${GH_TOKEN}@github.com/org/repo.git`,
        branch: "main",
        dirty: false,
      },
      env: ["SECRET_KEY=s3cr3t-material-do-not-share", "PATH=/usr/bin"],
    };
    const result = redactDeep(provenance);
    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain(GH_TOKEN);
    expect(serialized).not.toContain("s3cr3t-material-do-not-share");
    expect(result.total).toBeGreaterThanOrEqual(2);
    expect((result.value as typeof provenance).git.branch).toBe("main");
    expect((result.value as typeof provenance).git.dirty).toBe(false);
  });

  it("redacts a sib_ token nested in a provenance-shaped object and counts it once", () => {
    const provenance = {
      git: {
        origin_url: `https://example.com/org/repo.git?x=${SIB_TOKEN}`,
        branch: "main",
      },
    };
    const result = redactDeep(provenance);
    expect((result.value as typeof provenance).git.origin_url).toBe(
      "https://example.com/org/repo.git?x=«redacted:sib-token»",
    );
    expect((result.value as typeof provenance).git.branch).toBe("main");
    expect(result.counts["sib-token"]).toBe(1);
    expect(result.total).toBe(1);
  });

  it("leaves non-string primitives (numbers, booleans, null) untouched", () => {
    const value = { pid: 1234, dirty: true, missing: null, name: "ordinary text" };
    const result = redactDeep(value);
    expect(result.value).toEqual(value);
    expect(result.total).toBe(0);
  });

  it("handles undefined leaves without throwing (evidence-absent shape)", () => {
    const value = { evidence: undefined, body: "plain text" };
    const result = redactDeep(value);
    expect((result.value as typeof value).evidence).toBeUndefined();
    expect(result.total).toBe(0);
  });
});

// --- 6. formatRedactionSummary() — the stderr line --------------------------------
//
// A body containing three redactable secrets once produced ZERO stderr bytes
// about redaction — `redactions` only ever showed up inside `--output json`'s
// record. docs/YAK.md promises
// the count and class breakdown on stderr in text mode too. This function is
// the formatter `yak.ts` calls (see its `RunYakResult`'s "delivered" and
// "warn" branches) — `yak.ts` itself stays a one-line-per-branch caller;
// the actual rendering logic is tested here, at the pure-function seam.
describe("formatRedactionSummary() — the stderr line docs/YAK.md promises", () => {
  // The `{count, classes}` shape formatRedactionSummary() takes is
  // yak-submit.ts's `RedactionSummary`, derived from a `RedactionResult` the
  // same way `summarizeRedactionCounts` does there — reproduced locally
  // rather than imported, since this test targets the pure-formatting seam,
  // not the summarization logic (that belongs to yak-submit.test.ts).
  function toSummary(result: RedactionResult): { count: number; classes: RedactionClass[] } {
    const classes = ALL_CLASSES.filter((c) => result.counts[c] > 0);
    return { count: result.total, classes };
  }

  it("when redact() finds exactly one match, the line uses the singular 'redaction'", () => {
    const result = redact("SECRET_KEY=abcdef0123456789");
    const line = formatRedactionSummary(toSummary(result));
    expect(line).toBe("1 redaction: assignment\n");
  });

  it("when redact() finds matches across multiple classes, the line names every class and the total count", () => {
    const body = "SECRET_KEY=abcdef0123456789 and Authorization: Bearer xyz789.abc123.def456";
    const result = redact(body);
    const summary = toSummary(result);
    expect(result.total).toBe(2);
    const line = formatRedactionSummary(summary);
    expect(line).toBe("2 redactions: auth-header, assignment\n");
    // the class order matches REDACTION_CLASSES' pipeline order (auth-header
    // runs before assignment), not insertion/detection order — deterministic
    // for a caller rendering it verbatim.
  });

  it("takes the {count, classes} shape structurally — no import of yak-submit.ts's RedactionSummary needed", () => {
    // this is the exact shape `yak.ts` has in hand as `result.redaction`
    // (yak-submit.ts's `RedactionSummary`), passed without any adaptation.
    const line = formatRedactionSummary({ count: 3, classes: ["sk-key", "conn-string"] });
    expect(line).toBe("3 redactions: sk-key, conn-string\n");
  });
});
