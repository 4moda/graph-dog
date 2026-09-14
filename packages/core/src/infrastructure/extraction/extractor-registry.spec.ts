import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { ExtractionError } from "../../domain/errors.ts";
import type { ContentExtractor, ExtractedDocument } from "../../application/ports/sources.ts";
import { DefaultExtractorRegistry, defaultExtractors } from "./extractor-registry.ts";

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "graphdog-registry-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(name: string, content: string | Buffer): Promise<string> {
  const path = join(root, name);
  await writeFile(path, content);
  return path;
}

describe("infrastructure/extraction/extractorRegistry", () => {
  const registry = new DefaultExtractorRegistry();

  describe("dispatch", () => {
    it("reports which extensions it can read", () => {
      assert.ok(registry.supports(".md"));
      assert.ok(registry.supports(".PDF"), "extension matching is case-insensitive");
      assert.ok(!registry.supports(".png"));
    });

    it("advertises the same set it dispatches on", () => {
      for (const extension of registry.supportedExtensions()) {
        assert.ok(registry.supports(extension), `${extension} advertised but not dispatched`);
      }
    });

    it("routes a known extension to its extractor", async () => {
      const path = await write("a.md", "# Title\n");
      assert.equal((await registry.extract(path)).mediaType, "text/markdown");
    });
  });

  describe("unknown file types", () => {
    it("reads an unknown but textual file rather than discarding content", async () => {
      const path = await write("notes.unknownext", "readable prose\n");
      assert.match((await registry.extract(path)).text, /readable prose/);
    });

    it("refuses an unknown binary file, naming the extension", async () => {
      const path = await write("blob.bin", Buffer.from([0, 1, 2, 0]));
      await assert.rejects(
        () => registry.extract(path),
        (error: unknown) => {
          assert.ok(error instanceof ExtractionError);
          assert.equal(error.details["extension"], ".bin");
          return true;
        },
      );
    });

    it("refuses a file with no extension that looks binary", async () => {
      const path = await write("noext", Buffer.from([0, 0, 0, 0]));
      await assert.rejects(() => registry.extract(path), ExtractionError);
    });

    it("treats an unreadable file as binary rather than crashing", async () => {
      await assert.rejects(() => registry.extract(join(root, "does-not-exist")), ExtractionError);
    });
  });

  describe("composition", () => {
    it("ships a text, a PDF and a DOCX extractor by default", () => {
      assert.deepEqual(
        defaultExtractors().map((extractor) => extractor.name).sort(),
        ["docx", "pdf", "text"],
      );
    });

    it("accepts a custom extractor set", async () => {
      const custom: ContentExtractor = {
        name: "custom",
        extensions: new Set([".xyz"]),
        extract: async (): Promise<ExtractedDocument> => ({
          text: "from the custom extractor",
          title: "Custom",
          mediaType: "application/x-custom",
          pageBreaks: [],
          tags: [],
          links: [],
          notes: [],
        }),
      };
      const custom_registry = new DefaultExtractorRegistry([custom]);
      const path = await write("thing.xyz", "ignored");
      assert.equal((await custom_registry.extract(path)).title, "Custom");
    });

    it("lets a later extractor claim an extension from an earlier one", async () => {
      const override: ContentExtractor = {
        name: "override",
        extensions: new Set([".md"]),
        extract: async (): Promise<ExtractedDocument> => ({
          text: "overridden",
          title: "Override",
          mediaType: "text/x-override",
          pageBreaks: [],
          tags: [],
          links: [],
          notes: [],
        }),
      };
      const registry2 = new DefaultExtractorRegistry([...defaultExtractors(), override]);
      const path = await write("override.md", "# Real\n");
      assert.equal((await registry2.extract(path)).mediaType, "text/x-override");
    });
  });
});
