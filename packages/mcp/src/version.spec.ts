import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";

import { VERSION } from "./version.ts";

describe("version", () => {
  /**
   * Version drift is a real bug, not a cosmetic one: this string is written
   * into corpus manifests and reported to MCP clients, so a stale constant
   * mislabels artifacts that outlive the process.
   */
  it("matches the package manifest", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(
      await readFile(resolve(here, "..", "package.json"), "utf8"),
    ) as { version: string };
    assert.equal(VERSION, manifest.version);
  });
});
