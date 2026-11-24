/**
 * `isHumanGrant` at the contract seam: a grant with no visible text is no grant, whatever
 * invisible characters it is built from. The verb-level blank refusal shares the same predicate.
 */

import { describe, expect, it } from "bun:test";
import { isBlankGrant, isHumanGrant } from "eris/gates-contract";

describe("isHumanGrant", () => {
  // Turns red if a grant of zero-width or control characters passes as a human grant: it renders
  // blank in a receipt comment yet would sign a skip. Observed at the predicate's return value.
  it("refuses grants with no visible text", () => {
    for (const blank of ["", "   ", "\t\n", "​", "​‌﻿", "\u0000\u0007", " ​\u0001 ", "⁠­"]) {
      expect(isHumanGrant(blank)).toBe(false);
      expect(isBlankGrant(blank)).toBe(true);
    }
    expect(isHumanGrant(undefined)).toBe(false);
  });

  // Turns red if the invisible-character check swallows real prose, with or without invisible padding.
  it("still accepts prose grants", () => {
    for (const prose of ["Dan asked: ship it", "​Dan asked: ship it​", "x"]) {
      expect(isHumanGrant(prose)).toBe(true);
      expect(isBlankGrant(prose)).toBe(false);
    }
  });

  // Turns red if the machine-grant refusals loosen: doctrine and repo grants never read as human.
  it("keeps refusing doctrine and repo grants", () => {
    for (const machine of ["doctrine:rapid-prototype", "Doctrine:x", "​doctrine:x", "repo:no-eris-yaml", "​repo:no-eris-yaml"]) {
      expect(isHumanGrant(machine)).toBe(false);
    }
  });
});
