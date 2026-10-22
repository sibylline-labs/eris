/**
 * packages/yak-contract, the Yaks wire contract v2.
 *
 * Seams: `YakSubmission.parse` on the package's public entry (what the server
 * imports), the committed JSON Schema read from disk and run through ajv (what a
 * non-TypeScript consumer validates against), and v0's own behaviour as the oracle
 * for "unchanged": frozen idempotency-key vectors computed once from the v1
 * contract's derivation, and the v0 client's `resolveExecutionId` ladder.
 */

import { describe, expect, it } from "bun:test";
import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { buildJsonSchema, SCHEMA_FILE } from "../packages/yak-contract/scripts/emit-json-schema";
import { deriveIdempotencyKey, YakSubmission } from "../packages/yak-contract/src/index";
import { resolveExecutionId } from "../plugins/yak/yak-identity";

const PACKAGE_DIR = resolve(import.meta.dir, "../packages/yak-contract");

type Payload = Record<string, any>;

const SUBMISSION: Payload = {
  schema_version: "2.0.0",
  verb: "issue",
  route: "workspace",
  summary: "a hook blocks a legal edit",
  body: "The pre-edit hook refuses a write the policy allows.",
  evidence: "denied: path outside the allowlist",
  device_id: "device-1",
  execution_id: "execution-1",
  idempotency_key: "0".repeat(64),
  provenance: {
    execution: { rung: "codex", codex_session_id: "abc" },
    harness: { ai_agent: "codex_1-0-0_agent" },
    repo: { service: "widgets-api", target_repos: ["acme/widgets", "group/subgroup/project"] },
    git: { branch: "main", dirty: false },
  },
};

const withProvenance = (patch: Payload): Payload => ({ ...SUBMISSION, provenance: { ...SUBMISSION.provenance, ...patch } });
const withRung = (rung: string): Payload => withProvenance({ execution: { rung } });
const withTargetRepos = (target_repos: unknown): Payload => withProvenance({ repo: { target_repos } });

const ajvValidate = new Ajv({ strict: false, validateFormats: false }).compile(JSON.parse(readFileSync(SCHEMA_FILE, "utf8")));
const parse = (payload: Payload): Payload => YakSubmission.parse(payload);
/** What each consumer says about a payload: the Zod schema, and the emitted JSON Schema. */
const verdicts = (payload: Payload) => ({ zod: YakSubmission.safeParse(payload).success, jsonSchema: ajvValidate(payload) as boolean });

/** The rungs v0 can emit, by running its ladder: one env per rung. */
const V0_RUNGS = [{ ERIS_YAK_EXECUTION_ID: "x" }, { CLAUDE_CODE_SESSION_ID: "s" }, { CLAUDE_CODE_HOST_SESSION_ID: "h" }, { ERIS_YAK_SHELL_ID: "1" }, {}].map((env) => resolveExecutionId(env, 42).rung);
/** The generic rungs v2 adds (AI_AGENT, Codex, Cursor). */
const V2_RUNGS = ["ai-agent", "codex", "cursor"];

describe("yak-contract v2: what a client may send", () => {
  it("accepts a full submission, and the same under either route", () => {
    /** When the schema rejects or rewrites a field a v2 client legitimately sends, ingest answers 400 and the yak is lost: observed at parse and at the emitted JSON Schema. */
    expect(parse(SUBMISSION)).toEqual(SUBMISSION);
    for (const route of ["workspace", "vendor"]) expect({ route, ...verdicts({ ...SUBMISSION, route }) }).toEqual({ route, zod: true, jsonSchema: true });
  });

  it("accepts every v0 execution rung and the generic ones v2 adds", () => {
    /** When a rung a client may report is missing from the vocabulary, ingest answers 400 for every report that rode that rung. */
    expect(new Set(V0_RUNGS).size).toBe(5);
    for (const rung of [...V0_RUNGS, ...V2_RUNGS]) expect({ rung, ...verdicts(withRung(rung)) }).toEqual({ rung, zod: true, jsonSchema: true });
  });

  it("drops `reporter` and a tenant at the door, in both Zod and JSON Schema", () => {
    /** When v2 keeps a client-sent `reporter` or tenant, a git identity is stored as the reporter or a caller names a tenant: the server derives both from the token, so a stale client's fields must vanish, not be refused. */
    const stale = { ...SUBMISSION, reporter: { name: "Ada", email: "ada@example.com" }, tenant_id: "ws:another-tenant" };
    expect(parse(stale)).toEqual(SUBMISSION);
    expect(verdicts(stale)).toEqual({ zod: true, jsonSchema: true });
  });
});

describe("yak-contract v2: what ingest refuses", () => {
  const { route: _route, ...noRoute } = SUBMISSION;
  const REFUSED: [string, Payload][] = [
    ["no route", noRoute],
    ["a route outside the vocabulary", { ...SUBMISSION, route: "tenant" }],
    ["a route in the wrong case", { ...SUBMISSION, route: "Workspace" }],
    ["the v1 contract version", { ...SUBMISSION, schema_version: "1.0.0" }],
    ["a rung outside the vocabulary", withRung("claude-code")],
    ["target_repos as a string", withTargetRepos("acme/widgets")],
    ["a blank target_repos entry", withTargetRepos([""])],
    ["more than 20 target_repos", withTargetRepos(Array.from({ length: 21 }, (_, i) => `acme/repo-${i}`))],
    ["a target_repos entry over 200 characters", withTargetRepos([`acme/${"r".repeat(200)}`])],
  ];

  it("refuses each of them, in both Zod and JSON Schema", () => {
    /** When the two schemas disagree on a refusal, a TypeScript caller is turned away that a non-TypeScript one is not, or the reverse: observed as differing verdicts on one payload. */
    for (const [name, payload] of REFUSED) expect({ name, ...verdicts(payload) }).toEqual({ name, zod: false, jsonSchema: false });
  });

  it("accepts the largest target_repos list the bounds allow", () => {
    /** When the bounds are tightened past what the v0 client emits (20 hints, 200 characters each), reports spanning many repos are lost. */
    const edge = Array.from({ length: 20 }, (_, i) => `acme/${"r".repeat(195 - String(i).length)}${i}`);
    expect(edge.every((r) => r.length === 200)).toBe(true);
    expect(verdicts(withTargetRepos(edge))).toEqual({ zod: true, jsonSchema: true });
  });
});

describe("yak-contract v2: idempotency is v1's, byte for byte", () => {
  const BASE = { device_id: "device-1", execution_id: "execution-1", verb: "issue" as const, summary: "s", body: "b" };
  /** Frozen: each key was computed once by the v1 contract's `deriveIdempotencyKey` (that file is gone) and
   *  cross-checked with `shasum -a 256` over `${device_id}\n${execution_id}\n${verb}\n${canonical JSON}`. */
  const VECTORS: [string, Parameters<typeof deriveIdempotencyKey>[0], string][] = [
    ["with evidence", { ...BASE, evidence: "e" }, "1b0777bf9e621a0b3a4c972733ed0449cb48713b6273ae27be1c5ba24496f1e4"],
    ["without evidence", BASE, "d7dabe89049379cbcf5f811d5e14b88141179fc241ddd31ac92a40fe0642cc46"],
    ["empty evidence, which keys apart from none", { ...BASE, evidence: "" }, "661a60a5dd047e8e3848625008779e309e853e8b1ca856d7bbe1ea486a2dffc9"],
    ["every verb", { ...BASE, verb: "fatal" }, "7546b285831147218eb211734a249997742c225a6fac39fa5f2185651fb32446"],
    ["ids that differ only by where the boundary falls (a)", { ...BASE, device_id: "ab", execution_id: "c" }, "e9e6551d9b43cf7a8e53b3b70619e351b0f4e83df3e0af9d3444e2b6c95c1615"],
    ["ids that differ only by where the boundary falls (b)", { ...BASE, device_id: "a", execution_id: "bc" }, "761da178b311dadd0da4200155959bc8cbb954f59bb107eb9da09fe9d031e493"],
  ];

  it("derives the key a v0 client derived for the same submission", async () => {
    /** When the derivation drifts from v1's, a replayed or migrated report hashes to a new key and is filed twice instead of deduplicated: observed as a derived key differing from the frozen v1 key. */
    for (const [name, vector, expected] of VECTORS) expect({ name, key: await deriveIdempotencyKey(vector) }).toEqual({ name, key: expected });
  });
});

describe("yak-contract v2: the committed JSON Schema", () => {
  it("is what the emitter produces now", () => {
    /** When the Zod contract changes and schema/yak-v2.schema.json is not re-emitted (`bun run emit-schema` in packages/yak-contract), non-TypeScript consumers validate against a stale contract: observed as the committed file differing from a fresh emit. */
    expect({ stale: readFileSync(SCHEMA_FILE, "utf8") !== buildJsonSchema() }).toEqual({ stale: false });
  });
});

describe("yak-contract v2: standalone", () => {
  it("imports only its own files, node builtins and the packages its manifest declares", () => {
    /** When a package file imports outside the package dir, or a dependency its package.json does not declare, the monorepo still builds (hoisting and the shared tree hide it) and the package breaks for every consumer who installs it alone: observed at the import scan of each source file. */
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8"));
    const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }));
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const seen = new Set<string>();
    const stray: string[] = [];
    for (const file of new Bun.Glob("{src,scripts}/**/*.ts").scanSync({ cwd: PACKAGE_DIR, absolute: true })) {
      for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
        seen.add(path);
        const name = path.startsWith("@") ? path.split("/").slice(0, 2).join("/") : path.split("/")[0]!;
        const inside = path.startsWith(".") ? resolve(dirname(file), path).startsWith(`${PACKAGE_DIR}/`) : path.startsWith("node:") || declared.has(name);
        if (!inside) stray.push(`${relative(PACKAGE_DIR, file)} imports ${path}`);
      }
    }
    expect(stray).toEqual([]);
    // The scan sees real imports: a scanner that returned nothing would pass the check above for free.
    expect([...seen]).toEqual(expect.arrayContaining(["zod", "zod-to-json-schema", "./v2", "../src/index"]));
  });
});
