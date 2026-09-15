/**
 * The `.gdog` container: a gzip-compressed ustar archive.
 *
 * Ordinary formats on purpose, so an archive can be inspected with tools
 * everybody already has (`tar -tzf corpus.gdog`) before anybody imports it.
 *
 * Decompression is capped. A few kilobytes of gzip can expand to gigabytes,
 * and an import reads the whole archive into memory, so an uncapped gunzip is
 * a way to take down whatever runs the import. The cap is generous for any
 * corpus GraphDog targets and a hard stop for anything else.
 */

import { gunzipSync, gzipSync } from "node:zlib";

import { ArchiveError } from "../../domain/errors.ts";
import type { ArchiveCodec, ArchiveEntry } from "../../application/ports/archive.ts";
import { decodeTar, encodeTar } from "./tar-codec.ts";

/** 2 GiB: far above the corpora GraphDog targets, well short of exhausting memory. */
export const DEFAULT_MAX_EXPANDED_BYTES = 2 * 1024 ** 3;

export interface GzipArchiveCodecOptions {
  /** Refuse archives whose uncompressed tar would exceed this many bytes. */
  readonly maxExpandedBytes?: number;
  readonly maxEntries?: number;
}

export class GzipArchiveCodec implements ArchiveCodec {
  readonly #maxExpandedBytes: number;
  readonly #maxEntries: number | undefined;

  constructor(options: GzipArchiveCodecOptions = {}) {
    this.#maxExpandedBytes = options.maxExpandedBytes ?? DEFAULT_MAX_EXPANDED_BYTES;
    this.#maxEntries = options.maxEntries;
  }

  encode(entries: readonly ArchiveEntry[]): Uint8Array {
    return new Uint8Array(gzipSync(encodeTar(entries)));
  }

  decode(archive: Uint8Array): ArchiveEntry[] {
    if (archive.length < 2 || archive[0] !== 0x1f || archive[1] !== 0x8b) {
      throw new ArchiveError("not a GraphDog archive: the file is not gzip-compressed", {
        hint: "a .gdog file is produced by 'graphdog export'",
      });
    }

    let tar: Uint8Array;
    try {
      tar = gunzipSync(archive, { maxOutputLength: this.#maxExpandedBytes });
    } catch (error) {
      if (isTooLarge(error)) {
        throw new ArchiveError(
          `archive expands beyond ${this.#maxExpandedBytes} bytes; refusing to unpack it`,
          { limit: this.#maxExpandedBytes },
        );
      }
      throw new ArchiveError(`archive is corrupt: ${error instanceof Error ? error.message : String(error)}`, {});
    }

    return decodeTar(tar, this.#maxEntries === undefined ? {} : { maxEntries: this.#maxEntries });
  }
}

function isTooLarge(error: unknown): boolean {
  return (
    error instanceof RangeError ||
    (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE")
  );
}
