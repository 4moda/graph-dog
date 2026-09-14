import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ConfigError,
  CorpusNotFoundError,
  ExitCode,
  GraphDogError,
  IncompatibleCorpusError,
  isGraphDogError,
  toGraphDogError,
} from "./errors.ts";

describe("domain/errors", () => {
  it("gives each failure a distinct, stable code and exit code", () => {
    assert.equal(new ConfigError("x").code, "config_invalid");
    assert.equal(new ConfigError("x").exitCode, ExitCode.USAGE);
    assert.equal(new CorpusNotFoundError("x").code, "corpus_not_found");
    assert.equal(new CorpusNotFoundError("x").exitCode, ExitCode.NOT_FOUND);
    assert.equal(new IncompatibleCorpusError("x").exitCode, ExitCode.INCOMPATIBLE);
  });

  it("serializes to a machine-readable envelope", () => {
    const error = new CorpusNotFoundError("no corpus", { available: ["a", "b"] });
    assert.deepEqual(error.toJSON(), {
      error: {
        code: "corpus_not_found",
        message: "no corpus",
        details: { available: ["a", "b"] },
      },
    });
  });

  it("keeps the subclass name so stack traces stay readable", () => {
    assert.equal(new ConfigError("x").name, "ConfigError");
  });

  it("recognizes its own errors", () => {
    assert.ok(isGraphDogError(new GraphDogError("x")));
    assert.ok(!isGraphDogError(new Error("x")));
  });

  it("wraps foreign errors without losing the message or stack", () => {
    const native = new TypeError("bad type");
    const wrapped = toGraphDogError(native);
    assert.ok(isGraphDogError(wrapped));
    assert.equal(wrapped.message, "bad type");
    assert.equal(wrapped.details["cause"], "TypeError");
    assert.equal(wrapped.stack, native.stack);
  });

  it("wraps non-Error throwables", () => {
    assert.equal(toGraphDogError("boom").message, "boom");
    assert.equal(toGraphDogError(42).message, "42");
  });

  it("returns GraphDog errors unchanged", () => {
    const original = new ConfigError("x");
    assert.equal(toGraphDogError(original), original);
  });
});
