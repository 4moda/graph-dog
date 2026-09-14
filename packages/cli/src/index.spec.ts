import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as cli from "./index.ts";

describe("cli/index", () => {
  it("exports the programmatic entry point", () => {
    assert.equal(typeof cli.main, "function");
  });

  it("exports the version", () => {
    assert.match(cli.VERSION, /^\d+\.\d+\.\d+$/);
  });
});
