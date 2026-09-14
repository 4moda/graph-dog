import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { UsageError } from "@graphdog/core";

import {
  GLOBAL_OPTIONS,
  optionBoolean,
  optionList,
  optionNumber,
  optionString,
  parseCommandLine,
  renderCommandHelp,
  type CommandSpec,
} from "./argv.ts";

const spec: CommandSpec = {
  name: "demo",
  summary: "A demo command",
  usage: "graphdog demo <thing> [--flag]",
  options: {
    flag: { type: "boolean", description: "A boolean flag" },
    name: { type: "string", short: "n", description: "A named value", placeholder: "<name>" },
    tag: { type: "string", multiple: true, description: "Repeatable value", placeholder: "<tag>" },
    count: { type: "string", description: "A numeric value", placeholder: "<n>" },
  },
  examples: ["graphdog demo thing --flag"],
};

describe("cli/infrastructure/argv", () => {
  describe("parsing", () => {
    it("collects positionals", () => {
      assert.deepEqual(parseCommandLine(["one", "two"], spec).positionals, ["one", "two"]);
    });

    it("parses boolean and string options", () => {
      const parsed = parseCommandLine(["--flag", "--name", "value"], spec);
      assert.equal(optionBoolean(parsed, "flag"), true);
      assert.equal(optionString(parsed, "name"), "value");
    });

    it("supports short flags", () => {
      assert.equal(optionString(parseCommandLine(["-n", "short"], spec), "name"), "short");
    });

    it("collects repeatable options", () => {
      const parsed = parseCommandLine(["--tag", "a", "--tag", "b"], spec);
      assert.deepEqual(optionList(parsed, "tag"), ["a", "b"]);
    });

    it("accepts the global options on every command", () => {
      const parsed = parseCommandLine(["--json", "--corpus", "docs", "-q"], spec);
      assert.equal(optionBoolean(parsed, "json"), true);
      assert.equal(optionString(parsed, "corpus"), "docs");
      assert.equal(optionBoolean(parsed, "quiet"), true);
    });

    it("rejects an unknown option instead of ignoring it", () => {
      // A typo'd filter that is silently dropped returns results the caller
      // believes were filtered. That is worse than an error.
      assert.throws(() => parseCommandLine(["--sorce", "docs"], spec), UsageError);
    });

    it("includes the usage line in a parse error", () => {
      assert.throws(
        () => parseCommandLine(["--nope"], spec),
        (error: unknown) => {
          assert.ok(error instanceof UsageError);
          assert.equal(error.details["usage"], spec.usage);
          return true;
        },
      );
    });

    it("reports a missing value for a string option", () => {
      assert.throws(() => parseCommandLine(["--name"], spec), UsageError);
    });
  });

  describe("accessors", () => {
    it("returns undefined for an absent string option", () => {
      assert.equal(optionString(parseCommandLine([], spec), "name"), undefined);
    });

    it("returns false for an absent boolean option", () => {
      assert.equal(optionBoolean(parseCommandLine([], spec), "flag"), false);
    });

    it("returns an empty list for an absent repeatable option", () => {
      assert.deepEqual(optionList(parseCommandLine([], spec), "tag"), []);
    });

    it("parses a numeric option", () => {
      assert.equal(optionNumber(parseCommandLine(["--count", "7"], spec), "count", "demo"), 7);
    });

    it("returns undefined for an absent numeric option", () => {
      assert.equal(optionNumber(parseCommandLine([], spec), "count", "demo"), undefined);
    });

    it("rejects a non-numeric value rather than coercing it to NaN", () => {
      // NaN would become 0 downstream and return nothing, which reads as
      // "no results" instead of "you made a typo".
      assert.throws(
        () => optionNumber(parseCommandLine(["--count", "banana"], spec), "count", "demo"),
        UsageError,
      );
    });

    it("accepts a decimal value", () => {
      assert.equal(optionNumber(parseCommandLine(["--count", "0.5"], spec), "count", "demo"), 0.5);
    });
  });

  describe("help", () => {
    const help = renderCommandHelp(spec);

    it("shows the usage line and summary", () => {
      assert.match(help, /A demo command/);
      assert.match(help, /graphdog demo <thing>/);
    });

    it("documents the command's own options", () => {
      assert.match(help, /--flag/);
      assert.match(help, /-n, --name <name>/);
    });

    it("documents the global options too", () => {
      for (const name of Object.keys(GLOBAL_OPTIONS)) {
        assert.match(help, new RegExp(`--${name}`), `${name} should appear in help`);
      }
    });

    it("shows examples when the command has them", () => {
      assert.match(help, /Examples:/);
      assert.match(help, /graphdog demo thing --flag/);
    });

    it("omits the options section for a command with none", () => {
      const bare = renderCommandHelp({ ...spec, options: {}, examples: [] as string[] });
      assert.doesNotMatch(bare, /Examples:/);
    });
  });
});
