import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { ExtractionError } from "../../domain/errors.ts";
import { DefaultExtractorRegistry } from "./extractor-registry.ts";
import { TextExtractor } from "./text-extractor.ts";

let root: string;
const extractor = new TextExtractor();

before(async () => {
  root = await mkdtemp(join(tmpdir(), "graphdog-extract-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(name: string, content: string | Buffer): Promise<string> {
  const path = join(root, name);
  await writeFile(path, content);
  return path;
}

describe("infrastructure/extraction/textExtractor", () => {
  it("reads Markdown and reports its media type", async () => {
    const path = await write("a.md", "# Title\n\nbody text\n");
    const result = await extractor.extract(path);
    assert.equal(result.mediaType, "text/markdown");
    assert.equal(result.text, "# Title\n\nbody text\n");
  });

  it("prefers the front-matter title", async () => {
    const path = await write("b.md", "---\ntitle: Declared Title\n---\n# Heading\n");
    assert.equal((await extractor.extract(path)).title, "Declared Title");
  });

  it("falls back to the first heading", async () => {
    const path = await write("c.md", "# Heading Title\n\nbody\n");
    assert.equal((await extractor.extract(path)).title, "Heading Title");
  });

  it("falls back to the filename stem", async () => {
    const path = await write("no-heading.md", "just body text\n");
    assert.equal((await extractor.extract(path)).title, "no-heading");
  });

  it("collects tags and links from Markdown", async () => {
    const path = await write("d.md", "---\ntags: [auth]\n---\nsee [spec](other.md) #jwt\n");
    const result = await extractor.extract(path);
    assert.deepEqual(result.tags, ["auth", "jwt"]);
    assert.deepEqual(result.links, ["other.md"]);
  });

  it("does not harvest links or tags from source code", async () => {
    const path = await write("code.ts", "// see [thing](x.md) and #hash\nconst a = 1;\n");
    const result = await extractor.extract(path);
    assert.deepEqual(result.tags, []);
    assert.deepEqual(result.links, []);
    assert.equal(result.mediaType, "text/plain");
  });

  it("normalizes CRLF so stored line numbers match an editor", async () => {
    const path = await write("crlf.md", "line one\r\nline two\r\n");
    assert.equal((await extractor.extract(path)).text, "line one\nline two\n");
  });

  it("strips a UTF-8 byte order mark", async () => {
    const path = await write("bom.md", "﻿# Title\n");
    assert.equal((await extractor.extract(path)).text, "# Title\n");
  });

  it("preserves Japanese text exactly", async () => {
    const content = "# アクセストークン\n\n認証の設計方針\n";
    const path = await write("ja.md", content);
    assert.equal((await extractor.extract(path)).text, content);
  });

  it("decodes Shift-JIS and says that it did", async () => {
    // "日本語" in Shift-JIS.
    const path = await write("sjis.txt", Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]));
    const result = await extractor.extract(path);
    assert.equal(result.text, "日本語");
    assert.ok(result.notes.some((note) => note.includes("shift_jis")));
  });

  it("reports an unreadable file as an extraction error", async () => {
    await assert.rejects(() => extractor.extract(join(root, "missing.md")), ExtractionError);
  });

  it("returns no page breaks for unpaginated text", async () => {
    const path = await write("plain.md", "body\n");
    assert.deepEqual((await extractor.extract(path)).pageBreaks, []);
  });
});

describe("infrastructure/extraction/extractorRegistry", () => {
  const registry = new DefaultExtractorRegistry();

  it("advertises the extensions it can read", () => {
    const extensions = registry.supportedExtensions();
    assert.ok(extensions.has(".md"));
    assert.ok(extensions.has(".pdf"));
    assert.ok(!extensions.has(".png"));
  });

  it("dispatches Markdown to the text extractor", async () => {
    const path = await write("registry.md", "# Title\n");
    assert.equal((await registry.extract(path)).mediaType, "text/markdown");
  });

  it("reads an unknown but textual file as text rather than dropping it", async () => {
    const path = await write("notes.unknownext", "still readable content\n");
    const result = await registry.extract(path);
    assert.match(result.text, /still readable/);
  });

  it("refuses an unknown binary file, naming the type", async () => {
    const path = await write("blob.bin", Buffer.from([0x00, 0x01, 0x02, 0x00]));
    await assert.rejects(
      () => registry.extract(path),
      (error: unknown) => {
        assert.ok(error instanceof ExtractionError);
        assert.match(error.message, /binary/);
        return true;
      },
    );
  });

  it("reports a missing optional dependency instead of crashing", async () => {
    const path = await write("doc.pdf", Buffer.from("%PDF-1.4\n"));
    await assert.rejects(() => registry.extract(path), ExtractionError);
  });
});
