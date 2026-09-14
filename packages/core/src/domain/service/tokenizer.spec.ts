import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isCjk, termFrequencies, tokenize } from "./tokenizer.ts";

describe("domain/service/tokenizer", () => {
  it("returns nothing for empty input", () => {
    assert.deepEqual(tokenize(""), []);
    assert.deepEqual(tokenize("   \n\t "), []);
  });

  it("lowercases and splits Latin words on punctuation", () => {
    assert.deepEqual(tokenize("JWT, JWKS."), ["jwt", "jwks"]);
  });

  it("keeps digits and underscores as part of a term", () => {
    assert.deepEqual(tokenize("ES256 max_age"), ["es256", "max_age"]);
  });

  describe("identifiers", () => {
    it("splits camelCase and also keeps the whole identifier", () => {
      assert.deepEqual(tokenize("getUserToken"), ["get", "user", "token", "getusertoken"]);
    });

    it("splits an acronym prefix correctly", () => {
      assert.deepEqual(tokenize("JWTParser"), ["jwt", "parser", "jwtparser"]);
    });

    it("does not add a joined form for a single-piece identifier", () => {
      assert.deepEqual(tokenize("token"), ["token"]);
    });
  });

  describe("CJK", () => {
    it("emits character bigrams for a multi-character run", () => {
      assert.deepEqual(tokenize("認証設計"), ["認証", "証設", "設計"]);
    });

    it("keeps a single character as a unigram so short queries match", () => {
      assert.deepEqual(tokenize("鍵"), ["鍵"]);
    });

    it("handles katakana", () => {
      assert.deepEqual(tokenize("トークン"), ["トー", "ーク", "クン"]);
    });

    it("separates CJK runs from Latin runs", () => {
      assert.deepEqual(tokenize("JWT認証"), ["jwt", "認証"]);
    });

    it("lets a query bigram match a document bigram", () => {
      const document = new Set(tokenize("アクセストークンの設計方針"));
      const query = tokenize("トークン");
      assert.ok(query.every((term) => document.has(term)), "query bigrams must be a subset");
    });
  });

  describe("normalization", () => {
    it("folds fullwidth characters to their halfwidth form", () => {
      assert.deepEqual(tokenize("ＪＷＴ"), tokenize("JWT"));
    });

    it("folds halfwidth katakana to fullwidth", () => {
      assert.deepEqual(tokenize("ｱｸｾｽ"), tokenize("アクセス"));
    });
  });

  it("is deterministic across repeated calls", () => {
    const input = "OAuth2 の DelegationCode は 認証 に使う";
    assert.deepEqual(tokenize(input), tokenize(input));
  });

  it("does not leak regex state between calls", () => {
    const first = tokenize("alpha beta gamma");
    const second = tokenize("alpha beta gamma");
    assert.deepEqual(first, second);
  });

  describe("isCjk", () => {
    it("recognizes kana and ideographs", () => {
      assert.ok(isCjk("あ".codePointAt(0)!));
      assert.ok(isCjk("ア".codePointAt(0)!));
      assert.ok(isCjk("漢".codePointAt(0)!));
    });

    it("rejects Latin and punctuation", () => {
      assert.ok(!isCjk("a".codePointAt(0)!));
      assert.ok(!isCjk("、".codePointAt(0)!));
    });
  });

  describe("termFrequencies", () => {
    it("counts repeats", () => {
      const counts = termFrequencies("token token jwt");
      assert.equal(counts.get("token"), 2);
      assert.equal(counts.get("jwt"), 1);
    });

    it("is empty for empty input", () => {
      assert.equal(termFrequencies("").size, 0);
    });
  });
});
