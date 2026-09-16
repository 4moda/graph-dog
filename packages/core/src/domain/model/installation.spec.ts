import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EMPTY_LEDGER,
  findInstallations,
  parseLedger,
  removeInstallations,
  upsertInstallation,
  type InstallationRecord,
} from "./installation.ts";

function record(overrides: Partial<InstallationRecord> = {}): InstallationRecord {
  return {
    platform: "claude",
    scope: "project",
    root: "/repo",
    version: "0.1.0",
    installedAt: "2026-09-16T00:00:00.000Z",
    artifacts: [{ kind: "key", path: "/repo/.mcp.json", at: "mcpServers.graphdog" }],
    ...overrides,
  };
}

describe("domain/model/installation", () => {
  describe("upsertInstallation", () => {
    it("adds an installation to an empty ledger", () => {
      const ledger = upsertInstallation(EMPTY_LEDGER, record());
      assert.equal(ledger.installations.length, 1);
    });

    it("replaces the record for the same platform, scope and project", () => {
      // Re-running install overwrites what is on the machine, so the old list
      // of artifacts describes things that no longer exist.
      const first = upsertInstallation(EMPTY_LEDGER, record({ version: "0.1.0" }));
      const second = upsertInstallation(first, record({ version: "0.2.0", artifacts: [] }));
      assert.equal(second.installations.length, 1);
      assert.equal(second.installations[0]?.version, "0.2.0");
    });

    it("keeps the same platform installed at user and project scope apart", () => {
      const ledger = upsertInstallation(
        upsertInstallation(EMPTY_LEDGER, record()),
        record({ scope: "user", root: null }),
      );
      assert.equal(ledger.installations.length, 2);
    });

    it("keeps the same platform in two projects apart", () => {
      const ledger = upsertInstallation(upsertInstallation(EMPTY_LEDGER, record()), record({ root: "/other" }));
      assert.equal(ledger.installations.length, 2);
    });

    it("orders records so the file does not churn between runs", () => {
      const one = upsertInstallation(EMPTY_LEDGER, record({ platform: "kiro" }));
      const two = upsertInstallation(one, record({ platform: "claude" }));
      assert.deepEqual(two.installations.map((r) => r.platform), ["claude", "kiro"]);
    });
  });

  describe("findInstallations", () => {
    const ledger = upsertInstallation(
      upsertInstallation(EMPTY_LEDGER, record()),
      record({ platform: "kiro", scope: "user", root: null }),
    );

    it("returns everything for an empty query", () => {
      assert.equal(findInstallations(ledger).length, 2);
    });

    it("filters on platform, scope and project independently", () => {
      assert.equal(findInstallations(ledger, { platform: "kiro" }).length, 1);
      assert.equal(findInstallations(ledger, { scope: "project" }).length, 1);
      assert.equal(findInstallations(ledger, { root: "/repo" }).length, 1);
      assert.equal(findInstallations(ledger, { platform: "kiro", scope: "project" }).length, 0);
    });

    it("treats a null root as a value to match, not as 'any'", () => {
      assert.deepEqual(
        findInstallations(ledger, { root: null }).map((r) => r.platform),
        ["kiro"],
      );
    });
  });

  describe("removeInstallations", () => {
    it("drops what matched and says what that was", () => {
      const ledger = upsertInstallation(
        upsertInstallation(EMPTY_LEDGER, record()),
        record({ platform: "kiro" }),
      );
      const { ledger: after, removed } = removeInstallations(ledger, { platform: "claude" });
      assert.deepEqual(removed.map((r) => r.platform), ["claude"]);
      assert.deepEqual(after.installations.map((r) => r.platform), ["kiro"]);
    });

    it("removes nothing, and says so, when nothing matched", () => {
      const ledger = upsertInstallation(EMPTY_LEDGER, record());
      const { ledger: after, removed } = removeInstallations(ledger, { platform: "copilot" });
      assert.deepEqual(removed, []);
      assert.equal(after.installations.length, 1);
    });
  });

  describe("parseLedger", () => {
    it("round-trips what upsert produced", () => {
      const ledger = upsertInstallation(EMPTY_LEDGER, record());
      assert.deepEqual(parseLedger(JSON.parse(JSON.stringify(ledger))), ledger);
    });

    it("reads a damaged file as an empty ledger rather than throwing", () => {
      // Nothing here is a corpus. A ledger nobody can parse must not be what
      // stops somebody uninstalling; artifacts are identifiable without it.
      for (const value of [null, 42, "text", {}, { installations: "nope" }]) {
        assert.deepEqual(parseLedger(value), EMPTY_LEDGER);
      }
    });

    it("keeps the records it understands and drops the ones it does not", () => {
      const ledger = parseLedger({
        installations: [record(), { platform: "" }, { scope: "nonsense" }, 7],
      });
      assert.deepEqual(ledger.installations.map((r) => r.platform), ["claude"]);
    });

    it("drops an artifact of an unknown kind rather than trying to remove it later", () => {
      const ledger = parseLedger({
        installations: [
          { ...record(), artifacts: [{ kind: "spell", path: "/x" }, { kind: "file", path: "/keep" }] },
        ],
      });
      assert.deepEqual(ledger.installations[0]?.artifacts, [{ kind: "file", path: "/keep", at: null }]);
    });

    it("names a version it was not told, so doctor reports something true", () => {
      const ledger = parseLedger({ installations: [{ platform: "claude", scope: "user" }] });
      assert.equal(ledger.installations[0]?.version, "unknown");
    });
  });
});
