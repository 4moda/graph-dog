import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ArchiveError } from "../../domain/errors.ts";
import type { CorpusManifest } from "../../domain/model/corpus-manifest.ts";
import type { DatabaseInspection } from "../ports/archive.ts";
import { assertMatchesManifest, assertNoForeignObjects } from "./archive-checks.ts";

const MANIFEST: CorpusManifest = {
  formatVersion: 1,
  corpus: "docs",
  createdAt: "2026-09-15T00:00:00.000Z",
  createdBy: "graphdog 0.1.0",
  builtAt: "2026-09-14T00:00:00.000Z",
  identity: {
    schemaVersion: "1",
    chunkingSchemaVersion: "1",
    embeddingId: "hash-v1:d256",
    chunkingFingerprint: "chunk1:0123456789abcdef",
  },
  counts: { documents: 4, chunks: 57, nodes: 5, edges: 10 },
  sources: [{ id: "docs", revision: null }],
  files: {
    "graphdog.json": { bytes: 1, sha256: "0".repeat(64) },
    "corpus.sqlite3": { bytes: 1, sha256: "1".repeat(64) },
  },
};

function inspection(overrides: Partial<DatabaseInspection> = {}): DatabaseInspection {
  return {
    foreignObjects: [],
    identity: { ...MANIFEST.identity },
    builtAt: MANIFEST.builtAt,
    counts: { ...MANIFEST.counts },
    sources: MANIFEST.sources,
    failures: 0,
    ...overrides,
  };
}

function rejects(run: () => void, pattern: RegExp): ArchiveError {
  let caught: unknown;
  assert.throws(run, (error: unknown) => {
    caught = error;
    return true;
  });
  assert.ok(caught instanceof ArchiveError, `expected ArchiveError, got ${String(caught)}`);
  assert.match(caught.message, pattern);
  return caught;
}

describe("application/usecase/archive-checks", () => {
  describe("assertNoForeignObjects", () => {
    it("accepts a database with no triggers or views", () => {
      assert.doesNotThrow(() => assertNoForeignObjects(inspection(), "the archived database"));
    });

    it("refuses triggers and views, naming each one", () => {
      const error = rejects(
        () =>
          assertNoForeignObjects(
            inspection({ foreignObjects: ["trigger:exfiltrate", "view:documents_all"] }),
            "the archived database",
          ),
        /trigger:exfiltrate, view:documents_all/,
      );
      assert.deepEqual(error.details["foreign_objects"], ["trigger:exfiltrate", "view:documents_all"]);
    });

    it("says whose database it is, so an export and an import read differently", () => {
      rejects(
        () => assertNoForeignObjects(inspection({ foreignObjects: ["trigger:t"] }), 'corpus "docs"'),
        /^corpus "docs" defines/,
      );
    });
  });

  describe("assertMatchesManifest", () => {
    it("accepts a database that is exactly what the manifest describes", () => {
      assert.doesNotThrow(() => assertMatchesManifest(MANIFEST, inspection()));
    });

    it("refuses a manifest that misstates the embedding model", () => {
      // The compatibility gate trusts this field, so a lie here is exactly
      // what would get a corpus past it.
      rejects(
        () =>
          assertMatchesManifest(
            MANIFEST,
            inspection({ identity: { ...MANIFEST.identity, embeddingId: "st:all-MiniLM-L6-v2" } }),
          ),
        /embedding_id: manifest says "hash-v1:d256", database says "st:all-MiniLM-L6-v2"/,
      );
    });

    it("refuses a manifest that misstates the build time", () => {
      rejects(
        () => assertMatchesManifest(MANIFEST, inspection({ builtAt: "2020-01-01T00:00:00.000Z" })),
        /built_at/,
      );
    });

    it("refuses a manifest whose counts do not match the database", () => {
      rejects(
        () => assertMatchesManifest(MANIFEST, inspection({ counts: { ...MANIFEST.counts, chunks: 1 } })),
        /counts\.chunks: manifest says 57, database says 1/,
      );
    });

    it("treats a value the database lacks as a mismatch, not a match", () => {
      rejects(
        () =>
          assertMatchesManifest(
            MANIFEST,
            inspection({ identity: { ...MANIFEST.identity, schemaVersion: null } }),
          ),
        /schema_version: manifest says "1", database says null/,
      );
    });

    it("lists every mismatch at once, rather than one per attempt", () => {
      const error = rejects(
        () =>
          assertMatchesManifest(
            MANIFEST,
            inspection({
              identity: { ...MANIFEST.identity, chunkingFingerprint: "chunk1:ffffffffffffffff" },
              counts: { ...MANIFEST.counts, edges: 0 },
            }),
          ),
        /tampered with/,
      );
      assert.equal((error.details["mismatches"] as string[]).length, 2);
    });
  });
});
