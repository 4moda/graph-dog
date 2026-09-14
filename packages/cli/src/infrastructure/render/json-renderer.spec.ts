import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderJson, renderJsonError } from "./json-renderer.ts";

describe("cli/infrastructure/render/jsonRenderer", () => {
  it("emits indented JSON with a trailing newline", () => {
    const output = renderJson({ a: 1, b: { c: 2 } });
    assert.ok(output.endsWith("\n"));
    assert.equal(JSON.parse(output).b.c, 2);
    assert.match(output, /\n {2}"a"/, "should be indented for readability");
  });

  it("passes the payload through unchanged", () => {
    // The renderer must not filter, reorder or reshape: that is what makes
    // --json output identical to what the MCP server returns.
    const payload = { kind: "search", hits: [{ ref: "a.md", scores: { final: 0.5 } }] };
    assert.deepEqual(JSON.parse(renderJson(payload)), payload);
  });

  it("preserves an explicit null, which means 'this signal did not run'", () => {
    assert.equal(JSON.parse(renderJson({ dense: null })).dense, null);
  });

  it("preserves non-ASCII text without escaping it away", () => {
    assert.equal(JSON.parse(renderJson({ title: "アクセストークン" })).title, "アクセストークン");
  });

  it("renders an error envelope in the same shape", () => {
    const output = renderJsonError({ error: { code: "not_found", message: "gone", details: {} } });
    assert.equal(JSON.parse(output).error.code, "not_found");
  });
});
