/**
 * A small built corpus for MCP tests.
 *
 * Built through the real use cases rather than hand-assembled, so these tests
 * exercise the same path a user does. Excluded from the published build.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  buildCorpus,
  corpusConfigPath,
  defaultCorpusConfig,
  initProjectWorkspace,
  normalizeSourceSpec,
  openCorpus,
  saveCorpusConfig,
  type Logger,
} from "@graphdog/core";

export const SILENT_LOGGER_FOR_TESTS: Logger = { log: () => undefined };

const FILES: Record<string, string> = {
  "docs/token.md": [
    "---",
    "title: Access Token",
    "tags: [auth, jwt]",
    "---",
    "",
    "# Access Token",
    "",
    "Access tokens are issued as JWT values signed with ES256.",
    "",
    "## Rotation",
    "",
    "Tokens expire after one hour. See [key management](keys.md) for rotation.",
    "",
  ].join("\n"),
  "docs/keys.md": [
    "---",
    "title: Key Management",
    "tags: [auth, jwks]",
    "---",
    "",
    "# Key Management",
    "",
    "Public keys are published at the JWKS endpoint with a ten minute cache TTL.",
    "",
  ].join("\n"),
  "docs/menu.md": ["# Cafeteria", "", "Lunch is served between twelve and two.", ""].join("\n"),
};

/** Create a project workspace at `root`, write the fixture docs, and build. */
export async function buildFixtureCorpus(root: string): Promise<void> {
  for (const [path, content] of Object.entries(FILES)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }

  const workspace = await initProjectWorkspace(root);
  await saveCorpusConfig(corpusConfigPath(workspace, "demo"), {
    ...defaultCorpusConfig("demo"),
    description: "MCP test fixture",
    sources: [normalizeSourceSpec({ id: "docs", kind: "local", uri: "./docs" })],
  });

  const corpus = await openCorpus({ corpus: "demo", cwd: root, logger: SILENT_LOGGER_FOR_TESTS });
  try {
    await buildCorpus(
      { full: true },
      {
        store: corpus.store,
        config: corpus.config,
        sources: corpus.sources,
        extractors: corpus.extractors,
        embedding: corpus.embedding,
        clock: corpus.clock,
        hasher: corpus.hasher,
        readFile: corpus.readFile,
        logger: corpus.logger,
      },
    );
  } finally {
    corpus.close();
  }
}
