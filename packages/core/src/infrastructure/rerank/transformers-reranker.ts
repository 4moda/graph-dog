/**
 * Cross-encoder reranking via transformers.js.
 *
 * A cross-encoder reads the query and the passage *together* rather than
 * comparing two independently produced vectors, which is why it is markedly
 * more accurate -- and why it is far too slow to run over a whole corpus. It
 * therefore runs only on the top of the fused list, and it is always optional:
 * search returns well-ordered results without it, and says so when it was
 * asked for but unavailable.
 *
 * The model is configuration rather than a constant. The best multilingual
 * cross-encoder changes faster than this project will release, and swapping it
 * must not require a new version of GraphDog.
 */

import { ConfigError } from "../../domain/errors.ts";
import { compareStrings } from "../../domain/ordering.ts";
import type { RerankCandidate, RerankResult, Reranker } from "../../application/ports/models.ts";

/**
 * Default cross-encoder.
 *
 * BGE reranker base is multilingual (Japanese included) and small enough to
 * run on CPU. Override `rerank.model` in config to use another; any ONNX
 * sequence-classification model that scores a (query, passage) pair works.
 */
export const DEFAULT_RERANK_MODEL = "Xenova/bge-reranker-base";

interface ClassificationOutput {
  /** `[batch, labels]`. One label means a raw relevance score. */
  dims: number[];
  data: Float32Array | number[];
}

type TextClassificationPipeline = (
  pairs: Array<{ text: string; text_pair: string }>,
  options?: Record<string, unknown>,
) => Promise<ClassificationOutput | Array<{ label: string; score: number }>>;

interface TransformersModule {
  pipeline(
    task: "text-classification",
    model: string,
    options?: Record<string, unknown>,
  ): Promise<TextClassificationPipeline>;
  env?: { allowRemoteModels?: boolean; cacheDir?: string };
}

export interface TransformersRerankerOptions {
  readonly model?: string;
  readonly batchSize?: number;
  readonly offline?: boolean;
  readonly cacheDir?: string;
  /** Passages longer than this are truncated before scoring, to bound latency. */
  readonly maxPassageChars?: number;
}

export class TransformersReranker implements Reranker {
  readonly id: string;
  readonly #pipeline: TextClassificationPipeline;
  readonly #batchSize: number;
  readonly #maxPassageChars: number;

  private constructor(input: {
    id: string;
    pipeline: TextClassificationPipeline;
    batchSize: number;
    maxPassageChars: number;
  }) {
    this.id = input.id;
    this.#pipeline = input.pipeline;
    this.#batchSize = input.batchSize;
    this.#maxPassageChars = input.maxPassageChars;
  }

  static async load(options: TransformersRerankerOptions = {}): Promise<TransformersReranker> {
    const modelName = options.model ?? DEFAULT_RERANK_MODEL;
    const transformers = await loadTransformers();

    if (transformers.env !== undefined) {
      if (options.offline === true) transformers.env.allowRemoteModels = false;
      if (options.cacheDir !== undefined) transformers.env.cacheDir = options.cacheDir;
    }

    let pipeline: TextClassificationPipeline;
    try {
      pipeline = await transformers.pipeline("text-classification", modelName);
    } catch (error) {
      throw new ConfigError(`could not load reranker model ${modelName}: ${String(error)}`, {
        model: modelName,
        hint:
          "check the model exists on the Hugging Face Hub in ONNX form; any " +
          "cross-encoder that scores a (query, passage) pair will work",
      });
    }

    return new TransformersReranker({
      id: `rerank:${modelName}`,
      pipeline,
      batchSize: Math.max(1, options.batchSize ?? 8),
      maxPassageChars: Math.max(256, options.maxPassageChars ?? 2000),
    });
  }

  async rerank(query: string, candidates: readonly RerankCandidate[]): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];

    const scores = new Map<string, number>();
    for (let offset = 0; offset < candidates.length; offset += this.#batchSize) {
      const batch = candidates.slice(offset, offset + this.#batchSize);
      const output = await this.#pipeline(
        batch.map((candidate) => ({
          text: query,
          text_pair: candidate.text.slice(0, this.#maxPassageChars),
        })),
        { top_k: 1 },
      );
      const batchScores = readScores(output, batch.length);
      batch.forEach((candidate, index) => {
        scores.set(candidate.id, batchScores[index] ?? 0);
      });
    }

    return [...scores.entries()]
      .sort((left, right) =>
        right[1] === left[1] ? compareStrings(left[0], right[0]) : right[1] - left[1],
      )
      .map(([id, score]) => ({ id, score }));
  }
}

/**
 * Read per-candidate scores from whichever shape the pipeline returned.
 *
 * transformers.js returns either raw logits (a tensor) or an array of
 * `{label, score}` depending on the model's config. Handling both means a user
 * can point `rerank.model` at any cross-encoder without us shipping a
 * per-model adapter.
 */
function readScores(
  output: ClassificationOutput | Array<{ label: string; score: number }>,
  count: number,
): number[] {
  if (Array.isArray(output)) {
    return output.slice(0, count).map((entry) => entry.score);
  }
  const flat = output.data instanceof Float32Array ? output.data : Float32Array.from(output.data);
  const labels = output.dims[output.dims.length - 1] ?? 1;
  const scores: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (labels === 1) {
      scores.push(flat[i] ?? 0);
    } else {
      // Two-label head: the positive-class logit is the relevance signal.
      const positive = flat[i * labels + 1] ?? 0;
      const negative = flat[i * labels] ?? 0;
      scores.push(positive - negative);
    }
  }
  return scores;
}

async function loadTransformers(): Promise<TransformersModule> {
  // Through a variable so TypeScript does not resolve this optional peer
  // dependency at build time.
  const specifier = "@huggingface/transformers";
  try {
    return (await import(specifier)) as unknown as TransformersModule;
  } catch (error) {
    throw new ConfigError(
      "reranking requires @huggingface/transformers: npm install @huggingface/transformers",
      { cause: String(error) },
    );
  }
}
