import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { InMemoryStore } from "../__fixtures__/in-memory-store.ts";
import { IncompatibleCorpusError } from "../domain/errors.ts";
import { SCHEMA_VERSION } from "../domain/model/corpus-identity.ts";
import { chunkingFingerprint } from "../domain/service/chunker.ts";
import { defaultCorpusConfig } from "../application/config.ts";
import { CORPUS_META_KEYS } from "../application/corpus-meta.ts";
import { HashingEmbeddingModel } from "../infrastructure/embedding/hashing-embedding-model.ts";
import { sha256Hasher } from "../infrastructure/system-adapters.ts";
import { corpusConfigPath, initProjectWorkspace } from "../infrastructure/config/workspace.ts";
import { saveCorpusConfig } from "../infrastructure/config/corpus-config-file.ts";
import { assertCompatible, createEmbeddingModel, openCorpus } from "./corpus-context.ts";

const config = defaultCorpusConfig("demo");
const embedding = new HashingEmbeddingModel(config.embedding.dimensions);

function builtStore(): InMemoryStore {
  const store = new InMemoryStore();
  store.meta.set(CORPUS_META_KEYS.schemaVersion, SCHEMA_VERSION);
  store.meta.set(CORPUS_META_KEYS.builtAt, "2026-09-14T00:00:00.000Z");
  store.meta.set(CORPUS_META_KEYS.embeddingId, embedding.id);
  store.meta.set(
    CORPUS_META_KEYS.chunkingFingerprint,
    chunkingFingerprint(sha256Hasher.hashText, config.chunking),
  );
  return store;
}

let root: string;
const originalHome = process.env["GRAPHDOG_HOME"];
before(async () => {
  root = await mkdtemp(join(tmpdir(), "graphdog-ctx-"));
  process.env["GRAPHDOG_HOME"] = join(root, "fake-home");
});
after(async () => {
  if (originalHome === undefined) delete process.env["GRAPHDOG_HOME"];
  else process.env["GRAPHDOG_HOME"] = originalHome;
  await rm(root, { recursive: true, force: true });
});

describe("composition/corpusContext", () => {
  describe("assertCompatible", () => {
    it("accepts a corpus whose identities match the configuration", () => {
      assert.doesNotThrow(() => assertCompatible(builtStore(), config, embedding));
    });

    it("refuses an unbuilt corpus and says how to build it", () => {
      assert.throws(
        () => assertCompatible(new InMemoryStore(), config, embedding),
        (error: unknown) => {
          assert.ok(error instanceof IncompatibleCorpusError);
          assert.match(error.message, /graphdog build/);
          return true;
        },
      );
    });

    it("refuses vectors from a different embedding model", () => {
      const store = builtStore();
      store.meta.set(CORPUS_META_KEYS.embeddingId, "st:some-other-model:d384:e5");
      assert.throws(
        () => assertCompatible(store, config, embedding),
        (error: unknown) => {
          assert.ok(error instanceof IncompatibleCorpusError);
          assert.equal(error.details["field"], "embeddingId");
          assert.equal(error.details["remedy"], "graphdog build --full");
          return true;
        },
      );
    });

    it("refuses line ranges from a different chunker", () => {
      const store = builtStore();
      store.meta.set(CORPUS_META_KEYS.chunkingFingerprint, "chunk1:0000000000000000");
      assert.throws(
        () => assertCompatible(store, config, embedding),
        (error: unknown) => {
          assert.ok(error instanceof IncompatibleCorpusError);
          assert.equal(error.details["field"], "chunkingFingerprint");
          return true;
        },
      );
    });

    it("refuses an unsupported store layout", () => {
      const store = builtStore();
      store.meta.set(CORPUS_META_KEYS.schemaVersion, "99");
      assert.throws(() => assertCompatible(store, config, embedding), IncompatibleCorpusError);
    });
  });

  describe("createEmbeddingModel", () => {
    it("builds the dependency-free model for the default configuration", async () => {
      const model = await createEmbeddingModel(config);
      assert.equal(model.semantic, false);
      assert.equal(model.dimensions, config.embedding.dimensions);
    });

    it("honours a configured dimension", async () => {
      const model = await createEmbeddingModel({
        ...config,
        embedding: { ...config.embedding, dimensions: 64 },
      });
      assert.equal(model.dimensions, 64);
      assert.match(model.id, /d64/);
    });
  });

  describe("openCorpus", () => {
    it("assembles a context with every dependency wired", async () => {
      const project = join(root, "project");
      const workspace = await initProjectWorkspace(project);
      await saveCorpusConfig(corpusConfigPath(workspace, "demo"), config);

      const corpus = await openCorpus({ corpus: "demo", cwd: project });
      try {
        assert.equal(corpus.name, "demo");
        assert.equal(corpus.scope, "project");
        assert.ok(corpus.store !== undefined);
        assert.ok(corpus.extractors.supports(".md"));
        assert.equal(corpus.embedding.semantic, false);
      } finally {
        corpus.close();
      }
    });

    it("reports 'unknown' freshness for a corpus that was never built", async () => {
      const project = join(root, "unbuilt");
      const workspace = await initProjectWorkspace(project);
      await saveCorpusConfig(corpusConfigPath(workspace, "demo"), config);

      const corpus = await openCorpus({ corpus: "demo", cwd: project });
      try {
        assert.equal(corpus.freshness().status, "unknown");
      } finally {
        corpus.close();
      }
    });

    it("does not load a reranker just because a corpus was opened", async () => {
      // `reranker()` now always attempts the load when asked, because
      // `rerank.enabled` says whether to rerank by default and not whether the
      // model may be loaded -- conflating the two made `--rerank` a one-way
      // switch that could only turn reranking off. What keeps that from costing
      // a model load on every corpus is that opening one never asks.
      const project = join(root, "norerank");
      const workspace = await initProjectWorkspace(project);
      await saveCorpusConfig(corpusConfigPath(workspace, "demo"), config);

      const messages: string[] = [];
      const corpus = await openCorpus({
        corpus: "demo",
        cwd: project,
        logger: { log: (_level, message) => messages.push(message) },
      });
      try {
        assert.ok(
          !messages.some((message) => message.includes("reranker")),
          `opening a corpus touched the reranker: ${messages.join(" | ")}`,
        );
      } finally {
        corpus.close();
      }
    });

    it("refuses to open an incompatible corpus when asked to require compatibility", async () => {
      const project = join(root, "strict");
      const workspace = await initProjectWorkspace(project);
      await saveCorpusConfig(corpusConfigPath(workspace, "demo"), config);

      await assert.rejects(
        () => openCorpus({ corpus: "demo", cwd: project, requireCompatible: true }),
        IncompatibleCorpusError,
      );
    });

    it("skips source adapters when they are not needed", async () => {
      const project = join(root, "nosources");
      const workspace = await initProjectWorkspace(project);
      await saveCorpusConfig(corpusConfigPath(workspace, "demo"), config);

      const corpus = await openCorpus({ corpus: "demo", cwd: project, withoutSources: true });
      try {
        assert.deepEqual(corpus.sources, []);
      } finally {
        corpus.close();
      }
    });
  });
});
