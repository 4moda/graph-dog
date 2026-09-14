import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SILENT_LOGGER } from "./system.ts";

describe("application/ports/system", () => {
  describe("SILENT_LOGGER", () => {
    it("discards everything without throwing", () => {
      assert.doesNotThrow(() => {
        SILENT_LOGGER.log("error", "ignored", { detail: 1 });
        SILENT_LOGGER.log("debug", "also ignored");
      });
    });

    it("writes to neither stdout nor stderr", () => {
      // The default logger for library use must never touch a stream a caller
      // may be using for protocol output.
      let writes = 0;
      const originalOut = process.stdout.write.bind(process.stdout);
      const originalErr = process.stderr.write.bind(process.stderr);
      process.stdout.write = (() => {
        writes += 1;
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = (() => {
        writes += 1;
        return true;
      }) as typeof process.stderr.write;
      try {
        SILENT_LOGGER.log("error", "quiet please");
      } finally {
        process.stdout.write = originalOut;
        process.stderr.write = originalErr;
      }
      assert.equal(writes, 0);
    });
  });
});
