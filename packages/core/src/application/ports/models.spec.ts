import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { StubEmbeddingModel } from "../../__fixtures__/in-memory-store.ts";
import type { EmbeddingModel, RerankCandidate, Reranker } from "./models.ts";

/**
 * These are interfaces, so what is worth testing is that the contract they
 * describe is satisfiable and that its invariants hold for an implementation.
 * The real adapters are covered by their own specs.
 */
describe("application/ports/models", () => {
  describe("EmbeddingModel", () => {
    const model: EmbeddingModel = new StubEmbeddingModel({ hello: [1, 0, 0] });

    it("declares an identity, a dimension and whether it is semantic", () => {
      assert.equal(typeof model.id, "string");
      assert.ok(model.dimensions > 0);
      assert.equal(typeof model.semantic, "boolean");
    });

    it("declares the cosine below which its output is noise", () => {
      assert.ok(model.minUsefulSimilarity >= 0 && model.minUsefulSimilarity < 1);
    });

    it("embeds a batch positionally", async () => {
      const vectors = await model.embedDocuments(["hello", "unknown"]);
      assert.equal(vectors.length, 2);
      assert.equal(vectors[0]?.length, model.dimensions);
    });

    it("embeds a query to the same dimension as documents", async () => {
      const query = await model.embedQuery("hello");
      const [document] = await model.embedDocuments(["hello"]);
      assert.equal(query.length, document?.length);
    });
  });

  describe("Reranker", () => {
    const reranker: Reranker = {
      id: "test",
      rerank: async (_query, candidates: readonly RerankCandidate[]) =>
        candidates.map((candidate, index) => ({ id: candidate.id, score: 1 - index * 0.1 })),
    };

    it("returns a score per candidate, keyed by the same ids", async () => {
      const results = await reranker.rerank("q", [
        { id: "a", text: "alpha" },
        { id: "b", text: "beta" },
      ]);
      assert.deepEqual(results.map((result) => result.id).sort(), ["a", "b"]);
    });

    it("handles an empty shortlist", async () => {
      assert.deepEqual(await reranker.rerank("q", []), []);
    });
  });
});
