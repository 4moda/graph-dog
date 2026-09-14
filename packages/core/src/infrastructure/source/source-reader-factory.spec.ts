import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError } from "../../domain/errors.ts";
import { GitSourceReader } from "./git-source-reader.ts";
import { LocalSourceReader } from "./local-source-reader.ts";
import {
  SUPPORTED_SOURCE_KINDS,
  buildSourceReader,
  normalizeSourceSpec,
} from "./source-reader-factory.ts";

const EXTENSIONS = new Set([".md"]);

describe("infrastructure/source/sourceReaderFactory", () => {
  describe("normalizeSourceSpec", () => {
    it("defaults to a local source", () => {
      assert.equal(normalizeSourceSpec({ id: "docs", uri: "./docs" }).kind, "local");
    });

    it("keeps secrets and symlinks opt-in", () => {
      const spec = normalizeSourceSpec({ id: "docs", uri: "./docs" });
      assert.equal(spec.indexSecrets, false);
      assert.equal(spec.followSymlinks, false);
    });

    it("applies a size limit so one huge file cannot stall a build", () => {
      assert.ok(normalizeSourceSpec({ id: "docs", uri: "./docs" }).maxFileBytes > 0);
    });

    it("preserves include and exclude patterns", () => {
      const spec = normalizeSourceSpec({ id: "d", uri: ".", include: ["**/*.md"], exclude: ["x/**"] });
      assert.deepEqual([...spec.include], ["**/*.md"]);
      assert.deepEqual([...spec.exclude], ["x/**"]);
    });

    it("rejects an id that would break every ref", () => {
      for (const id of ["", "a/b", ".hidden"]) {
        assert.throws(() => normalizeSourceSpec({ id, uri: "." }), ConfigError, `should reject ${id}`);
      }
    });
  });

  describe("buildSourceReader", () => {
    it("builds a local reader", () => {
      const reader = buildSourceReader(normalizeSourceSpec({ id: "d", uri: "." }), EXTENSIONS);
      assert.ok(reader instanceof LocalSourceReader);
    });

    it("builds a git reader", () => {
      const reader = buildSourceReader(
        normalizeSourceSpec({ id: "d", kind: "git", uri: "." }),
        EXTENSIONS,
      );
      assert.ok(reader instanceof GitSourceReader);
    });

    it("names the supported kinds when given an unknown one", () => {
      assert.throws(
        () => buildSourceReader({ ...normalizeSourceSpec({ id: "d", uri: "." }), kind: "ftp" }, EXTENSIONS),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.deepEqual(error.details["supported"], SUPPORTED_SOURCE_KINDS);
          return true;
        },
      );
    });
  });
});
