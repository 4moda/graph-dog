import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ArchiveError } from "../../domain/errors.ts";
import { decodeTar, encodeTar, writeChecksum, type TarEntry } from "./tar-codec.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array): string => new TextDecoder().decode(data);

/** Binary content that exercises every byte value, NUL and 0xff included. */
function binary(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, index) => index % 256);
}

/** Edit the header at `offset`, then fix its checksum so only the edit is wrong. */
function withHeader(archive: Uint8Array, offset: number, edit: (block: Uint8Array) => void): Uint8Array {
  const copy = archive.slice();
  const block = copy.subarray(offset, offset + 512);
  edit(block);
  writeChecksum(block);
  return copy;
}

function field(block: Uint8Array, offset: number, width: number): string {
  const slice = block.subarray(offset, offset + width);
  const end = slice.indexOf(0);
  return text(end < 0 ? slice : slice.subarray(0, end));
}

function expectArchiveError(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ArchiveError, `expected ArchiveError, got ${String(error)}`);
    assert.match(error.message, pattern);
    return true;
  });
}

describe("infrastructure/archive/tar-codec", () => {
  describe("encodeTar", () => {
    it("round-trips names and bytes exactly, across block boundaries", () => {
      const entries: TarEntry[] = [
        { name: "empty", data: new Uint8Array(0) },
        { name: "one", data: binary(1) },
        { name: "almost-a-block", data: binary(511) },
        { name: "one-block", data: binary(512) },
        { name: "just-over", data: binary(513) },
      ];
      assert.deepEqual(decodeTar(encodeTar(entries)), entries);
    });

    it("pads to whole blocks and ends with two zero blocks", () => {
      const archive = encodeTar([{ name: "a", data: bytes("hello") }]);
      assert.equal(archive.length % 512, 0);
      assert.ok(archive.subarray(archive.length - 1024).every((byte) => byte === 0));
    });

    it("is deterministic, so two exports of one corpus carry identical tar bytes", () => {
      const entries = [{ name: "a", data: bytes("same") }];
      assert.deepEqual(encodeTar(entries), encodeTar(entries));
    });

    it("writes headers ordinary tar tools read: ustar, regular file, mode 0644, mtime 0", () => {
      const header = encodeTar([{ name: "manifest.json", data: bytes("{}") }]).subarray(0, 512);
      assert.equal(field(header, 0, 100), "manifest.json");
      assert.equal(field(header, 100, 8), "0000644");
      assert.equal(field(header, 136, 12), "00000000000");
      assert.equal(header[156], 0x30);
      assert.equal(field(header, 257, 6), "ustar");
      assert.equal(field(header, 263, 2), "00");
    });

    it("refuses names that ustar cannot hold", () => {
      assert.throws(() => encodeTar([{ name: "x".repeat(101), data: new Uint8Array(0) }]), /1 to 100 bytes/);
      assert.throws(() => encodeTar([{ name: "", data: new Uint8Array(0) }]), /1 to 100 bytes/);
    });
  });

  describe("decodeTar", () => {
    const single = encodeTar([{ name: "manifest.json", data: bytes("{}") }]);

    it("returns no entries for an archive that is only an end marker", () => {
      assert.deepEqual(decodeTar(encodeTar([])), []);
    });

    it("refuses an archive cut off inside an entry", () => {
      expectArchiveError(() => decodeTar(single.slice(0, 600)), /truncated/);
    });

    it("refuses an archive with no end-of-archive marker", () => {
      expectArchiveError(() => decodeTar(single.slice(0, 1024)), /end-of-archive marker/);
    });

    it("refuses a header whose checksum does not match", () => {
      const corrupt = single.slice();
      corrupt[0] = "N".charCodeAt(0);
      expectArchiveError(() => decodeTar(corrupt), /bad checksum/);
    });

    const unsupported: Array<[string, number, RegExp]> = [
      ["a hard link", 0x31, /hard link/],
      ["a symbolic link", 0x32, /symbolic link/],
      ["a directory", 0x35, /directory/],
      ["a pax extended header", 0x78, /pax extended header/],
      ["a GNU long name", 0x4c, /GNU long name/],
      ["an unknown type", 0x5a, /type "Z"/],
    ];
    for (const [label, type, pattern] of unsupported) {
      it(`refuses ${label}: only regular files are read`, () => {
        const archive = withHeader(single, 0, (block) => {
          block[156] = type;
        });
        expectArchiveError(() => decodeTar(archive), pattern);
      });
    }

    it("accepts the pre-POSIX regular-file type", () => {
      const archive = withHeader(single, 0, (block) => {
        block[156] = 0x00;
      });
      assert.equal(decodeTar(archive)[0]?.name, "manifest.json");
    });

    it("refuses a declared size that runs past the end of the archive", () => {
      const archive = withHeader(single, 0, (block) => {
        block.set(bytes("00007777777"), 124);
      });
      expectArchiveError(() => decodeTar(archive), /declares 2097151 bytes/);
    });

    it("refuses base-256 sizes, which only matter for files a corpus archive never has", () => {
      const archive = withHeader(single, 0, (block) => {
        block[124] = 0x80;
      });
      expectArchiveError(() => decodeTar(archive), /base-256/);
    });

    it("refuses a size field that is not octal", () => {
      const archive = withHeader(single, 0, (block) => {
        block.set(bytes("0000000009a"), 124);
      });
      expectArchiveError(() => decodeTar(archive), /malformed size/);
    });

    it("refuses a header that is not ustar", () => {
      const archive = withHeader(single, 0, (block) => {
        block.set(bytes("xxxxx"), 257);
      });
      expectArchiveError(() => decodeTar(archive), /not a ustar header/);
    });

    it("accepts GNU tar's ustar variant", () => {
      const archive = withHeader(single, 0, (block) => {
        block.set(bytes("ustar  "), 257);
      });
      assert.equal(decodeTar(archive).length, 1);
    });

    it("refuses a name that is not UTF-8", () => {
      const archive = withHeader(single, 0, (block) => {
        block.fill(0, 0, 100);
        block.set([0xff, 0xfe], 0);
      });
      expectArchiveError(() => decodeTar(archive), /invalid UTF-8/);
    });

    it("joins the ustar prefix onto the name, so a policy check sees the whole path", () => {
      const archive = withHeader(single, 0, (block) => {
        block.set(bytes("../../etc"), 345);
      });
      assert.equal(decodeTar(archive)[0]?.name, "../../etc/manifest.json");
    });

    it("refuses a name that appears twice", () => {
      const archive = encodeTar([
        { name: "a", data: bytes("1") },
        { name: "a", data: bytes("2") },
      ]);
      expectArchiveError(() => decodeTar(archive), /more than once/);
    });

    it("stops at the entry limit rather than reading an unbounded archive", () => {
      const archive = encodeTar([
        { name: "a", data: bytes("1") },
        { name: "b", data: bytes("2") },
        { name: "c", data: bytes("3") },
      ]);
      expectArchiveError(() => decodeTar(archive, { maxEntries: 2 }), /more than 2 entries/);
      assert.equal(decodeTar(archive, { maxEntries: 3 }).length, 3);
    });

    it("returns copies, so later edits to the archive buffer cannot change an entry", () => {
      const archive = encodeTar([{ name: "a", data: bytes("abc") }]);
      const [entry] = decodeTar(archive);
      archive.fill(0);
      assert.equal(text(entry?.data ?? new Uint8Array(0)), "abc");
    });

    it("returns plain, independent copies even when handed a Node Buffer", () => {
      // gunzip hands back a Buffer, whose `.slice()` is a view rather than a
      // copy. Entries must not alias the buffer they were decoded from.
      const archive = Buffer.from(encodeTar([{ name: "a", data: bytes("abc") }]));
      const [entry] = decodeTar(archive);
      assert.ok(entry !== undefined);
      assert.ok(!Buffer.isBuffer(entry.data), "entries are plain Uint8Arrays");
      archive.fill(0);
      assert.equal(text(entry.data), "abc");
    });
  });
});
