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

/** Assemble a PDF from object bodies, with a correct cross-reference table. */
function pdf(objects: readonly string[]): Buffer {
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function stream(content: string): string {
  return `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
}

const PAGE = "/Type /Page /Parent 2 0 R /MediaBox [0 0 300 200]";

/** Two pages of Helvetica text, and optionally a third page with no text at all. */
function latinPdf(options: { blankPage?: boolean } = {}): Buffer {
  const kids = options.blankPage === true ? "[3 0 R 4 0 R 8 0 R]" : "[3 0 R 4 0 R]";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids ${kids} /Count ${options.blankPage === true ? 3 : 2} >>`,
    `<< ${PAGE} /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>`,
    `<< ${PAGE} /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream("BT /F1 12 Tf 20 100 Td (Rotation happens every hour) Tj ET"),
    stream("BT /F1 12 Tf 20 100 Td (Keys are published at the JWKS endpoint) Tj ET"),
  ];
  if (options.blankPage === true) objects.push(`<< ${PAGE} /Contents 9 0 R >>`, stream(""));
  return pdf(objects);
}

/**
 * Japanese set the way most Japanese PDFs are: a CID-keyed font with the
 * predefined `UniJIS-UCS2-H` encoding and no embedded font. Turning these codes
 * back into text needs pdf.js's character maps.
 */
const JAPANESE = "日本語テキスト";
function japanesePdf(): Buffer {
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< ${PAGE} /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>`,
    "<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3 /Encoding /UniJIS-UCS2-H /DescendantFonts [5 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiMin-W3 " +
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor 6 0 R >>",
    "<< /Type /FontDescriptor /FontName /HeiseiMin-W3 /Flags 6 /FontBBox [0 -141 1000 859] " +
      "/ItalicAngle 0 /Ascent 859 /Descent -141 /CapHeight 709 /StemV 80 >>",
    // 日本語テキスト as UCS-2 code units.
    stream("BT /F1 12 Tf 20 100 Td <65E5672C8A9E30C630AD30B930C8> Tj ET"),
  ]);
}

/**
 * PDF extraction runs against the real pdfjs-dist, a development dependency,
 * with PDFs assembled here so there is no fixture file to go stale. DOCX
 * extraction's dependency is not installed, so for it what is tested is that a
 * missing dependency is a clear per-file failure naming the remedy.
 */
describe("infrastructure/extraction/binaryExtractors", () => {
  describe("PdfExtractor", () => {
    const extractor = new PdfExtractor();

    it("claims the .pdf extension", () => {
      assert.ok(extractor.extensions.has(".pdf"));
    });

    it("extracts each page's text, with a page break per page", async () => {
      const result = await extractor.extract(await write("two-pages.pdf", latinPdf()));
      assert.match(result.text, /Rotation happens every hour/);
      assert.match(result.text, /Keys are published at the JWKS endpoint/);
      assert.equal(result.pageBreaks.length, 2);
      assert.deepEqual(result.pageBreaks[0], [0, 1]);
      assert.equal(result.pageBreaks[1]?.[1], 2);
      assert.equal(result.mediaType, "application/pdf");
    });

    it("releases each document, which pdfjs-dist 6 does through the loading task", async () => {
      // pdfjs-dist 6 removed PDFDocumentProxy.destroy(). Calling it made every
      // PDF fail with "document.destroy is not a function"; extracting several
      // in a row is what that bug broke.
      const path = await write("repeat.pdf", latinPdf());
      for (let attempt = 0; attempt < 3; attempt += 1) {
        assert.match((await extractor.extract(path)).text, /JWKS endpoint/);
      }
    });

    it("maps Japanese text in CID-keyed fonts through pdf.js's character maps", async () => {
      const result = await extractor.extract(await write("japanese.pdf", japanesePdf()));
      assert.match(result.text, new RegExp(JAPANESE));
    });

    it("uses a fixture that genuinely needs the character maps", async () => {
      // Without this, the test above could pass for the wrong reason.
      const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
        getDocument(options: { data: Uint8Array; verbosity: number }): {
          promise: Promise<{ getPage(n: number): Promise<{ getTextContent(): Promise<{ items: Array<{ str?: string }> }> }> }>;
          destroy(): Promise<void>;
        };
      };
      const task = pdfjs.getDocument({ data: new Uint8Array(japanesePdf()), verbosity: 0 });
      let text = "";
      try {
        const page = await (await task.promise).getPage(1);
        text = (await page.getTextContent()).items.map((item) => item.str ?? "").join("");
      } catch {
        text = "";
      } finally {
        await task.destroy();
      }
      assert.doesNotMatch(text, new RegExp(JAPANESE));
    });

    it("notes pages with no text layer rather than dropping them silently", async () => {
      const result = await extractor.extract(await write("blank-page.pdf", latinPdf({ blankPage: true })));
      assert.equal(result.pageBreaks.length, 3);
      assert.ok(result.notes.some((note) => /1 of 3 page\(s\) had no text layer/.test(note)));
    });

    it("refuses bytes that are not a readable PDF, naming the file", async () => {
      const path = await write("broken.pdf", Buffer.from("%PDF-1.4\n"));
      await assert.rejects(
        () => extractor.extract(path),
        (error: unknown) => {
          assert.ok(error instanceof ExtractionError);
          assert.match(error.message, /cannot open PDF/);
          assert.equal(error.details["path"], path);
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
