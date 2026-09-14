import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { DEFAULT_CHUNKING, chunkText, chunkingFingerprint } from "./chunker.ts";
import type { ChunkingConfig, DraftChunk } from "./chunker.ts";

const sha256 = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex");

/** Re-extract each chunk from the original text via its recorded span. */
function spansRoundTrip(text: string, chunks: readonly DraftChunk[]): boolean {
  return chunks.every((chunk) => text.slice(chunk.location.startChar, chunk.location.endChar) === chunk.text);
}

/** Re-extract each chunk via its recorded 1-based inclusive line range. */
function linesContainChunk(text: string, chunks: readonly DraftChunk[]): boolean {
  const lines = text.split("\n");
  return chunks.every((chunk) => {
    const slice = lines.slice(chunk.location.startLine - 1, chunk.location.endLine).join("\n");
    return slice.includes(chunk.text.replace(/\n$/, ""));
  });
}

describe("domain/service/chunker", () => {
  describe("chunkingFingerprint", () => {
    it("is stable for the same configuration", () => {
      assert.equal(
        chunkingFingerprint(sha256, DEFAULT_CHUNKING),
        chunkingFingerprint(sha256, DEFAULT_CHUNKING),
      );
    });

    it("changes when any parameter changes, so corpora cannot be silently mixed", () => {
      const base = chunkingFingerprint(sha256, DEFAULT_CHUNKING);
      const variants: ChunkingConfig[] = [
        { ...DEFAULT_CHUNKING, maxChars: 1201 },
        { ...DEFAULT_CHUNKING, overlapChars: 161 },
        { ...DEFAULT_CHUNKING, minChars: 61 },
        { ...DEFAULT_CHUNKING, respectHeadings: false },
      ];
      for (const variant of variants) {
        assert.notEqual(chunkingFingerprint(sha256, variant), base);
      }
    });

    it("is namespaced so it cannot be confused with another hash", () => {
      assert.match(chunkingFingerprint(sha256, DEFAULT_CHUNKING), /^chunk1:[0-9a-f]{16}$/);
    });
  });

  describe("empty and trivial input", () => {
    it("produces no chunks for empty or whitespace-only text", () => {
      assert.deepEqual(chunkText(""), []);
      assert.deepEqual(chunkText("   \n\n  \t "), []);
    });

    it("produces a single chunk for a short document", () => {
      const chunks = chunkText("# Title\n\nA short body.\n");
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0]?.location.startLine, 1);
    });
  });

  describe("locations", () => {
    const text = "# Title\n\nintro paragraph\n\n## Section A\n\n" + "a line of content\n".repeat(120) + "\n## Section B\n\ntail content\n";
    const chunks = chunkText(text, { ...DEFAULT_CHUNKING, maxChars: 400 });

    it("produces spans that re-extract to exactly the chunk text", () => {
      assert.ok(spansRoundTrip(text, chunks), "startChar/endChar must reproduce the chunk");
    });

    it("produces line ranges that contain the chunk text", () => {
      assert.ok(linesContainChunk(text, chunks), "line range must cover the chunk");
    });

    it("numbers lines from 1", () => {
      assert.equal(chunks[0]?.location.startLine, 1);
    });

    it("never reports an end line before its start line", () => {
      for (const chunk of chunks) {
        assert.ok(chunk.location.endLine >= chunk.location.startLine);
      }
    });

    it("leaves page null for unpaginated text", () => {
      assert.equal(chunks[0]?.location.page, null);
    });

    it("numbers chunks consecutively from zero", () => {
      assert.deepEqual(
        chunks.map((c) => c.ordinal),
        chunks.map((_, i) => i),
      );
    });
  });

  describe("content preservation", () => {
    it("keeps a short trailing section instead of dropping it", () => {
      const text = "# Title\n\nintro\n\n## Big\n\n" + "filler line\n".repeat(200) + "\n## Tiny\n\nx\n";
      const chunks = chunkText(text, { ...DEFAULT_CHUNKING, maxChars: 400 });
      assert.ok(
        chunks.some((chunk) => chunk.text.includes("Tiny")),
        "a short final section must not be silently dropped",
      );
    });

    it("keeps every non-blank line of the document somewhere", () => {
      const text = "# A\n\nalpha\n\n## B\n\nbeta\n\n### C\n\ngamma\n";
      const chunks = chunkText(text, { ...DEFAULT_CHUNKING, maxChars: 200 });
      const joined = chunks.map((c) => c.text).join("\n");
      for (const token of ["alpha", "beta", "gamma", "# A", "## B", "### C"]) {
        assert.ok(joined.includes(token), `lost ${token}`);
      }
    });

    it("merges many tiny sections rather than emitting one chunk each", () => {
      const text = Array.from({ length: 10 }, (_, i) => `## H${i}\n\nx${i}\n`).join("\n");
      const chunks = chunkText(text);
      assert.ok(chunks.length < 10, `expected coalescing, got ${chunks.length} chunks`);
      const joined = chunks.map((c) => c.text).join("");
      for (let i = 0; i < 10; i += 1) assert.ok(joined.includes(`x${i}`), `lost x${i}`);
    });
  });

  describe("heading breadcrumbs", () => {
    const text = "# Design\n\nintro\n\n## Tokens\n\nbody\n\n### Rotation\n\ndetail\n\n## Keys\n\nmore\n";
    const chunks = chunkText(text, { ...DEFAULT_CHUNKING, minChars: 1 });

    it("nests headings into a breadcrumb", () => {
      const paths = chunks.map((c) => c.headingPath);
      assert.ok(paths.includes("Design > Tokens > Rotation"), paths.join(" | "));
    });

    it("pops back out when a sibling heading starts", () => {
      const paths = chunks.map((c) => c.headingPath);
      assert.ok(paths.includes("Design > Keys"), paths.join(" | "));
    });

    it("uses an empty breadcrumb for content before the first heading", () => {
      const preamble = chunkText("loose intro\n\n# Later\n\nbody\n", { ...DEFAULT_CHUNKING, minChars: 1 });
      assert.equal(preamble[0]?.headingPath, "");
    });

    it("treats the whole document as one section when headings are disabled", () => {
      const flat = chunkText(text, { ...DEFAULT_CHUNKING, respectHeadings: false });
      assert.ok(flat.every((chunk) => chunk.headingPath === ""));
    });
  });

  describe("windowing", () => {
    const text = "# T\n\n" + "line of content here\n".repeat(200);
    const config: ChunkingConfig = { ...DEFAULT_CHUNKING, maxChars: 500, overlapChars: 120 };
    const chunks = chunkText(text, config);

    it("splits long sections into several chunks", () => {
      assert.ok(chunks.length > 1);
    });

    it("respects the size ceiling", () => {
      for (const chunk of chunks) {
        assert.ok(chunk.text.length <= config.maxChars, `chunk of ${chunk.text.length} chars`);
      }
    });

    it("overlaps consecutive windows so boundary facts stay retrievable", () => {
      const overlapping = chunks
        .slice(1)
        .some((chunk, i) => chunk.location.startChar < (chunks[i]?.location.endChar ?? 0));
      assert.ok(overlapping, "consecutive windows must overlap");
    });

    it("covers the document end to end with no gap", () => {
      let reach = 0;
      for (const chunk of chunks) {
        assert.ok(chunk.location.startChar <= reach, "gap before this chunk");
        reach = Math.max(reach, chunk.location.endChar);
      }
      assert.equal(reach, text.length);
    });

    it("terminates on text with no line breaks at all", () => {
      const dense = chunkText("x".repeat(5000), { ...DEFAULT_CHUNKING, maxChars: 300 });
      assert.ok(dense.length > 1);
      assert.equal(dense[dense.length - 1]?.location.endChar, 5000);
    });
  });

  describe("paginated sources", () => {
    const page1 = "First page line.\nAnother line.\n";
    const page2 = "Second page line.\nMore text.\n";
    const text = page1 + page2;
    const pageBreaks: Array<readonly [number, number]> = [
      [0, 1],
      [page1.length, 2],
    ];
    const chunks = chunkText(text, { ...DEFAULT_CHUNKING, minChars: 1 }, pageBreaks);

    it("tags each chunk with its page", () => {
      assert.equal(chunks[0]?.location.page, 1);
      assert.equal(chunks[chunks.length - 1]?.location.page, 2);
    });

    it("never lets a chunk straddle a page boundary", () => {
      for (const chunk of chunks) {
        const crossesBreak = chunk.location.startChar < page1.length && chunk.location.endChar > page1.length;
        assert.ok(!crossesBreak, "a citation must belong to exactly one page");
      }
    });
  });

  describe("determinism", () => {
    it("produces identical chunks across runs", () => {
      const text = "# A\n\n" + "content line\n".repeat(90) + "\n## B\n\ntail\n";
      assert.deepEqual(chunkText(text), chunkText(text));
    });
  });
});
