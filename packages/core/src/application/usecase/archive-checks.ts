/**
 * What export and import both have to agree on: the outcome they report, and
 * what makes a corpus database fit to leave a machine or to enter one.
 *
 * The same checks run on both sides deliberately. An export that ships
 * something an import would refuse has only moved the failure to somebody
 * else's machine, where it is harder to diagnose and nobody has the sources to
 * fix it.
 */

import { ArchiveError } from "../../domain/errors.ts";
import type { CorpusManifest } from "../../domain/model/corpus-manifest.ts";
import type { Warning } from "../dto/mappers.ts";
import type { DatabaseInspection } from "../ports/archive.ts";

/** What an export or an import did. One shape for both, as the report has one shape. */
export interface ArchiveOutcome {
  readonly operation: "export" | "import";
  /** The corpus name on this machine: the one exported, or the name imported as. */
  readonly corpus: string;
  readonly archivePath: string;
  readonly bytes: number;
  /** SHA-256 of the archive file itself, so a copy can be checked before import. */
  readonly checksum: string;
  readonly manifest: CorpusManifest;
  /** Where an import landed. Null for an export. */
  readonly destination: {
    readonly path: string;
    readonly scope: string;
    readonly replaced: boolean;
  } | null;
  readonly warnings: Warning[];
}

/**
 * Refuse a database whose schema defines objects GraphDog never creates.
 *
 * Triggers run code whenever a table is written, and a view can stand in for a
 * table. A corpus GraphDog built has neither, so their presence can only mean
 * the file came from something else -- and the next `graphdog update` would
 * be what set them off.
 */
export function assertNoForeignObjects(inspection: DatabaseInspection, subject: string): void {
  if (inspection.foreignObjects.length === 0) return;
  throw new ArchiveError(
    `${subject} defines database objects GraphDog never creates ` +
      `(${inspection.foreignObjects.join(", ")}); refusing a corpus that could run code when written to`,
    { foreign_objects: [...inspection.foreignObjects] },
  );
}

/**
 * Refuse when a manifest and the database it vouches for describe different
 * corpora.
 *
 * The checksums already tie the database's bytes to the manifest, so a
 * mismatch here cannot be an accident of transport: someone wrote a manifest
 * that matches the bytes and misdescribes them. The compatibility gate trusts
 * these fields, so a lie in them is exactly what would get a corpus past it.
 */
export function assertMatchesManifest(manifest: CorpusManifest, inspection: DatabaseInspection): void {
  const mismatches: string[] = [];
  const compare = (field: string, claimed: string | number, actual: string | number | null): void => {
    if (claimed !== actual) {
      mismatches.push(`${field}: manifest says ${JSON.stringify(claimed)}, database says ${JSON.stringify(actual)}`);
    }
  };

  compare("schema_version", manifest.identity.schemaVersion, inspection.identity.schemaVersion);
  compare(
    "chunking_schema_version",
    manifest.identity.chunkingSchemaVersion,
    inspection.identity.chunkingSchemaVersion,
  );
  compare("embedding_id", manifest.identity.embeddingId, inspection.identity.embeddingId);
  compare(
    "chunking_fingerprint",
    manifest.identity.chunkingFingerprint,
    inspection.identity.chunkingFingerprint,
  );
  compare("built_at", manifest.builtAt, inspection.builtAt);
  compare("counts.documents", manifest.counts.documents, inspection.counts.documents);
  compare("counts.chunks", manifest.counts.chunks, inspection.counts.chunks);
  compare("counts.nodes", manifest.counts.nodes, inspection.counts.nodes);
  compare("counts.edges", manifest.counts.edges, inspection.counts.edges);

  if (mismatches.length > 0) {
    throw new ArchiveError(
      `the manifest does not describe the database it carries (${mismatches.join("; ")}); ` +
        `the archive was assembled by hand or has been tampered with`,
      { mismatches },
    );
  }
}
