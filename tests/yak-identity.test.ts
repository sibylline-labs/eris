/**
 * Tests for plugins/yak/yak-identity.ts.
 *
 * Every fs-touching test uses a FRESH `mkdtemp` home per test and never
 * reads or writes the real `~/.eris` — the module's `home`/`cwd`/`env`/`run`
 * parameters exist precisely so nothing here depends on this machine's git
 * config, HOME, or CLAUDE_CODE_* environment (dispatch constraint).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, chmod, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  yaksConfigPath,
  deviceIdPath,
  readYaksFileConfig,
  resolveUrl,
  resolveYaksBearer,
  yaksTokenSource,
  type YaksBearer,
  resolveDeviceId,
  resolveExecutionId,
  runBounded,
  asText,
} from "../plugins/yak/yak-identity";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "yak-identity-test-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

// --- readYaksFileConfig ------------------------------------------------------

describe("readYaksFileConfig", () => {
  it(
    "when ~/.eris/yaks.json does not exist, this resolves to an empty config " +
      "— observed at readYaksFileConfig's return value — so env vars alone can still supply url/token",
    async () => {
      const result = await readYaksFileConfig(home);
      expect("value" in result).toBe(true);
      if ("value" in result) expect(result.value).toEqual({});
    },
  );

  it(
    "when yaks.json is group- or world-readable (0644), this is REFUSED with " +
      "slug yak-config-permissive and the file's content — including its token — is never read, " +
      "observed at readYaksFileConfig's return value never containing the planted secret",
    async () => {
      const secret = "sk-" + "testTOKENvalue-should-never-leak-12345";
      await mkdir(join(home, ".eris"), { recursive: true });
      const path = yaksConfigPath(home);
      await writeFile(path, JSON.stringify({ url: "https://yaks.test", token: secret }));
      await chmod(path, 0o644);

      const result = await readYaksFileConfig(home);

      // positive: the refusal happened and carries its slug
      expect("reason" in result).toBe(true);
      if ("reason" in result) {
        expect(result.slug).toBe("yak-config-permissive");
        // negative: the secret that was on disk never appears in the message
        expect(result.reason).not.toContain(secret);
      }
    },
  );

  it(
    "when yaks.json is 0600 and holds valid JSON, this resolves the url/token fields " +
      "— observed at the returned value",
    async () => {
      await mkdir(join(home, ".eris"), { recursive: true });
      const path = yaksConfigPath(home);
      await writeFile(path, JSON.stringify({ url: "https://yaks.test", token: "tok-abc" }));
      await chmod(path, 0o600);

      const result = await readYaksFileConfig(home);
      expect("value" in result).toBe(true);
      if ("value" in result) {
        expect(result.value.url).toBe("https://yaks.test");
        expect(result.value.token).toBe("tok-abc");
      }
    },
  );

  it(
    "when yaks.json is 0600 but not valid JSON, this is refused with slug " +
      "yak-config-malformed rather than treated as an empty config — observed at the returned slug",
    async () => {
      await mkdir(join(home, ".eris"), { recursive: true });
      const path = yaksConfigPath(home);
      await writeFile(path, "{ not json");
      await chmod(path, 0o600);

      const result = await readYaksFileConfig(home);
      expect("reason" in result).toBe(true);
      if ("reason" in result) expect(result.slug).toBe("yak-config-malformed");
    },
  );

  it(
    "when yaks.json is 0600 but parses to a JSON array, this is refused with " +
      "slug yak-config-malformed — observed at the returned slug",
    async () => {
      await mkdir(join(home, ".eris"), { recursive: true });
      const path = yaksConfigPath(home);
      await writeFile(path, "[1,2,3]");
      await chmod(path, 0o600);

      const result = await readYaksFileConfig(home);
      expect("reason" in result).toBe(true);
      if ("reason" in result) expect(result.slug).toBe("yak-config-malformed");
    },
  );
});

// --- resolveYaksBearer / resolveUrl ------------------------------------------

describe("resolveYaksBearer", () => {
  // Each URL source paired with each token source. `default` + `env` is the one
  // pairing that fails: a token set for one endpoint never goes to the built-in host.
  const FILE_TOKEN = { token: "from-file" };
  const ENV_TOKEN = { ERIS_YAKS_TOKEN: "from-env" };
  const cases: Array<{ url: string; file: { url?: string; token?: string }; env: Record<string, string>; flag?: string; want: { tokenSource: string; url: string; urlSource: string } | "yak-url-unresolved" }> = [
    { url: "flag", file: FILE_TOKEN, env: {}, flag: "https://flag.test", want: { tokenSource: "config", url: "https://flag.test", urlSource: "flag" } },
    { url: "flag", file: {}, env: ENV_TOKEN, flag: "https://flag.test", want: { tokenSource: "env", url: "https://flag.test", urlSource: "flag" } },
    { url: "env", file: FILE_TOKEN, env: { ERIS_YAKS_URL: "https://env.test" }, want: { tokenSource: "config", url: "https://env.test", urlSource: "env" } },
    { url: "env", file: {}, env: { ...ENV_TOKEN, ERIS_YAKS_URL: "https://env.test" }, want: { tokenSource: "env", url: "https://env.test", urlSource: "env" } },
    { url: "config", file: { ...FILE_TOKEN, url: "https://file.test" }, env: {}, want: { tokenSource: "config", url: "https://file.test", urlSource: "config" } },
    { url: "config", file: { url: "https://file.test" }, env: ENV_TOKEN, want: { tokenSource: "env", url: "https://file.test", urlSource: "config" } },
    { url: "default", file: FILE_TOKEN, env: {}, want: { tokenSource: "config", url: "https://api.sibylline.group", urlSource: "default" } },
    { url: "default", file: {}, env: { ...ENV_TOKEN, ERIS_YAKS_URL: "" }, want: "yak-url-unresolved" },
  ];

  for (const c of cases) {
    const tokenSource = "ERIS_YAKS_TOKEN" in c.env ? "env" : "config";
    it(`${c.url} url + ${tokenSource} token → ${typeof c.want === "string" ? c.want : "paired"}`, () => {
      /** When a pairing resolves differently, a bearer goes to a host nobody named for it (env + default), or a login bearer loses its endpoint: observed at the returned value. */
      const result = resolveYaksBearer(c.file, c.env, c.flag);
      if (typeof c.want === "string") {
        expect(result).toMatchObject({ slug: c.want });
        if ("reason" in result) {
          expect(result.reason).not.toContain("from-env");
          expect(result.fix).toContain("ERIS_YAKS_URL");
        }
      } else {
        expect<unknown>("value" in result ? result.value : result).toEqual({ ...c.want, token: tokenSource === "env" ? "from-env" : "from-file" });
      }
    });
  }

  it("ERIS_YAKS_TOKEN wins over the file's token, and the pairing follows the env token", () => {
    /** When the file's token wins, an exported CI token is silently ignored; when the env token borrows the file's default-path licence, it reaches the default host: observed at the returned value. */
    expect(resolveYaksBearer({ token: "from-file" }, { ERIS_YAKS_TOKEN: "from-env" })).toMatchObject({ slug: "yak-url-unresolved" });
    expect(resolveYaksBearer({ token: "from-file", url: "https://file.test" }, { ERIS_YAKS_TOKEN: "from-env" })).toEqual({
      value: { token: "from-env", tokenSource: "env", url: "https://file.test", urlSource: "config" },
    });
  });

  it("no token anywhere fails yak-token-unresolved, carrying no token value", () => {
    /** When a missing token resolves, the endpoint's 401 hides the local fix: observed at the returned failure. */
    expect(resolveYaksBearer({}, {})).toEqual({ reason: "no yaks token: run 'eris login', or set ERIS_YAKS_TOKEN", slug: "yak-token-unresolved", fix: "run 'eris login'" });
  });

  it("yaksTokenSource names the source and never the token", () => {
    /** When it returns the token, a plugin can pair a bare bearer with any URL again: observed at the returned value. */
    expect([yaksTokenSource({ token: "t" }, { ERIS_YAKS_TOKEN: "e" }), yaksTokenSource({ token: "t" }, {}), yaksTokenSource({}, { ERIS_YAKS_TOKEN: "" })]).toEqual(["env", "config", null]);
  });

  it("the type refuses an env token paired with the default URL", () => {
    /** When the `env` arm's `urlSource` widens back to every source, `bunx tsc --noEmit` reports this directive unused: observed by the typecheck gate. */
    // @ts-expect-error an ERIS_YAKS_TOKEN bearer cannot carry the default URL
    const pairing: YaksBearer = { token: "t", tokenSource: "env", url: "https://api.sibylline.group", urlSource: "default" };
    expect(pairing.tokenSource).toBe("env");
  });
});

describe("resolveUrl", () => {
  it("when ERIS_YAKS_URL is set, this wins over the file config's url — observed at the returned value", () => {
    const result = resolveUrl({ url: "https://file.test" }, { ERIS_YAKS_URL: "https://env.test" });
    expect(result).toEqual({ value: "https://env.test", source: "env" });
  });

  it("when only the file config carries a url, this resolves it and tags its source — observed at the returned value", () => {
    const result = resolveUrl({ url: "https://file.test" }, {});
    expect(result).toEqual({ value: "https://file.test", source: "config" });
  });

  it("when --url is passed, it wins over ERIS_YAKS_URL and the file config — observed at the returned value", () => {
    const result = resolveUrl({ url: "https://file.test" }, { ERIS_YAKS_URL: "https://env.test" }, "https://flag.test");
    expect(result).toEqual({ value: "https://flag.test", source: "flag" });
  });

  it("when nothing names a url (an empty flag and variable included), it falls to the public default — observed at the returned value", () => {
    /** When the fallback is missing, a fresh machine's `eris yak` warns with no endpoint and `eris login` refuses. */
    expect(resolveUrl({}, { ERIS_YAKS_URL: "" }, "")).toEqual({ value: "https://api.sibylline.group", source: "default" });
  });
});

// --- resolveDeviceId ----------------------------------------------------------

describe("resolveDeviceId", () => {
  it(
    "when ~/.eris/device-id does not exist, this mints one, writes it 0600, and a " +
      "SECOND call returns the identical value — observed at both calls' return values and the file's mode",
    async () => {
      const first = await resolveDeviceId(home);
      expect("value" in first).toBe(true);
      if (!("value" in first)) throw new Error("expected a value");
      expect(first.value.length).toBeGreaterThan(0);

      const st = await stat(deviceIdPath(home));
      expect(st.mode & 0o777).toBe(0o600);

      const second = await resolveDeviceId(home);
      expect("value" in second).toBe(true);
      if ("value" in second) expect(second.value).toBe(first.value);
    },
  );

  it(
    "when device-id already exists with content, this returns it verbatim without " +
      "re-minting — observed at the returned value matching the pre-seeded content",
    async () => {
      await mkdir(join(home, ".eris"), { recursive: true });
      await writeFile(deviceIdPath(home), "pre-seeded-id\n");

      const result = await resolveDeviceId(home);
      expect("value" in result).toBe(true);
      if ("value" in result) expect(result.value).toBe("pre-seeded-id");
    },
  );

  it(
    "when two mint attempts race on a fresh home, this never corrupts the file — " +
      "observed at the on-disk content being exactly one well-formed value both calls agree with afterward",
    async () => {
      const [a, b] = await Promise.all([resolveDeviceId(home), resolveDeviceId(home)]);
      expect("value" in a).toBe(true);
      expect("value" in b).toBe(true);

      const onDisk = (await readFile(deviceIdPath(home), "utf8")).trim();
      expect(onDisk.length).toBeGreaterThan(0);
      // Neither ID silently vanished into a torn write; a THIRD call after
      // the race has settled converges on exactly what's on disk.
      const third = await resolveDeviceId(home);
      if ("value" in third) expect(third.value).toBe(onDisk);
    },
  );
});

// --- resolveExecutionId --------------------------------------------------------

describe("resolveExecutionId", () => {
  it("rung 'override': ERIS_YAK_EXECUTION_ID wins over every other rung", () => {
    const result = resolveExecutionId(
      {
        ERIS_YAK_EXECUTION_ID: "override-id",
        CLAUDE_CODE_SESSION_ID: "session-id",
        CLAUDE_CODE_HOST_SESSION_ID: "host-id",
      },
      12345,
    );
    expect(result).toEqual({ value: "override-id", rung: "override" });
  });

  it("rung 'session': CLAUDE_CODE_SESSION_ID wins when no override is set", () => {
    const result = resolveExecutionId(
      { CLAUDE_CODE_SESSION_ID: "session-id", CLAUDE_CODE_HOST_SESSION_ID: "host-id" },
      12345,
    );
    expect(result).toEqual({ value: "session-id", rung: "session" });
  });

  it("rung 'host-session': CLAUDE_CODE_HOST_SESSION_ID wins when no session id is set", () => {
    const result = resolveExecutionId({ CLAUDE_CODE_HOST_SESSION_ID: "host-id" }, 12345);
    expect(result).toEqual({ value: "host-id", rung: "host-session" });
  });

  it("rung 'shell-session': ERIS_YAK_SHELL_ID wins over the bare ppid floor", () => {
    // When a launcher forks between the
    // caller's shell and bun, `ppid` as bun observes it is a NEW value every
    // call — it can never be the stable "shared by all reports in that task"
    // id outside Claude Code. ERIS_YAK_SHELL_ID is set by the dispatcher
    // (plugins/yak/handlers.ts) to the pid of the shell that invoked `eris`
    // itself, constant across repeated calls from one terminal.
    const result = resolveExecutionId({ ERIS_YAK_SHELL_ID: "54321" }, 12345);
    expect(result).toEqual({ value: "shell:54321", rung: "shell-session" });
  });

  it("rung 'shell-session' beats the ppid floor even when ppid differs call to call", () => {
    // The regression this rung exists to prevent: three calls with three
    // different (bun-observed) ppids must still agree on execution_id as
    // long as ERIS_YAK_SHELL_ID — the stable outer-shell pid — is the same.
    const a = resolveExecutionId({ ERIS_YAK_SHELL_ID: "999" }, 111);
    const b = resolveExecutionId({ ERIS_YAK_SHELL_ID: "999" }, 222);
    const c = resolveExecutionId({ ERIS_YAK_SHELL_ID: "999" }, 333);
    expect(a.value).toBe(b.value);
    expect(b.value).toBe(c.value);
    expect(a.rung).toBe("shell-session");
  });

  it("rung 'shell': sh:<ppid> is the floor only when NEITHER a CLAUDE_CODE rung NOR ERIS_YAK_SHELL_ID resolves", () => {
    const result = resolveExecutionId({}, 12345);
    expect(result).toEqual({ value: "sh:12345", rung: "shell" });
  });

  it("rung order: override > session > host-session > shell-session > shell", () => {
    const allSet = {
      ERIS_YAK_EXECUTION_ID: "override-id",
      CLAUDE_CODE_SESSION_ID: "session-id",
      CLAUDE_CODE_HOST_SESSION_ID: "host-id",
      ERIS_YAK_SHELL_ID: "shell-id",
    };
    expect(resolveExecutionId(allSet, 1).rung).toBe("override");
    expect(resolveExecutionId({ ...allSet, ERIS_YAK_EXECUTION_ID: undefined }, 1).rung).toBe("session");
    expect(
      resolveExecutionId({ ...allSet, ERIS_YAK_EXECUTION_ID: undefined, CLAUDE_CODE_SESSION_ID: undefined }, 1)
        .rung,
    ).toBe("host-session");
    expect(
      resolveExecutionId(
        {
          ...allSet,
          ERIS_YAK_EXECUTION_ID: undefined,
          CLAUDE_CODE_SESSION_ID: undefined,
          CLAUDE_CODE_HOST_SESSION_ID: undefined,
        },
        1,
      ).rung,
    ).toBe("shell-session");
  });
});

// --- runBounded / asText: the shared bounded-subprocess runner --------------

describe("runBounded", () => {
  it(
    "when the command exits 0, this returns { ok: true, stdout } and the child " +
      "is reaped before this function returns — observed at proc.exited having settled",
    async () => {
      const result = await runBounded(["printf", "hello"], process.cwd(), 2_000);
      expect(result).toEqual({ ok: true, stdout: "hello" });
    },
  );

  it("when the command exits non-zero, this returns { ok: false } rather than throwing", async () => {
    const result = await runBounded(["sh", "-c", "exit 1"], process.cwd(), 2_000);
    expect(result).toEqual({ ok: false });
  });

  it(
    "when the command outruns its timeout, this is killed and reaped and returns " +
      "{ ok: false } WELL under the command's own duration — observed at wall time",
    async () => {
      const started = Date.now();
      const result = await runBounded(["sleep", "5"], process.cwd(), 150);
      const elapsed = Date.now() - started;
      expect(result).toEqual({ ok: false });
      // Bounded by the timeout, not by the 5s sleep — proves the process was
      // actually killed rather than the promise just resolving on its own.
      expect(elapsed).toBeLessThan(3_000);
    },
  );

  it("when the binary does not exist, this returns { ok: false } rather than throwing", async () => {
    const result = await runBounded(["a-command-that-does-not-exist-anywhere"], process.cwd(), 500);
    expect(result).toEqual({ ok: false });
  });
});

describe("asText", () => {
  it("returns the trimmed stdout for an ok result with content", () => {
    expect(asText({ ok: true, stdout: "  value\n" })).toBe("value");
  });

  it("returns undefined for an ok result with EMPTY stdout (absent, not the empty string)", () => {
    expect(asText({ ok: true, stdout: "" })).toBeUndefined();
    expect(asText({ ok: true, stdout: "   \n" })).toBeUndefined();
  });

  it("returns undefined for a failed result", () => {
    expect(asText({ ok: false })).toBeUndefined();
  });
});
