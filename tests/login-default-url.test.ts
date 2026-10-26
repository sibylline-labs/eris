/**
 * Where `eris login` signs in, through the real entrypoint (the shim, or the
 * binary under ERIS_BIN): `--url`, then ERIS_YAKS_URL, then the built-in
 * default `https://api.sibylline.group`.
 *
 * The default is observed without reaching it: the sandbox's HTTPS_PROXY is a
 * loopback CONNECT proxy that records the tunnel eris asks for and refuses it.
 * The env and flag cases point at loopback HTTP endpoints that refuse the
 * device login, so every run ends at its first request and writes nothing.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { sandbox, type Sandbox } from "./helpers/blackbox";

const DEFAULT = "https://api.sibylline.group";

let proxy: Server;
let proxyUrl: string;
const tunnels: string[] = [];

/** A device-login endpoint that refuses every start, recording the paths it saw. */
function endpoint(): { url: string; paths: string[]; stop: () => void } {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      paths.push(new URL(req.url).pathname);
      return Response.json({ error: "invalid_device" }, { status: 400 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, paths, stop: () => server.stop(true) };
}

beforeAll(async () => {
  proxy = createServer((socket) =>
    socket.once("data", (d) => {
      tunnels.push(d.toString().split("\r\n")[0] ?? "");
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    }),
  );
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const addr = proxy.address();
  if (addr === null || typeof addr === "string") throw new Error("proxy has no port");
  proxyUrl = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => proxy.close());

let sb: Sandbox;
afterEach(() => {
  tunnels.length = 0;
  sb?.cleanup();
});

describe("eris login — which endpoint", () => {
  it("with no --url, no ERIS_YAKS_URL and no yaks.json, opens a tunnel to the default host and writes nothing", async () => {
    /** When the default is missing or wrong, a fresh machine's `eris login` fails login-url-unresolved or signs in somewhere else — observed at the CONNECT the proxy received and the host stderr names. */
    sb = sandbox();
    const r = await sb.run(["login", "--no-browser"], { env: { HTTPS_PROXY: proxyUrl } });
    expect({ rc: r.status, stdout: r.stdout }).toEqual({ rc: 1, stdout: "" });
    expect(tunnels).toEqual(["CONNECT api.sibylline.group:443 HTTP/1.1"]);
    expect(r.stderr).toContain("slug: login-unreachable");
    expect(r.stderr).toContain(`cannot reach ${DEFAULT}`);
    expect(existsSync(join(sb.home, ".eris", "yaks.json"))).toBe(false);
  });

  it("ERIS_YAKS_URL beats the default", async () => {
    /** When the default wins over the variable, a self-hosted user's login goes to the public endpoint — observed at which server got the request. */
    sb = sandbox();
    const env = endpoint();
    try {
      const r = await sb.run(["login", "--no-browser"], { env: { HTTPS_PROXY: proxyUrl, ERIS_YAKS_URL: env.url } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("slug: login-refused");
      expect(env.paths).toEqual(["/v1/device/code"]);
      expect(tunnels).toEqual([]);
    } finally {
      env.stop();
    }
  });

  it("--url beats ERIS_YAKS_URL", async () => {
    /** When the variable wins over the flag, `eris login --url X` signs in to whatever the shell profile names — observed at which server got the request. */
    sb = sandbox();
    const flag = endpoint();
    const env = endpoint();
    try {
      const r = await sb.run(["login", "--no-browser", "--url", flag.url], { env: { HTTPS_PROXY: proxyUrl, ERIS_YAKS_URL: env.url } });
      expect(r.status).toBe(1);
      expect(flag.paths).toEqual(["/v1/device/code"]);
      expect(env.paths).toEqual([]);
      expect(tunnels).toEqual([]);
    } finally {
      flag.stop();
      env.stop();
    }
  });

  it("an empty --url is refused before any request, never read as \"use the default\"", async () => {
    /** When `--url ""` falls through to the default, an empty shell expansion (`--url "$UNSET"`) signs a machine in to an endpoint nobody named — observed at the proxy (no tunnel) and the slug. */
    sb = sandbox();
    const r = await sb.run(["login", "--no-browser", "--url", ""], { env: { HTTPS_PROXY: proxyUrl } });
    expect({ rc: r.status, stdout: r.stdout }).toEqual({ rc: 1, stdout: "" });
    expect(r.stderr).toContain("slug: flag-value-missing");
    expect(tunnels).toEqual([]);
  });
});
