import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { RefNotFoundError, UsageError } from "@graphdog/core";

import {
  SILENT_LOGGER_FOR_TESTS as logger,
  buildFixtureCorpus,
} from "../../infrastructure/__fixtures__/corpus-fixture.ts";
import {
  handleBuild,
  handleExplore,
  handleListCorpora,
  handleRead,
  handleSearch,
  handleStatus,
  type HandlerContext,
} from "./tool-handlers.ts";

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "graphdog-handlers-"));
  await buildFixtureCorpus(root);
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

function context(allowWrite = false): HandlerContext {
  return { cwd: root, logger, defaultCorpus: undefined, allowWrite };
}

describe("mcp/application/tools/toolHandlers", () => {
  describe("argument validation", () => {
    it("requires a non-empty query", async () => {
      await assert.rejects(() => handleSearch({}, context()), UsageError);
      await assert.rejects(() => handleSearch({ query: "   " }, context()), UsageError);
    });

    it("rejects a non-string query", async () => {
      await assert.rejects(() => handleSearch({ query: 42 }, context()), UsageError);
    });

    it("rejects a non-numeric top_k rather than coercing it", async () => {
      await assert.rejects(
        () => handleSearch({ query: "JWKS", top_k: "five" }, context()),
        UsageError,
      );
    });

    it("rejects a non-boolean rerank flag", async () => {
      await assert.rejects(
        () => handleSearch({ query: "JWKS", rerank: "yes" }, context()),
        UsageError,
      );
    });

    it("rejects a sources filter that is not an array of ids", async () => {
      await assert.rejects(
        () => handleSearch({ query: "JWKS", sources: "docs" }, context()),
        UsageError,
      );
    });

    it("requires a ref for read", async () => {
      await assert.rejects(() => handleRead({}, context()), UsageError);
    });
  });

  describe("search", () => {
    it("returns the search contract", async () => {
      const outcome = await handleSearch({ query: "JWKS" }, context());
      const payload = outcome.payload as { kind: string; hits: unknown[] };
      assert.equal(payload.kind, "search");
      assert.ok(payload.hits.length > 0);
    });

    it("marks an empty result as empty rather than failing", async () => {
      const outcome = await handleSearch({ query: "quantum chromodynamics" }, context());
      assert.equal(outcome.empty, true);
    });

    it("honours top_k", async () => {
      const outcome = await handleSearch({ query: "token keys rotation", top_k: 1 }, context());
      assert.equal((outcome.payload as { hits: unknown[] }).hits.length, 1);
    });

    it("filters by source id", async () => {
      const outcome = await handleSearch({ query: "token", sources: ["docs"] }, context());
      const hits = (outcome.payload as { hits: Array<{ ref: string }> }).hits;
      assert.ok(hits.every((hit) => hit.ref.startsWith("docs/")));
    });
  });

  describe("explore", () => {
    it("returns nodes and edges", async () => {
      const outcome = await handleExplore({ query: "JWKS" }, context());
      const payload = outcome.payload as { kind: string; nodes: unknown[] };
      assert.equal(payload.kind, "explore");
      assert.ok(payload.nodes.length > 0);
    });
  });

  describe("read", () => {
    it("returns verbatim text", async () => {
      const outcome = await handleRead({ ref: "docs/keys.md" }, context());
      const payload = outcome.payload as { text: string; truncated: boolean };
      assert.match(payload.text, /JWKS/);
      assert.equal(payload.truncated, false);
    });

    it("honours a line range", async () => {
      const outcome = await handleRead(
        { ref: "docs/keys.md", start_line: 6, end_line: 6 },
        context(),
      );
      const location = (outcome.payload as { location: { start_line: number } }).location;
      assert.equal(location.start_line, 6);
    });

    it("throws a typed error for an unknown ref", async () => {
      await assert.rejects(() => handleRead({ ref: "docs/nope.md" }, context()), RefNotFoundError);
    });
  });

  describe("status and list_corpora", () => {
    it("describes the corpus", async () => {
      const outcome = await handleStatus({}, context());
      const payload = outcome.payload as { kind: string; compatible: boolean };
      assert.equal(payload.kind, "corpus_info");
      assert.equal(payload.compatible, true);
    });

    it("lists corpora", async () => {
      const outcome = await handleListCorpora({}, context());
      const payload = outcome.payload as { corpora: Array<{ name: string }> };
      assert.ok(payload.corpora.some((entry) => entry.name === "demo"));
    });
  });

  describe("write protection", () => {
    it("refuses to build on a read-only server", async () => {
      await assert.rejects(
        () => handleBuild({}, context(false)),
        (error: unknown) => {
          assert.ok(error instanceof UsageError);
          assert.match(error.message, /read-only/);
          return true;
        },
      );
    });

    it("builds when writes are enabled", async () => {
      const outcome = await handleBuild({}, context(true));
      assert.equal((outcome.payload as { kind: string }).kind, "build_report");
    });
  });
});
