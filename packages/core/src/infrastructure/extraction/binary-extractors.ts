/**
 * Optional extractors for binary document formats.
 *
 * Each imports its third-party dependency lazily and raises `ExtractionError`
 * naming the extra to install when it is missing. A corpus containing PDFs
 * therefore still builds on a bare install -- those files appear as recorded
 * failures rather than aborting the build or vanishing without explanation.
 *
 * Paginated formats emit page breaks, which is what lets a PDF citation be
 * (page, lines within page) rather than an offset into a concatenated blob.
 */

import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, sep } from "node:path";

import { ExtractionError } from "../../domain/errors.ts";
import { sanitize, normalizeNewlines } from "../../domain/service/markdown.ts";
import type { ContentExtractor, ExtractedDocument } from "../../application/ports/sources.ts";

const MAX_BINARY_BYTES = 100 * 1024 * 1024;

async function guardSize(path: string): Promise<void> {
  const info = await stat(path);
  if (info.size > MAX_BINARY_BYTES) {
    throw new ExtractionError(`file exceeds ${MAX_BINARY_BYTES} bytes`, {
      path,
      size: info.size,
    });
  }
}

function stem(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

/** Assemble per-page text into one document with page offsets. */
function joinPages(pages: readonly string[]): {
  text: string;
  pageBreaks: Array<readonly [number, number]>;
} {
  const parts: string[] = [];
  const pageBreaks: Array<readonly [number, number]> = [];
  let offset = 0;
  pages.forEach((page, index) => {
    const block = page.endsWith("\n") ? page : `${page}\n`;
    pageBreaks.push([offset, index + 1] as const);
    parts.push(block);
    offset += block.length;
  });
  return { text: parts.join(""), pageBreaks };
}

/**
 * Import a module that may not be installed.
 *
 * The specifier is passed through a variable so TypeScript does not try to
 * resolve it at build time: these are optional dependencies, and a static
 * import would fail the build for every user who does not need them.
 */
async function importOptional(specifier: string): Promise<unknown> {
  return import(specifier);
}

interface MammothModule {
  extractRawText(input: { path: string }): Promise<{ value: string }>;
}

/**
 * The slice of pdfjs-dist this extractor uses.
 *
 * Declared structurally rather than imported: the package is an optional
 * dependency, so its types are not present in a default install and a real
 * import would break the build for everyone who does not need PDFs.
 */
interface PdfTextItem {
  str?: string;
}

interface PdfPage {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
}

interface PdfDocument {
  numPages: number;
  getPage(index: number): Promise<PdfPage>;
}

/**
 * What `getDocument` returns. Teardown belongs to this task, not to the
 * document: pdfjs-dist 6 removed `PDFDocumentProxy.destroy()`, and calling it
 * made every PDF fail to extract.
 */
interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

interface PdfOpenOptions {
  data: Uint8Array;
  useSystemFonts?: boolean;
  cMapUrl?: string;
  cMapPacked?: boolean;
  standardFontDataUrl?: string;
  verbosity?: number;
}

interface PdfJsModule {
  getDocument(options: PdfOpenOptions): PdfLoadingTask;
}

/** pdf.js's `VerbosityLevel.ERRORS`: warnings would go to stdout and corrupt `--json`. */
const PDFJS_ERRORS_ONLY = 0;

/**
 * Where pdfjs-dist keeps its character maps and standard font data.
 *
 * Without the character maps, text in CID-keyed fonts -- which is how most
 * Japanese PDFs are set -- cannot be mapped back to Unicode, and pages come
 * out empty or garbled. Resolved from the same place the module is imported
 * from, so the data always matches the code; if it cannot be found, extraction
 * still runs, as it did before, rather than failing outright.
 */
function pdfjsResources(): Pick<PdfOpenOptions, "cMapUrl" | "cMapPacked" | "standardFontDataUrl"> {
  try {
    const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
    return {
      cMapUrl: `${join(root, "cmaps")}${sep}`,
      cMapPacked: true,
      standardFontDataUrl: `${join(root, "standard_fonts")}${sep}`,
    };
  } catch {
    return {};
  }
}

export class PdfExtractor implements ContentExtractor {
  readonly name = "pdf";
  readonly extensions: ReadonlySet<string> = new Set([".pdf"]);

  async extract(absolutePath: string): Promise<ExtractedDocument> {
    await guardSize(absolutePath);

    let pdfjs: PdfJsModule;
    try {
      pdfjs = (await importOptional("pdfjs-dist/legacy/build/pdf.mjs")) as PdfJsModule;
    } catch (error) {
      throw new ExtractionError(
        "PDF support requires pdfjs-dist: npm install pdfjs-dist",
        { path: absolutePath, cause: String(error) },
      );
    }

    const { readFile } = await import("node:fs/promises");
    const data = new Uint8Array(await readFile(absolutePath));

    const task = pdfjs.getDocument({
      data,
      useSystemFonts: true,
      verbosity: PDFJS_ERRORS_ONLY,
      ...pdfjsResources(),
    });
    let document;
    try {
      document = await task.promise;
    } catch (error) {
      await task.destroy().catch(() => undefined);
      throw new ExtractionError(`cannot open PDF: ${String(error)}`, { path: absolutePath });
    }

    const pages: string[] = [];
    const emptyPages: number[] = [];
    try {
      for (let index = 1; index <= document.numPages; index += 1) {
        const page = await document.getPage(index);
        const content = await page.getTextContent();
        const text = sanitize(
          normalizeNewlines(
            content.items
              .map((item: PdfTextItem) => ("str" in item ? item.str : ""))
              .join(" ")
              .replace(/\s+/g, " "),
          ),
        ).trim();
        if (text === "") emptyPages.push(index);
        pages.push(text);
      }
    } finally {
      await task.destroy();
    }

    const notes: string[] = [];
    if (emptyPages.length > 0) {
      notes.push(
        `${emptyPages.length} of ${pages.length} page(s) had no text layer ` +
          `(likely scanned); GraphDog does not perform OCR`,
      );
    }

    const { text, pageBreaks } = joinPages(pages);
    return {
      text,
      title: stem(absolutePath),
      mediaType: "application/pdf",
      pageBreaks,
      tags: [],
      links: [],
      notes,
    };
  }
}

export class DocxExtractor implements ContentExtractor {
  readonly name = "docx";
  readonly extensions: ReadonlySet<string> = new Set([".docx"]);

  async extract(absolutePath: string): Promise<ExtractedDocument> {
    await guardSize(absolutePath);
    let mammoth: MammothModule;
    try {
      mammoth = (await importOptional("mammoth")) as MammothModule;
    } catch (error) {
      throw new ExtractionError("DOCX support requires mammoth: npm install mammoth", {
        path: absolutePath,
        cause: String(error),
      });
    }
    try {
      const result = await mammoth.extractRawText({ path: absolutePath });
      return {
        text: sanitize(normalizeNewlines(result.value)),
        title: stem(absolutePath),
        mediaType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        pageBreaks: [],
        tags: [],
        links: [],
        notes: [],
      };
    } catch (error) {
      throw new ExtractionError(`cannot read DOCX: ${String(error)}`, { path: absolutePath });
    }
  }
}
