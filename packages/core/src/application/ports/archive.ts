/**
 * Packing a corpus into one file, and bringing one in from elsewhere.
 *
 * A codec knows the container -- compression and layout -- and nothing about
 * corpora. What the files mean, and whether they can be trusted, is decided in
 * the domain (`corpus-manifest.ts`) and the use cases, so swapping any adapter
 * here cannot weaken the verification an import runs.
 */

import type { ManifestCounts, ManifestSource } from "../../domain/model/corpus-manifest.ts";

export interface ArchiveEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

export interface ArchiveCodec {
  /** Pack entries, in order, into a single archive. */
  encode(entries: readonly ArchiveEntry[]): Uint8Array;
  /**
   * Unpack an archive into its entries, in order.
   *
   * Must throw `ArchiveError` for anything malformed rather than returning
   * whatever it could salvage: a partially unpacked corpus is a damaged corpus
   * that nobody can tell is damaged.
   */
  decode(archive: Uint8Array): ArchiveEntry[];
}

/** What a corpus database says about itself, read without trusting it. */
export interface DatabaseInspection {
  /** Triggers and views, as `trigger:<name>` or `view:<name>`. GraphDog creates neither. */
  readonly foreignObjects: readonly string[];
  readonly identity: {
    readonly schemaVersion: string | null;
    readonly chunkingSchemaVersion: string | null;
    readonly embeddingId: string | null;
    readonly chunkingFingerprint: string | null;
  };
  readonly builtAt: string | null;
  readonly counts: ManifestCounts;
  readonly sources: readonly ManifestSource[];
  /** Files that failed to index when the corpus was built. */
  readonly failures: number;
}

export interface CorpusFileInspector {
  /**
   * Examine a corpus database's bytes without trusting them: from a private
   * copy, read-only, with no schema-defined code allowed side effects.
   *
   * Returns facts rather than a verdict, except that bytes which are not a
   * readable, intact SQLite corpus at all throw `ArchiveError` -- there are no
   * facts to report about those.
   */
  inspect(database: Uint8Array): Promise<DatabaseInspection>;
}

export interface InstallRequest {
  readonly name: string;
  /** The config file's text, already carrying `name`. */
  readonly config: string;
  readonly database: Uint8Array;
  /** Replace a corpus that already has this name, instead of refusing. */
  readonly replace: boolean;
}

export interface InstallResult {
  /** The corpus directory now holding the imported corpus. */
  readonly directory: string;
  readonly scope: string;
  readonly replaced: boolean;
}

export interface CorpusInstaller {
  /**
   * Place a verified corpus in a workspace, atomically: afterwards either the
   * whole corpus is there under `name`, or nothing changed.
   */
  install(request: InstallRequest): Promise<InstallResult>;
}
