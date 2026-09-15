import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { ArchiveError, IncompatibleCorpusError } from "../errors.ts";
import {
  ARCHIVE_ENTRIES,
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  PAYLOAD_ENTRIES,
  assertSafeEntryName,
  describeFile,
  parseManifest,
  serializeManifest,
  verifyArchive,
  type ArchiveFile,
  type CorpusManifest,
} from "./corpus-manifest.ts";

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const NUL = String.fromCharCode(0);

const CONFIG = bytes('{"version":1,"name":"docs"}\n');
const DATABASE = Uint8Array.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x00, 0xff]);

function manifest(overrides: Partial<CorpusManifest> = {}): CorpusManifest {
  return {
    formatVersion: ARCHIVE_FORMAT_VERSION,
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
    sources: [
      { id: "docs", revision: null },
      { id: "spec", revision: "a1b2c3" },
    ],
    files: {
      [ARCHIVE_ENTRIES.config]: describeFile(CONFIG, sha256),
      [ARCHIVE_ENTRIES.database]: describeFile(DATABASE, sha256),
    },
    ...overrides,
  };
}

/** The manifest as plain JSON, for tests that need to break it in a specific way. */
function rawManifest(): Record<string, any> {
  return JSON.parse(serializeManifest(manifest()));
}

function archive(
  options: { manifest?: string; extra?: ArchiveFile[]; omit?: string[]; replace?: Record<string, Uint8Array> } = {},
): ArchiveFile[] {
  const files: ArchiveFile[] = [
    { name: ARCHIVE_ENTRIES.manifest, data: bytes(options.manifest ?? serializeManifest(manifest())) },
    { name: ARCHIVE_ENTRIES.config, data: CONFIG },
    { name: ARCHIVE_ENTRIES.database, data: DATABASE },
  ];
  const kept = files
    .filter((file) => !(options.omit ?? []).includes(file.name))
    .map((file) => {
      const replacement = options.replace?.[file.name];
      return replacement === undefined ? file : { name: file.name, data: replacement };
    });
  return [...kept, ...(options.extra ?? [])];
}

describe("domain/model/corpus-manifest", () => {
  describe("serializeManifest and parseManifest", () => {
    it("round-trip every field", () => {
      assert.deepEqual(parseManifest(serializeManifest(manifest())), manifest());
    });

    it("write snake_case keys in a stable order, like the JSON contract", () => {
      assert.deepEqual(Object.keys(rawManifest()), [
        "format",
        "format_version",
        "corpus",
        "created_at",
        "created_by",
        "built_at",
        "identity",
        "counts",
        "sources",
        "files",
      ]);
    });

    it("name the format, so a stray archive from another tool is recognisable", () => {
      assert.equal(rawManifest()["format"], ARCHIVE_FORMAT);
    });

    it("list the payload files in the format's order", () => {
      assert.deepEqual(Object.keys(rawManifest()["files"]), [...PAYLOAD_ENTRIES]);
    });

    it("end with a newline, so the file diffs and cats cleanly", () => {
      assert.ok(serializeManifest(manifest()).endsWith("}\n"));
    });
  });

  describe("parseManifest refusals", () => {
    const reject = (mutate: (raw: Record<string, any>) => void, pattern: RegExp): void => {
      const raw = rawManifest();
      mutate(raw);
      assert.throws(
        () => parseManifest(JSON.stringify(raw)),
        (error: unknown) => {
          assert.ok(error instanceof ArchiveError, `expected ArchiveError, got ${String(error)}`);
          assert.match(error.message, pattern);
          return true;
        },
      );
    };

    it("refuses text that is not JSON", () => {
      assert.throws(() => parseManifest("{ nope"), ArchiveError);
    });

    it("refuses a manifest written by another tool", () => {
      reject((raw) => {
        raw["format"] = "something-else";
      }, /not a GraphDog corpus archive/);
    });

    it("treats a newer format as an incompatibility with an upgrade remedy, not as corruption", () => {
      const raw = rawManifest();
      raw["format_version"] = ARCHIVE_FORMAT_VERSION + 1;
      assert.throws(
        () => parseManifest(JSON.stringify(raw)),
        (error: unknown) => {
          assert.ok(error instanceof IncompatibleCorpusError);
          assert.match(error.message, /newer than this GraphDog understands/);
          assert.match(String(error.details["remedy"]), /graphdog/);
          return true;
        },
      );
    });

    it("refuses a format version of zero or a fraction", () => {
      reject((raw) => {
        raw["format_version"] = 0;
      }, /format_version/);
      reject((raw) => {
        raw["format_version"] = 1.5;
      }, /format_version/);
    });

    it("names the exact field that is wrong", () => {
      reject((raw) => {
        raw["identity"]["embedding_id"] = "";
      }, /identity\.embedding_id must be a non-empty string/);
    });

    it("refuses negative or fractional counts", () => {
      reject((raw) => {
        raw["counts"]["documents"] = -1;
      }, /counts\.documents/);
      reject((raw) => {
        raw["counts"]["chunks"] = 2.5;
      }, /counts\.chunks/);
    });

    it("refuses a checksum that is not lowercase hex SHA-256", () => {
      reject((raw) => {
        raw["files"]["corpus.sqlite3"]["sha256"] = "ABC";
      }, /sha256/);
    });

    it("refuses a files entry the format does not have", () => {
      reject((raw) => {
        raw["files"]["evil.sh"] = { bytes: 1, sha256: "0".repeat(64) };
      }, /entry the format does not have: "evil\.sh"/);
    });

    it("refuses a manifest that does not vouch for every payload file", () => {
      reject((raw) => {
        delete raw["files"]["corpus.sqlite3"];
      }, /files\["corpus\.sqlite3"\]/);
    });

    it("accepts a null or string revision and refuses anything else", () => {
      assert.deepEqual(parseManifest(serializeManifest(manifest())).sources[0], {
        id: "docs",
        revision: null,
      });
      reject((raw) => {
        raw["sources"][0]["revision"] = 7;
      }, /sources\[0\]\.revision/);
    });
  });

  describe("assertSafeEntryName", () => {
    it("accepts every name the format defines", () => {
      for (const name of Object.values(ARCHIVE_ENTRIES)) {
        assert.doesNotThrow(() => assertSafeEntryName(name));
      }
    });

    const hostile: Array<[string, RegExp]> = [
      ["../corpus.sqlite3", /path traversal/],
      ["docs/../../.ssh/authorized_keys", /path traversal/],
      ["/etc/passwd", /absolute paths/],
      ["\\\\server\\share\\x", /absolute paths/],
      ["C:\\Windows\\system32\\x.dll", /absolute paths/],
      ["c:relative-to-drive", /absolute paths/],
      ["docs/corpus.sqlite3", /flat/],
      ["docs\\corpus.sqlite3", /flat/],
      ["./manifest.json", /flat/],
      ["", /empty/],
      [`manifest.json${NUL}.png`, /control character/],
      ["evil.sh", /not part of the archive format/],
      ["MANIFEST.JSON", /not part of the archive format/],
    ];

    for (const [name, reason] of hostile) {
      it(`refuses ${JSON.stringify(name)} and says why`, () => {
        assert.throws(
          () => assertSafeEntryName(name),
          (error: unknown) => {
            assert.ok(error instanceof ArchiveError);
            assert.match(error.message, reason);
            assert.equal(error.details["entry"], name);
            return true;
          },
        );
      });
    }
  });

  describe("verifyArchive", () => {
    it("returns the manifest and the exact payload bytes when everything checks out", () => {
      const verified = verifyArchive(archive(), sha256);
      assert.equal(verified.manifest.corpus, "docs");
      assert.deepEqual(verified.config, CONFIG);
      assert.deepEqual(verified.database, DATABASE);
    });

    it("does not care what order the entries arrive in", () => {
      assert.doesNotThrow(() => verifyArchive(archive().reverse(), sha256));
    });

    it("refuses an archive with no manifest", () => {
      assert.throws(
        () => verifyArchive(archive({ omit: [ARCHIVE_ENTRIES.manifest] }), sha256),
        /manifest\.json is missing/,
      );
    });

    it("refuses an archive missing a payload file", () => {
      assert.throws(
        () => verifyArchive(archive({ omit: [ARCHIVE_ENTRIES.database] }), sha256),
        /missing corpus\.sqlite3/,
      );
    });

    it("refuses a payload whose bytes changed but whose size did not", () => {
      const tampered = DATABASE.slice();
      tampered[0] = 0x00;
      assert.throws(
        () => verifyArchive(archive({ replace: { [ARCHIVE_ENTRIES.database]: tampered } }), sha256),
        (error: unknown) => {
          assert.ok(error instanceof ArchiveError);
          assert.match(error.message, /checksum mismatch for corpus\.sqlite3/);
          assert.equal(error.details["expected"], sha256(DATABASE));
          assert.equal(error.details["actual"], sha256(tampered));
          return true;
        },
      );
    });

    it("refuses a payload whose size differs from the manifest", () => {
      assert.throws(
        () =>
          verifyArchive(
            archive({ replace: { [ARCHIVE_ENTRIES.config]: bytes("{}") } }),
            sha256,
          ),
        /graphdog\.json is 2 bytes but the manifest records/,
      );
    });

    it("refuses an entry the format does not have, even alongside a valid corpus", () => {
      assert.throws(
        () => verifyArchive(archive({ extra: [{ name: "postinstall.sh", data: bytes("rm -rf /") }] }), sha256),
        /not part of the archive format/,
      );
    });

    it("refuses a traversal entry before interpreting anything else", () => {
      // The manifest here is also broken. Being told about the traversal rather
      // than the JSON proves names are checked first.
      assert.throws(
        () =>
          verifyArchive(
            archive({ manifest: "{ broken", extra: [{ name: "../escape", data: bytes("x") }] }),
            sha256,
          ),
        /path traversal/,
      );
    });

    it("refuses a duplicated entry, which would make 'the' database ambiguous", () => {
      assert.throws(
        () =>
          verifyArchive(
            archive({ extra: [{ name: ARCHIVE_ENTRIES.database, data: DATABASE }] }),
            sha256,
          ),
        /more than once/,
      );
    });

    it("refuses a manifest that is not UTF-8", () => {
      const files = archive().map((file) =>
        file.name === ARCHIVE_ENTRIES.manifest ? { name: file.name, data: Uint8Array.from([0xff, 0xfe]) } : file,
      );
      assert.throws(() => verifyArchive(files, sha256), /not valid UTF-8/);
    });
  });
});
