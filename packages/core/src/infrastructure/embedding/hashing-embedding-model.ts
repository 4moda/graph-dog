/**
 * The built-in, dependency-free embedding model.
 *
 * This is a *lexical* embedder: signed feature hashing over the same tokens
 * BM25 uses. It exists so that `npx graphdog` works in seconds, offline, with
 * no model download, and produces byte-identical vectors on every machine --
 * which is what makes a portable corpus actually portable.
 *
 * It is explicitly not a semantic model and does not pretend to be. `semantic`
 * is false, `status` reports the fact, and every search over such a corpus
 * carries a warning pointing at the semantic option. Shipping a weak default
 * that announces its own weakness is better than shipping a heavyweight
 * default that most users never get past installing.
 *
 * Why it is worth having at all, given BM25 already exists: the dense vectors
 * also drive the similarity edges in the relation graph, and the two signals
 * weight terms differently -- BM25 by corpus-wide rarity, this by within-chunk
 * prominence -- so fusing them still separates results that either alone ties.
 */

import { createHash } from "node:crypto";

import { ConfigError } from "../../domain/errors.ts";
import { termFrequencies } from "../../domain/service/tokenizer.ts";
import type { EmbeddingModel } from "../../application/ports/models.ts";

export const DEFAULT_DIMENSIONS = 256;

export class HashingEmbeddingModel implements EmbeddingModel {
  readonly id: string;
  readonly dimensions: number;
  readonly semantic = false;
  /**
   * Signed feature hashing collides: two texts sharing no terms still land a
   * few terms in the same buckets, which on short inputs yields cosines around
   * 0.1-0.3. Below this, similarity is collision noise rather than evidence.
   */
  readonly minUsefulSimilarity = 0.35;

  constructor(dimensions: number = DEFAULT_DIMENSIONS) {
    if (!Number.isInteger(dimensions) || dimensions < 32 || dimensions % 8 !== 0) {
      throw new ConfigError(
        `embedding dimensions must be an integer multiple of 8, at least 32; got ${dimensions}`,
      );
    }
    this.dimensions = dimensions;
    this.id = `hash-v1:d${dimensions}`;
  }

  async embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.#embed(text));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.#embed(text);
  }

  #embed(text: string): Float32Array {
    const vector = new Float32Array(this.dimensions);
    for (const [term, frequency] of termFrequencies(text)) {
      const digest = createHash("sha256").update(term, "utf8").digest();
      // First four bytes choose the bucket; one bit of a later byte chooses the
      // sign. Signed hashing keeps collisions from systematically inflating
      // similarity: colliding terms cancel about as often as they reinforce.
      const bucket = digest.readUInt32LE(0) % this.dimensions;
      const sign = (digest[8] ?? 0) & 1 ? 1 : -1;
      // Sublinear term frequency, so one repeated word cannot dominate the
      // direction of a chunk the way raw counts would.
      vector[bucket] = (vector[bucket] ?? 0) + sign * (1 + Math.log(frequency));
    }
    return l2Normalize(vector);
  }
}

/** Normalize in place so cosine similarity is a plain dot product downstream. */
export function l2Normalize(vector: Float32Array): Float32Array {
  let sumOfSquares = 0;
  for (const value of vector) sumOfSquares += value * value;
  if (sumOfSquares === 0) return vector;
  const norm = Math.sqrt(sumOfSquares);
  for (let i = 0; i < vector.length; i += 1) vector[i] = (vector[i] ?? 0) / norm;
  return vector;
}
