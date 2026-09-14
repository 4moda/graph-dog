import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { NotFoundError } from "../../domain/errors.ts";
import { ExclusionReason } from "./exclusion-policy.ts";
import { GitSourceReader } from "./git-source-reader.ts";
import { normalizeSourceSpec } from "./source-reader-factory.ts";

const EXTENSIONS = new Set([".md", ".txt"]);
let repo: string;
let headSha: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

before(async () => {
  repo = await mkdtemp(join(tmpdir(), "graphdog-git-"));
  const files: Record<string, string> = {
    "README.md": "# Readme\n",
    "docs/tracked.md": "# Tracked\n",
    "build/generated.md": "# Generated\n",
    ".gitignore": "build/\n",
    "secrets/api.pem": "-----BEGIN PRIVATE KEY-----\n",
  };
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(repo, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }

  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "add", "README.md", "docs/tracked.md", ".gitignore", "secrets/api.pem");
  git(repo, "commit", "-q", "-m", "initial");
  headSha = git(repo, "rev-parse", "HEAD").trim();
});

after(async () => {
  await rm(repo, { recursive: true, force: true });
});

function reader(overrides: Partial<Parameters<typeof normalizeSourceSpec>[0]> = {}) {
  return new GitSourceReader(
    normalizeSourceSpec({ id: "repo", kind: "git", uri: repo, ...overrides }),
    EXTENSIONS,
  );
}

describe("infrastructure/source/gitSourceReader", () => {
  describe("revision", () => {
    it("reports the current commit, so a citation can be pinned to it", () => {
      assert.equal(reader().revision(), headSha);
    });

    it("reports a clean working tree", () => {
      assert.equal(reader().isDirty(), false);
    });

    it("notices uncommitted changes", async () => {
      await writeFile(join(repo, "docs", "tracked.md"), "# Tracked\n\nedited\n", "utf8");
      try {
        assert.equal(reader().isDirty(), true);
      } finally {
        git(repo, "checkout", "--", "docs/tracked.md");
      }
    });
  });

  describe("discovery", () => {
    it("indexes tracked files", () => {
      const refs = reader().discover().map((file) => file.ref);
      assert.ok(refs.includes("repo/README.md"));
      assert.ok(refs.includes("repo/docs/tracked.md"));
    });

    it("honours .gitignore, which a filesystem walk would not", () => {
      const refs = reader().discover().map((file) => file.ref);
      assert.ok(!refs.includes("repo/build/generated.md"), "ignored files must stay out");
    });

    it("includes untracked files that .gitignore does not exclude", async () => {
      await writeFile(join(repo, "docs", "draft.md"), "# Draft\n", "utf8");
      try {
        const refs = reader().discover().map((file) => file.ref);
        assert.ok(refs.includes("repo/docs/draft.md"), "work in progress should be searchable");
      } finally {
        await rm(join(repo, "docs", "draft.md"), { force: true });
      }
    });

    it("still skips secret-shaped files even when git tracks them", () => {
      const source = reader();
      source.discover();
      assert.ok(
        source.exclusions().some((entry) => entry.reason === ExclusionReason.SECRET_PATTERN),
      );
    });

    it("returns a stable sorted order", () => {
      assert.deepEqual(
        reader().discover().map((file) => file.ref),
        reader().discover().map((file) => file.ref),
      );
    });

    it("applies include patterns", () => {
      const refs = reader({ include: ["docs/**"] }).discover().map((file) => file.ref);
      assert.deepEqual(refs, ["repo/docs/tracked.md"]);
    });

    it("throws for a path that does not exist", () => {
      const missing = new GitSourceReader(
        normalizeSourceSpec({ id: "x", kind: "git", uri: join(repo, "nope") }),
        EXTENSIONS,
      );
      assert.throws(() => missing.discover(), NotFoundError);
    });
  });

  describe("not a git repository", () => {
    it("falls back to a filesystem walk and says so, rather than pretending", async () => {
      const plain = await mkdtemp(join(tmpdir(), "graphdog-notgit-"));
      try {
        await writeFile(join(plain, "note.md"), "# Note\n", "utf8");
        const source = new GitSourceReader(
          normalizeSourceSpec({ id: "p", kind: "git", uri: plain }),
          EXTENSIONS,
        );
        const refs = source.discover().map((file) => file.ref);
        assert.deepEqual(refs, ["p/note.md"], "content is still indexed");

        const notice = source
          .exclusions()
          .find((entry) => entry.reason === ExclusionReason.GIT_UNAVAILABLE);
        assert.ok(notice, "the degradation must be recorded, not silent");
        assert.match(String(notice?.details["detail"]), /gitignore/);
        assert.equal(source.revision(), null, "no revision may be invented");
      } finally {
        await rm(plain, { recursive: true, force: true });
      }
    });
  });

  describe("resolve", () => {
    it("maps a ref back to a file", () => {
      assert.equal(reader().resolve("repo/README.md"), join(repo, "README.md"));
    });

    it("refuses a ref that escapes the repository", () => {
      assert.equal(reader().resolve("repo/../../etc/passwd"), null);
    });

    it("returns null for another source's ref", () => {
      assert.equal(reader().resolve("other/README.md"), null);
    });
  });
});
