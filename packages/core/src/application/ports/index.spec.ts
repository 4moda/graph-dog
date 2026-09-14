import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as ports from "./index.ts";

describe("application/ports/index", () => {
  it("re-exports the one runtime value the ports define", () => {
    assert.equal(typeof ports.SILENT_LOGGER.log, "function");
  });

  it("exports nothing else at runtime, since ports are interfaces", () => {
    assert.deepEqual(Object.keys(ports), ["SILENT_LOGGER"]);
  });
});
