/**
 * Bringing in a corpus somebody else built.
 *
 * Everything in the archive is untrusted until checked, and the checks run in
 * an order where each one only relies on what the previous ones established:
 *
 * 1. the container unpacks cleanly (codec)
 * 2. every entry name is on the format's list, and every file matches the
 *    size and SHA-256 the manifest records (domain)
 * 3. the corpus schema is one this build reads
 * 4. the bundled config is valid, names the same corpus, and chunks text the
 *    way the index was chunked
 * 5. the database is intact, defines nothing GraphDog would not, and is the
 *    corpus the manifest says it is
 *
 * Only then is anything written, and the installer makes that write atomic. A
 * refusal at any step leaves the workspace exactly as it was.
 */

import { ArchiveError, IncompatibleCorpusError, toGraphDogError } from "../../domain/errors.ts";
import { checkIdentity } from "../../domain/model/corpus-identity.ts";
import { ARCHIVE_ENTRIES, verifyArchive } from "../../domain/model/corpus-manifest.ts";
import { chunkingFingerprint } from "../../domain/service/chunker.ts";
import type { CorpusConfig } from "../config.ts";
import { WarningCode } from "../dto/contracts.ts";
import type { Warning } from "../dto/mappers.ts";
import type { ArchiveCodec, CorpusFileInspector, CorpusInstaller } from "../ports/archive.ts";
import type { Hasher, Logger } from "../ports/system.ts";
import { SILENT_LOGGER } from "../ports/system.ts";
import { assertMatchesManifest, assertNoForeignObjects, type ArchiveOutcome } from "./archive-checks.ts";

export interface ImportOptions {
  readonly archivePath: string;
  /** Install under this name instead of the one the archive carries. */
  readonly name?: string;
  /** Replace an existing corpus of the same name instead of refusing. */
  readonly replace?: boolean;
}

export interface ImportDependencies {
  readonly codec: ArchiveCodec;
  readonly hasher: Hasher;
  readonly inspector: CorpusFileInspector;
  readonly installer: CorpusInstaller;
  readArchive(path: string): Promise<Uint8Array>;
  /** Validate a config document. Throws on anything unusable. */
  parseConfig(input: unknown): CorpusConfig;
  serializeConfig(config: CorpusConfig): string;
  readonly logger?: Logger;
}

export async function importCorpus(
  options: ImportOptions,
  dependencies: ImportDependencies,
): Promise<ArchiveOutcome> {
  const { hasher } = dependencies;
  const logger = dependencies.logger ?? SILENT_LOGGER;
  const warnings: Warning[] = [];

  const archive = await dependencies.readArchive(options.archivePath);
  const verified = verifyArchive(dependencies.codec.decode(archive), hasher.hashBytes);
  const { manifest } = verified;

  // Only the layout versions are checked here. The embedding model is checked
  // when the corpus is first searched, against whatever this machine is
  // configured with -- which is the only comparison that means anything.
  const incompatible = checkIdentity({
    schemaVersion: manifest.identity.schemaVersion,
    chunkingSchemaVersion: manifest.identity.chunkingSchemaVersion,
  });
  if (incompatible !== null) {
    throw new IncompatibleCorpusError(`cannot import "${manifest.corpus}": ${incompatible.message}`, {
      corpus: manifest.corpus,
      field: incompatible.field,
      expected: incompatible.expected,
      actual: incompatible.actual,
      remedy: "export it again with a matching GraphDog, or rebuild it from its sources",
    });
  }

  const config = readArchivedConfig(verified.config, dependencies.parseConfig);
  if (config.name !== manifest.corpus) {
    throw new ArchiveError(
      `the archive is inconsistent: its manifest names corpus "${manifest.corpus}" ` +
        `but its config names "${config.name}"`,
      { manifest: manifest.corpus, config: config.name },
    );
  }

  const fingerprint = chunkingFingerprint(hasher.hashText, config.chunking);
  if (fingerprint !== manifest.identity.chunkingFingerprint) {
    throw new ArchiveError(
      `the archive is inconsistent: its config chunks text as ${fingerprint} but its index was ` +
        `chunked as ${manifest.identity.chunkingFingerprint}, so it could never be searched`,
      { expected: manifest.identity.chunkingFingerprint, actual: fingerprint },
    );
  }

  const inspection = await dependencies.inspector.inspect(verified.database);
  assertNoForeignObjects(inspection, "the archived database");
  assertMatchesManifest(manifest, inspection);

  if (inspection.failures > 0) {
    warnings.push({
      code: WarningCode.PARTIAL_INDEX,
      message:
        `${inspection.failures} file(s) failed to index when this corpus was built; ` +
        `results from it may be incomplete`,
      details: { failures: inspection.failures },
    });
  }

  const name = options.name ?? manifest.corpus;
  const installed = await dependencies.installer.install({
    name,
    config: dependencies.serializeConfig(name === config.name ? config : { ...config, name }),
    database: verified.database,
    replace: options.replace === true,
  });

  logger.log("info", "imported corpus", { corpus: name, from: options.archivePath, into: installed.directory });

  return {
    operation: "import",
    corpus: name,
    archivePath: options.archivePath,
    bytes: archive.length,
    checksum: hasher.hashBytes(archive),
    manifest,
    destination: { path: installed.directory, scope: installed.scope, replaced: installed.replaced },
    warnings,
  };
}

/**
 * Parse the config the archive carries.
 *
 * Any failure is the archive's fault rather than a configuration mistake on
 * this machine, so it is reported as an invalid archive -- the caller's own
 * config files are not what needs fixing.
 */
function readArchivedConfig(bytes: Uint8Array, parse: (input: unknown) => CorpusConfig): CorpusConfig {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ArchiveError(`${ARCHIVE_ENTRIES.config} in the archive is not valid JSON`, {
      entry: ARCHIVE_ENTRIES.config,
    });
  }
  try {
    return parse(data);
  } catch (error) {
    throw new ArchiveError(
      `${ARCHIVE_ENTRIES.config} in the archive is not a usable corpus config: ${toGraphDogError(error).message}`,
      { entry: ARCHIVE_ENTRIES.config },
    );
  }
}
