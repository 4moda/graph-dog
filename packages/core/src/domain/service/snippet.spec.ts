import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ELLIPSIS, bestSnippet, flatten } from "./snippet.ts";

describe("domain/service/snippet", () => {
  describe("flatten", () => {
    it("collapses newlines and runs of whitespace into single spaces", () => {
      assert.equal(flatten("one\n\n  two   three\n"), "one two three");
    });

    it("strips Markdown syntax", () => {
      assert.equal(flatten("## Title\n\n**bold** text"), "Title bold text");
    });

    it("returns empty for whitespace-only input", () => {
      assert.equal(flatten("  \n\t "), "");
    });
  });

  describe("bestSnippet", () => {
    it("returns short text whole, with no ellipsis", () => {
      const snippet = bestSnippet("a short chunk", "chunk", 320);
      assert.equal(snippet, "a short chunk");
      assert.doesNotMatch(snippet, new RegExp(ELLIPSIS));
    });

    it("centres the window on the query term rather than taking the head", () => {
      const text = `${"filler ".repeat(100)}THE-ANSWER ${"tail ".repeat(100)}`;
      const snippet = bestSnippet(text, "THE-ANSWER", 120);
      assert.ok(snippet.includes("THE-ANSWER"), snippet);
    });

    it("respects the length budget", () => {
      const text = "word ".repeat(500);
      const snippet = bestSnippet(text, "word", 100);
      assert.ok(snippet.replaceAll(ELLIPSIS, "").length <= 100, `got ${snippet.length}`);
    });

    it("marks truncation at both ends when the window is interior", () => {
      const text = `${"a ".repeat(200)}needle ${"b ".repeat(200)}`;
      const snippet = bestSnippet(text, "needle", 80);
      assert.ok(snippet.startsWith(ELLIPSIS), snippet);
      assert.ok(snippet.endsWith(ELLIPSIS), snippet);
    });

    it("prefers the densest cluster of matches", () => {
      const text = `${"x ".repeat(300)}token ${"y ".repeat(300)}token token token ${"z ".repeat(300)}`;
      const snippet = bestSnippet(text, "token", 120);
      const occurrences = snippet.split("token").length - 1;
      assert.ok(occurrences >= 2, `expected the dense cluster, got ${occurrences}: ${snippet}`);
    });

    it("falls back to the head when the query does not appear", () => {
      const text = `START ${"filler ".repeat(200)}`;
      const snippet = bestSnippet(text, "absent-term", 80);
      assert.ok(snippet.startsWith("START"), snippet);
      assert.ok(snippet.endsWith(ELLIPSIS));
    });

    it("falls back to the head for an empty query, as graph-reached hits have", () => {
      const text = `BEGIN ${"filler ".repeat(200)}`;
      assert.ok(bestSnippet(text, "", 80).startsWith("BEGIN"));
    });

    it("finds Japanese terms via the shared tokenizer", () => {
      const text = `${"あ".repeat(400)}アクセストークンの設計${"い".repeat(400)}`;
      const snippet = bestSnippet(text, "トークン", 100);
      assert.ok(snippet.includes("トークン"), snippet);
    });

    it("matches case-insensitively", () => {
      const text = `${"pad ".repeat(200)}JsonWebToken ${"pad ".repeat(200)}`;
      assert.ok(bestSnippet(text, "jsonwebtoken", 100).includes("JsonWebToken"));
    });

    it("returns empty for empty text", () => {
      assert.equal(bestSnippet("", "query"), "");
    });
  });
});
