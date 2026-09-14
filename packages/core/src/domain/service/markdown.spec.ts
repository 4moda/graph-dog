import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extractLinks,
  extractTags,
  firstHeading,
  headingOutline,
  normalizeNewlines,
  parseFrontMatter,
  sanitize,
  stripMarkdown,
} from "./markdown.ts";

describe("domain/service/markdown", () => {
  describe("sanitize", () => {
    it("removes control characters that break XML export", () => {
      assert.equal(sanitize(`a${String.fromCharCode(0)}b${String.fromCharCode(7)}c`), "abc");
    });

    it("preserves tab, newline and carriage return", () => {
      assert.equal(sanitize("a\tb\nc\rd"), "a\tb\nc\rd");
    });
  });

  describe("normalizeNewlines", () => {
    it("converts CRLF and lone CR to LF so line numbers are stable", () => {
      assert.equal(normalizeNewlines("a\r\nb\rc\nd"), "a\nb\nc\nd");
    });
  });

  describe("parseFrontMatter", () => {
    it("returns nothing when there is no front matter", () => {
      const result = parseFrontMatter("# Title\n\nbody\n");
      assert.deepEqual(result.fields, {});
      assert.equal(result.lineOffset, 0);
    });

    it("parses scalar fields", () => {
      const result = parseFrontMatter("---\ntitle: Access Token\n---\nbody\n");
      assert.equal(result.fields["title"], "Access Token");
    });

    it("parses inline arrays", () => {
      const result = parseFrontMatter("---\ntags: [auth, jwt]\n---\n");
      assert.deepEqual(result.fields["tags"], ["auth", "jwt"]);
    });

    it("parses block-style lists", () => {
      const result = parseFrontMatter("---\ntags:\n  - auth\n  - jwt\n---\n");
      assert.deepEqual(result.fields["tags"], ["auth", "jwt"]);
    });

    it("strips surrounding quotes", () => {
      const result = parseFrontMatter(`---\ntitle: "Quoted: Title"\n---\n`);
      assert.equal(result.fields["title"], "Quoted: Title");
    });

    it("reports how many lines it consumed so line numbers stay true", () => {
      const result = parseFrontMatter("---\ntitle: A\ntags: [x]\n---\nbody\n");
      assert.equal(result.lineOffset, 4);
    });

    it("ignores comments and blank lines", () => {
      const result = parseFrontMatter("---\n# a comment\n\ntitle: A\n---\n");
      assert.deepEqual(result.fields, { title: "A" });
    });

    it("only matches front matter at the very start of the document", () => {
      const result = parseFrontMatter("intro\n---\ntitle: A\n---\n");
      assert.deepEqual(result.fields, {});
    });
  });

  describe("extractLinks", () => {
    it("collects relative Markdown links", () => {
      assert.deepEqual(extractLinks("see [spec](designs/token.md)"), ["designs/token.md"]);
    });

    it("collects wiki links", () => {
      assert.deepEqual(extractLinks("see [[Access Token]]"), ["Access Token"]);
    });

    it("skips external URLs and bare anchors, which cannot resolve in-corpus", () => {
      const text = "[a](https://example.com) [b](mailto:x@y.z) [c](#section) [d](//cdn/x)";
      assert.deepEqual(extractLinks(text), []);
    });

    it("skips image embeds", () => {
      assert.deepEqual(extractLinks("![alt](diagram.png)"), []);
    });

    it("ignores links inside fenced code blocks", () => {
      const text = "```\n[not a link](fake.md)\n```\n[real](real.md)";
      assert.deepEqual(extractLinks(text), ["real.md"]);
    });

    it("de-duplicates while preserving document order", () => {
      assert.deepEqual(extractLinks("[a](x.md) [b](y.md) [c](x.md)"), ["x.md", "y.md"]);
    });
  });

  describe("extractTags", () => {
    it("takes front-matter tags first", () => {
      assert.deepEqual(extractTags("body", { tags: ["auth", "jwt"] }), ["auth", "jwt"]);
    });

    it("accepts a comma-separated front-matter string", () => {
      assert.deepEqual(extractTags("body", { tags: "auth, jwt" }), ["auth", "jwt"]);
    });

    it("collects inline hashtags", () => {
      assert.deepEqual(extractTags("about #auth and #jwt"), ["auth", "jwt"]);
    });

    it("collects Japanese hashtags", () => {
      assert.deepEqual(extractTags("#認証 の話"), ["認証"]);
    });

    it("collects a single-character tag", () => {
      assert.deepEqual(extractTags("#鍵 について"), ["鍵"]);
    });

    it("does not treat a URL fragment as a tag", () => {
      assert.deepEqual(extractTags("see https://example.com/page#section"), []);
    });

    it("ignores hashtags inside code fences", () => {
      assert.deepEqual(extractTags("```\n#ffffff\n```\n#real"), ["real"]);
    });

    it("ignores Markdown headings, which are not tags", () => {
      assert.deepEqual(extractTags("# Heading\n\ntext"), []);
    });

    it("does not double-count a tag present in both places", () => {
      assert.deepEqual(extractTags("text #auth", { tags: ["auth"] }), ["auth"]);
    });

    it("strips a leading hash from front-matter tags", () => {
      assert.deepEqual(extractTags("", { tags: ["#auth"] }), ["auth"]);
    });
  });

  describe("headingOutline", () => {
    it("records level, title and line index", () => {
      const lines = ["# One", "text", "## Two"];
      assert.deepEqual(headingOutline(lines), [
        { lineIndex: 0, level: 1, title: "One" },
        { lineIndex: 2, level: 2, title: "Two" },
      ]);
    });

    it("ignores headings inside code fences", () => {
      const lines = ["# Real", "```", "# Fake", "```", "## Also real"];
      assert.deepEqual(
        headingOutline(lines).map((h) => h.title),
        ["Real", "Also real"],
      );
    });

    it("strips closing hashes from closed ATX headings", () => {
      assert.equal(headingOutline(["## Title ##"])[0]?.title, "Title");
    });

    it("does not treat a hash without a space as a heading", () => {
      assert.deepEqual(headingOutline(["#nospace"]), []);
    });
  });

  describe("firstHeading", () => {
    it("returns the first heading", () => {
      assert.equal(firstHeading("# Access Token\n\nbody"), "Access Token");
    });

    it("looks past front matter", () => {
      assert.equal(firstHeading("---\ntitle: A\n---\n# Real Title\n"), "Real Title");
    });

    it("returns null when prose comes first", () => {
      assert.equal(firstHeading("intro text\n\n# Later"), null);
    });

    it("returns null when there is no heading", () => {
      assert.equal(firstHeading("just text"), null);
    });
  });

  describe("stripMarkdown", () => {
    it("flattens syntax for display", () => {
      const text = "# Title\n\n**bold** and *italic* and `code`";
      assert.equal(stripMarkdown(text), "Title\n\nbold and italic and code");
    });

    it("keeps link text and wiki-link aliases", () => {
      assert.equal(stripMarkdown("see [the spec](a.md) and [[Note|alias]]"), "see the spec and alias");
    });

    it("drops fenced code blocks", () => {
      assert.doesNotMatch(stripMarkdown("text\n```\nsecret()\n```\n"), /secret/);
    });

    it("removes list markers", () => {
      assert.equal(stripMarkdown("- one\n- two"), "one\ntwo");
    });
  });
});
