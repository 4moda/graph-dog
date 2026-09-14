import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { NotFoundError } from "../../domain/errors.ts";
import { compareStrings } from "../../domain/ordering.ts";
import { ExclusionReason } from "./exclusion-policy.ts";
import { LocalSourceReader } from "./local-source-reader.ts";
import { normalizeSourceSpec } from "./source-reader-factory.ts";

const EXTENSIONS = new Set([".md", ".txt"]);
let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "graphdog-local-"));
  const files: Record<string, string> = {
    "README.md": "# Readme\n\nroot document",
    "docs/design.md": "# Design\n\ncontent",
    "docs/nested/deep.md": "# Deep\n\ncontent",
    "docs/notes.txt": "plain text",
    "docs/image.png": "not text",
    "node_modules/pkg/index.md": "should not be indexed",
    ".hidden/secret.md": "should not be indexed",
    ".env": "API_KEY=abc",
    "certs/server.pem": "-----BEGIN PRIVATE KEY-----",
    "empty.md": "",
    "large.md": "x".repeat(2000),
  };
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function reader(overrides: Partial<Parameters<typeof normalizeSourceSpec>[0]> = {}) {
  return new LocalSourceReader(
    normalizeSourceSpec({ id: "docs", kind: "local", uri: root, ...overrides }),
    EXTENSIONS,
  );
}

describe("infrastructure/source/localSourceReader", () => {
  describe("discovery", () => {
    it("finds supported files across the tree", () => {
      const refs = reader().discover().map((file) => file.ref);
      assert.ok(refs.includes("docs/README.md"));
      assert.ok(refs.includes("docs/docs/design.md"));
      assert.ok(refs.includes("docs/docs/nested/deep.md"));
    });

    it("builds portable posix refs prefixed with the source id", () => {
      const refs = reader().discover().map((file) => file.ref);
      assert.ok(refs.every((ref) => ref.startsWith("docs/") && !ref.includes("\\")));
    });

    it("returns files in a stable sorted order, so chunk ids are reproducible", () => {
      const first = reader().discover().map((file) => file.ref);
      const second = reader().discover().map((file) => file.ref);
      assert.deepEqual(first, second);
      assert.deepEqual(first, [...first].sort(compareStrings));
    });

    it("reports size and mtime", () => {
      const file = reader().discover().find((entry) => entry.ref === "docs/README.md");
      assert.ok((file?.size ?? 0) > 0);
      assert.ok((file?.mtime ?? 0) > 0);
    });

    it("skips files with an unsupported extension", () => {
      const refs = reader().discover().map((file) => file.ref);
      assert.ok(!refs.some((ref) => ref.endsWith(".png")));
    });

    it("does not descend into dependency or build directories", () => {
      const refs = reader().discover().map((file) => file.ref);
      assert.ok(!refs.some((ref) => ref.includes("node_modules")));
    });

    it("does not descend into dotted directories", () => {
      const refs = reader().discover().map((file) => file.ref);
      assert.ok(!refs.some((ref) => ref.includes(".hidden")));
    });

    it("throws a typed error for a path that does not exist", () => {
      const missing = new LocalSourceReader(
        normalizeSourceSpec({ id: "x", uri: join(root, "nope") }),
        EXTENSIONS,
      );
      assert.throws(() => missing.discover(), NotFoundError);
    });
  });

  describe("exclusions", () => {
    it("skips secret-shaped files and records why", () => {
      const source = reader();
      source.discover();
      const secrets = source
        .exclusions()
        .filter((exclusion) => exclusion.reason === ExclusionReason.SECRET_PATTERN);
      assert.ok(secrets.some((exclusion) => exclusion.ref.endsWith("server.pem")));
    });

    it("records a dotfile secret rather than skipping it as 'just a dotfile'", () => {
      // The most common secrets are dotfiles. Dropping them under the dotfile
      // rule would leave the audit trail claiming nothing was excluded.
      const source = reader();
      source.discover();
      assert.ok(
        source
          .exclusions()
          .some((entry) => entry.reason === ExclusionReason.SECRET_PATTERN && entry.ref.endsWith(".env")),
      );
    });

    it("indexes secrets only when explicitly opted in", () => {
      const refs = reader({ indexSecrets: true, include: ["**/*.pem"] })
        .discover()
        .map((file) => file.ref);
      assert.ok(refs.some((ref) => ref.endsWith("server.pem")));
    });

    it("records empty files rather than silently dropping them", () => {
      const source = reader();
      source.discover();
      assert.ok(
        source
          .exclusions()
          .some((e) => e.reason === ExclusionReason.EMPTY_FILE && e.ref === "docs/empty.md"),
      );
    });

    it("records oversized files with the limit that rejected them", () => {
      const source = reader({ maxFileBytes: 100 });
      source.discover();
      const big = source
        .exclusions()
        .find((e) => e.reason === ExclusionReason.FILE_TOO_LARGE && e.ref === "docs/large.md");
      assert.equal(big?.details["limit"], 100);
    });
  });

  describe("include and exclude patterns", () => {
    it("restricts discovery to include patterns", () => {
      const refs = reader({ include: ["docs/**/*.md"] }).discover().map((file) => file.ref);
      assert.ok(refs.includes("docs/docs/design.md"));
      assert.ok(!refs.includes("docs/README.md"));
    });

    it("an include pattern can pull in an otherwise unsupported extension", () => {
      const refs = reader({ include: ["**/*.png"] }).discover().map((file) => file.ref);
      assert.ok(refs.some((ref) => ref.endsWith(".png")));
    });

    it("applies exclude patterns", () => {
      const refs = reader({ exclude: ["docs/nested/**"] }).discover().map((file) => file.ref);
      assert.ok(!refs.some((ref) => ref.includes("nested")));
    });

    it("lets exclude win over include", () => {
      const refs = reader({ include: ["**/*.md"], exclude: ["**/deep.md"] })
        .discover()
        .map((file) => file.ref);
      assert.ok(!refs.some((ref) => ref.endsWith("deep.md")));
    });
  });

  describe("symlinks", () => {
    it("ignores symlinks by default", async () => {
      const linked = await mkdtemp(join(tmpdir(), "graphdog-link-"));
      try {
        await writeFile(join(linked, "real.md"), "content", "utf8");
        await symlink(join(linked, "real.md"), join(linked, "link.md"));
        const source = new LocalSourceReader(
          normalizeSourceSpec({ id: "s", uri: linked }),
          EXTENSIONS,
        );
        assert.deepEqual(source.discover().map((file) => file.ref), ["s/real.md"]);
      } finally {
        await rm(linked, { recursive: true, force: true });
      }
    });

    it("follows symlinks when asked, without looping", async () => {
      const linked = await mkdtemp(join(tmpdir(), "graphdog-loop-"));
      try {
        await mkdir(join(linked, "sub"), { recursive: true });
        await writeFile(join(linked, "sub", "real.md"), "content", "utf8");
        await symlink(linked, join(linked, "sub", "loop"));
        const source = new LocalSourceReader(
          normalizeSourceSpec({ id: "s", uri: linked, followSymlinks: true }),
          EXTENSIONS,
        );
        const refs = source.discover().map((file) => file.ref);
        assert.ok(refs.includes("s/sub/real.md"));
      } finally {
        await rm(linked, { recursive: true, force: true });
      }
    });
  });

  describe("resolve", () => {
    it("maps a ref back to a real file", () => {
      assert.equal(reader().resolve("docs/README.md"), join(root, "README.md"));
    });

    it("returns null for a ref belonging to another source", () => {
      assert.equal(reader().resolve("other/README.md"), null);
    });

    it("returns null for a file that does not exist", () => {
      assert.equal(reader().resolve("docs/nope.md"), null);
    });

    it("refuses a ref that would escape the source root", () => {
      assert.equal(reader().resolve("docs/../../etc/passwd"), null);
    });

    it("refuses an absolute path smuggled into a ref", () => {
      assert.equal(reader().resolve("docs//etc/passwd"), null);
    });
  });

  describe("revision", () => {
    it("reports null, since a plain folder cannot prove it is current", () => {
      assert.equal(reader().revision(), null);
    });
  });
});
