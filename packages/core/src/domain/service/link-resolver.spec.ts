import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LinkResolver } from "./link-resolver.ts";

const refs = [
  "docs/index.md",
  "docs/design/token.md",
  "docs/design/keys.md",
  "docs/guide/setup.md",
  "other/token.md",
];

describe("domain/service/linkResolver", () => {
  const resolver = new LinkResolver(refs);

  it("resolves a sibling relative link", () => {
    assert.equal(resolver.resolve("docs/design/token.md", "keys.md"), "docs/design/keys.md");
  });

  it("resolves a parent-relative link", () => {
    assert.equal(resolver.resolve("docs/design/token.md", "../guide/setup.md"), "docs/guide/setup.md");
  });

  it("resolves an explicit './' link", () => {
    assert.equal(resolver.resolve("docs/design/token.md", "./keys.md"), "docs/design/keys.md");
  });

  it("resolves a root-relative link against the source", () => {
    assert.equal(resolver.resolve("docs/index.md", "/design/keys.md"), "docs/design/keys.md");
  });

  it("adds a missing Markdown extension", () => {
    assert.equal(resolver.resolve("docs/design/token.md", "keys"), "docs/design/keys.md");
  });

  it("resolves a wiki title by stem", () => {
    assert.equal(resolver.resolve("docs/index.md", "setup"), "docs/guide/setup.md");
  });

  it("ignores a trailing anchor", () => {
    assert.equal(resolver.resolve("docs/design/token.md", "keys.md#rotation"), "docs/design/keys.md");
  });

  it("returns null for a target that does not exist", () => {
    assert.equal(resolver.resolve("docs/index.md", "nonexistent.md"), null);
  });

  it("returns null for an empty target", () => {
    assert.equal(resolver.resolve("docs/index.md", ""), null);
    assert.equal(resolver.resolve("docs/index.md", "#anchor"), null);
  });

  describe("ambiguity", () => {
    it("prefers a same-source match when a bare name is ambiguous across sources", () => {
      assert.equal(resolver.resolve("docs/index.md", "token.md"), "docs/design/token.md");
      assert.equal(resolver.resolve("other/token.md", "token.md"), "other/token.md");
    });

    it("refuses to guess when a bare name is ambiguous within one source", () => {
      const ambiguous = new LinkResolver(["docs/a/note.md", "docs/b/note.md"]);
      assert.equal(
        ambiguous.resolve("docs/index.md", "note.md"),
        null,
        "a wrong edge is worse than a missing one",
      );
    });
  });

  it("prefers an exact relative path over a same-named file elsewhere", () => {
    const resolver2 = new LinkResolver(["docs/a/note.md", "docs/b/note.md"]);
    assert.equal(resolver2.resolve("docs/a/other.md", "note.md"), "docs/a/note.md");
  });

  it("handles an empty corpus without throwing", () => {
    assert.equal(new LinkResolver([]).resolve("docs/a.md", "b.md"), null);
  });
});
