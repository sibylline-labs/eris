/**
 * The `paths` of the repository's tsconfig.json: how the specifiers a dependent
 * repository writes (`eris/sdk`, under the dependency key `eris`) resolve in
 * this tree, where no such dependency is installed. Read with the TypeScript
 * compiler's own reader, because the file carries comments.
 */

import { join } from "node:path";
import ts from "typescript";
import { REPO } from "./blackbox";

export function erisPaths(): Record<string, string[]> {
  const { config, error } = ts.readConfigFile(join(REPO, "tsconfig.json"), ts.sys.readFile);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  return (config as { compilerOptions: { paths: Record<string, string[]> } }).compilerOptions.paths;
}
