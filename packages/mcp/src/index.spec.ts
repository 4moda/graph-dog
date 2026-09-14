import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as mcp from "./index.ts";

describe("mcp/index", () => {
  it("exports the server factories", () => {
    assert.equal(typeof mcp.createServer, "function");
    assert.equal(typeof mcp.startStdioServer, "function");
  });

  it("exports the tool catalogue, so a host can inspect it before starting", () => {
    assert.equal(typeof mcp.toolsFor, "function");
    assert.ok(mcp.READ_ONLY_TOOLS.length > 0);
    assert.ok(mcp.WRITE_TOOLS.length > 0);
  });

  it("exports the programmatic entry point and version", () => {
    assert.equal(typeof mcp.main, "function");
    assert.match(mcp.VERSION, /^\d+\.\d+\.\d+$/);
  });
});
