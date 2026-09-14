import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EDGE_DECAY, documentNodeId, tagNodeId, type GraphEdge } from "../model/graph.ts";
import { DEFAULT_EXPANSION, expandGraph, type NeighborLookup } from "./graph-expansion.ts";

const doc = documentNodeId;

function lookupFrom(edges: readonly GraphEdge[]): NeighborLookup {
  return (nodeIds) => {
    const wanted = new Set(nodeIds);
    return edges.filter((edge) => wanted.has(edge.src));
  };
}

const chain: GraphEdge[] = [
  { src: doc("a.md"), dst: doc("b.md"), kind: "links_to", weight: 1 },
  { src: doc("b.md"), dst: doc("c.md"), kind: "links_to", weight: 1 },
  { src: doc("c.md"), dst: doc("d.md"), kind: "links_to", weight: 1 },
];

describe("domain/service/graphExpansion", () => {
  it("returns nothing without seeds", () => {
    const result = expandGraph(new Map(), lookupFrom(chain));
    assert.equal(result.scores.size, 0);
  });

  it("returns nothing when hops is zero", () => {
    const seeds = new Map([[doc("a.md"), 1]]);
    const result = expandGraph(seeds, lookupFrom(chain), { ...DEFAULT_EXPANSION, hops: 0 });
    assert.equal(result.scores.size, 0);
  });

  it("reaches neighbours within the hop budget", () => {
    const seeds = new Map([[doc("a.md"), 1]]);
    const result = expandGraph(seeds, lookupFrom(chain), { ...DEFAULT_EXPANSION, hops: 2 });
    assert.deepEqual([...result.scores.keys()].sort(), ["b.md", "c.md"]);
  });

  it("does not reach past the hop budget", () => {
    const seeds = new Map([[doc("a.md"), 1]]);
    const result = expandGraph(seeds, lookupFrom(chain), { ...DEFAULT_EXPANSION, hops: 1 });
    assert.deepEqual([...result.scores.keys()], ["b.md"]);
  });

  it("excludes the seeds themselves from the results", () => {
    const seeds = new Map([[doc("a.md"), 1]]);
    const result = expandGraph(seeds, lookupFrom(chain));
    assert.ok(!result.scores.has("a.md"));
  });

  it("decays score with distance", () => {
    const seeds = new Map([[doc("a.md"), 1]]);
    const result = expandGraph(seeds, lookupFrom(chain), { ...DEFAULT_EXPANSION, hops: 3 });
    const one = result.scores.get("b.md") ?? 0;
    const two = result.scores.get("c.md") ?? 0;
    const three = result.scores.get("d.md") ?? 0;
    assert.ok(one > two && two > three, `${one} > ${two} > ${three}`);
  });

  it("applies the edge-kind decay", () => {
    const edges: GraphEdge[] = [
      { src: doc("a.md"), dst: doc("linked.md"), kind: "links_to", weight: 1 },
      { src: doc("a.md"), dst: doc("beside.md"), kind: "same_directory", weight: 1 },
    ];
    const result = expandGraph(new Map([[doc("a.md"), 1]]), lookupFrom(edges));
    assert.equal(result.scores.get("linked.md"), EDGE_DECAY.links_to);
    assert.equal(result.scores.get("beside.md"), EDGE_DECAY.same_directory);
  });

  it("records the edge chain that reached each document", () => {
    const seeds = new Map([[doc("a.md"), 1]]);
    const result = expandGraph(seeds, lookupFrom(chain), { ...DEFAULT_EXPANSION, hops: 2 });
    assert.deepEqual(result.paths.get("b.md"), [chain[0]]);
    assert.deepEqual(result.paths.get("c.md"), [chain[0], chain[1]]);
  });

  it("passes through tag nodes without returning them as results", () => {
    const edges: GraphEdge[] = [
      { src: doc("a.md"), dst: tagNodeId("auth"), kind: "same_tag", weight: 0.5 },
      { src: tagNodeId("auth"), dst: doc("b.md"), kind: "same_tag", weight: 0.5 },
    ];
    const result = expandGraph(new Map([[doc("a.md"), 1]]), lookupFrom(edges));
    assert.deepEqual([...result.scores.keys()], ["b.md"], "a tag is a waypoint, not a result");
    assert.equal(result.paths.get("b.md")?.length, 2, "the path still records both hops");
  });

  it("keeps the best path when a document is reachable two ways", () => {
    const edges: GraphEdge[] = [
      { src: doc("a.md"), dst: doc("x.md"), kind: "same_directory", weight: 1 },
      { src: doc("a.md"), dst: doc("x.md"), kind: "links_to", weight: 1 },
    ];
    const result = expandGraph(new Map([[doc("a.md"), 1]]), lookupFrom(edges));
    assert.equal(result.scores.get("x.md"), EDGE_DECAY.links_to, "the stronger edge should win");
    assert.equal(result.paths.get("x.md")?.[0]?.kind, "links_to");
  });

  it("stops at the minimum score instead of flooding", () => {
    const seeds = new Map([[doc("a.md"), 1]]);
    const result = expandGraph(seeds, lookupFrom(chain), {
      ...DEFAULT_EXPANSION,
      hops: 5,
      minScore: 0.5,
    });
    assert.deepEqual([...result.scores.keys()], ["b.md"]);
  });

  it("caps the number of returned documents", () => {
    const edges: GraphEdge[] = Array.from({ length: 50 }, (_, i) => ({
      src: doc("a.md"),
      dst: doc(`n${String(i).padStart(2, "0")}.md`),
      kind: "links_to" as const,
      weight: 1,
    }));
    const result = expandGraph(new Map([[doc("a.md"), 1]]), lookupFrom(edges), {
      ...DEFAULT_EXPANSION,
      maxNodes: 10,
    });
    assert.equal(result.scores.size, 10);
  });

  it("terminates on a cycle", () => {
    const cycle: GraphEdge[] = [
      { src: doc("a.md"), dst: doc("b.md"), kind: "links_to", weight: 1 },
      { src: doc("b.md"), dst: doc("a.md"), kind: "links_to", weight: 1 },
    ];
    const result = expandGraph(new Map([[doc("a.md"), 1]]), lookupFrom(cycle), {
      ...DEFAULT_EXPANSION,
      hops: 10,
    });
    assert.deepEqual([...result.scores.keys()], ["b.md"]);
  });

  it("is deterministic across runs", () => {
    const edges: GraphEdge[] = [
      { src: doc("a.md"), dst: doc("x.md"), kind: "links_to", weight: 1 },
      { src: doc("a.md"), dst: doc("y.md"), kind: "links_to", weight: 1 },
      { src: doc("x.md"), dst: doc("z.md"), kind: "similar", weight: 0.8 },
    ];
    const seeds = new Map([[doc("a.md"), 1]]);
    const first = expandGraph(seeds, lookupFrom(edges));
    const second = expandGraph(seeds, lookupFrom(edges));
    assert.deepEqual([...first.scores.entries()], [...second.scores.entries()]);
  });

  it("weights a strong edge above a weak one of the same kind", () => {
    const edges: GraphEdge[] = [
      { src: doc("a.md"), dst: doc("strong.md"), kind: "similar", weight: 0.95 },
      { src: doc("a.md"), dst: doc("weak.md"), kind: "similar", weight: 0.2 },
    ];
    const result = expandGraph(new Map([[doc("a.md"), 1]]), lookupFrom(edges));
    assert.ok((result.scores.get("strong.md") ?? 0) > (result.scores.get("weak.md") ?? 0));
  });
});
