import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryStore, StubEmbeddingModel } from "../../__fixtures__/in-memory-store.ts";
import { assessFreshness } from "../../domain/model/freshness.ts";
import { documentNodeId, tagNodeId } from "../../domain/model/graph.ts";
import { defaultCorpusConfig } from "../config.ts";
import { exploreCorpus } from "./explore-corpus.ts";
import { searchCorpus, type SearchDependencies } from "./search-corpus.ts";

function fixture(): SearchDependencies {
  const store = new InMemoryStore();
  store.addDocument({ ref: "docs/keys.md", title: "Keys", tags: ["auth"], text: "JWKS endpoint." });
  store.addDocument({ ref: "docs/token.md", title: "Token", tags: ["auth"], text: "Bearer values." });
  store.graph.replaceAll(
    [
      { id: documentNodeId("docs/keys.md"), kind: "document", label: "Keys", ref: "docs/keys.md" },
      { id: documentNodeId("docs/token.md"), kind: "document", label: "Token", ref: "docs/token.md" },
      { id: tagNodeId("auth"), kind: "tag", label: "auth", ref: null },
    ],
    [
      { src: documentNodeId("docs/keys.md"), dst: tagNodeId("auth"), kind: "same_tag", weight: 0.5 },
      { src: tagNodeId("auth"), dst: documentNodeId("docs/token.md"), kind: "same_tag", weight: 0.5 },
    ],
  );
  const base = defaultCorpusConfig("test");
  return {
    store,
    config: { ...base, search: { ...base.search, minScore: 0 } },
    embedding: new StubEmbeddingModel(),
    freshness: assessFreshness("2026-09-14T00:00:00.000Z", []),
  };
}

describe("application/usecase/exploreCorpus", () => {
  it("returns the neighbourhood of the results", async () => {
    const result = await exploreCorpus({ query: "JWKS" }, fixture());
    assert.ok(result.nodes.length > 0);
    assert.ok(result.edges.length > 0);
  });

  it("includes the waypoint nodes that connect documents", async () => {
    const result = await exploreCorpus({ query: "JWKS" }, fixture());
    assert.ok(result.nodes.some((node) => node.kind === "tag"));
  });

  it("agrees with search about the top result", async () => {
    const deps = fixture();
    const searched = await searchCorpus({ query: "JWKS" }, deps);
    const explored = await exploreCorpus({ query: "JWKS" }, deps);
    assert.equal(explored.hits[0]?.ref, searched.hits[0]?.ref);
  });

  it("uses a wider hop budget than search by default", async () => {
    const deps = fixture();
    const explored = await exploreCorpus({ query: "JWKS" }, deps);
    assert.match(String(explored.strategy["graph"]), /3hop/);
  });

  it("honours an explicit hop override", async () => {
    const explored = await exploreCorpus({ query: "JWKS", hops: 1 }, fixture());
    assert.match(String(explored.strategy["graph"]), /1hop/);
  });

  it("returns an empty neighbourhood when nothing was found", async () => {
    const result = await exploreCorpus({ query: "nonexistent-term-xyz" }, fixture());
    assert.ok(result.noEvidence);
    assert.deepEqual(result.nodes, []);
    assert.deepEqual(result.edges, []);
  });

  it("caps the neighbourhood size", async () => {
    const result = await exploreCorpus({ query: "JWKS", neighborhoodLimit: 1 }, fixture());
    assert.ok(result.edges.length <= 1);
  });
});
