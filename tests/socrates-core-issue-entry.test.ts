/**
 * packages/socrates-core issue entries: a `prd` or `conflict` candidate's statement grammar.
 *
 * Seam: `issueEntryOf` on the package's public entry, which `eris socrates classify` and `submit` run before a
 * candidate leaves the machine and the server runs before it files the issue. Red when a PRD stops filing as one
 * entry naming its range, when a conflict site or its register IDs drop out of the body, or when a malformed
 * statement is filed instead of refused with a reason.
 */
import { describe, expect, test } from "bun:test";
import { issueEntryOf, parseConflictStatement, parsePrdStatement } from "../packages/socrates-core/src/index";

const PRD_URL = "https://docs.example.com/acme/document/billing";
const ANSWER_HERE = "Answer on this issue. A comment here is authoritative, and Socrates carries it to every linked site.";

const prdStatement = ["Decisions: `ACME-K1`–`ACME-K57`", "Confirmed by: @dana", "", "Decisions that touch other projects:", "- `ACME-K4`: [Accounts](https://docs.example.com/acme/project/accounts)"].join("\n");

const conflictStatement = [
  "The client-write rule contradicts the server-write decision.",
  "",
  "Authoritative sites:",
  "- `ACME-K11`, `ACME-K12` in [PRD — Acme](https://docs.example.com/acme/document/prd)",
  "- [Review issue](https://tracker.example.com/acme/issue/42)",
  "- [writer.ts](https://code.example.com/acme/blob/abc123/src/writer.ts)",
  "",
  "Proposed resolution:",
  "",
  "The newer server-write decision supersedes the client-write rule.",
].join("\n");

describe("a PRD files as one entry", () => {
  test("fifty-seven locked decisions are one issue naming the range, not one issue each", () => {
    /** When a PRD files one issue per decision, or drops its range, reviewers re-confirm every locked decision one by one: the noise a PRD entry exists to remove. Observed in the rendered issue. */
    const filed = issueEntryOf({ kind: "prd", title: "PRD — Acme Billing", statement: prdStatement, source: PRD_URL });
    expect(filed).toEqual({
      ok: true,
      value: {
        title: "PRD authored: PRD — Acme Billing",
        description: [
          `PRD authored: [PRD — Acme Billing](${PRD_URL}); decisions \`ACME-K1\`–\`ACME-K57\` were discussed and confirmed by @dana.`,
          "",
          "Decisions that touch other projects:",
          "- `ACME-K4`: [Accounts](https://docs.example.com/acme/project/accounts)",
          "",
          ANSWER_HERE,
        ].join("\n"),
      },
    });
  });

  // admits: algorithmic: issueEntryOf passes candidate.source into renderPrdEntry so valid ()<> sources must render percent-encoded while crossProject statement links keep refusing raw () and genuinely invalid source URLs return bad-link without blaming parentheses; runtime regexes and string errors are invisible to tsc and ast-grep.
  test("a PRD source URL with ()<> encodes on render, cross-project statement links still refuse raw (), and invalid source URLs report bad-link accurately", () => {
    const filed = issueEntryOf({
      kind: "prd",
      title: "PRD — Acme Billing",
      statement: prdStatement,
      source: "https://en.wikipedia.org/wiki/Problem_details_(HTTP)?q=<a>",
    });
    expect(filed.ok).toBe(true);
    if (filed.ok) {
      expect(filed.value.description.split("\n")[0]).toBe(
        "PRD authored: [PRD — Acme Billing](https://en.wikipedia.org/wiki/Problem_details_%28HTTP%29?q=%3Ca%3E); decisions `ACME-K1`–`ACME-K57` were discussed and confirmed by @dana.",
      );
    }
    const badCross = issueEntryOf({
      kind: "prd",
      title: "PRD — Acme Billing",
      statement: prdStatement.replace("https://docs.example.com/acme/project/accounts", "https://docs.example.com/a)b"),
      source: PRD_URL,
    });
    expect(badCross.ok).toBe(false);
    if (!badCross.ok) expect(badCross.reason).toMatch(/^bad-link:.*parentheses/);
    for (const badSource of ["https://x/a b", "javascript:alert(1)"]) {
      const bad = issueEntryOf({ kind: "prd", title: "PRD — Acme Billing", statement: prdStatement, source: badSource });
      expect(bad.ok).toBe(false);
      if (!bad.ok) {
        expect(bad.reason).toContain("bad-link:");
        expect(bad.reason).toContain(JSON.stringify(badSource));
        expect(bad.reason).not.toContain("parentheses");
      }
    }
  });

  // admits: algorithmic: issueEntryOf passes PRD title/source and statement links into renderPrdEntry/renderConflictEntry, where odd trailing backslashes, raw statement backslashes, and C0/DEL URLs break CommonMark <a> rendering unless encoded or refused; runtime Markdown parsing is invisible to tsc and ast-grep.
  test("issueEntryOf handles trailing backslashes and C0/DEL control characters without breaking CommonMark links", () => {
    const encodedPrd = issueEntryOf({
      kind: "prd",
      title: "PRD — Acme\\\\",
      statement: prdStatement,
      source: "https://docs.example.com/prd\\",
    });
    expect(encodedPrd.ok).toBe(true);
    if (encodedPrd.ok) {
      const html = Bun.markdown.html(encodedPrd.value.description);
      expect(html).toContain('<a href="https://docs.example.com/prd%5C">PRD — Acme\\</a>');
    }

    for (const oddTitle of ["PRD — Acme\\", "PRD — Acme\\\\\\", "PRD — Acme\\ "]) {
      const badTitle = issueEntryOf({ kind: "prd", title: oddTitle, statement: prdStatement, source: PRD_URL });
      expect(badTitle.ok).toBe(false);
      if (!badTitle.ok) expect(badTitle.reason).toMatch(/^bad-link:/);
    }

    for (const ctrlSource of ["https://docs.example.com/\u0000nul", "https://docs.example.com/\u0007bell", "https://docs.example.com/\u007fdel"]) {
      const badCtrl = issueEntryOf({ kind: "prd", title: "PRD — Acme", statement: prdStatement, source: ctrlSource });
      expect(badCtrl.ok).toBe(false);
      if (!badCtrl.ok) {
        expect(badCtrl.reason).toContain("bad-link:");
        expect(badCtrl.reason).not.toContain("parentheses");
      }
    }

    const badCrossLabel = issueEntryOf({
      kind: "prd",
      title: "PRD — Acme",
      statement: prdStatement.replace("[Accounts]", "[Accounts\\]"),
      source: PRD_URL,
    });
    expect(badCrossLabel.ok).toBe(false);
    if (!badCrossLabel.ok) expect(badCrossLabel.reason).toMatch(/^bad-link:/);

    const badCrossUrl = issueEntryOf({
      kind: "prd",
      title: "PRD — Acme",
      statement: prdStatement.replace("https://docs.example.com/acme/project/accounts", "https://docs.example.com/a\\"),
      source: PRD_URL,
    });
    expect(badCrossUrl.ok).toBe(false);
    if (!badCrossUrl.ok) expect(badCrossUrl.reason).toMatch(/^bad-link:/);

    const badSiteLabel = issueEntryOf({
      kind: "conflict",
      title: "Conflict",
      statement: conflictStatement.replace("[Review issue]", "[Review issue\\]"),
      source: PRD_URL,
    });
    expect(badSiteLabel.ok).toBe(false);
    if (!badSiteLabel.ok) expect(badSiteLabel.reason).toMatch(/^bad-link:/);

    for (const badUrl of ["https://tracker.example.com/a\\", "https://tracker.example.com/\u0007bell", "https://tracker.example.com/\u007fdel"]) {
      const badSiteUrl = issueEntryOf({
        kind: "conflict",
        title: "Conflict",
        statement: conflictStatement.replace("https://tracker.example.com/acme/issue/42", badUrl),
        source: PRD_URL,
      });
      expect(badSiteUrl.ok).toBe(false);
      if (!badSiteUrl.ok) expect(badSiteUrl.reason).toMatch(/^bad-link:/);
    }
  });

  test("one locked decision, written with `..`, names that one decision", () => {
    /** When the one-decision or `..` spelling is refused or mis-ranged, a valid PRD statement cannot be filed. */
    const parsed = parsePrdStatement("Decisions: `ACME-BILL-K3`..`ACME-BILL-K3`\nConfirmed by: dana", { label: "PRD", url: PRD_URL });
    expect(parsed).toEqual({ ok: true, value: { prd: { label: "PRD", url: PRD_URL }, decisions: { first: "ACME-BILL-K3", last: "ACME-BILL-K3" }, confirmedBy: "dana", crossProject: [] } });
  });
});

describe("a conflict links every site, on one thread", () => {
  test("each site is a bullet, its register IDs outside the link, then the proposal and the answer-here line", () => {
    /** When a site, its IDs or the answer-here line drop out of the body, resolve misses a site or sends the reviewer elsewhere. The resolver reads sites from this list and IDs from the bullet line, outside the link Linear turns into a chip. */
    const filed = issueEntryOf({ kind: "conflict", title: "Two sources disagree on who writes", statement: conflictStatement, source: PRD_URL });
    expect(filed.ok).toBe(true);
    if (!filed.ok) return;
    expect(filed.value.title).toBe("Two sources disagree on who writes");
    expect(filed.value.description).toBe(`${conflictStatement}\n\n${ANSWER_HERE}`);
    // The only instruction the body gives is to answer here.
    expect(filed.value.description.match(/\bcomment\b|\banswer\b/gi)?.length).toBe(2);
  });

  test("a statement round-trips: the parsed sites are the written ones", () => {
    /** When parsing loses a site's label, url or IDs, the filed body links less than the statement named. */
    const parsed = parseConflictStatement(conflictStatement, "t");
    expect(parsed.ok && parsed.value.sites).toEqual([
      { label: "PRD — Acme", url: "https://docs.example.com/acme/document/prd", decisions: ["ACME-K11", "ACME-K12"] },
      { label: "Review issue", url: "https://tracker.example.com/acme/issue/42" },
      { label: "writer.ts", url: "https://code.example.com/acme/blob/abc123/src/writer.ts" },
    ]);
  });

  // admits: When DECISION_ID requires letters and digits in one final segment, parseConflictStatement and issueEntryOf refuse NFR-<CAT>-<n> site IDs so Canon NFR Conflicts cannot link their register IDs for resolve — regex matching on runtime strings is not visible to tsc or ast-grep.
  test("a Canon NFR conflict links NFR-<CAT>-<n> IDs on its site line and round-trips", () => {
    /** When the site-line grammar rejects NFR-<CAT>-<n> IDs, a Canon Conflict cannot carry its register ID outside the link and resolve cannot patch the row. */
    const nfrAuthz = ["NFR", "AUTHZ", "1"].join("-");
    const canonConflict = [
      `A candidate cites Canon entry \`${nfrAuthz}\` and states something else.`,
      "",
      "Authoritative sites:",
      `- \`${nfrAuthz}\`, \`NFR-FAILCLOSED-1\` in [Socrates Canon, Current](https://docs.example.com/acme/document/canon)`,
      "- [Candidate](https://docs.example.com/acme/issue/99)",
    ].join("\n");
    const filed = issueEntryOf({ kind: "conflict", title: `Conflict: ${nfrAuthz} restated differently`, statement: canonConflict, source: PRD_URL });
    expect(filed).toEqual({
      ok: true,
      value: {
        title: `Conflict: ${nfrAuthz} restated differently`,
        description: `${canonConflict}\n\n${ANSWER_HERE}`,
      },
    });
    const reparsed = parseConflictStatement(canonConflict, "t");
    expect(reparsed.ok && reparsed.value.sites).toEqual([
      { label: "Socrates Canon, Current", url: "https://docs.example.com/acme/document/canon", decisions: [nfrAuthz, "NFR-FAILCLOSED-1"] },
      { label: "Candidate", url: "https://docs.example.com/acme/issue/99" },
    ]);
    const nfrPrd = parsePrdStatement("Decisions: `NFR-FAILCLOSED-1`–`NFR-FAILCLOSED-6`\nConfirmed by: dana", { label: "NFR", url: PRD_URL });
    expect(nfrPrd).toEqual({
      ok: true,
      value: { prd: { label: "NFR", url: PRD_URL }, decisions: { first: "NFR-FAILCLOSED-1", last: "NFR-FAILCLOSED-6" }, confirmedBy: "dana", crossProject: [] },
    });
  });
});

describe("a statement the grammar cannot place is refused with the reason", () => {
  const prd = (statement: string) => issueEntryOf({ kind: "prd", title: "PRD", statement, source: PRD_URL });
  const conflict = (statement: string) => issueEntryOf({ kind: "conflict", title: "t", statement, source: PRD_URL });
  const sites = "Authoritative sites:\n- [A](https://a.example.com/x)\n- [B](https://b.example.com/y)";
  const cases: [string, () => ReturnType<typeof issueEntryOf>, RegExp][] = [
    ["a PRD with no range", () => prd("Confirmed by: dana"), /no Decisions: line/],
    ["a PRD with no confirmer", () => prd("Decisions: `ACME-K1`–`ACME-K2`"), /no Confirmed by:/],
    ["a range across two registers", () => prd("Decisions: `ACME-K1`–`ACME-P2`\nConfirmed by: dana"), /different registers/],
    ["a range across two NFR categories", () => prd("Decisions: `NFR-FAILCLOSED-1`–`NFR-LOGGING-2`\nConfirmed by: dana"), /different registers/],
    ["a range that runs backwards", () => prd("Decisions: `ACME-K9`–`ACME-K2`\nConfirmed by: dana"), /before it starts/],
    ["a lowercase ID", () => prd("Decisions: `acme-k1`\nConfirmed by: dana"), /not part of a PRD statement/],
    ["a cross-project decision outside the range", () => prd(`${prdStatement.replace("`ACME-K4`:", "`ACME-K58`:")}`), /outside/],
    ["a stray line in a PRD", () => prd(`${prdStatement}\nAlso this.`), /not part of a PRD statement/],
    ["a PRD that carries the footer", () => prd(`${prdStatement}\n\n${ANSWER_HERE}`), /footer/],
    ["a PRD title over the entry length", () => issueEntryOf({ kind: "prd", title: "x".repeat(70), statement: prdStatement, source: PRD_URL }), /title-too-long/],
    ["a conflict with no sites list", () => conflict("Two things disagree."), /no Authoritative sites/],
    ["a conflict with no summary", () => conflict(sites), /no summary/],
    ["a conflict with one site", () => conflict("S.\n\nAuthoritative sites:\n- [A](https://a.example.com/x)"), /at least two sites, got 1/],
    ["a site that is not a link", () => conflict(`S.\n\n${sites}\n- the writer module`), /is not a site/],
    ["a site listed twice", () => conflict(`S.\n\n${sites}\n- [A](https://a.example.com/x)`), /listed twice/],
    ["a site ID that is not a register ID", () => conflict(`S.\n\n${sites}\n- \`acme\` in [C](https://c.example.com/z)`), /is not a site/],
    ["a two-segment tracker key as a site ID", () => conflict(`S.\n\n${sites}\n- \`ABC-1\` in [C](https://c.example.com/z)`), /is not a site/],
    ["a zero-numbered NFR site ID", () => conflict(`S.\n\n${sites}\n- \`NFR-FAILCLOSED-0\` in [C](https://c.example.com/z)`), /is not a site/],
    ["an empty proposal", () => conflict(`S.\n\n${sites}\n\nProposed resolution:\n\n`), /is empty/],
    ["a conflict that carries the footer", () => conflict(`S.\n\n${sites}\n\n${ANSWER_HERE}`), /footer/],
    ["a site url with a parenthesis", () => conflict(`S.\n\n${sites}\n- [C](https://c.example.com/a)b)`), /bad-link/],
  ];
  for (const [name, run, reason] of cases) {
    test(name, () => {
      /** When a malformed statement is filed instead of refused with its reason, the review issue links the wrong sites or none. */
      const result = run();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(reason);
    });
  }

  // admits: When SITE_LINE only accepts DECISION_ID, a v3 doc's 8-hex entry hash is refused as "not a site" and agents drop the entry pointer; the grammar is a runtime regex tsc and ast-grep cannot see.
  test("a conflict site may cite an 8-hex legacy entry ID, and round-trips", () => {
    const hash = ["6f2f", "822b"].join("");
    const statement = [
      "Two docs disagree.",
      "",
      "Authoritative sites:",
      `- \`${hash}\` in [Load-Bearing Decisions](https://docs.example.com/acme/document/lbd)`,
      "- [Candidate](https://docs.example.com/acme/issue/99)",
    ].join("\n");
    const reparsed = parseConflictStatement(statement, "t");
    expect(reparsed.ok && reparsed.value.sites[0]).toEqual({ label: "Load-Bearing Decisions", url: "https://docs.example.com/acme/document/lbd", decisions: [hash] });
    const filed = issueEntryOf({ kind: "conflict", title: "Legacy hash site", statement, source: PRD_URL });
    expect(filed).toEqual({ ok: true, value: { title: "Legacy hash site", description: `${statement}\n\n${ANSWER_HERE}` } });
    expect(parseConflictStatement(statement.replace(hash, hash.toUpperCase()), "t").ok).toBe(false);
    // 7 and 9 hex (a git short SHA) are not entry hashes: the length is exact.
    for (const odd of [hash.slice(1), `${hash}a`]) expect(parseConflictStatement(statement.replace(hash, odd), "t").ok).toBe(false);
  });
});
