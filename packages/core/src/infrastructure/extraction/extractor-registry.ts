/**
 * Extension-to-extractor dispatch.
 *
 * A file with no registered extractor is not silently dropped: if it looks
 * textual it is read as text, and if it looks binary the build records a
 * failure naming the format. "Why is this file not in my results" always has
 * an answer.
 */

import { open } from "node:fs/promises";
import { extname } from "node:path";

import { ExtractionError } from "../../domain/errors.ts";
import type {
  ContentExtractor,
  ExtractedDocument,
  ExtractorRegistry,
} from "../../application/ports/sources.ts";
import { DocxExtractor, PdfExtractor } from "./binary-extractors.ts";
import { TextExtractor } from "./text-extractor.ts";

const PROBE_BYTES = 8192;

export class DefaultExtractorRegistry implements ExtractorRegistry {
  readonly #byExtension = new Map<string, ContentExtractor>();
  readonly #textExtractor: TextExtractor;

  constructor(extractors: readonly ContentExtractor[] = defaultExtractors()) {
    this.#textExtractor = new TextExtractor();
    for (const extractor of extractors) {
      for (const extension of extractor.extensions) {
        this.#byExtension.set(extension.toLowerCase(), extractor);
      }
    }
  }

  supports(extension: string): boolean {
    return this.#byExtension.has(extension.toLowerCase());
  }

  supportedExtensions(): ReadonlySet<string> {
    return new Set(this.#byExtension.keys());
  }

  async extract(absolutePath: string): Promise<ExtractedDocument> {
    const extension = extname(absolutePath).toLowerCase();
    const extractor = this.#byExtension.get(extension);
    if (extractor !== undefined) return extractor.extract(absolutePath);

    if (await looksBinary(absolutePath)) {
      throw new ExtractionError(
        `no extractor for ${extension === "" ? "this file type" : extension}, ` +
          `and the file appears to be binary`,
        { path: absolutePath, extension },
      );
    }
    // Unknown but textual: index it rather than discard content the user
    // deliberately pointed an include pattern at.
    return this.#textExtractor.extract(absolutePath);
  }
}

export function defaultExtractors(): ContentExtractor[] {
  return [new TextExtractor(), new PdfExtractor(), new DocxExtractor()];
}

/** A NUL byte in the first block is the usual, cheap binary heuristic. */
async function looksBinary(path: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, PROBE_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } catch {
    return true;
  } finally {
    await handle?.close();
  }
}
