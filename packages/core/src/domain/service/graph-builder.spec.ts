import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { directoryNodeId, documentNodeId, tagNodeId } from "../model/graph.ts";
import {
  DEFAULT_GRAPH_RULES,
  buildGraph,
  collapseChunkNeighbors,
  type GraphDocumentInput,
} from "./graph-builder.ts";

function doc(ref: string, overrides: Partial<GraphDocumentInput> = {}): GraphDocumentInput {
  return { ref, title: ref, tags: [], links: [], ...overrides };
}

const edgeKinds = (graph: { edges: ReadonlyArray<{ kind: string }> }): string[] =>
  [...new Set(graph.edges.map((edge) => edge.kind))].sort();

describe("domain/service/graphBuilder", () => {
  it("creates a node per document", () => {
    const graph = buildGraph([doc("docs/a.md"), doc("docs/b.md")], []);
    const documentNodes = graph.nodes.filter((node) => node.kind === "document");
    assert.equal(documentNodes.length, 2);
    assert.equal(documentNodes[0]?.ref, "docs/a.md");
  });

  it("handles an empty corpus", () => {
    const graph = buildGraph([], []);
    assert.deepEqual(graph.nodes, []);
    assert.deepEqual(graph.edges, []);
  });

  describe("link edges", () => {
    const documents = [doc("docs/a.md", { links: ["b.md"] }), doc("docs/b.md")];

    it("connects a document to what it links to", () => {
      const graph = buildGraph(documents, [], { ...DEFAULT_GRAPH_RULES, enableTags: false, enableDirectories: false });
      const forward = graph.edges.find((edge) => edge.kind === "links_to");
      assert.equal(forward?.src, documentNodeId("docs/a.md"));
      assert.equal(forward?.dst, documentNodeId("docs/b.md"));
    });

    it("adds a weaker reverse edge", () => {
      const graph = buildGraph(documents, [], { ...DEFAULT_GRAPH_RULES, enableTags: false, enableDirectories: false });
      const forward = graph.edges.find((edge) => edge.kind === "links_to");
      const reverse = graph.edges.find((edge) => edge.kind === "linked_from");
      assert.ok(reverse);
      assert.ok((reverse?.weight ?? 0) < (forward?.weight ?? 0));
    });

    it("ignores links that do not resolve in this corpus", () => {
      const graph = buildGraph([doc("docs/a.md", { links: ["nowhere.md"] })], []);
      assert.deepEqual(graph.edges, []);
    });

    it("ignores a self-link", () => {
      const graph = buildGraph([doc("docs/a.md", { links: ["a.md"] })], []);
      assert.deepEqual(graph.edges, []);
    });

    it("can be disabled", () => {
      const graph = buildGraph(documents, [], { ...DEFAULT_GRAPH_RULES, enableLinks: false });
      assert.ok(!edgeKinds(graph).includes("links_to"));
    });
  });

  describe("tag edges", () => {
    const documents = [
      doc("a/one.md", { tags: ["auth"] }),
      doc("b/two.md", { tags: ["auth"] }),
      doc("c/three.md", { tags: ["other"] }),
    ];

    it("routes shared tags through a tag node", () => {
      const graph = buildGraph(documents, [], { ...DEFAULT_GRAPH_RULES, enableDirectories: false });
      assert.ok(graph.nodes.some((node) => node.id === tagNodeId("auth")));
      assert.ok(!graph.nodes.some((node) => node.id === tagNodeId("other")), "a tag of one is not shared");
    });

    it("weights a small tag group above a large one", () => {
      const small = buildGraph(
        [doc("a/1.md", { tags: ["t"] }), doc("b/2.md", { tags: ["t"] })],
        [],
        { ...DEFAULT_GRAPH_RULES, enableDirectories: false },
      );
      const large = buildGraph(
        Array.from({ length: 20 }, (_, i) => doc(`d${i}/f.md`, { tags: ["t"] })),
        [],
        { ...DEFAULT_GRAPH_RULES, enableDirectories: false },
      );
      const smallWeight = small.edges.find((edge) => edge.kind === "same_tag")?.weight ?? 0;
      const largeWeight = large.edges.find((edge) => edge.kind === "same_tag")?.weight ?? 0;
      assert.ok(smallWeight > largeWeight);
    });

    it("skips a tag shared by too many documents to be informative", () => {
      const many = Array.from({ length: 50 }, (_, i) => doc(`d${i}/f.md`, { tags: ["draft"] }));
      const graph = buildGraph(many, [], { ...DEFAULT_GRAPH_RULES, enableDirectories: false, maxGroupSize: 40 });
      assert.ok(!graph.nodes.some((node) => node.id === tagNodeId("draft")));
    });

    it("keeps the edge count linear in group size, not quadratic", () => {
      const group = Array.from({ length: 20 }, (_, i) => doc(`d${i}/f.md`, { tags: ["t"] }));
      const graph = buildGraph(group, [], { ...DEFAULT_GRAPH_RULES, enableDirectories: false });
      assert.equal(graph.edges.length, 40, "20 documents should give 2 edges each, not 380");
    });
  });

  describe("directory edges", () => {
    it("connects documents sharing a directory", () => {
      const graph = buildGraph([doc("docs/x/a.md"), doc("docs/x/b.md")], [], {
        ...DEFAULT_GRAPH_RULES,
        enableTags: false,
      });
      assert.ok(graph.nodes.some((node) => node.id === directoryNodeId("docs/x")));
    });

    it("does not connect documents in different directories", () => {
      const graph = buildGraph([doc("docs/x/a.md"), doc("docs/y/b.md")], [], {
        ...DEFAULT_GRAPH_RULES,
        enableTags: false,
      });
      assert.deepEqual(graph.edges, []);
    });
  });

  describe("similarity edges", () => {
    it("adds an edge above the threshold", () => {
      const graph = buildGraph(
        [doc("a/1.md"), doc("b/2.md")],
        [{ from: "a/1.md", to: "b/2.md", score: 0.9 }],
        DEFAULT_GRAPH_RULES,
      );
      const edge = graph.edges.find((e) => e.kind === "similar");
      assert.equal(edge?.weight, 0.9);
    });

    it("drops a pair below the threshold rather than adding a weak edge", () => {
      const graph = buildGraph(
        [doc("a/1.md"), doc("b/2.md")],
        [{ from: "a/1.md", to: "b/2.md", score: 0.1 }],
        DEFAULT_GRAPH_RULES,
      );
      assert.ok(!edgeKinds(graph).includes("similar"));
    });

    it("can be disabled", () => {
      const graph = buildGraph(
        [doc("a/1.md"), doc("b/2.md")],
        [{ from: "a/1.md", to: "b/2.md", score: 0.99 }],
        { ...DEFAULT_GRAPH_RULES, enableSimilarity: false },
      );
      assert.ok(!edgeKinds(graph).includes("similar"));
    });
  });

  describe("determinism", () => {
    it("produces identical output across runs", () => {
      const documents = [
        doc("docs/a.md", { tags: ["x"], links: ["b.md"] }),
        doc("docs/b.md", { tags: ["x"] }),
      ];
      const pairs = [{ from: "docs/a.md", to: "docs/b.md", score: 0.8 }];
      assert.deepEqual(buildGraph(documents, pairs), buildGraph(documents, pairs));
    });

    it("sorts nodes and edges so the store is written in a stable order", () => {
      const graph = buildGraph([doc("docs/z.md"), doc("docs/a.md")], []);
      const ids = graph.nodes.map((node) => node.id);
      assert.deepEqual(ids, [...ids].sort());
    });
  });

  describe("collapseChunkNeighbors", () => {
    const owner = new Map([
      ["c1", "docs/a.md"],
      ["c2", "docs/a.md"],
      ["c3", "docs/b.md"],
    ]);

    it("maps chunk neighbours onto documents", () => {
      const pairs = collapseChunkNeighbors(new Map([["c1", [["c3", 0.8] as const]]]), owner);
      assert.deepEqual(pairs, [{ from: "docs/a.md", to: "docs/b.md", score: 0.8 }]);
    });

    it("keeps the best chunk pair so long documents do not win on volume", () => {
      const neighbors = new Map([
        ["c1", [["c3", 0.6] as const]],
        ["c2", [["c3", 0.9] as const]],
      ]);
      const pairs = collapseChunkNeighbors(neighbors, owner);
      assert.deepEqual(pairs, [{ from: "docs/a.md", to: "docs/b.md", score: 0.9 }]);
    });

    it("drops self-similarity between chunks of the same document", () => {
      const pairs = collapseChunkNeighbors(new Map([["c1", [["c2", 0.99] as const]]]), owner);
      assert.deepEqual(pairs, []);
    });

    it("ignores chunks with no known owner", () => {
      const pairs = collapseChunkNeighbors(new Map([["unknown", [["c3", 0.9] as const]]]), owner);
      assert.deepEqual(pairs, []);
    });
  });
});
