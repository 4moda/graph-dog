import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SIMILARITY_NEIGHBORS,
  compareNeighbors,
  mergeNeighbors,
  neighborStamp,
  planNeighborRefresh,
  type NeighborList,
} from "./similarity-index.ts";

/** The order a full recompute would produce, for comparing a merge against it. */
function topK(candidates: NeighborList, k: number): Array<[string, number]> {
  return [...candidates].map((entry): [string, number] => [entry[0], entry[1]]).sort(compareNeighbors).slice(0, k);
}

describe("domain/service/similarity-index", () => {
  describe("compareNeighbors", () => {
    it("puts the stronger score first", () => {
      assert.ok(compareNeighbors(["a", 0.9], ["b", 0.4]) < 0);
    });

    it("breaks a tie on chunk id, so two builds agree", () => {
      assert.ok(compareNeighbors(["a", 0.5], ["b", 0.5]) < 0);
      assert.ok(compareNeighbors(["b", 0.5], ["a", 0.5]) > 0);
    });
  });

  describe("planNeighborRefresh", () => {
    const stored = new Map<string, NeighborList>([
      ["a", [["b", 0.9], ["c", 0.5]]],
      ["b", [["a", 0.9], ["c", 0.4]]],
      ["c", [["a", 0.5]]],
    ]);

    it("merges into a list that lost nothing", () => {
      const plan = planNeighborRefresh(["a", "b", "c"], new Set(), stored);
      assert.deepEqual(plan, { recompute: [], merge: ["a", "b", "c"] });
    });

    it("recomputes a list that named a chunk which went", () => {
      const plan = planNeighborRefresh(["a", "b", "c"], new Set(["c"]), stored);
      // `a` and `b` both named `c`; `c`'s own list named only `a`, which stayed.
      assert.deepEqual(plan.recompute, ["a", "b"]);
      assert.deepEqual(plan.merge, ["c"]);
    });

    it("recomputes a chunk nothing stored a list for", () => {
      const plan = planNeighborRefresh(["a", "z"], new Set(), stored);
      assert.deepEqual(plan.recompute, ["z"]);
    });

    it("has nothing to plan for an empty corpus", () => {
      assert.deepEqual(planNeighborRefresh([], new Set(), stored), { recompute: [], merge: [] });
    });
  });

  describe("mergeNeighbors", () => {
    const stored: NeighborList = [["b", 0.9], ["c", 0.6], ["d", 0.3]];

    it("reports no change when nothing arrived", () => {
      assert.equal(mergeNeighbors(stored, [], 5), null);
    });

    it("reports no change when what arrived is too weak to make the list", () => {
      assert.equal(mergeNeighbors(stored, [["new", 0.1]], 3), null);
    });

    it("inserts an arrival in its place and drops the weakest", () => {
      const merged = mergeNeighbors(stored, [["new", 0.7]], 3);
      assert.deepEqual(merged, [["b", 0.9], ["new", 0.7], ["c", 0.6]]);
    });

    it("grows a list that was shorter than the limit", () => {
      const merged = mergeNeighbors([["b", 0.9]], [["new", 0.1]], 3);
      assert.deepEqual(merged, [["b", 0.9], ["new", 0.1]]);
    });

    it("gives the same answer as recomputing the whole list", () => {
      const arrivals: NeighborList = [["new1", 0.95], ["new2", 0.45]];
      assert.deepEqual(
        mergeNeighbors(stored, arrivals, 3),
        topK([...stored, ...arrivals], 3),
        "a merged list and a recomputed one have to agree, or an update drifts from a rebuild",
      );
    });

    it("keeps the stronger score when an arrival is already in the list", () => {
      const merged = mergeNeighbors([["b", 0.4]], [["b", 0.8]], 3);
      assert.deepEqual(merged, [["b", 0.8]]);
    });

    it("orders an arrival tied with a stored entry by chunk id", () => {
      const merged = mergeNeighbors([["m", 0.5]], [["a", 0.5], ["z", 0.5]], 3);
      assert.deepEqual(merged, [["a", 0.5], ["m", 0.5], ["z", 0.5]]);
    });
  });

  describe("neighborStamp", () => {
    it("distinguishes everything that would invalidate a stored list", () => {
      const base = neighborStamp("e5:d384", 5, 100);
      assert.notEqual(base, neighborStamp("hash-v1:d256", 5, 100), "a different model");
      assert.notEqual(base, neighborStamp("e5:d384", 8, 100), "a different neighbour count");
      assert.notEqual(base, neighborStamp("e5:d384", 5, 101), "chunks written without it");
      assert.equal(base, neighborStamp("e5:d384", 5, 100));
    });

    it("never collides with the empty stamp that means 'nothing stored these'", () => {
      assert.notEqual(neighborStamp("", SIMILARITY_NEIGHBORS, 0), "");
    });
  });
});
