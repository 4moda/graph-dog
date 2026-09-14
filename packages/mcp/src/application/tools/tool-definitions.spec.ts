import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  toolsFor,
  type ToolDefinition,
} from "./tool-definitions.ts";

const ALL: readonly ToolDefinition[] = [...READ_ONLY_TOOLS, ...WRITE_TOOLS];

describe("mcp/application/tools/toolDefinitions", () => {
  describe("permission separation", () => {
    it("defaults to read-only", () => {
      assert.deepEqual(
        toolsFor(false).map((tool) => tool.name).sort(),
        ["explore", "list_corpora", "read", "search", "status"],
      );
    });

    it("adds write tools only when writes are enabled", () => {
      assert.ok(toolsFor(true).some((tool) => tool.name === "build_corpus"));
      assert.ok(!toolsFor(false).some((tool) => tool.name === "build_corpus"));
    });

    it("marks every read-only tool as such", () => {
      for (const tool of READ_ONLY_TOOLS) {
        assert.equal(tool.permission, "read", `${tool.name} should be a read tool`);
        assert.equal(tool.readOnly, true);
      }
    });

    it("marks write tools as not read-only", () => {
      for (const tool of WRITE_TOOLS) {
        assert.equal(tool.permission, "write");
        assert.equal(tool.readOnly, false);
      }
    });
  });

  describe("schemas", () => {
    it("gives every tool a closed object schema", () => {
      for (const tool of ALL) {
        assert.equal(tool.inputSchema["type"], "object", `${tool.name}`);
        assert.equal(
          tool.inputSchema["additionalProperties"],
          false,
          `${tool.name} should reject unknown arguments rather than ignore them`,
        );
      }
    });

    it("requires a query for the search tools", () => {
      for (const name of ["search", "explore"]) {
        const tool = ALL.find((candidate) => candidate.name === name);
        assert.deepEqual(tool?.inputSchema["required"], ["query"], name);
      }
    });

    it("requires a ref for read", () => {
      const tool = ALL.find((candidate) => candidate.name === "read");
      assert.deepEqual(tool?.inputSchema["required"], ["ref"]);
    });

    it("lets every corpus-scoped tool take a corpus name", () => {
      for (const tool of ALL) {
        if (tool.name === "list_corpora") continue;
        const properties = tool.inputSchema["properties"] as Record<string, unknown>;
        assert.ok(properties["corpus"] !== undefined, `${tool.name} should accept --corpus`);
      }
    });

    it("bounds numeric options so a bad call cannot ask for everything", () => {
      const search = ALL.find((tool) => tool.name === "search");
      const properties = search?.inputSchema["properties"] as Record<string, Record<string, unknown>>;
      assert.equal(properties["top_k"]?.["minimum"], 1);
      assert.ok(typeof properties["top_k"]?.["maximum"] === "number");
    });

    it("documents every property, since the schema is what an agent reads", () => {
      for (const tool of ALL) {
        const properties = tool.inputSchema["properties"] as Record<string, Record<string, unknown>>;
        for (const [name, property] of Object.entries(properties)) {
          assert.ok(
            typeof property["description"] === "string" && property["description"].length > 10,
            `${tool.name}.${name} needs a description`,
          );
        }
      }
    });
  });

  describe("descriptions", () => {
    it("gives every tool a name, title and substantial description", () => {
      for (const tool of ALL) {
        assert.match(tool.name, /^[a-z][a-z_]*$/, "tool names should be snake_case");
        assert.ok(tool.title.length > 0);
        assert.ok(tool.description.length > 80, `${tool.name} needs a usable description`);
      }
    });

    it("tells the agent how search and read fit together", () => {
      const search = ALL.find((tool) => tool.name === "search");
      const read = ALL.find((tool) => tool.name === "read");
      assert.match(search?.description ?? "", /read_ref/);
      assert.match(read?.description ?? "", /read_ref/);
    });

    it("says that an empty search result is not an error", () => {
      const search = ALL.find((tool) => tool.name === "search");
      assert.match(search?.description ?? "", /not as an error|no hits/i);
    });

    it("uses a distinct name per tool", () => {
      const names = ALL.map((tool) => tool.name);
      assert.equal(new Set(names).size, names.length);
    });
  });
});
