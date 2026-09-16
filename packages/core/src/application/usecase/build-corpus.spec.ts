import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  InMemoryStore,
  StubEmbeddingModel,
  WordVectorEmbeddingModel,
} from "../../__fixtures__/in-memory-store.ts";
import { ExtractionError } from "../../domain/errors.ts";
import { defaultCorpusConfig, type CorpusConfig } from "../config.ts";
import { CORPUS_META_KEYS } from "../corpus-meta.ts";
import { WarningCode } from "../dto/contracts.ts";
import type { DiscoveredFile, ExtractedDocument, ExtractorRegistry, SourceExclusion, SourceReader } from "../ports/sources.ts";
import type { Clock, Hasher } from "../ports/system.ts";
import { buildCorpus, type BuildDependencies } from "./build-corpus.ts";

const hasher: Hasher = {
  hashText: (input) => createHash("sha256").update(input, "utf8").digest("hex"),
  hashBytes: (input) => createHash("sha256").update(input).digest("hex"),
};

function fixedClock(): Clock {
  let tick = 0;
  return { nowIso: () => "2026-09-14T00:00:00.000Z", monotonicMs: () => (tick += 100) };
}

/** A source whose files live in a plain object, so no filesystem is involved. */
class FakeSource implements SourceReader {
  readonly spec = {
    id: "docs",
    kind: "fake",
    uri: "/fake",
    include: [],
    exclude: [],
    maxFileBytes: 1_000_000,
    followSymlinks: false,
    indexSecrets: false,
  };

  files: Record<string, string>;
  revisionValue: string | null;
  skipped: SourceExclusion[];

  // Explicit fields rather than parameter properties: Node's type-stripping
  // runs the .spec.ts files directly and does not support that syntax.
  constructor(
    files: Record<string, string>,
    revisionValue: string | null = "rev1",
    skipped: SourceExclusion[] = [],
  ) {
    this.files = files;
    this.revisionValue = revisionValue;
    this.skipped = skipped;
  }

  revision(): string | null {
    return this.revisionValue;
  }

  discover(): DiscoveredFile[] {
    return Object.keys(this.files)
      .sort()
      .map((name) => ({
        ref: `docs/${name}`,
        absolutePath: name,
        size: (this.files[name] ?? "").length,
        mtime: 0,
      }));
  }

  exclusions(): SourceExclusion[] {
    return this.skipped;
  }

  resolve(ref: string): string | null {
    const name = ref.slice("docs/".length);
    return name in this.files ? name : null;
  }
}

function registryFor(source: FakeSource, failing: Set<string> = new Set()): ExtractorRegistry {
  return {
    supports: () => true,
    supportedExtensions: () => new Set([".md"]),
    extract: async (absolutePath: string): Promise<ExtractedDocument> => {
      if (failing.has(absolutePath)) {
        throw new ExtractionError("no text layer", { path: absolutePath });
      }
      const text = source.files[absolutePath] ?? "";
      return {
        text,
        title: absolutePath,
        mediaType: "text/markdown",
        pageBreaks: [],
        tags: text.includes("#auth") ? ["auth"] : [],
        links: [],
        notes: text.includes("NOTE") ? ["a non-fatal extraction note"] : [],
      };
    },
  };
}

function deps(
  store: InMemoryStore,
  source: FakeSource,
  overrides: Partial<BuildDependencies> = {},
): BuildDependencies {
  const base: CorpusConfig = defaultCorpusConfig("test-corpus");
  return {
    store,
    config: base,
    sources: [source],
    extractors: registryFor(source),
    embedding: new StubEmbeddingModel(),
    clock: fixedClock(),
    hasher,
    readFile: async (path: string) => new TextEncoder().encode(source.files[path] ?? ""),
    ...overrides,
  };
}

describe("application/usecase/buildCorpus", () => {
  describe("first build", () => {
    it("indexes every discovered file", async () => {
      const store = new InMemoryStore();
      const source = new FakeSource({ "a.md": "alpha text here", "b.md": "beta text here" });
      const report = await buildCorpus({}, deps(store, source));

      assert.equal(report.status, "ok");
      assert.equal(report.documents.added, 2);
      assert.equal(store.documents.count(), 2);
      assert.ok(report.chunks > 0);
    });

    it("stores the full document text, untruncated", async () => {
      const store = new InMemoryStore();
      const long = "x".repeat(20_000);
      const source = new FakeSource({ "a.md": long });
      await buildCorpus({}, deps(store, source));
      assert.equal(store.documents.get("docs/a.md")?.text.length, 20_000);
    });

    it("records the identities needed to check compatibility later", async () => {
      const store = new InMemoryStore();
      await buildCorpus({}, deps(store, new FakeSource({ "a.md": "content" })));
      assert.equal(store.meta.get(CORPUS_META_KEYS.embeddingId), "stub:v1:d3");
      assert.ok(store.meta.get(CORPUS_META_KEYS.chunkingFingerprint)?.startsWith("chunk1:"));
      assert.equal(store.meta.get(CORPUS_META_KEYS.builtAt), "2026-09-14T00:00:00.000Z");
    });

    it("records the source and its revision", async () => {
      const store = new InMemoryStore();
      await buildCorpus({}, deps(store, new FakeSource({ "a.md": "content" }, "sha-123")));
      assert.equal(store.meta.listSources()[0]?.revision, "sha-123");
      assert.equal(store.documents.get("docs/a.md")?.revision, "sha-123");
    });

    it("builds the relation graph", async () => {
      const store = new InMemoryStore();
      const source = new FakeSource({ "a.md": "alpha #auth", "b.md": "beta #auth" });
      const report = await buildCorpus({}, deps(store, source));
      assert.ok(report.nodes > 0);
      assert.ok(report.edges > 0, "documents sharing a tag should be connected");
    });

    it("makes the corpus searchable lexically", async () => {
      const store = new InMemoryStore();
      await buildCorpus({}, deps(store, new FakeSource({ "a.md": "distinctive vocabulary" })));
      assert.ok(store.lexical.postingsFor(["distinctive"]).length > 0);
    });
  });

  describe("incremental update", () => {
    it("skips files whose content has not changed", async () => {
      const store = new InMemoryStore();
      const source = new FakeSource({ "a.md": "alpha", "b.md": "beta" });
      await buildCorpus({}, deps(store, source));
      const second = await buildCorpus({}, deps(store, source));

      assert.equal(second.documents.unchanged, 2);
      assert.equal(second.documents.added, 0);
      assert.equal(second.documents.modified, 0);
    });

    it("re-indexes a modified file", async () => {
      const store = new InMemoryStore();
      const source = new FakeSource({ "a.md": "alpha" });
      await buildCorpus({}, deps(store, source));

      source.files["a.md"] = "alpha rewritten completely";
      const second = await buildCorpus({}, deps(store, source));

      assert.equal(second.documents.modified, 1);
      assert.match(store.documents.get("docs/a.md")?.text ?? "", /rewritten/);
    });

    it("does not leave stale chunks behind after an edit", async () => {
      const store = new InMemoryStore();
      const source = new FakeSource({ "a.md": "original wording" });
      await buildCorpus({}, deps(store, source));

      source.files["a.md"] = "replacement wording";
      await buildCorpus({}, deps(store, source));

      const texts = store.chunks.listByRef("docs/a.md").map((chunk) => chunk.text);
      assert.ok(!texts.some((text) => text.includes("original")), "old chunk survived the update");
    });

    it("removes documents that disappeared from the source", async () => {
      const store = new InMemoryStore();
      const source = new FakeSource({ "a.md": "alpha", "b.md": "beta" });
      await buildCorpus({}, deps(store, source));

      delete source.files["b.md"];
      const second = await buildCorpus({}, deps(store, source));

      assert.equal(second.documents.deleted, 1);
      assert.equal(store.documents.get("docs/b.md"), null);
      assert.equal(store.chunks.listByRef("docs/b.md").length, 0);
    });

    it("handles a rename as a delete plus an add", async () => {
      const store = new InMemoryStore();
      const source = new FakeSource({ "old.md": "same content" });
      await buildCorpus({}, deps(store, source));

      delete source.files["old.md"];
      source.files["new.md"] = "same content";
      const second = await buildCorpus({}, deps(store, source));

      assert.equal(second.documents.added, 1);
      assert.equal(second.documents.deleted, 1);
      assert.equal(store.documents.get("docs/old.md"), null);
      assert.ok(store.documents.get("docs/new.md"));
    });

    it("re-indexes everything when asked for a full rebuild", async () => {
      const store = new InMemoryStore();
      const source = new FakeSource({ "a.md": "alpha" });
      await buildCorpus({}, deps(store, source));
      const second = await buildCorpus({ full: true }, deps(store, source));
      assert.equal(second.documents.modified, 1);
      assert.equal(second.documents.unchanged, 0);
    });
  });

  describe("partial failure", () => {
    it("reports partial rather than ok, and keeps the files that worked", async () => {
      const store = new InMemoryStore();
      const source = new FakeSource({ "good.md": "fine content", "bad.pdf": "unreadable" });
      const report = await buildCorpus(
        {},
        deps(store, source, { extractors: registryFor(source, new Set(["bad.pdf"])) }),
      );

      assert.equal(report.status, "partial");
      assert.equal(report.failures.length, 1);
      assert.equal(report.failures[0]?.ref, "docs/bad.pdf");
      assert.ok(store.documents.get("docs/good.md"), "a failure must not abort the build");
    });

    it("names the reason a file failed", async () => {
      const store = new InMemoryStore();
      const source = new FakeSource({ "bad.pdf": "x" });
      const report = await buildCorpus(
        {},
        deps(store, source, { extractors: registryFor(source, new Set(["bad.pdf"])) }),
      );
      assert.equal(report.failures[0]?.code, "extraction_failed");
      assert.match(report.failures[0]?.message ?? "", /no text layer/);
    });

    it("warns that the corpus is incomplete", async () => {
      const store = new InMemoryStore();
      const source = new FakeSource({ "bad.pdf": "x" });
      const report = await buildCorpus(
        {},
        deps(store, source, { extractors: registryFor(source, new Set(["bad.pdf"])) }),
      );
      assert.ok(report.warnings.some((w) => w.code === WarningCode.PARTIAL_INDEX));
    });

    it("clears a previous failure once the file can be read", async () => {
      const store = new InMemoryStore();
      const source = new FakeSource({ "flaky.md": "v1" });
      await buildCorpus({}, deps(store, source, { extractors: registryFor(source, new Set(["flaky.md"])) }));
      assert.equal(store.meta.listFailures().length, 1);

      source.files["flaky.md"] = "v2 now readable";
      const second = await buildCorpus({}, deps(store, source));
      assert.equal(second.status, "ok");
      assert.equal(store.meta.listFailures().length, 0);
    });

    it("records a read failure separately from an extraction failure", async () => {
      const store = new InMemoryStore();
      const source = new FakeSource({ "a.md": "content" });
      const report = await buildCorpus(
        {},
        deps(store, source, {
          readFile: async () => {
            throw new Error("EACCES: permission denied");
          },
        }),
      );
      assert.equal(report.failures[0]?.stage, "read");
      assert.match(report.failures[0]?.message ?? "", /EACCES/);
    });
  });

  describe("auditability", () => {
    it("records what the source deliberately skipped", async () => {
      const store = new InMemoryStore();
      const source = new FakeSource({ "a.md": "content" }, "rev1", [
        { ref: "docs/.env", reason: "secret_pattern", details: { path: ".env" } },
      ]);
      const report = await buildCorpus({}, deps(store, source));

      assert.equal(report.exclusions.length, 1);
      assert.equal(report.exclusions[0]?.reason, "secret_pattern");
      assert.equal(store.meta.listExclusions().length, 1);
    });

    it("surfaces non-fatal extraction notes as warnings", async () => {
      const store = new InMemoryStore();
      const source = new FakeSource({ "a.md": "content with NOTE inside" });
      const report = await buildCorpus({}, deps(store, source));
      assert.ok(report.warnings.some((w) => w.code === WarningCode.EXTRACTION_NOTE));
    });

    it("reports elapsed time", async () => {
      const store = new InMemoryStore();
      const report = await buildCorpus({}, deps(store, new FakeSource({ "a.md": "x" })));
      assert.ok(report.elapsedSeconds > 0);
    });
  });

  describe("edge cases", () => {
    it("builds an empty corpus without failing", async () => {
      const store = new InMemoryStore();
      const report = await buildCorpus({}, deps(store, new FakeSource({})));
      assert.equal(report.status, "ok");
      assert.equal(report.chunks, 0);
    });

    it("skips a file whose extracted text is empty", async () => {
      const store = new InMemoryStore();
      const source = new FakeSource({ "empty.md": "" });
      const report = await buildCorpus({}, deps(store, source));
      assert.equal(report.chunks, 0);
      assert.ok(store.documents.get("docs/empty.md"), "the document is still recorded");
    });

    it("restricts the build to the requested sources", async () => {
      const store = new InMemoryStore();
      const source = new FakeSource({ "a.md": "content" });
      const report = await buildCorpus({ onlySources: ["other"] }, deps(store, source));
      assert.equal(report.documents.added, 0);
    });
  });
});

describe("application/usecase/buildCorpus: report reconciliation", () => {
  /**
   * Regression: `added` was counted during the diff, before extraction, so a
   * file that failed to extract appeared both as an indexed document and as a
   * failure. The totals must add up, or a caller cannot tell how much of the
   * corpus is actually there.
   */
  it("does not count a file that failed extraction as an indexed document", async () => {
    const store = new InMemoryStore();
    const source = new FakeSource({ "good.md": "usable content", "bad.pdf": "unreadable" });
    const report = await buildCorpus(
      {},
      deps(store, source, { extractors: registryFor(source, new Set(["bad.pdf"])) }),
    );

    assert.equal(report.documents.added, 1, "only the good file was indexed");
    assert.equal(report.failures.length, 1);
    assert.equal(store.documents.count(), 1);
  });

  it("reconciles: indexed plus failed equals the files discovered", async () => {
    const store = new InMemoryStore();
    const source = new FakeSource({ "a.md": "one", "b.md": "two", "c.pdf": "three" });
    const report = await buildCorpus(
      {},
      deps(store, source, { extractors: registryFor(source, new Set(["c.pdf"])) }),
    );

    const accountedFor =
      report.documents.added +
      report.documents.modified +
      report.documents.unchanged +
      report.failures.length;
    assert.equal(accountedFor, 3);
  });

  it("does not count a failed re-index as modified", async () => {
    const store = new InMemoryStore();
    const source = new FakeSource({ "a.md": "original" });
    await buildCorpus({}, deps(store, source));

    source.files["a.md"] = "edited but now unreadable";
    const report = await buildCorpus(
      {},
      deps(store, source, { extractors: registryFor(source, new Set(["a.md"])) }),
    );

    assert.equal(report.documents.modified, 0);
    assert.equal(report.failures.length, 1);
  });
});

describe("application/usecase/buildCorpus: an update leaves what a rebuild would", () => {
  const before = {
    "keys.md": "# Key Management\n\nPublic keys are published at the JWKS endpoint. See [tokens](token.md).\n\n## Rotation\n\nSigning keys rotate every 30 days.\n",
    "token.md": "# Access Token\n\nTokens are JWT values signed with ES256. #auth\n",
    "old.md": "# Deprecated\n\nThis page is about to be deleted.\n",
    "notes.md": "# Notes\n\nUnrelated notes about the cafeteria menu.\n",
  };
  const after = {
    "keys.md": "# Key Management\n\nPublic keys are published at the JWKS endpoint. See [tokens](token.md).\n\n## Rotation\n\nSigning keys now rotate every 7 days, and the JWKS cache lives for 60 seconds.\n",
    "token.md": before["token.md"],
    "new.md": "# Incident runbook\n\nIf JWKS rotation fails, page the on-call engineer. See [keys](keys.md). #auth\n",
    "notes.md": before["notes.md"],
  };

  /** Everything the corpus holds that a query can reach, in a comparable shape. */
  function snapshot(store: InMemoryStore): unknown {
    const refs = store.documents.listRefs();
    const chunkIds = [...store.chunks.ownerMap().keys()].sort();
    const chunks = store.chunks.getMany(chunkIds);
    const neighbourhood = store.graph.neighborhood(refs, 500);
    return {
      documents: refs.map((ref) => {
        const document = store.documents.get(ref);
        return {
          ref,
          title: document?.title,
          contentHash: document?.contentHash,
          text: document?.text,
          tags: document?.tags,
          links: document?.links,
          totalLines: document?.totalLines,
        };
      }),
      chunks: chunkIds.map((chunkId) => {
        const chunk = chunks.get(chunkId);
        return {
          chunkId,
          ref: chunk?.ref,
          ordinal: chunk?.ordinal,
          text: chunk?.text,
          location: chunk?.location,
          headingPath: chunk?.headingPath,
          tokenCount: chunk?.tokenCount,
        };
      }),
      statistics: store.lexical.statistics(),
      postings: ["rotation", "jwks", "token", "menu"].map((term) =>
        store.lexical
          .postingsFor([term])
          .map((posting) => `${term}:${posting.chunkId}:${posting.tf}:${posting.df}`)
          .sort(),
      ),
      graph: {
        nodes: neighbourhood.nodes.map((node) => `${node.id}|${node.kind}|${node.label}`).sort(),
        edges: neighbourhood.edges.map((edge) => `${edge.src}|${edge.dst}|${edge.kind}|${edge.weight}`).sort(),
        counts: [store.graph.nodeCount(), store.graph.edgeCount()],
      },
      identity: [
        store.meta.get(CORPUS_META_KEYS.embeddingId),
        store.meta.get(CORPUS_META_KEYS.chunkingFingerprint),
        store.meta.get(CORPUS_META_KEYS.corpusName),
      ],
    };
  }

  it("matches a rebuild after a file changes, one is added and one is deleted", async () => {
    // The promise an incremental index has to keep: what you get is what you
    // would have got by indexing the final state from nothing. Chunk ids,
    // BM25 statistics, similarity edges and link edges all depend on the whole
    // corpus, so any of them could drift.
    const updated = new InMemoryStore();
    const source = new FakeSource({ ...before });
    await buildCorpus({}, deps(updated, source));
    source.files = { ...after };
    const report = await buildCorpus({}, deps(updated, source));
    assert.deepEqual(report.documents, { added: 1, modified: 1, deleted: 1, unchanged: 2 });

    const rebuilt = new InMemoryStore();
    await buildCorpus({}, deps(rebuilt, new FakeSource({ ...after })));

    assert.deepEqual(snapshot(updated), snapshot(rebuilt));
  });

  it("matches a rebuild when nothing changed at all", async () => {
    const updated = new InMemoryStore();
    const source = new FakeSource({ ...before });
    await buildCorpus({}, deps(updated, source));
    const report = await buildCorpus({}, deps(updated, source));
    assert.equal(report.documents.unchanged, 4);

    const rebuilt = new InMemoryStore();
    await buildCorpus({}, deps(rebuilt, new FakeSource({ ...before })));
    assert.deepEqual(snapshot(updated), snapshot(rebuilt));
  });

  // The stub embedder above returns the zero vector, so no pair ever clears the
  // similarity threshold and the tests either side of this one say nothing
  // about `similar` edges -- which are the edges an incremental update reuses
  // stored neighbour lists to avoid recomputing, and so the ones that can drift.
  describe("with similarity edges that really exist", () => {
    const similar = (store: InMemoryStore): string[] =>
      store.graph
        .neighborhood(store.documents.listRefs(), 500)
        .edges.filter((edge) => edge.kind === "similar")
        .map((edge) => `${edge.src}|${edge.dst}|${edge.weight}`)
        .sort();

    const withVectors = (store: InMemoryStore, source: FakeSource): BuildDependencies =>
      deps(store, source, { embedding: new WordVectorEmbeddingModel() });

    it("matches a rebuild after a file changes, one is added and one is deleted", async () => {
      const updated = new InMemoryStore();
      const source = new FakeSource({ ...before });
      await buildCorpus({}, withVectors(updated, source));
      source.files = { ...after };
      await buildCorpus({}, withVectors(updated, source));

      const rebuilt = new InMemoryStore();
      await buildCorpus({}, withVectors(rebuilt, new FakeSource({ ...after })));

      assert.ok(similar(rebuilt).length > 0, "the fixture must produce similarity edges to compare");
      assert.deepEqual(similar(updated), similar(rebuilt));
      assert.deepEqual(snapshot(updated), snapshot(rebuilt));
    });

    it("matches a rebuild when only one document changed", async () => {
      const updated = new InMemoryStore();
      const source = new FakeSource({ ...before });
      await buildCorpus({}, withVectors(updated, source));
      source.files = { ...before, "notes.md": "# Notes\n\nThe cafeteria now serves JWKS rotation pie.\n" };
      await buildCorpus({}, withVectors(updated, source));

      const rebuilt = new InMemoryStore();
      await buildCorpus({}, withVectors(rebuilt, new FakeSource({ ...source.files })));
      assert.deepEqual(snapshot(updated), snapshot(rebuilt));
    });

    it("matches a rebuild when nothing changed at all", async () => {
      const updated = new InMemoryStore();
      const source = new FakeSource({ ...before });
      await buildCorpus({}, withVectors(updated, source));
      await buildCorpus({}, withVectors(updated, source));

      const rebuilt = new InMemoryStore();
      await buildCorpus({}, withVectors(rebuilt, new FakeSource({ ...before })));
      assert.deepEqual(snapshot(updated), snapshot(rebuilt));
    });

    it("matches a rebuild after a document is only deleted", async () => {
      // Deletion is the case stored lists cannot simply be merged into: the
      // chunk that fills the hole may be one the list never mentioned.
      const updated = new InMemoryStore();
      const source = new FakeSource({ ...before });
      await buildCorpus({}, withVectors(updated, source));
      const { ["old.md"]: _dropped, ...remaining } = before;
      source.files = { ...remaining };
      await buildCorpus({}, withVectors(updated, source));

      const rebuilt = new InMemoryStore();
      await buildCorpus({}, withVectors(rebuilt, new FakeSource({ ...remaining })));
      assert.deepEqual(snapshot(updated), snapshot(rebuilt));
    });

    /** Record every vector-index scan a build asks for. */
    function recordScans(store: InMemoryStore): Array<{ of: number; within: number | null }> {
      const calls: Array<{ of: number; within: number | null }> = [];
      const real = store.vectors.neighbors;
      const patched = store.vectors as { neighbors: typeof real };
      patched.neighbors = (ids, topK, within) => {
        calls.push({ of: ids.length, within: within?.length ?? null });
        return real(ids, topK, within);
      };
      return calls;
    }

    it("does no vector work at all when nothing changed", async () => {
      const store = new InMemoryStore();
      const source = new FakeSource({ ...before });
      await buildCorpus({}, withVectors(store, source));

      const calls = recordScans(store);
      await buildCorpus({}, withVectors(store, source));
      assert.deepEqual(calls, [], "an unchanged corpus should not be rescanned to reach the same lists");
    });

    it("scans the corpus only for the chunks a change can have reached", async () => {
      // Wider than the fixture above on purpose: with five neighbours kept and
      // four chunks in the corpus, every list names every other chunk and any
      // deletion dirties all of them. The saving only appears once a corpus is
      // larger than one chunk's neighbourhood, which is every real corpus.
      const many: Record<string, string> = {};
      for (let index = 0; index < 30; index += 1) {
        many[`page-${index}.md`] = `# Page ${index}\n\nThis page is about subject ${index} and nothing else.\n`;
      }
      const store = new InMemoryStore();
      const source = new FakeSource({ ...many });
      await buildCorpus({}, withVectors(store, source));
      const chunksBefore = store.chunks.count();

      const calls = recordScans(store);
      source.files = { ...many, "page-7.md": "# Page 7\n\nRewritten: this page is now about subject seven only.\n" };
      await buildCorpus({}, withVectors(store, source));

      const full = calls.filter((call) => call.within === null);
      const scanned = full.reduce((total, call) => total + call.of, 0);
      assert.ok(scanned > 0, "the arrivals do need a scan");
      assert.ok(
        scanned < chunksBefore,
        `rescanned ${scanned} of ${chunksBefore} chunks; the stored lists exist to avoid that`,
      );
      // Everyone else is only scored against what arrived.
      assert.ok(calls.some((call) => call.within !== null && call.within < chunksBefore));
    });

    it("rebuilds the lists when the embedding model changes under it", async () => {
      const updated = new InMemoryStore();
      const source = new FakeSource({ ...before });
      await buildCorpus({}, deps(updated, source));
      // A stored list from the stub embedder must not survive into a build with
      // a model that scores differently, however little the sources changed.
      await buildCorpus({ full: true }, withVectors(updated, source));

      const rebuilt = new InMemoryStore();
      await buildCorpus({}, withVectors(rebuilt, new FakeSource({ ...before })));
      assert.deepEqual(snapshot(updated), snapshot(rebuilt));
    });
  });
});
