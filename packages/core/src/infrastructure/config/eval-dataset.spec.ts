import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { ConfigError } from "../../domain/errors.ts";
import { DEFAULT_GRADE, DATASET_VERSION, loadEvalDataset, parseEvalDataset } from "./eval-dataset.ts";

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "graphdog-dataset-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const minimal = { queries: [{ query: "JWKS", relevant: ["docs/keys.md"] }] };

describe("infrastructure/config/evalDataset", () => {
  describe("parsing", () => {
    it("accepts a minimal dataset", () => {
      const dataset = parseEvalDataset(minimal);
      assert.equal(dataset.queries.length, 1);
      assert.equal(dataset.queries[0]?.query, "JWKS");
    });

    it("accepts a bare string as a relevance judgment", () => {
      const dataset = parseEvalDataset(minimal);
      assert.deepEqual(dataset.queries[0]?.judgments, [
        { ref: "docs/keys.md", grade: DEFAULT_GRADE },
      ]);
    });

    it("accepts a graded judgment", () => {
      const dataset = parseEvalDataset({
        queries: [{ query: "q", relevant: [{ ref: "a.md", grade: 3 }] }],
      });
      assert.equal(dataset.queries[0]?.judgments[0]?.grade, 3);
    });

    it("defaults query ids by position, so a small dataset need not name them", () => {
      const dataset = parseEvalDataset({ queries: [{ query: "a" }, { query: "b" }] });
      assert.deepEqual(dataset.queries.map((q) => q.id), ["q1", "q2"]);
    });

    it("keeps explicit ids, which is how a regression names what got worse", () => {
      const dataset = parseEvalDataset({ queries: [{ id: "jwks-rotation", query: "a" }] });
      assert.equal(dataset.queries[0]?.id, "jwks-rotation");
    });

    it("carries the corpus and description", () => {
      const dataset = parseEvalDataset({ ...minimal, corpus: "docs", description: "auth docs" });
      assert.equal(dataset.corpus, "docs");
      assert.equal(dataset.description, "auth docs");
    });

    it("carries a per-query note", () => {
      const dataset = parseEvalDataset({
        queries: [{ query: "q", note: "tests paraphrase recall" }],
      });
      assert.equal(dataset.queries[0]?.note, "tests paraphrase recall");
    });

    it("allows a query with no judgments, which measures latency only", () => {
      const dataset = parseEvalDataset({ queries: [{ query: "unjudged" }] });
      assert.deepEqual(dataset.queries[0]?.judgments, []);
    });
  });

  describe("line ranges", () => {
    function judgment(lines: unknown) {
      return parseEvalDataset({ queries: [{ query: "q", relevant: [{ ref: "a.md", lines }] }] })
        .queries[0]?.judgments[0];
    }

    it('parses "12-28"', () => {
      assert.equal(judgment("12-28")?.startLine, 12);
      assert.equal(judgment("12-28")?.endLine, 28);
    });

    it('parses a single line as "12"', () => {
      assert.equal(judgment("12")?.startLine, 12);
      assert.equal(judgment("12")?.endLine, 12);
    });

    it("parses a number", () => {
      assert.equal(judgment(7)?.startLine, 7);
      assert.equal(judgment(7)?.endLine, 7);
    });

    it("parses a [start, end] pair", () => {
      assert.equal(judgment([3, 9])?.startLine, 3);
      assert.equal(judgment([3, 9])?.endLine, 9);
    });

    it("omits the span when none was given", () => {
      assert.equal(judgment(undefined)?.startLine, undefined);
    });

    it("rejects a malformed range", () => {
      assert.throws(() => judgment("twelve"), ConfigError);
      assert.throws(() => judgment({}), ConfigError);
      assert.throws(() => judgment([1, 2, 3]), ConfigError);
    });

    it("rejects a range that ends before it starts", () => {
      assert.throws(() => judgment("28-12"), ConfigError);
    });

    it("rejects line 0, since lines are 1-based", () => {
      assert.throws(() => judgment("0-5"), ConfigError);
    });
  });

  describe("validation", () => {
    it("rejects a dataset with no queries", () => {
      assert.throws(() => parseEvalDataset({ queries: [] }), ConfigError);
    });

    it("rejects queries that are not an array", () => {
      assert.throws(() => parseEvalDataset({ queries: {} }), ConfigError);
    });

    it("rejects an empty query string", () => {
      assert.throws(() => parseEvalDataset({ queries: [{ query: "   " }] }), ConfigError);
    });

    it("rejects a duplicate query id", () => {
      // Ids are how a report points at the query that regressed; a duplicate
      // would make that report ambiguous.
      assert.throws(
        () => parseEvalDataset({ queries: [{ id: "a", query: "x" }, { id: "a", query: "y" }] }),
        ConfigError,
      );
    });

    it("rejects an empty ref", () => {
      assert.throws(
        () => parseEvalDataset({ queries: [{ query: "q", relevant: [{ ref: "" }] }] }),
        ConfigError,
      );
    });

    it("rejects a grade outside 0-3", () => {
      for (const grade of [-1, 4, 1.5]) {
        assert.throws(
          () => parseEvalDataset({ queries: [{ query: "q", relevant: [{ ref: "a.md", grade }] }] }),
          ConfigError,
          `grade ${grade} should be rejected`,
        );
      }
    });

    it("names the exact entry that is wrong", () => {
      assert.throws(
        () => parseEvalDataset({ queries: [{ query: "ok" }, { query: "" }] }),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, /queries\[1\]\.query/);
          return true;
        },
      );
    });

    it("rejects a dataset from a newer GraphDog", () => {
      assert.throws(
        () => parseEvalDataset({ ...minimal, version: DATASET_VERSION + 1 }),
        ConfigError,
      );
    });
  });

  describe("file IO", () => {
    it("loads a dataset from disk", async () => {
      const path = join(root, "dataset.json");
      await writeFile(path, JSON.stringify(minimal), "utf8");
      assert.equal((await loadEvalDataset(path)).queries.length, 1);
    });

    it("reports a missing file clearly", async () => {
      await assert.rejects(() => loadEvalDataset(join(root, "absent.json")), ConfigError);
    });

    it("reports malformed JSON with the path", async () => {
      const path = join(root, "broken.json");
      await writeFile(path, "{ not json", "utf8");
      await assert.rejects(
        () => loadEvalDataset(path),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, /broken\.json/);
          return true;
        },
      );
    });
  });
});
