import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { createStderrLogger, sha256Hasher, systemClock } from "./system-adapters.ts";

describe("infrastructure/systemAdapters", () => {
  describe("systemClock", () => {
    it("returns an ISO-8601 timestamp", () => {
      assert.match(systemClock.nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("advances monotonically", () => {
      const first = systemClock.monotonicMs();
      for (let i = 0; i < 1_000_000; i += 1) {
        // burn a little time
      }
      assert.ok(systemClock.monotonicMs() >= first);
    });
  });

  describe("sha256Hasher", () => {
    it("hashes text to the standard digest", () => {
      assert.equal(
        sha256Hasher.hashText("graphdog"),
        createHash("sha256").update("graphdog", "utf8").digest("hex"),
      );
    });

    it("hashes bytes", () => {
      const bytes = new Uint8Array([1, 2, 3]);
      assert.equal(sha256Hasher.hashBytes(bytes), createHash("sha256").update(bytes).digest("hex"));
    });

    it("is deterministic", () => {
      assert.equal(sha256Hasher.hashText("x"), sha256Hasher.hashText("x"));
    });

    it("distinguishes different inputs", () => {
      assert.notEqual(sha256Hasher.hashText("a"), sha256Hasher.hashText("b"));
    });

    it("handles non-ASCII text consistently with its UTF-8 bytes", () => {
      const text = "アクセストークン";
      assert.equal(sha256Hasher.hashText(text), sha256Hasher.hashBytes(new TextEncoder().encode(text)));
    });
  });

  describe("createStderrLogger", () => {
    it("writes to stderr, never stdout", () => {
      // stdout carries JSON contract output and JSON-RPC frames; a stray log
      // line there would corrupt a machine-readable stream.
      const captured: string[] = [];
      const originalErr = process.stderr.write.bind(process.stderr);
      const originalOut = process.stdout.write.bind(process.stdout);
      let stdoutWrites = 0;

      process.stderr.write = ((chunk: string) => {
        captured.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      process.stdout.write = ((chunk: string) => {
        stdoutWrites += 1;
        return originalOut(chunk);
      }) as typeof process.stdout.write;

      try {
        createStderrLogger("info").log("warn", "something happened", { code: 7 });
      } finally {
        process.stderr.write = originalErr;
        process.stdout.write = originalOut;
      }

      assert.equal(stdoutWrites, 0);
      assert.match(captured.join(""), /warn: something happened/);
      assert.match(captured.join(""), /"code":7/);
    });

    it("suppresses messages below the threshold", () => {
      const captured: string[] = [];
      const original = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string) => {
        captured.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        const logger = createStderrLogger("error");
        logger.log("debug", "noisy");
        logger.log("info", "also noisy");
        logger.log("error", "important");
      } finally {
        process.stderr.write = original;
      }
      assert.equal(captured.length, 1);
      assert.match(captured[0] ?? "", /important/);
    });

    it("omits the field suffix when there are no fields", () => {
      const captured: string[] = [];
      const original = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string) => {
        captured.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        createStderrLogger("info").log("info", "plain");
      } finally {
        process.stderr.write = original;
      }
      assert.equal(captured[0], "graphdog info: plain\n");
    });
  });
});
