import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  SILENT_LOGGER_FOR_TESTS as logger,
  buildFixtureCorpus,
} from "./__fixtures__/corpus-fixture.ts";
import { createServer } from "./stdio-server.ts";

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "graphdog-mcp-"));
  await buildFixtureCorpus(root);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function connect(allowWrite = false): Promise<Client> {
  const server = createServer({ cwd: root, logger, defaultCorpus: undefined, allowWrite });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

type StructuredResult = { structuredContent?: Record<string, unknown>; isError?: boolean; content?: unknown };

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<StructuredResult> {
  return (await client.callTool({ name, arguments: args })) as StructuredResult;
}

describe("mcp/stdio-server", () => {
  describe("tool listing", () => {
    it("advertises the read-only tools", async () => {
      const client = await connect();
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, ["explore", "list_corpora", "read", "search", "status"]);
      await client.close();
    });

    it("hides write tools unless the server allows writes", async () => {
      const client = await connect(false);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      assert.ok(!names.includes("build_corpus"), "an agent must not be able to rewrite the corpus");
      await client.close();
    });

    it("exposes build_corpus when writes are enabled", async () => {
      const client = await connect(true);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      assert.ok(names.includes("build_corpus"));
      await client.close();
    });

    it("marks read tools as read-only for the host", async () => {
      const client = await connect();
      const search = (await client.listTools()).tools.find((tool) => tool.name === "search");
      assert.equal(search?.annotations?.readOnlyHint, true);
      await client.close();
    });

    it("documents every tool and gives it an input schema", async () => {
      const client = await connect(true);
      for (const tool of (await client.listTools()).tools) {
        assert.ok((tool.description ?? "").length > 40, `${tool.name} needs a usable description`);
        assert.equal(tool.inputSchema.type, "object", `${tool.name} needs an object schema`);
      }
      await client.close();
    });
  });

  describe("search", () => {
    it("returns hits as structured content", async () => {
      const client = await connect();
      const result = await call(client, "search", { query: "JWKS" });
      const payload = result.structuredContent as { kind: string; hits: unknown[] };
      assert.equal(payload.kind, "search");
      assert.ok(payload.hits.length > 0);
      await client.close();
    });

    it("gives every hit a re-readable ref and a score breakdown", async () => {
      const client = await connect();
      const result = await call(client, "search", { query: "JWKS" });
      const hit = (result.structuredContent as { hits: Array<Record<string, unknown>> }).hits[0];
      assert.ok(typeof hit?.["read_ref"] === "string");
      assert.ok(typeof hit?.["found_by"] === "string");
      const location = hit?.["location"] as { start_line: number };
      assert.ok(location.start_line >= 1);
      await client.close();
    });

    it("reports 'no evidence' as a normal result, not an error", async () => {
      const client = await connect();
      const result = await call(client, "search", { query: "quantum chromodynamics" });
      assert.notEqual(result.isError, true, "an empty result must not read as a failure");
      const payload = result.structuredContent as { hits: unknown[]; warnings: Array<{ code: string }> };
      assert.equal(payload.hits.length, 0);
      assert.ok(payload.warnings.some((warning) => warning.code === "no_sufficient_evidence"));
      await client.close();
    });

    it("rejects a missing query with a usable message", async () => {
      const client = await connect();
      const result = await call(client, "search", {});
      assert.equal(result.isError, true);
      const error = (result.structuredContent as { error: { message: string } }).error;
      assert.match(error.message, /query/);
      await client.close();
    });

    it("honours top_k", async () => {
      const client = await connect();
      const result = await call(client, "search", { query: "rotation keys token", top_k: 1 });
      assert.equal((result.structuredContent as { hits: unknown[] }).hits.length, 1);
      await client.close();
    });
  });

  describe("explore", () => {
    it("returns the graph neighbourhood alongside the hits", async () => {
      const client = await connect();
      const result = await call(client, "explore", { query: "JWKS" });
      const payload = result.structuredContent as { kind: string; nodes: unknown[]; edges: unknown[] };
      assert.equal(payload.kind, "explore");
      assert.ok(payload.nodes.length > 0);
      assert.ok(payload.edges.length > 0);
      await client.close();
    });
  });

  describe("read", () => {
    it("returns the verbatim text for a ref from a search hit", async () => {
      const client = await connect();
      const search = await call(client, "search", { query: "JWKS" });
      const hit = (search.structuredContent as { hits: Array<Record<string, unknown>> }).hits[0];
      const readRef = hit?.["read_ref"] as string;

      const result = await call(client, "read", { ref: readRef });
      const payload = result.structuredContent as { kind: string; text: string; truncated: boolean };
      assert.equal(payload.kind, "read");
      assert.ok(payload.text.length > 0);
      assert.equal(payload.truncated, false);
      await client.close();
    });

    it("reports a missing ref as a tool error with a code", async () => {
      const client = await connect();
      const result = await call(client, "read", { ref: "docs/nope.md" });
      assert.equal(result.isError, true);
      const error = (result.structuredContent as { error: { code: string } }).error;
      assert.equal(error.code, "ref_not_found");
      await client.close();
    });
  });

  describe("status and list_corpora", () => {
    it("reports corpus health", async () => {
      const client = await connect();
      const result = await call(client, "status");
      const payload = result.structuredContent as { kind: string; compatible: boolean; counts: Record<string, number> };
      assert.equal(payload.kind, "corpus_info");
      assert.equal(payload.compatible, true);
      assert.ok((payload.counts["documents"] ?? 0) > 0);
      await client.close();
    });

    it("lists the corpora it can see", async () => {
      const client = await connect();
      const result = await call(client, "list_corpora");
      const payload = result.structuredContent as { corpora: Array<{ name: string }> };
      assert.ok(payload.corpora.some((entry) => entry.name === "demo"));
      await client.close();
    });
  });

  describe("write protection", () => {
    it("refuses build_corpus on a read-only server", async () => {
      const client = await connect(false);
      const result = await call(client, "build_corpus", {});
      assert.equal(result.isError, true);
      const error = (result.structuredContent as { error: { message: string } }).error;
      assert.match(error.message, /read-only/);
      await client.close();
    });

    it("allows build_corpus when writes are enabled", async () => {
      const client = await connect(true);
      const result = await call(client, "build_corpus", {});
      assert.notEqual(result.isError, true);
      assert.equal((result.structuredContent as { kind: string }).kind, "build_report");
      await client.close();
    });
  });

  describe("unknown tools", () => {
    it("reports an unknown tool without killing the connection", async () => {
      const client = await connect();
      const result = await call(client, "not_a_tool", {});
      assert.equal(result.isError, true);
      // The session must survive: a bad call is data, not a transport failure.
      const follow = await call(client, "status");
      assert.notEqual(follow.isError, true);
      await client.close();
    });
  });

  describe("text content", () => {
    it("summarizes results for text-only clients and points at the payload", async () => {
      const client = await connect();
      const result = await call(client, "search", { query: "JWKS" });
      const content = result.content as Array<{ type: string; text: string }>;
      assert.equal(content[0]?.type, "text");
      assert.match(content[0]?.text ?? "", /structured content/);
      await client.close();
    });
  });
});

describe("CLI/MCP equivalence", () => {
  /**
   * The guarantee that matters most: an agent and a human must be looking at
   * the same result. Both paths call the same use case through the same
   * mappers, and this pins that down rather than trusting it.
   */
  it("returns exactly what the CLI's --json mode returns", async () => {
    const { runSearchForTest } = await import("./__fixtures__/cli-bridge.ts");

    const client = await connect();
    const viaMcp = (await call(client, "search", { query: "JWKS", top_k: 5 })).structuredContent;
    await client.close();

    const viaCli = await runSearchForTest(root, ["JWKS", "--top-k", "5"]);

    // Timing varies between runs; everything else must match byte for byte.
    assert.deepEqual(withoutTiming(viaMcp), withoutTiming(viaCli));
  });

  it("returns identical read output on both paths", async () => {
    const { runReadForTest } = await import("./__fixtures__/cli-bridge.ts");

    const client = await connect();
    const viaMcp = (await call(client, "read", { ref: "docs/keys.md" })).structuredContent;
    await client.close();

    const viaCli = await runReadForTest(root, ["docs/keys.md"]);
    assert.deepEqual(viaMcp, viaCli);
  });
});

function withoutTiming(payload: unknown): unknown {
  const copy = structuredClone(payload) as Record<string, unknown>;
  const stats = copy["stats"] as Record<string, unknown> | undefined;
  if (stats !== undefined) delete stats["elapsed_ms"];
  return copy;
}
