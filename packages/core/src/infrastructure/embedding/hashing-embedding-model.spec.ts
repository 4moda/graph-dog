import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError } from "../../domain/errors.ts";
import { HashingEmbeddingModel, l2Normalize } from "./hashing-embedding-model.ts";

const model = new HashingEmbeddingModel(64);

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

describe("infrastructure/embedding/hashingEmbeddingModel", () => {
  describe("identity", () => {
    it("encodes the dimension, so two sizes are never mixed", () => {
      assert.equal(new HashingEmbeddingModel(64).id, "hash-v1:d64");
      assert.notEqual(new HashingEmbeddingModel(64).id, new HashingEmbeddingModel(128).id);
    });

    it("declares itself non-semantic", () => {
      assert.equal(model.semantic, false);
    });

    it("rejects a dimension it cannot use", () => {
      assert.throws(() => new HashingEmbeddingModel(7), ConfigError);
      assert.throws(() => new HashingEmbeddingModel(16), ConfigError);
      assert.throws(() => new HashingEmbeddingModel(100), ConfigError);
    });
  });

  describe("vectors", () => {
    it("produces vectors of the declared dimension", async () => {
      assert.equal((await model.embedQuery("text")).length, 64);
    });

    it("is deterministic", async () => {
      const first = await model.embedQuery("access token rotation");
      const second = await model.embedQuery("access token rotation");
      assert.deepEqual([...first], [...second]);
    });

    it("normalizes to unit length, so a dot product is a cosine", async () => {
      const vector = await model.embedQuery("some indexed content");
      assert.ok(Math.abs(Math.sqrt(cosine(vector, vector)) - 1) < 1e-5);
    });

    it("handles empty text without producing NaN", async () => {
      const vector = await model.embedQuery("");
      assert.ok([...vector].every((value) => Number.isFinite(value)));
    });

    it("handles text with no index terms", async () => {
      const vector = await model.embedQuery("!!! ???");
      assert.ok([...vector].every((value) => Number.isFinite(value)));
    });
  });

  describe("similarity behaviour", () => {
    it("scores identical text at 1", async () => {
      const [a, b] = await model.embedDocuments(["token rotation policy", "token rotation policy"]);
      assert.ok(Math.abs(cosine(a!, b!) - 1) < 1e-5);
    });

    it("scores overlapping text above unrelated text", async () => {
      const [shared, unrelated, base] = await model.embedDocuments([
        "access token rotation policy",
        "cafeteria lunch menu options",
        "access token rotation schedule",
      ]);
      assert.ok(cosine(base!, shared!) > cosine(base!, unrelated!));
    });

    it("matches Japanese text through shared bigrams", async () => {
      const [a, b, c] = await model.embedDocuments([
        "アクセストークンの設計",
        "アクセストークンの運用",
        "食堂のメニュー",
      ]);
      assert.ok(cosine(a!, b!) > cosine(a!, c!));
    });

    it("saturates repeated terms rather than letting them dominate", async () => {
      const [once, many, other] = await model.embedDocuments([
        "alpha beta gamma",
        `${"alpha ".repeat(50)}beta gamma`,
        "beta gamma",
      ]);
      // With linear tf the repeated word would swamp the vector and drive
      // similarity to the shorter text toward zero.
      assert.ok(cosine(many!, other!) > 0.2, `got ${cosine(many!, other!)}`);
      assert.ok(cosine(once!, other!) > cosine(many!, other!));
    });
  });

  describe("embedDocuments", () => {
    it("maps a batch positionally", async () => {
      const vectors = await model.embedDocuments(["one", "two", "three"]);
      assert.equal(vectors.length, 3);
      const single = await model.embedQuery("two");
      assert.deepEqual([...(vectors[1] ?? [])], [...single]);
    });

    it("returns an empty array for an empty batch", async () => {
      assert.deepEqual(await model.embedDocuments([]), []);
    });
  });

  describe("l2Normalize", () => {
    it("leaves a zero vector alone rather than dividing by zero", () => {
      const zero = l2Normalize(new Float32Array([0, 0, 0]));
      assert.deepEqual([...zero], [0, 0, 0]);
    });

    it("scales to unit length", () => {
      const vector = l2Normalize(Float32Array.from([3, 4]));
      assert.ok(Math.abs((vector[0] ?? 0) - 0.6) < 1e-6);
      assert.ok(Math.abs((vector[1] ?? 0) - 0.8) < 1e-6);
    });
  });
});
