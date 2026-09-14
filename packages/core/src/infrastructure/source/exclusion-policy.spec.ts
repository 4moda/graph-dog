import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { globToRegExp, isSecretPath, isSkippedDirectory, matchesAny } from "./exclusion-policy.ts";

describe("infrastructure/source/exclusionPolicy", () => {
  describe("globToRegExp", () => {
    it("matches a literal name", () => {
      assert.ok(globToRegExp("README.md").test("README.md"));
      assert.ok(!globToRegExp("README.md").test("READMEXmd"), "the dot must be literal");
    });

    it("treats * as within-segment", () => {
      assert.ok(globToRegExp("*.md").test("notes.md"));
      assert.ok(!globToRegExp("*.md").test("docs/notes.md"));
    });

    it("treats ** as across segments", () => {
      assert.ok(globToRegExp("**/*.md").test("a/b/c.md"));
      assert.ok(globToRegExp("**/*.md").test("c.md"), "**/ should also match zero segments");
    });

    it("supports ?", () => {
      assert.ok(globToRegExp("v?.md").test("v1.md"));
      assert.ok(!globToRegExp("v?.md").test("v10.md"));
    });

    it("escapes regex metacharacters instead of interpreting them", () => {
      assert.ok(globToRegExp("a+b.md").test("a+b.md"));
      assert.ok(!globToRegExp("a+b.md").test("aab.md"));
    });

    it("is case-insensitive", () => {
      assert.ok(globToRegExp("*.MD").test("notes.md"));
    });
  });

  describe("matchesAny", () => {
    it("matches against the basename as well as the full path", () => {
      assert.ok(matchesAny("deep/nested/notes.md", ["*.md"]));
    });

    it("returns false for an empty pattern list", () => {
      assert.ok(!matchesAny("anything.md", []));
    });
  });

  describe("isSecretPath", () => {
    it("catches private keys", () => {
      for (const path of ["id_rsa", "certs/server.pem", "keys/app.p12", "deploy_ed25519"]) {
        assert.ok(isSecretPath(path), `${path} should be treated as a secret`);
      }
    });

    it("catches env files anywhere in the tree", () => {
      for (const path of [".env", ".env.production", "config/prod.env"]) {
        assert.ok(isSecretPath(path), `${path} should be treated as a secret`);
      }
    });

    it("catches credential-shaped names", () => {
      for (const path of ["aws-credentials.json", "app/secrets.yaml", "gcp-service-account.json"]) {
        assert.ok(isSecretPath(path), `${path} should be treated as a secret`);
      }
    });

    it("does not catch ordinary documents", () => {
      for (const path of ["docs/design.md", "README.md", "src/token.ts", "guide/environment.md"]) {
        assert.ok(!isSecretPath(path), `${path} should be indexable`);
      }
    });

    it("accepts extra project-specific patterns", () => {
      assert.ok(isSecretPath("internal/roster.csv", ["*roster*"]));
    });
  });

  describe("isSkippedDirectory", () => {
    it("skips VCS, dependency and build directories", () => {
      for (const name of [".git", "node_modules", "dist", "__pycache__", "target"]) {
        assert.ok(isSkippedDirectory(name));
      }
    });

    it("skips dotted tooling directories generally", () => {
      assert.ok(isSkippedDirectory(".somefuturetool"));
    });

    it("does not skip ordinary content directories", () => {
      for (const name of ["docs", "designs", "src", "notes"]) {
        assert.ok(!isSkippedDirectory(name));
      }
    });
  });
});
