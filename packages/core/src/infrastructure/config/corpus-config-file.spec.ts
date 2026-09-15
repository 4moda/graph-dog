import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { ConfigError } from "../../domain/errors.ts";
import { defaultCorpusConfig } from "../../application/config.ts";
import {
  CONFIG_VERSION,
  formatCorpusConfig,
  loadCorpusConfig,
  parseCorpusConfig,
  saveCorpusConfig,
  serializeCorpusConfig,
} from "./corpus-config-file.ts";

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "graphdog-config-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("infrastructure/config/corpusConfigFile", () => {
  describe("parsing", () => {
    it("accepts a minimal config", () => {
      const config = parseCorpusConfig({ name: "docs" });
      assert.equal(config.name, "docs");
      assert.deepEqual(config.sources, []);
    });

    it("fills in defaults for everything unspecified", () => {
      const config = parseCorpusConfig({ name: "docs" });
      assert.equal(config.fusion.strategy, "rrf");
      assert.equal(config.embedding.provider, "hash");
      assert.equal(config.search.topK, 10);
    });

    it("requires a name", () => {
      assert.throws(() => parseCorpusConfig({}), ConfigError);
    });

    it("rejects a config from a newer GraphDog rather than guessing", () => {
      assert.throws(
        () => parseCorpusConfig({ version: CONFIG_VERSION + 1, name: "docs" }),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, /newer/);
          return true;
        },
      );
    });

    it("names the exact path of a bad value", () => {
      assert.throws(
        () => parseCorpusConfig({ name: "docs", search: { topK: "ten" } }),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, /search\.topK/);
          return true;
        },
      );
    });

    it("rejects an unknown embedding provider instead of falling back", () => {
      assert.throws(
        () => parseCorpusConfig({ name: "docs", embedding: { provider: "magic" } }),
        ConfigError,
      );
    });

    it("rejects an unknown fusion strategy", () => {
      assert.throws(
        () => parseCorpusConfig({ name: "docs", fusion: { strategy: "vibes" } }),
        ConfigError,
      );
    });

    it("parses sources and applies their defaults", () => {
      const config = parseCorpusConfig({
        name: "docs",
        sources: [{ id: "docs", kind: "local", uri: "./docs" }],
      });
      assert.equal(config.sources[0]?.id, "docs");
      assert.equal(config.sources[0]?.indexSecrets, false, "secrets must stay opt-in");
      assert.ok((config.sources[0]?.maxFileBytes ?? 0) > 0);
    });

    it("rejects duplicate source ids, which would collide in every ref", () => {
      assert.throws(
        () =>
          parseCorpusConfig({
            name: "docs",
            sources: [
              { id: "a", uri: "./one" },
              { id: "a", uri: "./two" },
            ],
          }),
        ConfigError,
      );
    });

    it("rejects a source id containing a separator", () => {
      assert.throws(
        () => parseCorpusConfig({ name: "docs", sources: [{ id: "a/b", uri: "./x" }] }),
        ConfigError,
      );
    });

    it("rejects sources that are not an array", () => {
      assert.throws(() => parseCorpusConfig({ name: "docs", sources: {} }), ConfigError);
    });

    it("treats a null dense floor as 'ask the model'", () => {
      const config = parseCorpusConfig({ name: "docs", search: { minDenseSimilarity: null } });
      assert.equal(config.search.minDenseSimilarity, null);
    });

    it("accepts an explicit dense floor override", () => {
      const config = parseCorpusConfig({ name: "docs", search: { minDenseSimilarity: 0.4 } });
      assert.equal(config.search.minDenseSimilarity, 0.4);
    });

    it("ignores unknown keys so a newer config still loads", () => {
      const config = parseCorpusConfig({ name: "docs", futureFeature: { enabled: true } });
      assert.equal(config.name, "docs");
    });
  });

  describe("serializing", () => {
    it("omits values still at their default, keeping the file readable", () => {
      const serialized = serializeCorpusConfig(defaultCorpusConfig("docs"));
      assert.ok(!("fusion" in serialized), "an untouched section should not be written");
      assert.equal(serialized["name"], "docs");
    });

    it("records a value that differs from the default", () => {
      const config = { ...defaultCorpusConfig("docs") };
      const serialized = serializeCorpusConfig({
        ...config,
        search: { ...config.search, topK: 25 },
      });
      assert.deepEqual(serialized["search"], { topK: 25 });
    });

    it("round-trips through parse", () => {
      const original = {
        ...defaultCorpusConfig("docs"),
        description: "the docs",
        search: { ...defaultCorpusConfig("docs").search, topK: 3 },
      };
      assert.deepEqual(parseCorpusConfig(serializeCorpusConfig(original)), original);
    });
  });

  describe("file IO", () => {
    it("writes and reads back a config", async () => {
      const path = join(root, "graphdog.json");
      const config = defaultCorpusConfig("docs");
      await saveCorpusConfig(path, config);
      assert.deepEqual(await loadCorpusConfig(path), config);
    });

    it("writes pretty-printed JSON with a trailing newline", async () => {
      const path = join(root, "pretty.json");
      await saveCorpusConfig(path, defaultCorpusConfig("docs"));
      const raw = await readFile(path, "utf8");
      assert.ok(raw.includes("\n  "), "should be indented for human review");
      assert.ok(raw.endsWith("\n"));
    });

    it("creates the parent directory", async () => {
      const path = join(root, "nested", "deep", "graphdog.json");
      await saveCorpusConfig(path, defaultCorpusConfig("docs"));
      assert.ok((await loadCorpusConfig(path)).name === "docs");
    });

    it("reports a missing file clearly", async () => {
      await assert.rejects(() => loadCorpusConfig(join(root, "absent.json")), ConfigError);
    });

    it("reports malformed JSON with the file path", async () => {
      const path = join(root, "broken.json");
      await writeFile(path, "{ not json", "utf8");
      await assert.rejects(
        () => loadCorpusConfig(path),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, /broken\.json/);
          return true;
        },
      );
    });
  });

  describe("formatCorpusConfig", () => {
    it("is byte-for-byte what saveCorpusConfig writes, so an exported config matches the file", async () => {
      const config = defaultCorpusConfig("formatted");
      const path = join(root, "formatted.json");
      await saveCorpusConfig(path, config);
      assert.equal(await readFile(path, "utf8"), formatCorpusConfig(config));
    });

    it("is stable through a parse, so re-exporting an imported corpus changes nothing", () => {
      const text = formatCorpusConfig(defaultCorpusConfig("stable"));
      assert.equal(formatCorpusConfig(parseCorpusConfig(JSON.parse(text))), text);
    });

    it("ends with a newline", () => {
      assert.ok(formatCorpusConfig(defaultCorpusConfig("nl")).endsWith("}\n"));
    });
  });
});
