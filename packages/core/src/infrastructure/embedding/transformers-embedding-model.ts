/**
 * Semantic embeddings via transformers.js (ONNX, local, no Python).
 *
 * Opt-in: `@huggingface/transformers` is an optional peer dependency, so the
 * default install stays small and free of native build steps. Once installed,
 * the model runs entirely on this machine -- the first run downloads weights,
 * after which it is fully offline, which keeps the "no service dependency"
 * promise intact.
 *
 * The model name is configuration, not a constant, because the best
 * multilingual embedding model changes faster than this project will release.
 */

import { ConfigError } from "../../domain/errors.ts";
import type { EmbeddingModel } from "../../application/ports/models.ts";
import { l2Normalize } from "./hashing-embedding-model.ts";

/**
 * A multilingual model that handles Japanese and English, small enough to run
 * comfortably on CPU. Override it in config if a better one exists.
 */
export const DEFAULT_MODEL = "Xenova/multilingual-e5-small";

/**
 * Models trained with asymmetric prompts.
 *
 * E5-family models expect `query:` and `passage:` prefixes; omitting them
 * measurably degrades retrieval. Because the prefixes change the vectors, they
 * are folded into the model identity so a corpus built with them can never be
 * queried without them.
 */
const PROMPT_PREFIXES: ReadonlyMap<string, { query: string; passage: string }> = new Map([
  ["Xenova/multilingual-e5-small", { query: "query: ", passage: "passage: " }],
  ["Xenova/multilingual-e5-base", { query: "query: ", passage: "passage: " }],
  ["Xenova/multilingual-e5-large", { query: "query: ", passage: "passage: " }],
  ["intfloat/multilingual-e5-small", { query: "query: ", passage: "passage: " }],
  ["intfloat/multilingual-e5-base", { query: "query: ", passage: "passage: " }],
]);

interface FeatureExtractionOutput {
  dims: number[];
  data: Float32Array | number[];
  tolist?: () => number[][];
}

type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: "mean" | "cls"; normalize: boolean },
) => Promise<FeatureExtractionOutput>;

interface TransformersModule {
  pipeline(
    task: "feature-extraction",
    model: string,
    options?: Record<string, unknown>,
  ): Promise<FeatureExtractionPipeline>;
  env?: { allowRemoteModels?: boolean; cacheDir?: string };
}

export interface TransformersEmbeddingOptions {
  readonly model?: string;
  readonly batchSize?: number;
  /** Refuse to download; use only what is already cached. */
  readonly offline?: boolean;
  readonly cacheDir?: string;
}

export class TransformersEmbeddingModel implements EmbeddingModel {
  readonly id: string;
  readonly dimensions: number;
  readonly semantic = true;
  /**
   * Sentence-embedding models compress into a narrow cosine band -- E5 scores
   * most unrelated pairs around 0.7 -- so the floor sits high enough to cut the
   * genuinely unrelated without discarding paraphrases.
   */
  readonly minUsefulSimilarity = 0.7;

  readonly #pipeline: FeatureExtractionPipeline;
  readonly #batchSize: number;
  readonly #queryPrefix: string;
  readonly #passagePrefix: string;

  private constructor(input: {
    id: string;
    dimensions: number;
    pipeline: FeatureExtractionPipeline;
    batchSize: number;
    queryPrefix: string;
    passagePrefix: string;
  }) {
    this.id = input.id;
    this.dimensions = input.dimensions;
    this.#pipeline = input.pipeline;
    this.#batchSize = input.batchSize;
    this.#queryPrefix = input.queryPrefix;
    this.#passagePrefix = input.passagePrefix;
  }

  /**
   * Load the model.
   *
   * Async because the dimension has to be discovered by running one input:
   * hard-coding it per model would be a table to maintain and get wrong, and
   * the dimension is part of the identity the compatibility gate checks.
   */
  static async load(options: TransformersEmbeddingOptions = {}): Promise<TransformersEmbeddingModel> {
    const modelName = options.model ?? DEFAULT_MODEL;
    const transformers = await loadTransformers();

    if (transformers.env !== undefined) {
      if (options.offline === true) transformers.env.allowRemoteModels = false;
      if (options.cacheDir !== undefined) transformers.env.cacheDir = options.cacheDir;
    }

    let pipeline: FeatureExtractionPipeline;
    try {
      pipeline = await transformers.pipeline("feature-extraction", modelName);
    } catch (error) {
      throw new ConfigError(
        `could not load embedding model ${modelName}: ${String(error)}`,
        {
          model: modelName,
          hint:
            "check the model name exists on the Hugging Face Hub in ONNX form, " +
            "and that this machine can reach it on first use",
        },
      );
    }

    const prefixes = PROMPT_PREFIXES.get(modelName) ?? { query: "", passage: "" };
    const probe = await pipeline([`${prefixes.passage}dimension probe`], {
      pooling: "mean",
      normalize: true,
    });
    const dimensions = probe.dims[probe.dims.length - 1] ?? 0;
    if (dimensions <= 0) {
      throw new ConfigError(`model ${modelName} returned an unusable embedding shape`, {
        dims: probe.dims,
      });
    }

    // The prefixes are part of what produced the vectors, so they belong in the
    // identity: the same model with different prompts is a different index.
    const promptTag = prefixes.query === "" && prefixes.passage === "" ? "noprompt" : "e5";
    return new TransformersEmbeddingModel({
      id: `st:${modelName}:d${dimensions}:${promptTag}`,
      dimensions,
      pipeline,
      batchSize: Math.max(1, options.batchSize ?? 32),
      queryPrefix: prefixes.query,
      passagePrefix: prefixes.passage,
    });
  }

  async embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let offset = 0; offset < texts.length; offset += this.#batchSize) {
      const batch = texts
        .slice(offset, offset + this.#batchSize)
        .map((text) => this.#passagePrefix + text);
      const output = await this.#pipeline(batch, { pooling: "mean", normalize: true });
      out.push(...this.#split(output, batch.length));
    }
    return out;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const output = await this.#pipeline([this.#queryPrefix + text], {
      pooling: "mean",
      normalize: true,
    });
    const [vector] = this.#split(output, 1);
    return vector ?? new Float32Array(this.dimensions);
  }

  /** Slice the flat `[batch, dims]` tensor the pipeline returns into vectors. */
  #split(output: FeatureExtractionOutput, count: number): Float32Array[] {
    const flat = output.data instanceof Float32Array ? output.data : Float32Array.from(output.data);
    const width = output.dims[output.dims.length - 1] ?? this.dimensions;
    const vectors: Float32Array[] = [];
    for (let i = 0; i < count; i += 1) {
      // Copied rather than subarray'd: these are stored as blobs and held in
      // memory, and a view would pin the whole batch tensor alive.
      const vector = flat.slice(i * width, (i + 1) * width);
      // Normalized again defensively: the store treats a dot product as a
      // cosine, so an un-normalized vector would silently distort every score.
      vectors.push(l2Normalize(new Float32Array(vector)));
    }
    return vectors;
  }
}

async function loadTransformers(): Promise<TransformersModule> {
  // The specifier goes through a variable so TypeScript does not try to resolve
  // this optional peer dependency at build time.
  const specifier = "@huggingface/transformers";
  try {
    return (await import(specifier)) as unknown as TransformersModule;
  } catch (error) {
    throw new ConfigError(
      "semantic embeddings require @huggingface/transformers: " +
        "npm install @huggingface/transformers",
      { cause: String(error) },
    );
  }
}
