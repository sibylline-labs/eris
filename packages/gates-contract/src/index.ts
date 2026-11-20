/**
 * `eris/gates-contract`: the doctrine `policy:` contract and what reads it, with no CLI runtime.
 *
 *   - the Schema: `DoctrinePolicy` (policy.ts) over the base `GateDoctrinePolicy` (doctrine.ts),
 *     the floor constants and the `.claude/surfaces.yml` Schema (surfaces.ts);
 *   - the explanations each knob carries, and the machinery that reads them (explain.ts);
 *   - the doctrine.md reader (file.ts), the active posture, its hash and citation (active.ts), and
 *     the evaluators: gate modes, the effective gate map, requirements, lifts, remediation, asks;
 *   - the profiles a gate map is taken over (profile.ts);
 *   - the effect-sentence engine (effect.ts) and the JSON Schema document (schema.ts);
 *   - `decodeResult` / `decodeResultStrict`, the value-stripping decode every problem line uses;
 *   - the `/v1/linear` and yak lookup replies (linear.ts), and the bounded 429 retry the verbs share
 *     (retry.ts);
 *   - the hosted org policy bundle (bundle.ts): its Schema, `bundle_sha`, and the files it is written
 *     to disk as; and the client for the hosted gates API (client.ts, docs/dev/GATES-CLIENT.md).
 *
 * A read that cannot go on returns a `ContractFailure` (failure.ts) for the caller to render.
 */

export * from "./active";
export * from "./bundle";
export * from "./client";
export * from "./decode";
export * from "./doctrine";
export * from "./effect";
export * from "./explain";
export * from "./explains";
export * from "./failure";
export * from "./file";
export * from "./policy";
export * from "./profile";
export * from "./schema";
export * from "./signoff";
export * from "./surfaces";
export * from "./grants";
export * from "./linear";
export * from "./retry";
export * from "./receipt";
export * from "./review-report";
export * from "./surfaces-eval";
export * from "./monotone";
export * from "./ladder";
export * from "./remediate";
