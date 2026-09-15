import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import { ArchiveError } from "../../domain/errors.ts";
import { DEFAULT_MAX_EXPANDED_BYTES, GzipArchiveCodec } from "./gzip-archive-codec.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const ENTRIES = [
  { name: "manifest.json", data: bytes('{"format":"graphdog-corpus"}') },
  { name: "corpus.sqlite3", data: Uint8Array.from({ length: 2000 }, (_, index) => index % 256) },
];

function expectArchiveError(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ArchiveError, `expected ArchiveError, got ${String(error)}`);
    assert.match(error.message, pattern);
    return true;
  });
}

describe("infrastructure/archive/gzip-archive-codec", () => {
  const codec = new GzipArchiveCodec();

  it("round-trips entries exactly", () => {
    assert.deepEqual(codec.decode(codec.encode(ENTRIES)), ENTRIES);
  });

  it("writes gzip, so the archive is recognisable by its magic bytes", () => {
    const archive = codec.encode(ENTRIES);
    assert.equal(archive[0], 0x1f);
    assert.equal(archive[1], 0x8b);
  });

  it("contains an ordinary ustar archive, so tar -tzf can inspect it before import", () => {
    const tar = gunzipSync(codec.encode(ENTRIES));
    assert.equal(new TextDecoder().decode(tar.subarray(257, 262)), "ustar");
  });

  it("refuses a file that is not gzip at all, such as a zip", () => {
    expectArchiveError(() => codec.decode(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x20, 0x7a, 0x69, 0x70])), /not gzip-compressed/);
  });

  it("refuses an empty file", () => {
    expectArchiveError(() => codec.decode(new Uint8Array(0)), /not gzip-compressed/);
  });

  it("refuses a damaged gzip stream instead of salvaging part of it", () => {
    const archive = codec.encode(ENTRIES);
    const damaged = archive.slice();
    const middle = Math.floor(damaged.length / 2);
    damaged[middle] = (damaged[middle] ?? 0) ^ 0xff;
    expectArchiveError(() => codec.decode(damaged), /corrupt|checksum|truncated/);
  });

  it("refuses an archive that expands past the limit, which is how a gzip bomb is stopped", () => {
    const bomb = new Uint8Array(gzipSync(new Uint8Array(1_000_000)));
    assert.ok(bomb.length < 5_000, "a megabyte of zeros compresses to almost nothing");
    const guarded = new GzipArchiveCodec({ maxExpandedBytes: 64 * 1024 });
    expectArchiveError(() => guarded.decode(bomb), /expands beyond 65536 bytes/);
  });

  it("defaults to a limit generous for real corpora", () => {
    assert.ok(DEFAULT_MAX_EXPANDED_BYTES >= 1024 ** 3);
  });

  it("passes a tar-level refusal through as an ArchiveError", () => {
    const notTar = new Uint8Array(gzipSync(bytes("this is not a tar archive")));
    expectArchiveError(() => codec.decode(notTar), /truncated/);
  });

  it("honours an entry limit", () => {
    const limited = new GzipArchiveCodec({ maxEntries: 1 });
    expectArchiveError(() => limited.decode(codec.encode(ENTRIES)), /more than 1 entries/);
  });
});
