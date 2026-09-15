import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CorpusManifest } from "../../domain/model/corpus-manifest.ts";
import type { ArchiveOutcome } from "../usecase/archive-checks.ts";
import { CONTRACT_VERSION, SCHEMA_VERSION, WarningCode } from "./contracts.ts";
import { toArchiveManifestDto, toArchiveReportDto } from "./archive-mappers.ts";

const MANIFEST: CorpusManifest = {
  formatVersion: 1,
  corpus: "docs",
  createdAt: "2026-09-15T12:00:00.000Z",
  createdBy: "graphdog 0.1.0",
  builtAt: "2026-09-14T00:00:00.000Z",
  identity: {
    schemaVersion: "1",
    chunkingSchemaVersion: "1",
    embeddingId: "hash-v1:d256",
    chunkingFingerprint: "chunk1:0123456789abcdef",
  },
  counts: { documents: 4, chunks: 57, nodes: 5, edges: 10 },
  sources: [
    { id: "docs", revision: null },
    { id: "spec", revision: "a1b2c3d4" },
  ],
  files: {
    "graphdog.json": { bytes: 120, sha256: "0".repeat(64) },
    "corpus.sqlite3": { bytes: 90112, sha256: "1".repeat(64) },
  },
};

function exported(overrides: Partial<ArchiveOutcome> = {}): ArchiveOutcome {
  return {
    operation: "export",
    corpus: "docs",
    archivePath: "/work/docs.gdog",
    bytes: 20480,
    checksum: "a".repeat(64),
    manifest: MANIFEST,
    destination: null,
    warnings: [],
    ...overrides,
  };
}

describe("application/dto/archive-mappers", () => {
  describe("toArchiveReportDto", () => {
    it("stamps the envelope, so a consumer can gate before parsing", () => {
      const dto = toArchiveReportDto(exported());
      assert.equal(dto.kind, "archive_report");
      assert.equal(dto.schema_version, SCHEMA_VERSION);
      assert.equal(dto.contract_version, CONTRACT_VERSION);
    });

    it("pins the documented key order", () => {
      assert.deepEqual(Object.keys(toArchiveReportDto(exported())), [
        "schema_version",
        "contract_version",
        "kind",
        "operation",
        "corpus",
        "archive_path",
        "bytes",
        "checksum",
        "destination",
        "manifest",
        "warnings",
      ]);
    });

    it("reports an export with no destination", () => {
      const dto = toArchiveReportDto(exported());
      assert.equal(dto.operation, "export");
      assert.equal(dto.destination, null);
      assert.equal(dto.archive_path, "/work/docs.gdog");
    });

    it("reports where an import landed", () => {
      const dto = toArchiveReportDto(
        exported({
          operation: "import",
          corpus: "team-docs",
          destination: { path: "/home/u/.graphdog/corpora/team-docs", scope: "home", replaced: true },
        }),
      );
      assert.deepEqual(dto.destination, {
        path: "/home/u/.graphdog/corpora/team-docs",
        scope: "home",
        replaced: true,
      });
      assert.equal(dto.corpus, "team-docs");
      assert.equal(dto.manifest.corpus, "docs", "the manifest keeps the name the corpus was built under");
    });

    it("maps warnings through the shared mapper", () => {
      const dto = toArchiveReportDto(
        exported({ warnings: [{ code: WarningCode.PARTIAL_INDEX, message: "2 file(s) failed" }] }),
      );
      assert.deepEqual(dto.warnings, [{ code: "partial_index", message: "2 file(s) failed", details: {} }]);
    });

    it("survives a JSON round trip unchanged", () => {
      const dto = toArchiveReportDto(exported());
      assert.deepEqual(JSON.parse(JSON.stringify(dto)), dto);
    });
  });

  describe("toArchiveManifestDto", () => {
    it("uses the manifest file's own snake_case names", () => {
      const dto = toArchiveManifestDto(MANIFEST);
      assert.equal(dto.built_at, "2026-09-14T00:00:00.000Z");
      assert.equal(dto.identity.embedding_id, "hash-v1:d256");
      assert.equal(dto.identity.chunking_fingerprint, "chunk1:0123456789abcdef");
    });

    it("carries counts and source revisions, so an importer can see what it brought in", () => {
      const dto = toArchiveManifestDto(MANIFEST);
      assert.deepEqual(dto.counts, { documents: 4, chunks: 57, nodes: 5, edges: 10 });
      assert.deepEqual(dto.sources, [
        { id: "docs", revision: null },
        { id: "spec", revision: "a1b2c3d4" },
      ]);
    });

    it("leaves out the per-file checksums, which the report's own checksum supersedes", () => {
      assert.equal("files" in toArchiveManifestDto(MANIFEST), false);
    });
  });
});
