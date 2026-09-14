import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assessFreshness } from "./freshness.ts";

const BUILT_AT = "2026-09-14T00:00:00.000Z";

describe("domain/model/freshness", () => {
  it("reports unknown when the corpus has never been built", () => {
    const freshness = assessFreshness(null, []);
    assert.equal(freshness.status, "unknown");
    assert.equal(freshness.builtAt, null);
    assert.match(freshness.reason ?? "", /never been built/);
  });

  it("reports current when every revision matches", () => {
    const freshness = assessFreshness(BUILT_AT, [
      { sourceId: "docs", indexedRevision: "abc", currentRevision: "abc" },
    ]);
    assert.equal(freshness.status, "current");
    assert.equal(freshness.reason, null);
    assert.deepEqual(freshness.sourceRevisions, { docs: "abc" });
  });

  it("reports stale and names the drifted source", () => {
    const freshness = assessFreshness(BUILT_AT, [
      { sourceId: "docs", indexedRevision: "abc", currentRevision: "abc" },
      { sourceId: "spec", indexedRevision: "old", currentRevision: "new" },
    ]);
    assert.equal(freshness.status, "stale");
    assert.match(freshness.reason ?? "", /spec/);
    assert.doesNotMatch(freshness.reason ?? "", /docs/);
  });

  it("does not claim current for a source it cannot verify", () => {
    const freshness = assessFreshness(BUILT_AT, [
      { sourceId: "notes", indexedRevision: null, currentRevision: null },
    ]);
    assert.equal(freshness.status, "unknown");
    assert.match(freshness.reason ?? "", /no revision to compare/);
  });

  it("prefers reporting stale over unknown when both apply", () => {
    const freshness = assessFreshness(BUILT_AT, [
      { sourceId: "notes", indexedRevision: null, currentRevision: null },
      { sourceId: "spec", indexedRevision: "old", currentRevision: "new" },
    ]);
    assert.equal(freshness.status, "stale");
  });

  it("records indexed revisions even when reporting stale", () => {
    const freshness = assessFreshness(BUILT_AT, [
      { sourceId: "spec", indexedRevision: "old", currentRevision: "new" },
    ]);
    assert.deepEqual(freshness.sourceRevisions, { spec: "old" });
  });
});
