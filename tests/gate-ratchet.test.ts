/**
 * The monotone bar's ratchet dimension: `classifyRatchets` per JSON shape. The git reader and the
 * verbs are exercised over real repos in tests/gate-ci.test.ts and by the distribution's verb tests.
 */

import { describe, expect, it } from "bun:test";
import { classifyMonotone, classifyRatchets, rowLine, type RatchetFile, type RatchetSide } from "eris/gates-contract";

const F = "r.json";
const side = (value: unknown, declared: string[] = [F]): RatchetSide => ({
  declared,
  files: new Map<string, RatchetFile>([[F, value === undefined ? { kind: "absent" } : { kind: "json", value }]]),
});
const rows = (b: unknown, h: unknown) => classifyRatchets(side(b), side(h)).map(rowLine);

describe("classifyRatchets", () => {
  // admits: algorithmic: the verdict per JSON shape is branching no type holds; a wrong arm lets a widening read tighter or vanish.
  it("reads each shape's verdict, with an RFC 6901 pointer per leaf", () => {
    const table: Array<[string, unknown, unknown, string[]]> = [
      ["number down", { n: 5 }, { n: 4 }, ["ratchet\tr.json#/n\tvalue\ttighter\t5 -> 4"]],
      ["number up", { n: 5 }, { n: 6 }, ["ratchet\tr.json#/n\tvalue\twider\t5 -> 6"]],
      ["unchanged", { n: 5, a: ["x"] }, { a: ["x"], n: 5 }, []],
      ["number key added", { b: {} }, { b: { "a/b~c": 9 } }, ["ratchet\tr.json#/b/a~1b~0c\tkey\twider\tadded 9"]],
      ["number key removed", { b: { k: 9 } }, { b: {} }, ["ratchet\tr.json#/b/k\tkey\ttighter\tremoved 9"]],
      ["nested object added", {}, { b: { k: { lines: 1 } } }, ["ratchet\tr.json#/b/k/lines\tkey\twider\tadded 1"]],
      ["nested object removed", { b: { k: { lines: 1 } } }, {}, ["ratchet\tr.json#/b/k/lines\tkey\ttighter\tremoved 1"]],
      ["member added and removed", { e: ["a", "b"] }, { e: ["b", "c"] }, ["ratchet\tr.json#/e\tmember\twider\tadded \"c\"", "ratchet\tr.json#/e\tmember\ttighter\tremoved \"a\""]],
      ["string array key added", {}, { e: ["x"] }, ["ratchet\tr.json#/e\tmember\twider\tadded \"x\""]],
      ["empty array key added", {}, { e: [] }, ["ratchet\tr.json#/e\tkey\twider\tadded []"]],
      ["string changed", { s: "a" }, { s: "b" }, ["ratchet\tr.json#/s\tvalue\twider\t\"a\" -> \"b\""]],
      ["type changed", { n: 5 }, { n: "5" }, ["ratchet\tr.json#/n\tvalue\twider\t5 -> \"5\""]],
      ["mixed array changed", { m: [1, "a"] }, { m: [2, "a"] }, ["ratchet\tr.json#/m\tvalue\twider\t[1,\"a\"] -> [2,\"a\"]"]],
      ["boolean key removed", { f: true }, {}, ["ratchet\tr.json#/f\tkey\twider\tremoved true"]],
      ["control char in key", {}, { "a\tb": 1 }, ["ratchet\tr.json#/a\\u0009b\tkey\twider\tadded 1"]],
      ["top-level number", 3, 2, ["ratchet\tr.json#\tvalue\ttighter\t3 -> 2"]],
    ];
    expect(table.map(([, b, h]) => rows(b, h))).toEqual(table.map(([, , , want]) => want));
  });

  // admits: algorithmic: file presence and declaration are their own arms; an undeclare or delete must never read as no change.
  it("reads the file and its declaration", () => {
    expect(rows({ n: 1 }, undefined)).toEqual(["ratchet\tr.json#\tfile\twider\tdeleted"]);
    expect(rows(undefined, { n: 1 })).toEqual(["ratchet\tr.json#\tfile\ttighter\tadded"]);
    expect(classifyRatchets(side({ n: 1 }), side({ n: 9 }, [])).map(rowLine)).toEqual(["ratchet\tr.json#\tdeclaration\twider\tundeclared"]);
    expect(classifyRatchets(side({ n: 9 }, []), side({ n: 1 })).map(rowLine)).toEqual(["ratchet\tr.json#\tdeclaration\ttighter\tdeclared"]);
  });

  // admits: integration: classifyMonotone must carry ratchet rows after the surface rows, and a side with none must add none.
  it("rides classifyMonotone after the other scopes", () => {
    const base = { registry: null, files: new Map(), ratchets: side({ n: 1 }) };
    const head = { registry: null, files: new Map(), ratchets: side({ n: 2 }) };
    expect(classifyMonotone(base, head, []).map(rowLine)).toEqual(["ratchet\tr.json#/n\tvalue\twider\t1 -> 2"]);
    expect(classifyMonotone({ registry: null, files: new Map() }, { registry: null, files: new Map() }, [])).toEqual([]);
  });
});
