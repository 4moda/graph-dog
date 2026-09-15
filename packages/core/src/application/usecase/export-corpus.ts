/**
 * Packaging a built corpus as a single `.gdog` file.
 *
 * The archive is the corpus plus what it takes to trust it elsewhere: a
 * manifest recording the identities the compatibility gate checks, the
 * corpus's own config, and a SHA-256 of every file. Whoever imports it can
 * verify it end to end without having been there when it was built.
 *
 * The manifest is written from the *snapshot* being shipped, not from the live
 * store: a build that commits between the two would otherwise produce a
 * manifest describing a different corpus from the one inside it, which the
 * importer would -- correctly -- refuse.
 */

import { IncompatibleCorpusError } from "../../domain/errors.ts";
import { checkIdentity } from "../../domain/model/corpus-identity.ts";
import {
  ARCHIVE_ENTRIES,
  ARCHIVE_FORMAT_VERSION,
  describeFile,
  serializeManifest,
  type CorpusManifest,
} from "../../domain/model/corpus-manifest.ts";
import { chunkingFingerprint } from "../../domain/service/chunker.ts";
import type { CorpusConfig } from "../config.ts";
import { WarningCode } from "../dto/contracts.ts";
import type { Warning } from "../dto/mappers.ts";
import type { ArchiveCodec, CorpusFileInspector } from "../ports/archive.ts";
import type { Clock, Hasher, Logger } from "../ports/system.ts";
import { SILENT_LOGGER } from "../ports/system.ts";
import { assertNoForeignObjects, type ArchiveOutcome } from "./archive-checks.ts";

export interface ExportOptions {
  readonly archivePath: string;
  /** Replace an existing file at `archivePath` instead of refusing. */
  readonly overwrite?: boolean;
}

export interface ExportDependencies {
  readonly config: CorpusConfig;
  readonly codec: ArchiveCodec;
  readonly inspector: CorpusFileInspector;
  readonly hasher: Hasher;
  readonly clock: Clock;
  /** Recorded in the manifest as `created_by`. */
  readonly version: string;
  /** A transactionally consistent, self-contained copy of the corpus database. */
  snapshot(): Promise<Uint8Array>;
  /** The config exactly as it would be written to `graphdog.json`. */
  serializeConfig(config: CorpusConfig): string;
  /** Write the archive, refusing an existing file unless `overwrite` is set. */
  writeArchive(path: string, data: Uint8Array, overwrite: boolean): Promise<void>;
  readonly logger?: Logger;
}

export async function exportCorpus(
  options: ExportOptions,
  dependencies: ExportDependencies,
): Promise<ArchiveOutcome> {
  const { config, hasher } = dependencies;
  const logger = dependencies.logger ?? SILENT_LOGGER;
  const warnings: Warning[] = [];

  const database = await dependencies.snapshot();
  const inspection = await dependencies.inspector.inspect(database);

  const builtAt = inspection.builtAt;
  if (builtAt === null) {
    throw new IncompatibleCorpusError(
      `corpus "${config.name}" has not been built yet; build it before exporting`,
      { corpus: config.name, remedy: "graphdog build" },
    );
  }

  // Every identity field is required, with no defaults filled in: an importer
  // compares the manifest against the database field by field, so a default
  // written here for a value the database lacks would produce an archive that
  // no import could ever accept.
  const { schemaVersion, chunkingSchemaVersion, embeddingId } = inspection.identity;
  const storedFingerprint = inspection.identity.chunkingFingerprint;
  if (
    schemaVersion === null ||
    chunkingSchemaVersion === null ||
    embeddingId === null ||
    storedFingerprint === null
  ) {
    throw new IncompatibleCorpusError(
      `corpus "${config.name}" does not record its full identity; rebuild it before exporting`,
      { corpus: config.name, remedy: "graphdog build --full" },
    );
  }

  const unreadable = checkIdentity({ schemaVersion, chunkingSchemaVersion });
  if (unreadable !== null) {
    throw new IncompatibleCorpusError(unreadable.message, {
      corpus: config.name,
      field: unreadable.field,
      expected: unreadable.expected,
      actual: unreadable.actual,
      remedy: "graphdog build --full",
    });
  }

  // The archive carries this config, and an importer checks that it would
  // chunk text the way the index was chunked. If the two already disagree
  // here, every importer would refuse the archive -- so refuse now, where the
  // sources are and a rebuild is possible.
  const configuredFingerprint = chunkingFingerprint(hasher.hashText, config.chunking);
  if (configuredFingerprint !== storedFingerprint) {
    throw new IncompatibleCorpusError(
      `corpus "${config.name}" was chunked as ${storedFingerprint} but its config now produces ` +
        `${configuredFingerprint}; rebuild it so the exported config and index agree`,
      {
        corpus: config.name,
        field: "chunkingFingerprint",
        expected: configuredFingerprint,
        actual: storedFingerprint,
        remedy: "graphdog build --full",
      },
    );
  }

  assertNoForeignObjects(inspection, `corpus "${config.name}"`);

  if (inspection.failures > 0) {
    warnings.push({
      code: WarningCode.PARTIAL_INDEX,
      message:
        `${inspection.failures} file(s) failed to index when this corpus was built; ` +
        `the archive carries that gap to whoever imports it`,
      details: { failures: inspection.failures },
    });
  }

  const encoder = new TextEncoder();
  const configBytes = encoder.encode(dependencies.serializeConfig(config));

  const manifest: CorpusManifest = {
    formatVersion: ARCHIVE_FORMAT_VERSION,
    corpus: config.name,
    createdAt: dependencies.clock.nowIso(),
    createdBy: `graphdog ${dependencies.version}`,
    builtAt,
    identity: { schemaVersion, chunkingSchemaVersion, embeddingId, chunkingFingerprint: storedFingerprint },
    counts: inspection.counts,
    sources: inspection.sources,
    files: {
      [ARCHIVE_ENTRIES.config]: describeFile(configBytes, hasher.hashBytes),
      [ARCHIVE_ENTRIES.database]: describeFile(database, hasher.hashBytes),
    },
  };

  // The manifest goes first, so `tar -tzf` lists it first and a reader that
  // stops early has already seen what the archive claims to be.
  const archive = dependencies.codec.encode([
    { name: ARCHIVE_ENTRIES.manifest, data: encoder.encode(serializeManifest(manifest)) },
    { name: ARCHIVE_ENTRIES.config, data: configBytes },
    { name: ARCHIVE_ENTRIES.database, data: database },
  ]);

  await dependencies.writeArchive(options.archivePath, archive, options.overwrite === true);
  logger.log("info", "exported corpus", {
    corpus: config.name,
    path: options.archivePath,
    bytes: archive.length,
  });

  return {
    operation: "export",
    corpus: config.name,
    archivePath: options.archivePath,
    bytes: archive.length,
    checksum: hasher.hashBytes(archive),
    manifest,
    destination: null,
    warnings,
  };
}
