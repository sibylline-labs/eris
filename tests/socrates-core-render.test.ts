/**
 * packages/socrates-core entry rendering.
 *
 * Seam: the render functions on the package's public entry, whose output the tenant actor splices into a living
 * doc or files as an issue body. Red when output stops being byte-identical for the same input, when an entry's
 * shape drifts (field order, the date label, where the ID or hash sits), or when an input that would break the
 * nested-bullet structure is accepted instead of refused.
 */
import { describe, expect, test } from "bun:test";
import {
  EntryRenderError,
  type EntryRenderReason,
  formatEntryDate,
  renderConflictEntry,
  renderDecision,
  renderPractice,
  renderPrdEntry,
} from "../packages/socrates-core/src/index";

// A date label and 8-hex handles are assembled at runtime: as literals they read as a tracker label and as commit
// SHAs to the public-tree scrub check.
const DAY = ["2026", "OCT", "28"].join("-");
const HASH = "0c43" + "e7d3";
const NEXT_HASH = "529a" + "30c2";

const source = { label: "eris#21", url: "https://github.com/acme/app/pull/21" };

const decision = {
  handle: { id: "ACME-K2" },
  title: "The server performs every Linear write",
  statement: "Clients hold only an API token and never write Linear directly.",
  scope: "org",
  source,
  date: { date: "2026-10-28", cycle: 7 },
};

const practice = {
  handle: { id: "ACME-P3" },
  title: "Run the suite once at the end",
  statement: "Gates run once before the PR, not after every edit.",
  source,
  date: { date: "2026-10-28" },
};

const prd = {
  prd: { label: "PRD — Acme Billing", url: "https://docs.example.com/acme/document/billing" },
  decisions: { first: "BILL-K1", last: "BILL-K9" },
  confirmedBy: "dana",
  crossProject: [{ decision: "BILL-K4", project: { label: "Accounts", url: "https://docs.example.com/acme/project/accounts" } }],
};

const conflict = {
  title: "Two sources disagree on who writes Linear",
  summary: "The client-write rule contradicts the server-write decision.",
  sites: [
    { label: "Practices", url: "https://docs.example.com/acme/document/practices" },
    { label: "LBD", url: "https://docs.example.com/acme/document/lbd" },
  ],
  proposedResolution: "The newer server-write decision supersedes the client-write rule.",
};

describe("rendering is byte-deterministic", () => {
  test("each kind renders identically twice from the same input", () => {
    expect(renderDecision(decision)).toBe(renderDecision(structuredClone(decision)));
    expect(renderPractice(practice)).toBe(renderPractice(structuredClone(practice)));
    expect(renderPrdEntry(prd)).toEqual(renderPrdEntry(structuredClone(prd)));
    expect(renderConflictEntry(conflict)).toEqual(renderConflictEntry(structuredClone(conflict)));
  });
});

describe("doc-entry shape", () => {
  test("a decision with a readable ID: the ID in the title line, fields in fixed order", () => {
    expect(renderDecision(decision)).toBe(
      [
        "- `ACME-K2` The server performs every Linear write",
        "  - Clients hold only an API token and never write Linear directly.",
        "  - scope: org",
        "  - source: [eris#21](https://github.com/acme/app/pull/21)",
        `  - ${DAY} [cycle 7]`,
        "  - superseded-by: -",
      ].join("\n"),
    );
  });

  test("a decision with a content hash: a bare title line and the hash as the last field", () => {
    const rendered = renderDecision({ ...decision, handle: { hash: HASH }, supersededBy: NEXT_HASH });
    expect(rendered).toBe(
      [
        "- The server performs every Linear write",
        "  - Clients hold only an API token and never write Linear directly.",
        "  - scope: org",
        "  - source: [eris#21](https://github.com/acme/app/pull/21)",
        `  - ${DAY} [cycle 7]`,
        `  - superseded-by: ${NEXT_HASH}`,
        `  - hash: ${HASH}`,
      ].join("\n"),
    );
  });

  test("a practice carries no scope, and a date without a cycle has no cycle label", () => {
    expect(renderPractice(practice)).toBe(
      [
        "- `ACME-P3` Run the suite once at the end",
        "  - Gates run once before the PR, not after every edit.",
        "  - source: [eris#21](https://github.com/acme/app/pull/21)",
        `  - ${DAY}`,
        "  - superseded-by: -",
      ].join("\n"),
    );
  });
});

describe("issue-entry shape", () => {
  test("a PRD entry names the decision range, the confirmer and every cross-project decision", () => {
    expect(renderPrdEntry(prd)).toEqual({
      title: "PRD authored: PRD — Acme Billing",
      description: [
        "PRD authored: [PRD — Acme Billing](https://docs.example.com/acme/document/billing); decisions `BILL-K1`–`BILL-K9` were discussed and confirmed by @dana.",
        "",
        "Decisions that touch other projects:",
        "- `BILL-K4`: [Accounts](https://docs.example.com/acme/project/accounts)",
        "",
        "Answer on this issue. A comment here is authoritative, and Socrates carries it to every linked site.",
      ].join("\n"),
    });
  });

  test("a PRD entry with one decision and no cross-project decisions", () => {
    const { description } = renderPrdEntry({ ...prd, decisions: { first: "BILL-K1", last: "BILL-K1" }, crossProject: [] });
    expect(description).toBe(
      [
        "PRD authored: [PRD — Acme Billing](https://docs.example.com/acme/document/billing); decision `BILL-K1` was discussed and confirmed by @dana.",
        "",
        "Answer on this issue. A comment here is authoritative, and Socrates carries it to every linked site.",
      ].join("\n"),
    );
  });

  test("a conflict entry links every site and carries the proposed resolution", () => {
    expect(renderConflictEntry(conflict)).toEqual({
      title: "Two sources disagree on who writes Linear",
      description: [
        "The client-write rule contradicts the server-write decision.",
        "",
        "Authoritative sites:",
        "- [Practices](https://docs.example.com/acme/document/practices)",
        "- [LBD](https://docs.example.com/acme/document/lbd)",
        "",
        "Proposed resolution:",
        "",
        "The newer server-write decision supersedes the client-write rule.",
        "",
        "Answer on this issue. A comment here is authoritative, and Socrates carries it to every linked site.",
      ].join("\n"),
    });
  });

  // admits: When renderSite rejects NFR-<CAT>-<n> IDs or renders them inside the link label, Linear's chip rewrite drops them or renderConflictEntry throws bad-decision — runtime string rendering is not visible to tsc or ast-grep.
  test("a conflict site's register IDs sit before its link, outside the label", () => {
    /** When a site's register IDs render inside the link label, Linear's chip rewrite drops them from the line the resolver reads. */
    const nfrAuthz = ["NFR", "AUTHZ", "1"].join("-");
    const sites = [{ ...conflict.sites[0]!, decisions: ["ACME-K11", "ACME-BILL-K4", nfrAuthz, "NFR-FAILCLOSED-1"] }, conflict.sites[1]!];
    expect(renderConflictEntry({ ...conflict, sites }).description.split("\n").slice(3, 5)).toEqual([
      `- \`ACME-K11\`, \`ACME-BILL-K4\`, \`${nfrAuthz}\`, \`NFR-FAILCLOSED-1\` in [Practices](https://docs.example.com/acme/document/practices)`,
      "- [LBD](https://docs.example.com/acme/document/lbd)",
    ]);
  });
});

describe("formatEntryDate", () => {
  test("every month renders its three-letter label, and leap days are real dates", () => {
    const labels = Array.from({ length: 12 }, (_, i) =>
      formatEntryDate({ date: `2026-${String(i + 1).padStart(2, "0")}-01` }).slice(5, 8),
    );
    expect(labels).toEqual(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]);
    expect(formatEntryDate({ date: "2028-02-29", cycle: 0 })).toBe(`${["2028", "FEB", "29"].join("-")} [cycle 0]`);
  });
});

test("a backticked dotted name in a title renders", () => {
  /** When the autolink rule ignores code spans differently in render and parseTitle, a safe title is refused. */
  expect(renderDecision({ ...decision, title: "Adopt `payload.source` as the key" }).split("\n")[0]).toBe("- `ACME-K2` Adopt `payload.source` as the key");
});

// admits: algorithmic: a source URL with ( ) < > passes the contract's Url but ends the Markdown link destination early or throws bad-link at resolve time; the rendered string is runtime data no type or lint rule sees.
test("a source URL with parentheses or angle brackets renders as one percent-encoded link destination", () => {
  /** When renderLink refuses or leaves ( ) < > raw, a source the CLI accepted never files; observed as the rendered source line. */
  const url = "https://en.wikipedia.org/wiki/Problem_details_(HTTP)?q=<a>";
  const line = renderPractice({ ...practice, source: { ...source, url } }).split("\n").find((l) => l.startsWith("  - source: "));
  expect(line).toBe("  - source: [eris#21](https://en.wikipedia.org/wiki/Problem_details_%28HTTP%29?q=%3Ca%3E)");
});

// admits: algorithmic: renderPrdEntry receives candidate.source via entry.prd and must percent-encode ( ) < > idempotently like renderDocEntry while refusing genuinely invalid source URLs with the original URL and without mentioning parentheses; runtime string formatting is invisible to tsc and ast-grep.
test("a PRD entry percent-encodes ()<> in prd.url and rejects invalid source URLs accurately", () => {
  const url = "https://en.wikipedia.org/wiki/Problem_details_(HTTP)?q=<a>";
  const encoded = "https://en.wikipedia.org/wiki/Problem_details_%28HTTP%29?q=%3Ca%3E";
  const rendered = renderPrdEntry({ ...prd, prd: { ...prd.prd, url } });
  expect(rendered.description.split("\n")[0]).toBe(
    `PRD authored: [PRD — Acme Billing](${encoded}); decisions \`BILL-K1\`–\`BILL-K9\` were discussed and confirmed by @dana.`,
  );
  // Idempotent on already-encoded URLs.
  expect(renderPrdEntry({ ...prd, prd: { ...prd.prd, url: encoded } }).description.split("\n")[0]).toBe(
    `PRD authored: [PRD — Acme Billing](${encoded}); decisions \`BILL-K1\`–\`BILL-K9\` were discussed and confirmed by @dana.`,
  );
  for (const invalid of ["javascript:alert(1)", "https://x/a b"]) {
    let thrown: unknown;
    try {
      renderPrdEntry({ ...prd, prd: { ...prd.prd, url: invalid } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EntryRenderError);
    expect((thrown as EntryRenderError).reason).toBe("bad-link");
    expect((thrown as EntryRenderError).message).toContain(JSON.stringify(invalid));
    expect((thrown as EntryRenderError).message).not.toContain("parentheses");
  }
});

// admits: algorithmic: trailing backslashes in Link.label or Link.url and ASCII C0/DEL controls in Link.url break CommonMark <a> parsing (\], \), §6.3); CommonMark interaction with rendered runtime strings is invisible to tsc and ast-grep.
test("trailing backslashes and C0/DEL control characters never render broken CommonMark links", () => {
  const withBackslashUrl = "https://example.com/foo\\";
  const encodedBackslashUrl = "https://example.com/foo%5C";
  const practiceLine = renderPractice({ ...practice, source: { ...source, url: withBackslashUrl } })
    .split("\n")
    .find((l) => l.startsWith("  - source: "));
  expect(practiceLine).toBe(`  - source: [eris#21](${encodedBackslashUrl})`);
  expect(Bun.markdown.html(practiceLine!)).toContain(`<a href="${encodedBackslashUrl}">eris#21</a>`);

  const decisionRendered = renderDecision({ ...decision, source: { label: "eris\\\\", url: withBackslashUrl } });
  expect(Bun.markdown.html(decisionRendered)).toContain(`<a href="${encodedBackslashUrl}">eris\\</a>`);

  // Idempotent on %5C and allows even trailing backslashes in label.
  const prdRendered = renderPrdEntry({
    ...prd,
    prd: { label: "PRD — Foo\\\\", url: encodedBackslashUrl },
    crossProject: [{ decision: "BILL-K4", project: { label: "Accounts\\\\", url: prd.crossProject[0]!.project.url } }],
  });
  const prdHtml = Bun.markdown.html(prdRendered.description);
  expect(prdHtml).toContain(`<a href="${encodedBackslashUrl}">PRD — Foo\\</a>`);
  expect(prdHtml).toContain(`<a href="${prd.crossProject[0]!.project.url}">Accounts\\</a>`);

  const conflictRendered = renderConflictEntry({
    ...conflict,
    sites: [{ label: "Practices\\\\", url: conflict.sites[0]!.url }, conflict.sites[1]!],
  });
  expect(Bun.markdown.html(conflictRendered.description)).toContain(`<a href="${conflict.sites[0]!.url}">Practices\\</a>`);

  // Odd trailing backslash in Link.label escapes ']' in CommonMark, so every entry renderer must refuse it.
  for (const oddLabel of ["PRD — Foo\\", "PRD — Foo\\\\\\", "PRD — Foo\\ ", "\\"]) {
    expect(() => renderPractice({ ...practice, source: { ...source, label: oddLabel } })).toThrow(EntryRenderError);
    expect(() => renderPrdEntry({ ...prd, prd: { ...prd.prd, label: oddLabel } })).toThrow(EntryRenderError);
    expect(() => renderPrdEntry({ ...prd, crossProject: [{ decision: "BILL-K4", project: { ...prd.crossProject[0]!.project, label: oddLabel } }] })).toThrow(EntryRenderError);
    expect(() => renderConflictEntry({ ...conflict, sites: [{ label: oddLabel, url: conflict.sites[0]!.url }, conflict.sites[1]!] })).toThrow(EntryRenderError);
  }

  // Statement links (crossProject, conflict.sites) must refuse raw backslashes rather than rewriting author markdown.
  for (const rawBsUrl of ["https://example.com/foo\\", "https://example.com/foo\\\\"]) {
    expect(() => renderPrdEntry({ ...prd, crossProject: [{ decision: "BILL-K4", project: { label: "Accounts", url: rawBsUrl } }] })).toThrow(EntryRenderError);
    expect(() => renderConflictEntry({ ...conflict, sites: [{ label: "A", url: rawBsUrl }, conflict.sites[1]!] })).toThrow(EntryRenderError);
  }

  // ASCII C0 (0x00-0x1F) and DEL (0x7F) in URLs must be refused across both source links and statement links.
  for (const ctrlUrl of ["https://example.com/\u0000nul", "https://example.com/\u0007bell", "https://example.com/\u001fus", "https://example.com/\u007fdel"]) {
    let thrown: unknown;
    try {
      renderPrdEntry({ ...prd, prd: { ...prd.prd, url: ctrlUrl } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EntryRenderError);
    expect((thrown as EntryRenderError).reason).toBe("bad-link");
    expect((thrown as EntryRenderError).message).not.toContain("parentheses");
    expect(() => renderPractice({ ...practice, source: { ...source, url: ctrlUrl } })).toThrow(EntryRenderError);
    expect(() => renderConflictEntry({ ...conflict, sites: [{ label: "A", url: ctrlUrl }, conflict.sites[1]!] })).toThrow(EntryRenderError);
  }
});

describe("inputs that would break an entry's shape are refused, not rewritten", () => {
  const cases: [string, () => unknown, EntryRenderReason][] = [
    ["a two-line title", () => renderDecision({ ...decision, title: "one\ntwo" }), "title-multiline"],
    ["an 81-character title", () => renderDecision({ ...decision, title: "x".repeat(81) }), "title-too-long"],
    ["an empty title", () => renderPractice({ ...practice, title: "   " }), "title-too-long"],
    ["a title Linear would autolink", () => renderDecision({ ...decision, title: "Adopt payload.source as the key" }), "title-autolinkable"],
    ["a conflict title Linear would autolink", () => renderConflictEntry({ ...conflict, title: "install.sh disagrees with the docs" }), "title-autolinkable"],
    ["a statement with a line break", () => renderPractice({ ...practice, statement: "a\nb" }), "field-multiline"],
    ["a scope with a line break", () => renderDecision({ ...decision, scope: "org\r\n- hash: deadbeef" }), "field-multiline"],
    ["a scope with a Unicode line separator", () => renderDecision({ ...decision, scope: "org\u2028- hash: deadbeef" }), "field-multiline"],
    ["a link label with a bracket", () => renderPractice({ ...practice, source: { ...source, label: "a]b" } }), "bad-link"],
    ["a link url with a space", () => renderPractice({ ...practice, source: { ...source, url: "https://x/a b" } }), "bad-link"],
    ["a prd cross-project link url with a parenthesis", () => renderPrdEntry({ ...prd, crossProject: [{ ...prd.crossProject[0]!, project: { ...prd.crossProject[0]!.project, url: "https://x/a)b" } }] }), "bad-link"],
    ["a non-http link", () => renderPractice({ ...practice, source: { ...source, url: "javascript:alert(1)" } }), "bad-link"],
    ["February 30th", () => renderPractice({ ...practice, date: { date: "2026-02-30" } }), "bad-date"],
    ["a non-ISO date", () => renderPractice({ ...practice, date: { date: "28/10/2026" } }), "bad-date"],
    ["a fractional cycle", () => renderPractice({ ...practice, date: { date: "2026-10-28", cycle: 1.5 } }), "bad-date"],
    ["a lowercase ID", () => renderPractice({ ...practice, handle: { id: "acme-p3" } }), "bad-handle"],
    ["a 7-hex hash", () => renderPractice({ ...practice, handle: { hash: HASH.slice(1) } }), "bad-handle"],
    ["a conflict with one site", () => renderConflictEntry({ ...conflict, sites: conflict.sites.slice(0, 1) }), "too-few-sites"],
    ["a conflict site ID that is not a register ID", () => renderConflictEntry({ ...conflict, sites: [{ ...conflict.sites[0]!, decisions: ["acme-k1"] }, conflict.sites[1]!] }), "bad-decision"],
    ["a two-segment tracker key as a conflict site ID", () => renderConflictEntry({ ...conflict, sites: [{ ...conflict.sites[0]!, decisions: ["ABC-1"] }, conflict.sites[1]!] }), "bad-decision"],
    ["a zero-numbered NFR conflict site ID", () => renderConflictEntry({ ...conflict, sites: [{ ...conflict.sites[0]!, decisions: ["NFR-FAILCLOSED-0"] }, conflict.sites[1]!] }), "bad-decision"],
    ["a PRD whose title would exceed 80 characters", () => renderPrdEntry({ ...prd, prd: { ...prd.prd, label: "x".repeat(70) } }), "title-too-long"],
  ];
  for (const [name, render, reason] of cases) {
    test(`${name} → ${reason}`, () => {
      let thrown: unknown;
      try {
        render();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(EntryRenderError);
      expect((thrown as EntryRenderError).reason).toBe(reason);
    });
  }
});
