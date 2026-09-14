import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compareByScoreThenKey, compareStrings } from "./ordering.ts";

describe("domain/ordering", () => {
  describe("compareStrings", () => {
    it("orders by code unit, not by locale", () => {
      // Under many locales localeCompare puts "README" after "docs";
      // code-unit order is uppercase-first and identical everywhere.
      assert.ok(compareStrings("README.md", "docs.md") < 0);
    });

    it("is consistent regardless of the ambient locale", () => {
      const pairs: Array<[string, string]> = [
        ["a", "B"],
        ["Z", "a"],
        ["ä", "z"],
        ["_x", "ax"],
        ["10", "9"],
      ];
      for (const [left, right] of pairs) {
        assert.equal(Math.sign(compareStrings(left, right)), left < right ? -1 : 1);
      }
    });

    it("returns 0 for equal strings", () => {
      assert.equal(compareStrings("same", "same"), 0);
    });

    it("produces a total order usable by sort", () => {
      const input = ["b", "A", "a", "B", "0"];
      const sorted = [...input].sort(compareStrings);
      assert.deepEqual(sorted, ["0", "A", "B", "a", "b"]);
    });
  });

  describe("compareByScoreThenKey", () => {
    it("puts the higher score first", () => {
      assert.ok(compareByScoreThenKey(["a", 0.9], ["b", 0.1]) < 0);
    });

    it("breaks ties on the key, ascending", () => {
      assert.ok(compareByScoreThenKey(["alpha", 1], ["zeta", 1]) < 0);
    });

    it("sorts a list stably", () => {
      const entries: Array<[string, number]> = [
        ["zeta", 1],
        ["alpha", 1],
        ["mid", 2],
      ];
      assert.deepEqual(
        [...entries].sort(compareByScoreThenKey).map(([key]) => key),
        ["mid", "alpha", "zeta"],
      );
    });
  });
});
