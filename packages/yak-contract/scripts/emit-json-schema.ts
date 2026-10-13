/**
 * Emits schema/yak-v2.schema.json from the Zod contract: the contract for
 * consumers that are not TypeScript. The file is committed, and the repo's
 * tests fail when it differs from a fresh emit. Re-emit with `bun run
 * emit-schema` in this package.
 *
 * `removeAdditionalStrategy: "strict"` makes an object accept unknown keys, as
 * the Zod schemas do (they strip them). The library's default would refuse a
 * payload that still carries a dropped field such as `reporter`.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { YakCluster, YakObservation, YakReceipt, YakSubmission } from "../src/index";

export const SCHEMA_FILE = fileURLToPath(new URL("../schema/yak-v2.schema.json", import.meta.url));

export function buildJsonSchema(): string {
  const defs = { YakSubmission, YakReceipt, YakObservation, YakCluster };
  const definitions = Object.fromEntries(
    Object.entries(defs).map(([name, schema]) => {
      const { $schema: _omit, ...body } = zodToJsonSchema(schema, { $refStrategy: "none", removeAdditionalStrategy: "strict" }) as Record<string, unknown>;
      return [name, body];
    }),
  );
  return `${JSON.stringify({ $schema: "http://json-schema.org/draft-07/schema#", title: "Eris Yaks wire contract v2", $ref: "#/definitions/YakSubmission", definitions }, null, 2)}\n`;
}

if (import.meta.main) writeFileSync(SCHEMA_FILE, buildJsonSchema());
