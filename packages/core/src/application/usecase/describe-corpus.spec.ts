import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { InMemoryStore } from "../../__fixtures__/in-memory-store.ts";
import { SCHEMA_VERSION } from "../../domain/model/corpus-identity.ts";
import { chunkingFingerprint } from "../../domain/service/chunker.ts";
import { defaultCorpusConfig } from "../config.ts";
import { CORPUS_META_KEYS } from "../corpus-meta.ts";
import { WarningCode } from "../dto/contracts.ts";
import type { Hasher } from "../ports/system.ts";
import { describeCorpus, type DescribeDependencies } from "./describe-corpus.ts";

const hasher: Hasher = {
  hashText: (input) => createHash("sha256").update(input, "utf8").digest("hex"),
  hashBytes: (input) => createHash("sha256").update(input).digest("hex"),
};

const config = defaultCorpusConfig("test-corpus");
const BUILT_AT = "2026-09-14T00:00:00.000Z";

function builtStore(): InMemoryStore {
  const store = new InMemoryStore();
  store.addDocument({ ref: "docs/a.md", text: "alpha content", revision: "abc" });
  store.meta.set(CORPUS_META_KEYS.schemaVersion, SCHEMA_VERSION);
  store.meta.set(CORPUS_META_KEYS.corpusName, "test-corpus");
  store.meta.set(CORPUS_META_KEYS.builtAt, BUILT_AT);
  store.meta.set(CORPUS_META_KEYS.embeddingId, "hash-v1:d256");
  store.meta.set(CORPUS_META_KEYS.embeddingDimensions, "256");
  store.meta.set(CORPUS_META_KEYS.embeddingSemantic, "0");
  store.meta.set(
    CORPUS_META_KEYS.chunkingFingerprint,
    chunkingFingerprint(hasher.hashText, config.chunking),
  );
  store.meta.upsertSource({
    id: "docs",
    kind: "git",
    uri: "/repo",
    revision: "abc",
    indexedAt: BUILT_AT,
    spec: {},
  });
  return store;
}

const deps = (store: InMemoryStore, extra: Partial<DescribeDependencies> = {}): DescribeDependencies => ({
  store,
  config,
  hasher,
  path: "/tmp/corpus",
  scope: "project",
  ...extra,
});

describe("application/usecase/describeCorpus", () => {
  it("reports counts of what is indexed", () => {
    const result = describeCorpus(deps(builtStore()));
    assert.equal(result.counts["documents"], 1);
    assert.ok((result.counts["chunks"] ?? 0) > 0);
  });

  it("reports the corpus as compatible when identities line up", () => {
    const result = describeCorpus(deps(builtStore()));
    assert.equal(result.compatible, true);
    assert.equal(result.incompatibility, null);
  });

  it("reports incompatibility as a field rather than throwing", () => {
    const store = builtStore();
    store.meta.set(CORPUS_META_KEYS.chunkingFingerprint, "chunk1:somethingelse");
    const result = describeCorpus(deps(store));
    assert.equal(result.compatible, false);
    assert.match(result.incompatibility ?? "", /chunk/);
  });

  it("does not call an unbuilt corpus incompatible", () => {
    const result = describeCorpus(deps(new InMemoryStore()));
    assert.equal(result.compatible, true);
    assert.equal(result.freshness.status, "unknown");
  });

  it("lists sources with their indexed revision and document count", () => {
    const result = describeCorpus(deps(builtStore()));
    assert.equal(result.sources[0]?.id, "docs");
    assert.equal(result.sources[0]?.revision, "abc");
    assert.equal(result.sources[0]?.documentCount, 1);
  });

  it("reports current when the live revision matches", () => {
    const live = {
      spec: { id: "docs", kind: "git", uri: "/repo", include: [], exclude: [], maxFileBytes: 0, followSymlinks: false, indexSecrets: false },
      revision: () => "abc",
      discover: () => [],
      exclusions: () => [],
      resolve: () => null,
    };
    const result = describeCorpus(deps(builtStore(), { sources: [live] }));
    assert.equal(result.freshness.status, "current");
  });

  it("reports stale and warns when the live revision has moved on", () => {
    const live = {
      spec: { id: "docs", kind: "git", uri: "/repo", include: [], exclude: [], maxFileBytes: 0, followSymlinks: false, indexSecrets: false },
      revision: () => "newsha",
      discover: () => [],
      exclusions: () => [],
      resolve: () => null,
    };
    const result = describeCorpus(deps(builtStore(), { sources: [live] }));
    assert.equal(result.freshness.status, "stale");
    assert.ok(result.warnings.some((w) => w.code === WarningCode.STALE_CORPUS));
  });

  it("does not report false staleness when no live source is available", () => {
    const result = describeCorpus(deps(builtStore()));
    assert.equal(result.freshness.status, "current");
  });

  it("warns that the built-in embedder is not semantic", () => {
    const result = describeCorpus(deps(builtStore()));
    assert.ok(result.warnings.some((w) => w.code === WarningCode.LEXICAL_EMBEDDING));
  });

  it("surfaces indexing failures", () => {
    const store = builtStore();
    store.meta.recordFailure({
      ref: "docs/broken.pdf",
      stage: "extract",
      code: "extraction_failed",
      message: "no text layer",
      at: BUILT_AT,
    });
    const result = describeCorpus(deps(store));
    assert.equal(result.counts["failures"], 1);
    assert.ok(result.warnings.some((w) => w.code === WarningCode.PARTIAL_INDEX));
  });

  it("reports both the stored and the currently configured chunking fingerprint", () => {
    const result = describeCorpus(deps(builtStore()));
    assert.equal(result.chunking["fingerprint"], result.chunking["expected_fingerprint"]);
  });
});
