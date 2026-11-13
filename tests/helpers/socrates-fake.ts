/**
 * A fake Socrates endpoint and a temp HOME, for tests that drive `runSocrates` in-process.
 *
 * `fetch` is the `SocratesDeps` seam: it records every request and answers the policy GET, the
 * status GET and the submit POST from `answer`, so a test observes what left the machine, in
 * what order. HOME and the repo are throwaway directories (a `.git` entry bounds the `eris.yaml`
 * walk), so the policy cache and the repo layer are facts of the test.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defaultPolicy, RUBRIC_V2 } from "../../packages/socrates-core/src/index";
import { runSocrates } from "../../plugins/socrates/submit";
import { CliExit } from "../../src/cli/ts-verb";

const REPO = resolve(import.meta.dir, "..", "..");

/** Assembled at runtime so no literal trips a secret scanner. */
export const TOKEN = ["sib", "01HZX3K5Q8W2N4R6T8V0Y2B4D6", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"].join("_");
export const GHP = ["ghp", "Zq8Lr2Vm5Nx7Pk1Ws4Ty6Hb9Jd3Gf0Ca8Ee2"].join("_");
export const ENDPOINT = "https://socrates.example";
export const H1 = "1".repeat(64);
export const H2 = "2".repeat(64);

export const CANDIDATE = ["--title", "Errors use problem+json", "--statement", "Every 4xx/5xx is RFC 7807.", "--source", "https://example.com/pr/14"];

/** Every gate passes and the consequence scores 3, the rubric's threshold. */
export const PASSING: Record<string, string> = {
  already_recorded: "new",
  end_condition: "none",
  owning_layer: "no-other-owner",
  practice: "what-the-system-is",
  reversibility: "more-than-a-setting",
  premise_basis: "observed",
  consequence: "a-service-contract",
};
export const answers = (over: Record<string, string> = {}) => Object.entries({ ...PASSING, ...over }).flatMap(([q, v]) => ["--answer", `${q}=${v}`]);

export const policyResult = (hash: string, policy: object, rubric_version = "rubric@v2") => ({ rubric_version, policy_hash: hash, policy, contract_version: "1.0.0" });
export const ORG_V2 = { ...defaultPolicy(RUBRIC_V2), threshold: 5 };

export interface Call {
  method: string;
  path: string;
  /** The query string, without the `?`. */
  search: string;
  body: unknown;
}

export interface Driven {
  rc: number;
  stdout: string;
  stderr: string;
  slug: string | undefined;
}

export interface DriveOptions {
  format?: "text" | "json";
  env?: Record<string, string>;
  /** Text `--evidence-file -` reads; stdin is a pipe. */
  stdin?: string;
  /** Stdin is a terminal. */
  stdinIsTty?: boolean;
}

export interface SocratesFake {
  /** Physical paths. */
  home: string;
  cwd: string;
  calls: Call[];
  /** What each route answers; a test replaces one. */
  answer: { policy: () => Response; status: () => Response; submit: () => Response };
  drive(args: string[], opts?: DriveOptions): Promise<Driven>;
  cachePath(): string;
  /** Cache `result` as fetched `ageMs` ago. */
  writeCache(result: object, ageMs?: number): void;
  erisYaml(text: string): void;
  /** A file under the repo; its absolute path. */
  file(name: string, text: string): string;
  cleanup(): void;
}

export function socratesFake(): SocratesFake {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "eris-socrates-home-")));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "eris-socrates-repo-")));
  mkdirSync(join(cwd, ".git"));
  writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(home, ".eris"));
  const fake: SocratesFake = {
    home,
    cwd,
    calls: [],
    answer: {
      policy: () => Response.json(policyResult(H1, ORG_V2)),
      status: () => Response.json({}),
      submit: () => Response.json({ candidate_id: "cand_1", deduped: false, contract_version: "1.0.0" }),
    },
    cachePath: () => join(home, ".eris", "socrates-policy.json"),
    writeCache(result, ageMs = 0) {
      writeFileSync(fake.cachePath(), JSON.stringify({ ...result, fetched_at: new Date(Date.now() - ageMs).toISOString() }));
    },
    erisYaml: (text) => writeFileSync(join(cwd, "eris.yaml"), text),
    file(name, text) {
      const path = join(cwd, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      return path;
    },
    cleanup() {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
    async drive(args, opts = {}) {
      let stdout = "";
      let stderr = "";
      const ctx = {
        erisDir: REPO,
        env: opts.env ?? { HOME: home, ERIS_YAKS_URL: ENDPOINT, ERIS_YAKS_TOKEN: TOKEN },
        format: opts.format ?? "text",
        stdout: { write: (s: string) => ((stdout += s), true) },
        stderr: { write: (s: string) => ((stderr += s), true) },
      };
      const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        fake.calls.push({ method: init?.method ?? "GET", path: url.pathname, search: url.search.slice(1), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
        if (url.pathname === "/v1/socrates/policy") return fake.answer.policy();
        if (url.pathname === "/v1/socrates/status") return fake.answer.status();
        return fake.answer.submit();
      }) as unknown as typeof globalThis.fetch;
      let rc: number;
      try {
        rc = await runSocrates(args, ctx, {
          fetch,
          home,
          cwd,
          ...(opts.stdin === undefined && opts.stdinIsTty !== true ? {} : { readStdin: async () => opts.stdin ?? "", isStdinTTY: () => opts.stdinIsTty === true }),
        });
      } catch (e) {
        if (!(e instanceof CliExit)) throw e;
        rc = e.code;
      }
      const slug = stderr.split("\n").find((l) => l.startsWith("slug: "))?.slice("slug: ".length);
      return { rc, stdout, stderr, slug };
    },
  };
  return fake;
}

/** The `fix:` text of a failure block: from its `fix: ` line up to the `docs: ` line. */
export function fixOf(stderr: string): string {
  const lines = stderr.split("\n");
  const at = lines.findIndex((l) => l.startsWith("fix: "));
  const end = lines.findIndex((l, i) => i > at && l.startsWith("docs: "));
  return lines.slice(at, end === -1 ? undefined : end).join("\n").slice("fix: ".length);
}
