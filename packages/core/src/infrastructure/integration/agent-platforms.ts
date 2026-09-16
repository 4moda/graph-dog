/**
 * Where each agent keeps its MCP registration and its instructions.
 *
 * This is knowledge about other people's tools, so it lives at the edge and is
 * a table rather than code: adding a platform is a row, and the install and
 * uninstall paths never learn a platform's name. The locations are the ones
 * this repository's own agent configuration already uses, which is the evidence
 * they are right rather than guessed.
 *
 * A scope a platform does not support is `null` and carries the reason, because
 * "Copilot has no user-scope MCP registration GraphDog knows how to write" is
 * something a user should be told, not something to approximate by writing to a
 * plausible-looking path.
 */

import { join } from "node:path";

import { ConfigError } from "../../domain/errors.ts";
import type { IntegrationScope } from "../../domain/model/installation.ts";
import type { JsonObject } from "./json-config-file.ts";

/** The name GraphDog's marker blocks and configuration keys are filed under. */
export const INTEGRATION_NAME = "graphdog";

/** The MCP server entry, and where in which file it goes. */
export interface McpTarget {
  /** Relative to the project root, or to the user's home directory. */
  readonly file: string;
  /** Dotted path of the object that holds servers: `mcpServers` for most, `servers` for VS Code. */
  readonly container: string;
}

export interface InstructionTarget {
  readonly file: string;
  /**
   * True where the platform reads a directory of instruction files and this one
   * is entirely GraphDog's, so uninstall deletes it. False where the platform
   * reads one shared file, which gets a marker block instead.
   */
  readonly own: boolean;
}

/**
 * Where an agent keeps the hooks it runs, and which events GraphDog wants.
 *
 * `SessionStart` and `Stop`: the two moments the tree has reached a state worth
 * indexing. `SessionStart` catches the pull, the branch switch and the editing
 * somebody did between sessions, before the first search of this one reads the
 * index; `Stop` catches what the agent itself just changed. Not a `PostToolUse`
 * on every edit, which would run several updates inside one turn and make the
 * agent wait for each.
 */
export interface HookTarget {
  readonly file: string;
  /** The container of hook lists, e.g. `hooks`. */
  readonly container: string;
  readonly events: readonly string[];
}

export interface PlatformTargets {
  readonly mcp: McpTarget;
  readonly instructions: InstructionTarget;
  /** Null where the platform has no hook mechanism; the instructions carry the freshness rule instead. */
  readonly hooks: HookTarget | null;
}

const CLAUDE_HOOK_EVENTS = ["SessionStart", "Stop"] as const;

export interface AgentPlatform {
  readonly id: string;
  readonly title: string;
  readonly project: PlatformTargets | null;
  readonly user: PlatformTargets | null;
  /** Why a null scope is null, phrased for the person who asked for it. */
  readonly unsupported: Partial<Record<IntegrationScope, string>>;
}

const CLAUDE: AgentPlatform = {
  id: "claude",
  title: "Claude Code",
  project: {
    mcp: { file: ".mcp.json", container: "mcpServers" },
    // One file that several tools write to -- code-review-graph has its own
    // section in this repository's -- so a marker block, never the whole file.
    instructions: { file: "CLAUDE.md", own: false },
    hooks: { file: join(".claude", "settings.json"), container: "hooks", events: [...CLAUDE_HOOK_EVENTS] },
  },
  user: {
    mcp: { file: ".claude.json", container: "mcpServers" },
    instructions: { file: join(".claude", "CLAUDE.md"), own: false },
    hooks: { file: join(".claude", "settings.json"), container: "hooks", events: [...CLAUDE_HOOK_EVENTS] },
  },
  unsupported: {},
};

const COPILOT: AgentPlatform = {
  id: "copilot",
  title: "GitHub Copilot",
  project: {
    mcp: { file: join(".vscode", "mcp.json"), container: "servers" },
    instructions: { file: join(".github", "instructions", "graphdog.instructions.md"), own: true },
    // No hook mechanism, so the instruction file's freshness rule is the whole
    // of it -- which works because every search reports whether it is stale.
    hooks: null,
  },
  user: null,
  unsupported: {
    user: "Copilot's user-scope MCP registration differs between VS Code and the Copilot CLI, and GraphDog does not yet write either; install into the project instead",
  },
};

const KIRO: AgentPlatform = {
  id: "kiro",
  title: "Kiro",
  project: {
    mcp: { file: join(".kiro", "settings", "mcp.json"), container: "mcpServers" },
    instructions: { file: join(".kiro", "steering", "graphdog.md"), own: true },
    // Kiro has agent hooks; which of its events correspond to SessionStart and
    // Stop is not confirmed, and writing a guess would be a hook that silently
    // never fires.
    hooks: null,
  },
  // Kiro's steering is a property of a project, so a user-scope install would
  // register the server and then have nowhere to say what it is for.
  user: null,
  unsupported: { user: "Kiro reads steering from the project, so there is nothing to install at user scope" },
};

export const AGENT_PLATFORMS: readonly AgentPlatform[] = [CLAUDE, COPILOT, KIRO];

export function platformIds(): string[] {
  return AGENT_PLATFORMS.map((platform) => platform.id);
}

export function findPlatform(id: string): AgentPlatform {
  const platform = AGENT_PLATFORMS.find((candidate) => candidate.id === id);
  if (platform === undefined) {
    throw new ConfigError(`unknown platform ${JSON.stringify(id)}`, {
      known: platformIds(),
      remedy: `use one of: ${platformIds().join(", ")}`,
    });
  }
  return platform;
}

/** The targets for this scope, or a refusal naming why there are none. */
export function targetsFor(platform: AgentPlatform, scope: IntegrationScope): PlatformTargets {
  const targets = scope === "project" ? platform.project : platform.user;
  if (targets === null) {
    throw new ConfigError(
      `${platform.title} has no ${scope}-scope integration: ${platform.unsupported[scope] ?? "it is not supported"}`,
      { platform: platform.id, scope },
    );
  }
  return targets;
}

/**
 * The MCP server entry written into the agent's configuration.
 *
 * `graphdog mcp`, not `graphdog-mcp`: the subcommand is in the package people
 * install, and the separate binary ships in `@graphdog/mcp`, which `npm install
 * -g graphdog` does not put on anyone's `PATH`. Registering a command the user
 * does not have is an integration that fails at the agent's first search.
 *
 * From `PATH`, never a Homebrew Cellar path -- which an upgrade replaces -- and
 * never `npx`, which would make that first search a download. Read-only unless
 * the install explicitly asked otherwise: an agent given a corpus to consult
 * should not be able to rewrite it because a document it read said to.
 */
export function mcpServerEntry(options: { allowWrite: boolean }): JsonObject {
  return {
    command: "graphdog",
    args: options.allowWrite ? ["mcp", "--allow-write"] : ["mcp"],
  };
}

/**
 * What a trigger runs.
 *
 * `--all`, because a search may reach any corpus visible from here and a
 * refresh that took the first of three would be the silent staleness the
 * trigger exists to prevent. `--quiet` because nobody asked to see it, and
 * `|| true` because an index that could not be refreshed must not fail the
 * commit or end the agent's turn in an error.
 */
export const UPDATE_COMMAND = "graphdog update --all --quiet || true";

/**
 * What GraphDog tells the agent about itself.
 *
 * Short on purpose: it is prepended to every one of that agent's conversations,
 * and an instruction file nobody reads because it is long is worse than none.
 * The freshness rule is here rather than only on the platforms without hooks,
 * because a tree can change in the middle of a turn on any of them.
 */
export function instructionBody(): string {
  return [
    "## GraphDog",
    "",
    "This project has a searchable index of its documents. Prefer it to reading files",
    "one by one, and cite from it.",
    "",
    "- **Search before you read.** `search` returns a `read_ref` -- a file and an exact",
    "  line range. Pass it to `read` to get those lines verbatim.",
    "- **Believe it when it finds nothing.** It says so, rather than returning the",
    "  least-bad rows, so an empty result means the answer is not in the corpus.",
    "- **Check freshness.** Every response reports whether the corpus is current. If it",
    "  says stale, re-index before relying on what you got.",
    "- Every hit reports what each signal contributed, so a surprising result can be",
    "  explained rather than guessed at.",
  ].join("\n");
}
