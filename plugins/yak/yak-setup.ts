#!/usr/bin/env bun
/**
 * yak-setup.ts — mint this machine's Yaks bearer and write ~/.eris/yaks.json.
 *
 * `eris yak` reads its URL and bearer from ONE file, ~/.eris/yaks.json, mode
 * 0600 (ERIS_YAKS_URL / ERIS_YAKS_TOKEN override each field). The file lives
 * outside every repository on purpose: a per-source token IS the ingest
 * identity, and a repo file is committed. A private file in $HOME is not that,
 * but only while it stays 0600, so the file is created at 0600 here and the
 * reader REFUSES a group- or world-readable one.
 *
 * There is no default host: the URL comes from --url or ERIS_YAKS_URL, and the
 * script refuses without one.
 *
 * THIS SCRIPT DOES HALF THE JOB. The token it mints is meaningless until the
 * endpoint's operator registers it against the `source` slug stamped on every
 * observation. That half belongs to the operator and is not automated here.
 * The final message prints the entry to hand over. The token itself is never
 * printed.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { readArgs } from "../../src/cli/plugin";

const USAGE_LINE = "plugins/yak/yak-setup.ts [--slug <slug>] [--url <url>] [--force]";
/** Not an eris verb, so not in the manifest: the one parser reads this row directly. */
const ROWS = {
  "yak-setup": {
    summary: "Mint this machine's Yaks bearer",
    flags: [
      { name: "--slug", takesValue: true },
      { name: "--url", takesValue: true },
      { name: "--force", takesValue: false },
    ],
  },
} as const;
const USAGE = `Usage: ${USAGE_LINE}

Mint this machine's Yaks bearer and write ~/.eris/yaks.json at mode 0600.

  --slug <slug>   the source slug the bearer maps to (default: yak-<hostname>)
  --url <url>     the Yaks endpoint base URL (default: $ERIS_YAKS_URL; one
                  of the two is required)
  --force         overwrite an existing ~/.eris/yaks.json (mints a NEW bearer;
                  the old one stays live until the operator removes it)

The bearer works only once the endpoint's operator has registered it; the
entry to send them is printed after the file is written.
`;

/** `hostname -s`, lowercased, every byte outside [a-z0-9._-] made '-', trailing '-' dropped. */
function defaultSlug(): string {
  const short = hostname().split(".")[0] ?? "";
  return `yak-${short.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/-+$/, "")}`;
}

/** The `ls -l` mode string of a regular file. */
function modeString(path: string): string {
  const m = statSync(path).mode;
  const bits = "rwxrwxrwx";
  return `-${[...bits].map((c, i) => (m & (1 << (8 - i)) ? c : "-")).join("")}`;
}

function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

export function main(
  argv: string[],
  home: string = process.env.HOME ?? homedir(),
  env: Record<string, string | undefined> = process.env,
): number {
  const io = { erisDir: "", stdout: process.stdout, stderr: process.stderr };
  const p = readArgs(ROWS, "yak-setup", argv, io, {
    help: USAGE,
    refuse: (_e, what) => fail(`${what.charAt(0).toUpperCase()}${what.slice(1)} (usage: ${USAGE_LINE})`),
  });
  if (p === null) return 0;
  const slug = p.flags["--slug"] ?? defaultSlug();
  const url = p.flags["--url"] ?? env.ERIS_YAKS_URL;
  if (!url) fail(`no Yaks URL: pass --url <url> or set ERIS_YAKS_URL (usage: ${USAGE_LINE})`);
  const force = p.flags["--force"];

  // The registry's own grammar for a source slug.
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) fail(`slug '${slug}' fails the registry grammar ^[a-z0-9][a-z0-9._-]*$`);

  const dir = join(home, ".eris");
  const dest = join(dir, "yaks.json");
  if (existsSync(dest) && !force) {
    fail(
      `refusing to overwrite ${dest} (pass --force if that is what you want)\n` +
        "  a rewrite mints a NEW bearer, and the old one keeps working until it is\n" +
        "  removed by the endpoint's operator — you would be leaving a live key behind.",
    );
  }

  // 256 bits. The temp file is CREATED at 0600 (never chmod-after-write, which
  // leaves a readable window on credential material), then renamed so a reader
  // never sees a half-written file.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const tmp = `${dest}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, `{\n  "url": "${url}",\n  "token": "${token}"\n}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, dest);
  } finally {
    rmSync(tmp, { force: true });
  }

  process.stdout.write(
    `wrote ${dest} (${modeString(dest)})

NEXT — the half this script cannot do. The bearer works only once
the operator of ${url} registers it against this machine's source
slug. Send them this entry over a private channel (the token is in
${dest} — it is not reprinted here):

    "<token from ${dest}>": "${slug}"
`,
  );
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
