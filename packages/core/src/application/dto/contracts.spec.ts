import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHUNKING_SCHEMA_VERSION,
  CONTRACT_VERSION,
  SCHEMA_VERSION,
  WarningCode,
  envelope,
  round,
} from "./contracts.ts";

describe("application/dto/contracts", () => {
  describe("versions", () => {
    it("exposes the three version identifiers a consumer gates on", () => {
      assert.ok(SCHEMA_VERSION.length > 0);
      assert.ok(CONTRACT_VERSION.length > 0);
      assert.ok(CHUNKING_SCHEMA_VERSION.length > 0);
    });
  });

  describe("envelope", () => {
    it("stamps every response with the versions and its kind", () => {
      assert.deepEqual(envelope("search"), {
        schema_version: SCHEMA_VERSION,
        contract_version: CONTRACT_VERSION,
        kind: "search",
      });
    });
  });

  describe("round", () => {
    it("rounds to six places so two runs serialize identically", () => {
      assert.equal(round(0.1234567891), 0.123457);
    });

    it("passes null through, preserving 'this signal did not run'", () => {
      assert.equal(round(null), null);
      assert.equal(round(undefined), null);
    });

    it("maps NaN to null rather than emitting invalid JSON", () => {
      assert.equal(round(Number.NaN), null);
    });

    it("preserves an exact zero", () => {
      assert.equal(round(0), 0);
    });

    it("honours a custom precision", () => {
      assert.equal(round(1.23456, 2), 1.23);
    });
  });

  describe("WarningCode", () => {
    it("gives every warning a distinct code", () => {
      const values = Object.values(WarningCode);
      assert.equal(new Set(values).size, values.length);
    });

    it("uses snake_case, matching the JSON it appears in", () => {
      for (const value of Object.values(WarningCode)) {
        assert.match(value, /^[a-z][a-z0-9_]*$/);
      }
    });
  });
});
