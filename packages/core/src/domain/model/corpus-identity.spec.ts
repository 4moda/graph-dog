import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHUNKING_SCHEMA_VERSION,
  SCHEMA_VERSION,
  checkIdentity,
  type CorpusIdentity,
} from "./corpus-identity.ts";

const CURRENT: CorpusIdentity = {
  schemaVersion: SCHEMA_VERSION,
  chunkingSchemaVersion: CHUNKING_SCHEMA_VERSION,
  embeddingId: "hash-v1:d256",
  chunkingFingerprint: "chunk1:abc123",
};

describe("domain/model/corpusIdentity", () => {
  it("accepts a corpus built by this version", () => {
    assert.equal(checkIdentity(CURRENT), null);
  });

  it("rejects an unsupported store schema", () => {
    const reason = checkIdentity({ ...CURRENT, schemaVersion: "99" });
    assert.equal(reason?.field, "schemaVersion");
    assert.equal(reason?.actual, "99");
    assert.match(reason?.message ?? "", /rebuild/);
  });

  it("rejects a corpus with no schema version at all", () => {
    const reason = checkIdentity({});
    assert.equal(reason?.field, "schemaVersion");
    assert.equal(reason?.actual, "<missing>");
  });

  it("rejects an incompatible chunking schema", () => {
    const reason = checkIdentity({ ...CURRENT, chunkingSchemaVersion: "0" });
    assert.equal(reason?.field, "chunkingSchemaVersion");
    assert.match(reason?.message ?? "", /line ranges/);
  });

  it("refuses to search vectors from a different embedding model", () => {
    const reason = checkIdentity(CURRENT, { embeddingId: "st:e5-small:d384:pdeadbeef" });
    assert.equal(reason?.field, "embeddingId");
    assert.equal(reason?.actual, "hash-v1:d256");
    assert.match(reason?.message ?? "", /not comparable/);
  });

  it("refuses to mix incompatible chunkings", () => {
    const reason = checkIdentity(CURRENT, { chunkingFingerprint: "chunk1:different" });
    assert.equal(reason?.field, "chunkingFingerprint");
    assert.match(reason?.message ?? "", /evidence locations/);
  });

  it("accepts the corpus's own identities when no expectation is given", () => {
    assert.equal(checkIdentity({ ...CURRENT, embeddingId: "anything" }), null);
  });

  it("checks the store schema before anything else", () => {
    const reason = checkIdentity(
      { ...CURRENT, schemaVersion: "99", embeddingId: "wrong" },
      { embeddingId: "right" },
    );
    assert.equal(reason?.field, "schemaVersion", "layout mismatch makes other checks moot");
  });
});
