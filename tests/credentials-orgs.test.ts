/**
 * One `eris login` bearer per org in ~/.eris/yaks.json: the org a directory
 * acts as (`ERIS_ORG`, else `repo.org` in the nearest `eris.yaml` that names
 * one, else the default), and the flat view of the file each client reads.
 *
 * The seam is src/runtime/credentials.ts over a sandbox HOME and sandbox
 * checkouts under .scratch/. Bearers are assembled at runtime so no literal
 * trips a secret scanner.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  addOrgLogin,
  readYaksFileConfig,
  removeOrgLogin,
  resolveOrgBearer,
  resolveOrgSelection,
  selectOrgConfig,
  tokenOrg,
  writeYaksFileConfig,
  type OrgSelection,
  type YaksFileConfig,
} from "../src/runtime/credentials";

const REPO = resolve(import.meta.dir, "..");
const B64 = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
const ORG_A = "01HZX3K5Q8W2N4R6T8V0Y2B4D6";
const ORG_B = "01J0AAAAAAAAAAAAAAAAAAAAAB";
const ORG_C = "01J0CCCCCCCCCCCCCCCCCCCCCC";
const bearer = (org: string, tail = B64) => ["sib", org, tail].join("_");
const TOKEN_A = bearer(ORG_A);
const TOKEN_B = bearer(ORG_B);
const URL_A = "https://a.example.test";
const URL_B = "https://b.example.test";
const DEFAULT: OrgSelection = { org: null, source: "default" };

mkdirSync(join(REPO, ".scratch"), { recursive: true });
const sandbox = realpathSync(mkdtempSync(join(REPO, ".scratch", "orgs-")));
let root: string;

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(sandbox, "t-")));
});

/** A checkout at `dir` (a `.git` directory) with an optional root eris.yaml. */
function checkout(dir: string, yaml?: string): string {
  const path = join(root, dir);
  mkdirSync(join(path, ".git"), { recursive: true });
  if (yaml !== undefined) writeFileSync(join(path, "eris.yaml"), yaml);
  return path;
}

function writeStore(home: string, body: unknown): void {
  mkdirSync(join(home, ".eris"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".eris", "yaks.json"), JSON.stringify(body), { mode: 0o600 });
}

describe("tokenOrg", () => {
  // admits: a lookalike bearer (case, length, prefix) keyed into an org slot; the shape is a runtime string
  it("reads the org a sib_ bearer claims, and nothing from any other shape", () => {
    expect(tokenOrg(TOKEN_A)).toBe(ORG_A);
    for (const other of [undefined, "", "plain-token", bearer(ORG_A.toLowerCase()), bearer(`${ORG_A}X`), bearer(ORG_A, B64.slice(1)), ["ghp", ORG_A, B64].join("_"), bearer("01HZX3K5Q8W2N4R6T8V0Y2B4DU")]) {
      expect(tokenOrg(other)).toBeNull();
    }
  });
});

describe("resolveOrgSelection", () => {
  // admits: a leaf without repo.org selecting some org; walk results depend on files on disk
  it("is the default with no ERIS_ORG and no repo.org up to the checkout root", async () => {
    const repo = checkout("a", "service: a\nrepo:\n  github: a\n");
    mkdirSync(join(repo, "svc"), { recursive: true });
    writeFileSync(join(repo, "svc", "eris.yaml"), "service: svc\n");
    expect(await resolveOrgSelection({}, join(repo, "svc"))).toEqual({ value: { org: null, source: "default" } });
  });

  // admits: the walk stopping at a leaf that names no org; walk results depend on files on disk
  it("takes repo.org from the nearest manifest that names one, walking past a leaf that does not", async () => {
    const repo = checkout("b", `service: b\nrepo:\n  org: ${ORG_B}\n`);
    mkdirSync(join(repo, "svc", "deep"), { recursive: true });
    writeFileSync(join(repo, "svc", "eris.yaml"), "service: svc\n");
    const path = join(repo, "eris.yaml");
    expect(await resolveOrgSelection({}, join(repo, "svc", "deep"))).toEqual({ value: { org: ORG_B, source: "eris.yaml", path } });
  });

  // admits: the root overriding a leaf that selects its own org; walk order is runtime
  it("lets a leaf's repo.org win over the root's", async () => {
    const repo = checkout("c", `service: c\nrepo:\n  org: ${ORG_A}\n`);
    mkdirSync(join(repo, "svc"), { recursive: true });
    writeFileSync(join(repo, "svc", "eris.yaml"), `service: svc\nrepo:\n  org: ${ORG_B}\n`);
    expect(await resolveOrgSelection({}, join(repo, "svc"))).toEqual({ value: { org: ORG_B, source: "eris.yaml", path: join(repo, "svc", "eris.yaml") } });
  });

  // admits: a manifest above the checkout selecting the org of a nested repo; the boundary is a filesystem fact
  it("stops at the checkout root, never reading a manifest above it", async () => {
    writeFileSync(join(root, "eris.yaml"), `service: outer\nrepo:\n  org: ${ORG_B}\n`);
    const inner = checkout("inner");
    expect(await resolveOrgSelection({}, inner)).toEqual({ value: { org: null, source: "default" } });
    // Control: without the inner checkout boundary the outer manifest is found.
    mkdirSync(join(root, "plain"), { recursive: true });
    const found = await resolveOrgSelection({}, join(root, "plain"));
    expect("value" in found && found.value.org).toBe(ORG_B);
  });

  // admits: repo.org overriding an explicit ERIS_ORG; precedence is runtime
  it("puts ERIS_ORG ahead of repo.org", async () => {
    const repo = checkout("d", `service: d\nrepo:\n  org: ${ORG_B}\n`);
    expect(await resolveOrgSelection({ ERIS_ORG: ORG_C }, repo)).toEqual({ value: { org: ORG_C, source: "env" } });
  });

  // admits: a broken selector falling back to the default org (NFR-FAILCLOSED-1); manifest contents are runtime
  it("fails closed on a malformed id and on a manifest it cannot parse", async () => {
    const bad = checkout("e", "service: e\nrepo:\n  org: hypothetical\n");
    const r1 = await resolveOrgSelection({}, bad);
    expect("slug" in r1 && r1.slug).toBe("org-selector-invalid");
    const r2 = await resolveOrgSelection({ ERIS_ORG: "nope" }, bad);
    expect("slug" in r2 && r2.slug).toBe("org-selector-invalid");
    const broken = checkout("f", "service: [unclosed\n");
    const r3 = await resolveOrgSelection({}, broken);
    expect("slug" in r3 && r3.slug).toBe("org-selector-invalid");
  });
});

describe("selectOrgConfig", () => {
  const file: YaksFileConfig = { url: URL_A, token: TOKEN_A, orgs: { [ORG_B]: { url: URL_B, token: TOKEN_B } } };
  const sel = (org: string): OrgSelection => ({ org, source: "env" });

  // admits: the zero-touch migration changing what a single-org file resolves to; behaviour over data
  it("reads a single-org file exactly as before for the default selection", () => {
    expect(selectOrgConfig({ url: URL_A, token: "legacy" }, DEFAULT, {})).toEqual({ value: { config: { url: URL_A, token: "legacy" }, org: null, isDefault: true } });
    expect(selectOrgConfig(file, DEFAULT, {})).toEqual({ value: { config: { url: URL_A, token: TOKEN_A }, org: ORG_A, isDefault: true } });
  });

  // admits: a selected org reading the wrong slot; slot choice depends on the token inside the data
  it("gives a selected org its own entry, and the default org the top-level one", () => {
    expect(selectOrgConfig(file, sel(ORG_B), {})).toEqual({ value: { config: { url: URL_B, token: TOKEN_B }, org: ORG_B, isDefault: false } });
    expect(selectOrgConfig(file, sel(ORG_A), {})).toEqual({ value: { config: { url: URL_A, token: TOKEN_A }, org: ORG_A, isDefault: true } });
  });

  // admits: a selected org silently borrowing the default org's bearer; the store's contents are data
  it("refuses an org this machine is not signed in to, never lending the default's bearer", () => {
    const r = selectOrgConfig(file, sel(ORG_C), {});
    expect("slug" in r && r.slug).toBe("org-not-signed-in");
    expect(JSON.stringify(r)).not.toContain(B64);
  });

  // admits: an env bearer for org A acting in an org B repo; the token's org is inside a runtime string
  it("lets ERIS_YAKS_TOKEN act only as its own org", () => {
    expect(selectOrgConfig(file, sel(ORG_B), { ERIS_YAKS_TOKEN: TOKEN_B })).toEqual({ value: { config: { url: URL_B }, org: ORG_B, isDefault: false } });
    for (const envToken of [TOKEN_A, "not-a-sib-token"]) {
      const r = selectOrgConfig(file, sel(ORG_B), { ERIS_YAKS_TOKEN: envToken });
      expect("slug" in r && r.slug).toBe("org-token-mismatch");
      expect(JSON.stringify(r)).not.toContain(B64);
    }
    expect(selectOrgConfig(file, DEFAULT, { ERIS_YAKS_TOKEN: TOKEN_B })).toEqual({ value: { config: { url: URL_A, token: TOKEN_A }, org: ORG_B, isDefault: true } });
  });
});

describe("addOrgLogin / removeOrgLogin", () => {
  // admits: a second org login replacing the default sign-in; merge semantics over data
  it("fills the default slot first, adds another org beside it, and re-login replaces in place", () => {
    const first = addOrgLogin({}, URL_A, TOKEN_A);
    expect(first).toEqual({ config: { url: URL_A, token: TOKEN_A }, org: ORG_A, asDefault: true, replaced: false });
    const second = addOrgLogin(first.config, URL_B, TOKEN_B);
    expect(second).toEqual({ config: { url: URL_A, token: TOKEN_A, orgs: { [ORG_B]: { url: URL_B, token: TOKEN_B } } }, org: ORG_B, asDefault: false, replaced: false });
    const rotated = bearer(ORG_B, `${B64.slice(0, 42)}Z`);
    const again = addOrgLogin(second.config, URL_B, rotated);
    expect(again.config.orgs).toEqual({ [ORG_B]: { url: URL_B, token: rotated } });
    expect({ asDefault: again.asDefault, replaced: again.replaced }).toEqual({ asDefault: false, replaced: true });
  });

  // admits: a legacy non-sib default being kept beside a new login and shadowing it; data-dependent
  it("replaces a default whose org cannot be read, as a single-org file always did", () => {
    expect(addOrgLogin({ url: URL_A, token: "legacy" }, URL_B, TOKEN_B)).toEqual({ config: { url: URL_B, token: TOKEN_B }, org: ORG_B, asDefault: true, replaced: true });
  });

  // admits: logout removing every org or the wrong one; data-dependent
  it("signs out only the selected org", () => {
    const file: YaksFileConfig = { url: URL_A, token: TOKEN_A, orgs: { [ORG_B]: { url: URL_B, token: TOKEN_B } } };
    expect(removeOrgLogin(file, { org: ORG_B, source: "env" })).toEqual({ config: { url: URL_A, token: TOKEN_A }, removed: true });
    expect(removeOrgLogin(file, DEFAULT)).toEqual({ config: { url: URL_A, orgs: { [ORG_B]: { url: URL_B, token: TOKEN_B } } }, removed: true });
    expect(removeOrgLogin(file, { org: ORG_C, source: "env" })).toEqual({ config: file, removed: false });
  });
});

describe("the store on disk", () => {
  // admits: the orgs map lost on write, a permissive mode, or a mis-keyed entry routing a bearer; fs facts
  it("round-trips orgs at mode 0600 and drops an entry keyed by another org", async () => {
    const home = join(root, "home");
    writeStore(home, { url: URL_A, token: TOKEN_A, orgs: { [ORG_B]: { url: URL_B, token: TOKEN_B }, [ORG_C]: { token: TOKEN_B }, junk: { token: "x" } } });
    const read = await readYaksFileConfig(home);
    expect(read).toEqual({ value: { url: URL_A, token: TOKEN_A, orgs: { [ORG_B]: { url: URL_B, token: TOKEN_B } } } });
    const written = await writeYaksFileConfig(addOrgLogin({}, URL_A, TOKEN_A).config, home);
    expect("value" in written).toBe(true);
    await writeYaksFileConfig({ url: URL_A, token: TOKEN_A, orgs: { [ORG_B]: { url: URL_B, token: TOKEN_B } } }, home);
    expect(statSync(join(home, ".eris", "yaks.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(home, ".eris", "yaks.json"), "utf8"))).toEqual({ url: URL_A, token: TOKEN_A, orgs: { [ORG_B]: { url: URL_B, token: TOKEN_B } } });
  });

  // admits: end to end through one call: repo A acting as B or an unknown org lending A; fs + data
  it("resolves each repo's bearer in one call, and fails closed with the login fix", async () => {
    const home = join(root, "home");
    writeStore(home, { url: URL_A, token: TOKEN_A, orgs: { [ORG_B]: { url: URL_B, token: TOKEN_B } } });
    const a = checkout("repo-a", "service: a\n");
    const b = checkout("repo-b", `service: b\nrepo:\n  org: ${ORG_B}\n`);
    const c = checkout("repo-c", `service: c\nrepo:\n  org: ${ORG_C}\n`);
    const ra = await resolveOrgBearer({ home, env: {}, cwd: a });
    const rb = await resolveOrgBearer({ home, env: {}, cwd: b });
    expect("value" in ra && [ra.value.token, ra.value.url, ra.value.org, ra.value.isDefault]).toEqual([TOKEN_A, URL_A, ORG_A, true]);
    expect("value" in rb && [rb.value.token, rb.value.url, rb.value.org, rb.value.isDefault]).toEqual([TOKEN_B, URL_B, ORG_B, false]);
    const rc = await resolveOrgBearer({ home, env: {}, cwd: c });
    expect("slug" in rc && [rc.slug, rc.fix.includes("eris login")]).toEqual(["org-not-signed-in", true]);
  });
});
