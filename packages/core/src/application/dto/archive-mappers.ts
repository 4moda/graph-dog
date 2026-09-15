/**
 * Archive outcomes to wire DTOs.
 *
 * The report carries the manifest as well as the operation's own result, so
 * `graphdog import --json` tells a caller what they just brought in -- which
 * model built it, when, and from which revisions -- without a second command.
 */

import type { CorpusManifest } from "../../domain/model/corpus-manifest.ts";
import type { ArchiveManifestDto, ArchiveReportDto } from "./contracts.ts";
import { envelope } from "./contracts.ts";
import { toWarningDtos } from "./mappers.ts";
import type { ArchiveOutcome } from "../usecase/archive-checks.ts";

export function toArchiveReportDto(outcome: ArchiveOutcome): ArchiveReportDto {
  return {
    ...envelope("archive_report"),
    operation: outcome.operation,
    corpus: outcome.corpus,
    archive_path: outcome.archivePath,
    bytes: outcome.bytes,
    checksum: outcome.checksum,
    destination:
      outcome.destination === null
        ? null
        : {
            path: outcome.destination.path,
            scope: outcome.destination.scope,
            replaced: outcome.destination.replaced,
          },
    manifest: toArchiveManifestDto(outcome.manifest),
    warnings: toWarningDtos(outcome.warnings),
  };
}

export function toArchiveManifestDto(manifest: CorpusManifest): ArchiveManifestDto {
  return {
    format_version: manifest.formatVersion,
    corpus: manifest.corpus,
    created_at: manifest.createdAt,
    created_by: manifest.createdBy,
    built_at: manifest.builtAt,
    identity: {
      schema_version: manifest.identity.schemaVersion,
      chunking_schema_version: manifest.identity.chunkingSchemaVersion,
      embedding_id: manifest.identity.embeddingId,
      chunking_fingerprint: manifest.identity.chunkingFingerprint,
    },
    counts: {
      documents: manifest.counts.documents,
      chunks: manifest.counts.chunks,
      nodes: manifest.counts.nodes,
      edges: manifest.counts.edges,
    },
    sources: manifest.sources.map((source) => ({ id: source.id, revision: source.revision })),
  };
}
