import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { ConfigError } from "../../domain/errors.ts";
import {
  deleteAtPath,
  getAtPath,
  isEmptyConfig,
  readJsonConfig,
  setAtPath,
  writeJsonConfig,
} from "./json-config-file.ts";

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "graphdog-jsonconfig-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

let counter = 0;
const fresh = (): string => join(root, `config-${(counter += 1)}.json`);

describe("infrastructure/integration/json-config-file", () => {
  describe("readJsonConfig", () => {
    it("reads an object back", async () => {
      const path = fresh();
      await writeFile(path, '{"mcpServers":{"other":{"command":"x"}}}', "utf8");
      assert.deepEqual(await readJsonConfig(path), { mcpServers: { other: { command: "x" } } });
    });

    it("reports a missing file as null, not as an empty configuration", async () => {
      // Only a file GraphDog brought into existence is one GraphDog may delete.
      assert.equal(await readJsonConfig(join(root, "absent.json")), null);
    });

    it("reads an empty file as an empty configuration", async () => {
      const path = fresh();
      await writeFile(path, "   \n", "utf8");
      assert.deepEqual(await readJsonConfig(path), {});
    });

    it("refuses to rewrite a file it cannot parse", async () => {
      const path = fresh();
      await writeFile(path, "{ not json", "utf8");
      await assert.rejects(
        () => readJsonConfig(path),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, /not valid JSON/);
          return true;
        },
      );
    });

    it("refuses a JSON array, which is not a configuration", async () => {
      const path = fresh();
      await writeFile(path, "[1,2,3]", "utf8");
      await assert.rejects(() => readJsonConfig(path), ConfigError);
    });
  });

  describe("writeJsonConfig", () => {
    it("creates the directories it needs and ends the file with a newline", async () => {
      const path = join(root, "nested", "deeper", "mcp.json");
      await writeJsonConfig(path, { servers: {} });
      assert.equal(await readFile(path, "utf8"), '{\n  "servers": {}\n}\n');
    });
  });

  describe("setAtPath", () => {
    it("sets a nested property, creating the objects above it", () => {
      assert.deepEqual(setAtPath({}, "mcpServers.graphdog", { command: "graphdog" }), {
        mcpServers: { graphdog: { command: "graphdog" } },
      });
    });

    it("leaves another tool's entry beside its own", () => {
      const before = { mcpServers: { other: { command: "x" } } };
      const after = setAtPath(before, "mcpServers.graphdog", { command: "graphdog" });
      assert.deepEqual(after["mcpServers"], { other: { command: "x" }, graphdog: { command: "graphdog" } });
    });

    it("leaves everything outside the path alone", () => {
      const after = setAtPath({ theme: "dark", mcpServers: {} }, "mcpServers.graphdog", 1);
      assert.equal(after["theme"], "dark");
    });

    it("does not modify the document it was given", () => {
      const before = { mcpServers: { other: 1 } };
      setAtPath(before, "mcpServers.graphdog", 2);
      assert.deepEqual(before, { mcpServers: { other: 1 } });
    });

    it("refuses when something that is not an object is in the way", () => {
      assert.throws(() => setAtPath({ mcpServers: "nope" }, "mcpServers.graphdog", 1), ConfigError);
    });

    it("refuses a malformed path rather than inventing a key", () => {
      assert.throws(() => setAtPath({}, "a..b", 1), ConfigError);
      assert.throws(() => setAtPath({}, "", 1), ConfigError);
    });
  });

  describe("getAtPath", () => {
    it("finds a nested value, and reports undefined for a path that is not there", () => {
      const document = { mcpServers: { graphdog: { command: "graphdog" } } };
      assert.deepEqual(getAtPath(document, "mcpServers.graphdog"), { command: "graphdog" });
      assert.equal(getAtPath(document, "mcpServers.absent"), undefined);
      assert.equal(getAtPath(document, "nothing.here.at.all"), undefined);
    });
  });

  describe("deleteAtPath", () => {
    it("removes the property and says it did", () => {
      const { document, removed } = deleteAtPath({ mcpServers: { graphdog: 1, other: 2 } }, "mcpServers.graphdog");
      assert.equal(removed, true);
      assert.deepEqual(document, { mcpServers: { other: 2 } });
    });

    it("prunes a container it has emptied, so an empty file can be recognized", () => {
      const { document } = deleteAtPath({ mcpServers: { graphdog: 1 } }, "mcpServers.graphdog");
      assert.deepEqual(document, {});
      assert.equal(isEmptyConfig(document), true);
    });

    it("keeps a container that still holds somebody else's entry", () => {
      const { document } = deleteAtPath({ mcpServers: { graphdog: 1, other: 2 } }, "mcpServers.graphdog");
      assert.equal(isEmptyConfig(document), false);
    });

    it("reports not-removed when the property was never there", () => {
      const before = { mcpServers: { other: 1 } };
      const { document, removed } = deleteAtPath(before, "mcpServers.graphdog");
      assert.equal(removed, false);
      assert.deepEqual(document, before);
    });

    it("leaves unrelated top-level settings in place", () => {
      const { document } = deleteAtPath({ theme: "dark", mcpServers: { graphdog: 1 } }, "mcpServers.graphdog");
      assert.deepEqual(document, { theme: "dark" });
    });

    it("does not modify the document it was given", () => {
      const before = { mcpServers: { graphdog: 1, other: 2 } };
      deleteAtPath(before, "mcpServers.graphdog");
      assert.deepEqual(before, { mcpServers: { graphdog: 1, other: 2 } });
    });
  });
});
