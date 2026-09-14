import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLocation } from "../../domain/model/location.ts";
import { createScores } from "../../domain/model/scores.ts";
import { assessFreshness } from "../../domain/model/freshness.ts";
import type { GraphEdge } from "../../domain/model/graph.ts";
import {
  toEdgeDto,
  toFreshnessDto,
  toHitDto,
  toLocationDto,
  toScoresDto,
  toWarningDto,
  type HitView,
} from "./mappers.ts";

const location = createLocation({ startLine: 10, endLine: 24, startChar: 100, endChar: 500 });

function hit(overrides: Partial<HitView> = {}): HitView {
  return {
    ref: "docs/design/token.md",
    chunkId: "abc123",
    title: "Access Token",
    headingPath: "Design > Tokens",
    snippet: "Access tokens are JWTs...",
    location,
    scores: createScores({ final: 0.86, dense: 0.91, bm25: 0.78, graph: 0 }),
    sourceRevision: "deadbeef",
    graphPath: [],
    tags: ["auth"],
    ...overrides,
  };
}

describe("application/dto/mappers", () => {
  describe("toLocationDto", () => {
    it("emits snake_case keys in the documented order", () => {
      assert.deepEqual(Object.keys(toLocationDto(location)), [
        "start_line",
        "end_line",
        "start_char",
        "end_char",
      ]);
    });

    it("omits page for unpaginated sources so its presence is meaningful", () => {
      assert.ok(!("page" in toLocationDto(location)));
    });

    it("includes page for paginated sources", () => {
      const paged = createLocation({ ...location, page: 3 });
      assert.equal(toLocationDto(paged).page, 3);
    });
  });

  describe("toScoresDto", () => {
    it("rounds so identical inputs serialize identically", () => {
      const scores = createScores({ final: 0.123456789, dense: 0.987654321 });
      const dto = toScoresDto(scores);
      assert.equal(dto.final, 0.123457);
      assert.equal(dto.dense, 0.987654);
    });

    it("preserves null for a signal that did not run", () => {
      assert.equal(toScoresDto(createScores({ final: 1 })).bm25, null);
    });

    it("preserves an explicit zero", () => {
      assert.equal(toScoresDto(createScores({ final: 1, bm25: 0 })).bm25, 0);
    });

    it("never emits a null final", () => {
      assert.equal(toScoresDto(createScores({ final: Number.NaN })).final, 0);
    });
  });

  describe("toEdgeDto", () => {
    it("adds a human-readable relation so output needs no lookup table", () => {
      const edge: GraphEdge = { src: "doc:a", dst: "doc:b", kind: "links_to", weight: 1 };
      assert.equal(toEdgeDto(edge).relation, "links to");
    });
  });

  describe("toHitDto", () => {
    it("builds a read_ref that can be passed straight back to read", () => {
      assert.equal(toHitDto(hit()).read_ref, "docs/design/token.md#L10-L24");
    });

    it("builds a page-qualified read_ref for paginated sources", () => {
      const paged = hit({ location: createLocation({ ...location, page: 7 }) });
      assert.equal(toHitDto(paged).read_ref, "docs/design/token.md#p7L10-L24");
    });

    it("names the signal responsible for a direct hit", () => {
      assert.equal(toHitDto(hit()).found_by, "dense");
    });

    it("reports graph provenance when the hit was reached by expansion", () => {
      const viaGraph = hit({
        graphPath: [{ src: "doc:a", dst: "doc:b", kind: "links_to", weight: 1 }],
        scores: createScores({ final: 0.3, dense: 0, bm25: 0, graph: 0.9 }),
      });
      const dto = toHitDto(viaGraph);
      assert.equal(dto.found_by, "graph");
      assert.equal(dto.graph_path.length, 1);
      assert.equal(dto.graph_path[0]?.relation, "links to");
    });

    it("emits the documented top-level key order", () => {
      assert.deepEqual(Object.keys(toHitDto(hit())), [
        "ref",
        "chunk_id",
        "title",
        "heading_path",
        "snippet",
        "location",
        "scores",
        "found_by",
        "graph_path",
        "source_revision",
        "tags",
        "read_ref",
      ]);
    });

    it("copies tags rather than aliasing the domain object", () => {
      const source = hit();
      const dto = toHitDto(source);
      assert.notEqual(dto.tags, source.tags);
      assert.deepEqual(dto.tags, source.tags);
    });
  });

  describe("toFreshnessDto", () => {
    it("passes status, timestamp and reason through", () => {
      const freshness = assessFreshness("2026-09-14T00:00:00.000Z", [
        { sourceId: "docs", indexedRevision: "old", currentRevision: "new" },
      ]);
      const dto = toFreshnessDto(freshness);
      assert.equal(dto.status, "stale");
      assert.equal(dto.built_at, "2026-09-14T00:00:00.000Z");
      assert.match(dto.reason ?? "", /docs/);
    });
  });

  describe("toWarningDto", () => {
    it("always emits a details object, never undefined", () => {
      assert.deepEqual(toWarningDto({ code: "x", message: "y" }).details, {});
    });
  });
});
