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
});

describe("a statement the grammar cannot place is refused with the reason", () => {
  const prd = (statement: string) => issueEntryOf({ kind: "prd", title: "PRD", statement, source: PRD_URL });
  const conflict = (statement: string) => issueEntryOf({ kind: "conflict", title: "t", statement, source: PRD_URL });
  const sites = "Authoritative sites:\n- [A](https://a.example.com/x)\n- [B](https://b.example.com/y)";
  const cases: [string, () => ReturnType<typeof issueEntryOf>, RegExp][] = [
    ["a PRD with no range", () => prd("Confirmed by: dana"), /no Decisions: line/],
    ["a PRD with no confirmer", () => prd("Decisions: `ACME-K1`–`ACME-K2`"), /no Confirmed by:/],
    ["a range across two registers", () => prd("Decisions: `ACME-K1`–`ACME-P2`\nConfirmed by: dana"), /different registers/],
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
});
