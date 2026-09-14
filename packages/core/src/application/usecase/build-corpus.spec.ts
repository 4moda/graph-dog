import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { InMemoryStore, StubEmbeddingModel } from "../../__fixtures__/in-memory-store.ts";
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
