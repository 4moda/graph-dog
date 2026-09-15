/**
 * The manifest inside a `.gdog` corpus archive, and the checks an import runs
 * before trusting one.
 *
 * An archive is a corpus somebody else built, so nothing in it is trusted until
 * it has been checked: every entry name against a fixed list, every payload
 * file against the size and SHA-256 the manifest records, and the manifest's
 * format against what this build can read. The checks are pure so they can be
 * tested against hand-built archives, hostile ones included, with no
 * filesystem involved.
 *
 * Entry names are never used as filesystem paths -- the installer writes fixed
 * file names -- so path traversal is structurally impossible. An entry that
 * merely *looks* like traversal is still refused, loudly: it can only mean the
 * archive was crafted, and quietly importing the rest of a crafted archive
 * would be the wrong response to noticing.
 */

import { ArchiveError, IncompatibleCorpusError } from "../errors.ts";

/** Written into every manifest, so a stray `.gdog` from another tool is refused by name. */
export const ARCHIVE_FORMAT = "graphdog-corpus";

/** Bumped when the archive layout changes incompatibly. */
export const ARCHIVE_FORMAT_VERSION = 1;

export const ARCHIVE_EXTENSION = ".gdog";

/**
 * Every name an archive may contain.
 *
 * These are the archive format's own names. They match the on-disk file names
 * today, but the installer maps them explicitly rather than relying on that, so
 * an archive's contents never choose where anything lands.
 */
export const ARCHIVE_ENTRIES = {
  manifest: "manifest.json",
  config: "graphdog.json",
  database: "corpus.sqlite3",
} as const;

export type ArchiveEntryName = (typeof ARCHIVE_ENTRIES)[keyof typeof ARCHIVE_ENTRIES];

/** The files a manifest vouches for. The manifest is the voucher, so it is not among them. */
export const PAYLOAD_ENTRIES = [ARCHIVE_ENTRIES.config, ARCHIVE_ENTRIES.database] as const;

export type PayloadEntryName = (typeof PAYLOAD_ENTRIES)[number];

const ALLOWED_ENTRIES: ReadonlySet<string> = new Set(Object.values(ARCHIVE_ENTRIES));

const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface ManifestFile {
  readonly bytes: number;
  /** Lowercase hex SHA-256 of the file's exact bytes. */
  readonly sha256: string;
}

export interface ManifestIdentity {
  readonly schemaVersion: string;
  readonly chunkingSchemaVersion: string;
  readonly embeddingId: string;
  readonly chunkingFingerprint: string;
}

export interface ManifestCounts {
  readonly documents: number;
  readonly chunks: number;
  readonly nodes: number;
  readonly edges: number;
}

export interface ManifestSource {
  readonly id: string;
  /** Commit SHA for a git source; null for a plain folder, which has none. */
  readonly revision: string | null;
}

export interface CorpusManifest {
  readonly formatVersion: number;
  readonly corpus: string;
  readonly createdAt: string;
  /** Which build wrote the archive, e.g. `graphdog 0.1.0`. Informational only. */
  readonly createdBy: string;
  readonly builtAt: string;
  readonly identity: ManifestIdentity;
  readonly counts: ManifestCounts;
  readonly sources: readonly ManifestSource[];
  readonly files: Readonly<Record<PayloadEntryName, ManifestFile>>;
}

/** One file inside an archive, before anything about it is trusted. */
export interface ArchiveFile {
  readonly name: string;
  readonly data: Uint8Array;
}

/** An archive whose every check passed: the only shape an installer accepts. */
export interface VerifiedArchive {
  readonly manifest: CorpusManifest;
  readonly config: Uint8Array;
  readonly database: Uint8Array;
}

export function describeFile(
  data: Uint8Array,
  hashBytes: (input: Uint8Array) => string,
): ManifestFile {
  return { bytes: data.length, sha256: hashBytes(data) };
}

/**
 * Serialize with snake_case keys in a fixed order.
 *
 * The manifest is read by people deciding whether to import something and by
 * tools that are not GraphDog, so it follows the JSON contract's conventions
 * rather than the TypeScript names.
 */
export function serializeManifest(manifest: CorpusManifest): string {
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const name of PAYLOAD_ENTRIES) {
    files[name] = { bytes: manifest.files[name].bytes, sha256: manifest.files[name].sha256 };
  }

  const document = {
    format: ARCHIVE_FORMAT,
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
    files,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Parse a manifest, refusing anything malformed.
 *
 * A newer format is an *incompatibility* rather than corruption: the archive is
 * probably fine and this build is too old to read it, which deserves a
 * different exit code and a different remedy.
 */
export function parseManifest(text: string): CorpusManifest {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ArchiveError(`${MANIFEST} is not valid JSON: ${String(error)}`, { entry: MANIFEST });
  }

  const root = asObject(data, "");
  if (root["format"] !== ARCHIVE_FORMAT) {
    throw new ArchiveError(
      `not a GraphDog corpus archive: ${MANIFEST} declares format ` +
        `${JSON.stringify(root["format"] ?? null)}`,
      { entry: MANIFEST, expected: ARCHIVE_FORMAT },
    );
  }

  const formatVersion = asCount(root["format_version"], "format_version");
  if (formatVersion < 1) {
    throw new ArchiveError(`${MANIFEST}: format_version must be 1 or greater`, { entry: MANIFEST });
  }
  if (formatVersion > ARCHIVE_FORMAT_VERSION) {
    throw new IncompatibleCorpusError(
      `archive format ${formatVersion} is newer than this GraphDog understands ` +
        `(${ARCHIVE_FORMAT_VERSION}); upgrade GraphDog to import it`,
      {
        field: "archiveFormatVersion",
        expected: String(ARCHIVE_FORMAT_VERSION),
        actual: String(formatVersion),
        remedy: "npm install -g graphdog@latest",
      },
    );
  }

  const identity = asObject(root["identity"], "identity");
  const counts = asObject(root["counts"], "counts");

  const rawSources = root["sources"];
  if (!Array.isArray(rawSources)) {
    throw new ArchiveError(`${MANIFEST}: sources must be an array`, { entry: MANIFEST });
  }

  return {
    formatVersion,
    corpus: asText(root["corpus"], "corpus"),
    createdAt: asText(root["created_at"], "created_at"),
    createdBy: asText(root["created_by"], "created_by"),
    builtAt: asText(root["built_at"], "built_at"),
    identity: {
      schemaVersion: asText(identity["schema_version"], "identity.schema_version"),
      chunkingSchemaVersion: asText(
        identity["chunking_schema_version"],
        "identity.chunking_schema_version",
      ),
      embeddingId: asText(identity["embedding_id"], "identity.embedding_id"),
      chunkingFingerprint: asText(identity["chunking_fingerprint"], "identity.chunking_fingerprint"),
    },
    counts: {
      documents: asCount(counts["documents"], "counts.documents"),
      chunks: asCount(counts["chunks"], "counts.chunks"),
      nodes: asCount(counts["nodes"], "counts.nodes"),
      edges: asCount(counts["edges"], "counts.edges"),
    },
    sources: rawSources.map((entry, index) => {
      const source = asObject(entry, `sources[${index}]`);
      const revision = source["revision"];
      if (revision !== null && typeof revision !== "string") {
        throw new ArchiveError(`${MANIFEST}: sources[${index}].revision must be a string or null`, {
          entry: MANIFEST,
        });
      }
      return { id: asText(source["id"], `sources[${index}].id`), revision };
    }),
    files: parseFiles(root["files"]),
  };
}

function parseFiles(input: unknown): Record<PayloadEntryName, ManifestFile> {
  const files = asObject(input, "files");
  for (const name of Object.keys(files)) {
    if (!(PAYLOAD_ENTRIES as readonly string[]).includes(name)) {
      throw new ArchiveError(`${MANIFEST}: files lists an entry the format does not have: "${name}"`, {
        entry: MANIFEST,
      });
    }
  }

  const describe = (name: PayloadEntryName): ManifestFile => {
    const file = asObject(files[name], `files["${name}"]`);
    const sha256 = file["sha256"];
    if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) {
      throw new ArchiveError(`${MANIFEST}: files["${name}"].sha256 must be a lowercase hex SHA-256`, {
        entry: MANIFEST,
      });
    }
    return { bytes: asCount(file["bytes"], `files["${name}"].bytes`), sha256 };
  };

  return {
    [ARCHIVE_ENTRIES.config]: describe(ARCHIVE_ENTRIES.config),
    [ARCHIVE_ENTRIES.database]: describe(ARCHIVE_ENTRIES.database),
  };
}

/**
 * Refuse any entry name that is not exactly one of the format's names.
 *
 * The specific reasons are checked first so a crafted archive is described as
 * what it is -- "path traversal", "absolute path" -- rather than as a generic
 * unknown entry. Someone investigating a refused import deserves to know the
 * archive was hostile rather than merely unfamiliar.
 */
export function assertSafeEntryName(name: string): asserts name is ArchiveEntryName {
  const refuse = (reason: string): never => {
    throw new ArchiveError(`refusing archive entry ${JSON.stringify(name)}: ${reason}`, {
      entry: name,
      reason,
    });
  };

  if (name === "") refuse("the name is empty");
  if (hasControlCharacter(name)) refuse("the name contains a control character");
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) {
    refuse("absolute paths are not allowed");
  }
  const segments = name.split(/[/\\]/);
  if (segments.includes("..")) refuse("path traversal is not allowed");
  if (segments.length > 1) refuse("a corpus archive is flat; nested paths are not allowed");
  if (!ALLOWED_ENTRIES.has(name)) {
    refuse(`not part of the archive format (expected ${[...ALLOWED_ENTRIES].join(", ")})`);
  }
}

/**
 * Check an unpacked archive end to end, and return its payload only if all of
 * it holds.
 *
 * Order matters: names are checked before anything is parsed, and the
 * manifest before any payload is looked at, so a hostile archive is refused on
 * the first thing wrong with it rather than partway through being interpreted.
 */
export function verifyArchive(
  files: readonly ArchiveFile[],
  hashBytes: (input: Uint8Array) => string,
): VerifiedArchive {
  const byName = new Map<string, Uint8Array>();
  for (const file of files) {
    assertSafeEntryName(file.name);
    if (byName.has(file.name)) {
      throw new ArchiveError(`archive contains "${file.name}" more than once`, { entry: file.name });
    }
    byName.set(file.name, file.data);
  }

  const manifestBytes = byName.get(MANIFEST);
  if (manifestBytes === undefined) {
    throw new ArchiveError(`not a GraphDog corpus archive: ${MANIFEST} is missing`, { entry: MANIFEST });
  }
  const manifest = parseManifest(decodeUtf8(manifestBytes, MANIFEST));

  const payload = new Map<PayloadEntryName, Uint8Array>();
  for (const name of PAYLOAD_ENTRIES) {
    const data = byName.get(name);
    if (data === undefined) {
      throw new ArchiveError(`archive is missing ${name}`, { entry: name });
    }
    const expected = manifest.files[name];
    if (data.length !== expected.bytes) {
      throw new ArchiveError(
        `${name} is ${data.length} bytes but the manifest records ${expected.bytes}; ` +
          `the archive is truncated or has been modified`,
        { entry: name, expected: expected.bytes, actual: data.length },
      );
    }
    const actual = hashBytes(data);
    if (actual !== expected.sha256) {
      throw new ArchiveError(
        `checksum mismatch for ${name}: the archive is corrupt or has been modified`,
        { entry: name, expected: expected.sha256, actual },
      );
    }
    payload.set(name, data);
  }

  return {
    manifest,
    config: payload.get(ARCHIVE_ENTRIES.config) as Uint8Array,
    database: payload.get(ARCHIVE_ENTRIES.database) as Uint8Array,
  };
}

// --- helpers -----------------------------------------------------------------

const MANIFEST = ARCHIVE_ENTRIES.manifest;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function decodeUtf8(bytes: Uint8Array, entry: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ArchiveError(`${entry} is not valid UTF-8`, { entry });
  }
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArchiveError(`${MANIFEST}: ${path === "" ? "the top level" : path} must be an object`, {
      entry: MANIFEST,
    });
  }
  return value as Record<string, unknown>;
}

function asText(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") {
    throw new ArchiveError(`${MANIFEST}: ${path} must be a non-empty string`, { entry: MANIFEST });
  }
  return value;
}

function asCount(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ArchiveError(`${MANIFEST}: ${path} must be a non-negative integer`, { entry: MANIFEST });
  }
  return value;
}
