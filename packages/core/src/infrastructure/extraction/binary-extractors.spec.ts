import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { ExtractionError } from "../../domain/errors.ts";
import { DocxExtractor, PdfExtractor } from "./binary-extractors.ts";

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "graphdog-binary-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(name: string, content: Buffer): Promise<string> {
  const path = join(root, name);
  await writeFile(path, content);
  return path;
}

/**
 * These extractors depend on packages that are not installed by default. What
 * matters, and what is tested here, is that a missing dependency produces a
 * clear per-file failure naming the remedy -- so a corpus containing PDFs still
 * builds, with those files listed as failures rather than silently absent.
 */
describe("infrastructure/extraction/binaryExtractors", () => {
  describe("PdfExtractor", () => {
    const extractor = new PdfExtractor();

    it("claims the .pdf extension", () => {
      assert.ok(extractor.extensions.has(".pdf"));
    });

    it("reports a missing dependency with the package to install", async () => {
      const path = await write("doc.pdf", Buffer.from("%PDF-1.4\n"));
      await assert.rejects(
        () => extractor.extract(path),
        (error: unknown) => {
          assert.ok(error instanceof ExtractionError);
          assert.match(error.message, /pdfjs-dist|cannot open PDF/);
          return true;
        },
      );
    });

    it("fails per file rather than aborting, for a missing file", async () => {
      await assert.rejects(() => extractor.extract(join(root, "absent.pdf")));
    });
  });

  describe("DocxExtractor", () => {
    const extractor = new DocxExtractor();

    it("claims the .docx extension", () => {
      assert.ok(extractor.extensions.has(".docx"));
    });

    it("reports a missing dependency with the package to install", async () => {
      const path = await write("doc.docx", Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      await assert.rejects(
        () => extractor.extract(path),
        (error: unknown) => {
          assert.ok(error instanceof ExtractionError);
          assert.match(error.message, /mammoth|cannot read DOCX/);
          return true;
        },
      );
    });
  });
});
