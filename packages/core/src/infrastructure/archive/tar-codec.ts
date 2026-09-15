/**
 * A minimal POSIX ustar reader and writer.
 *
 * A corpus archive holds three flat files, so the full tar format -- links,
 * directories, long names, pax headers, sparse files -- is not just unneeded
 * but a liability: every entry type a reader understands is an entry type a
 * crafted archive can abuse. This reads regular files and nothing else, and
 * refuses the rest by name rather than skipping them.
 *
 * Hand-written rather than a dependency for the same reason the rest of the
 * default install is dependency-light, and because the subset needed is short
 * enough to read in full. The output is still ordinary tar: `tar -tzf
 * corpus.gdog` lists it.
 */

import { ArchiveError } from "../../domain/errors.ts";

const BLOCK = 512;

/** The largest size ustar's eleven octal digits can express. */
const MAX_ENTRY_BYTES = 0o77777777777;

/** Far above the three entries a corpus archive has; a guard, not a limit anyone meets. */
const DEFAULT_MAX_ENTRIES = 64;

const TYPE_REGULAR = 0x30; // '0'
const TYPE_REGULAR_LEGACY = 0x00; // pre-POSIX regular file

const TYPE_NAMES: Readonly<Record<number, string>> = {
  0x31: "hard link",
  0x32: "symbolic link",
  0x33: "character device",
  0x34: "block device",
  0x35: "directory",
  0x36: "FIFO",
  0x37: "contiguous file",
  0x67: "pax global header",
  0x78: "pax extended header",
  0x4b: "GNU long link name",
  0x4c: "GNU long name",
};

export interface TarEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

export interface DecodeTarOptions {
  readonly maxEntries?: number;
}

const encoder = new TextEncoder();

export function encodeTar(entries: readonly TarEntry[]): Uint8Array {
  let total = BLOCK * 2;
  for (const entry of entries) total += BLOCK + padded(entry.data.length);

  const out = new Uint8Array(total);
  let offset = 0;
  for (const entry of entries) {
    out.set(headerFor(entry), offset);
    offset += BLOCK;
    out.set(entry.data, offset);
    offset += padded(entry.data.length);
  }
  // The two zero blocks that end the archive are already there: the buffer
  // starts zero-filled.
  return out;
}

function headerFor(entry: TarEntry): Uint8Array {
  const name = encoder.encode(entry.name);
  if (name.length === 0 || name.length > 100) {
    throw new Error(`tar entry names must be 1 to 100 bytes: ${JSON.stringify(entry.name)}`);
  }
  if (entry.data.length > MAX_ENTRY_BYTES) {
    throw new Error(`tar entry ${entry.name} is too large for ustar: ${entry.data.length} bytes`);
  }

  const block = new Uint8Array(BLOCK);
  block.set(name, 0);
  writeOctal(block, 100, 8, 0o644);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, entry.data.length);
  // Modification time is fixed at zero. The archive's dates live in the
  // manifest, and a header timestamp would make two exports of one corpus
  // differ for no reason.
  writeOctal(block, 136, 12, 0);
  block[156] = TYPE_REGULAR;
  block.set(encoder.encode("ustar"), 257);
  block.set(encoder.encode("00"), 263);
  writeChecksum(block);
  return block;
}

/** Write `value` as zero-padded octal filling all but the field's last byte, which stays NUL. */
function writeOctal(block: Uint8Array, offset: number, width: number, value: number): void {
  block.set(encoder.encode(value.toString(8).padStart(width - 1, "0")), offset);
}

/**
 * Compute and store a header's checksum.
 *
 * Exported for tests that build deliberately malformed headers: without a
 * valid checksum such a header would be refused for the wrong reason, and the
 * test would prove nothing about the check it meant to exercise.
 */
export function writeChecksum(block: Uint8Array): void {
  const digits = checksumOf(block).toString(8).padStart(6, "0");
  block.set(encoder.encode(digits), 148);
  block[154] = 0x00;
  block[155] = 0x20;
}

/** Sum of the header bytes, with the checksum field itself counted as spaces. */
function checksumOf(block: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
  }
  return sum;
}

/**
 * Read every entry, refusing anything outside the supported subset.
 *
 * Refusal is always an `ArchiveError`, never a partial result: an archive that
 * is damaged halfway through must not yield the half before the damage as if
 * that were the whole thing.
 */
export function decodeTar(archive: Uint8Array, options: DecodeTarOptions = {}): TarEntry[] {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;

  for (;;) {
    if (offset + BLOCK > archive.length) {
      throw new ArchiveError(
        "archive is truncated: it ends without the tar end-of-archive marker",
        { offset },
      );
    }
    const block = archive.subarray(offset, offset + BLOCK);
    if (isZeroBlock(block)) return entries;

    const recorded = parseOctal(block, 148, 8, "checksum", offset);
    if (recorded !== checksumOf(block)) {
      throw new ArchiveError(`tar header at byte ${offset} has a bad checksum; the archive is corrupt`, {
        offset,
      });
    }

    // POSIX writes "ustar\0", GNU tar "ustar " -- both are ustar headers.
    const magic = readField(block, 257, 6, offset);
    if (magic !== "ustar" && magic !== "ustar ") {
      throw new ArchiveError(`tar header at byte ${offset} is not a ustar header`, { offset });
    }

    const prefix = readField(block, 345, 155, offset);
    const base = readField(block, 0, 100, offset);
    // The prefix is joined on so that the name policy sees the full path an
    // extracting tool would use, not a harmless-looking tail of it.
    const name = prefix === "" ? base : `${prefix}/${base}`;
    if (name === "") {
      throw new ArchiveError(`tar header at byte ${offset} has an empty name`, { offset });
    }

    const type = block[156] ?? 0;
    if (type !== TYPE_REGULAR && type !== TYPE_REGULAR_LEGACY) {
      const label = TYPE_NAMES[type] ?? `type ${JSON.stringify(String.fromCharCode(type))}`;
      throw new ArchiveError(
        `refusing tar entry "${name}": it is a ${label}, and a corpus archive contains regular files only`,
        { entry: name, type: String.fromCharCode(type) },
      );
    }

    const size = parseOctal(block, 124, 12, "size", offset);
    const start = offset + BLOCK;
    if (start + size > archive.length) {
      throw new ArchiveError(
        `archive is truncated: "${name}" declares ${size} bytes but the archive ends first`,
        { entry: name, size },
      );
    }
    if (seen.has(name)) {
      throw new ArchiveError(`archive contains "${name}" more than once`, { entry: name });
    }
    if (entries.length >= maxEntries) {
      throw new ArchiveError(`archive has more than ${maxEntries} entries; refusing to read further`, {
        limit: maxEntries,
      });
    }

    seen.add(name);
    // Copied through the Uint8Array constructor rather than `.slice()`: on a
    // Node Buffer -- which is what gunzip returns -- `.slice()` is a view into
    // the same memory, not a copy, so every entry would silently alias one
    // shared buffer.
    entries.push({ name, data: new Uint8Array(archive.subarray(start, start + size)) });
    offset = start + padded(size);
  }
}

function parseOctal(
  block: Uint8Array,
  offset: number,
  width: number,
  field: string,
  headerOffset: number,
): number {
  if (((block[offset] ?? 0) & 0x80) !== 0) {
    throw new ArchiveError(
      `tar header at byte ${headerOffset} uses base-256 for its ${field}, which a corpus archive never needs`,
      { offset: headerOffset, field },
    );
  }
  const text = readField(block, offset, width, headerOffset).trim();
  if (!/^[0-7]+$/.test(text)) {
    throw new ArchiveError(`tar header at byte ${headerOffset} has a malformed ${field} field`, {
      offset: headerOffset,
      field,
      value: text,
    });
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) {
    throw new ArchiveError(`tar header at byte ${headerOffset} has an out-of-range ${field}`, {
      offset: headerOffset,
      field,
    });
  }
  return value;
}

/** The bytes of a header field up to its first NUL, as UTF-8. */
function readField(block: Uint8Array, offset: number, width: number, headerOffset: number): string {
  const field = block.subarray(offset, offset + width);
  const end = field.indexOf(0x00);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(end < 0 ? field : field.subarray(0, end));
  } catch {
    throw new ArchiveError(`tar header at byte ${headerOffset} contains invalid UTF-8`, {
      offset: headerOffset,
    });
  }
}

function isZeroBlock(block: Uint8Array): boolean {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

function padded(size: number): number {
  return Math.ceil(size / BLOCK) * BLOCK;
}
