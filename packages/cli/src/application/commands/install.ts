/**
 * `graphdog install` and `graphdog uninstall`.
 *
 * Connecting an agent is one command, and taking it back off is one command,
 * because an integration nobody can confidently remove is one nobody should
 * install. Both accept `--dry-run`, which is the answer to "what exactly are
 * you about to write in my repository".
 *
 * A flag per platform rather than a subcommand per platform: `install` does one
 * job, and which agent it does it for is an argument to it.
 */

import {
  UsageError,
  envelope,
  installAgentIntegration,
  knownPlatforms,
  uninstallAgentIntegration,
  type IntegrationOutcome,
  type IntegrationReportDto,
  type IntegrationScope,
} from "@graphdog/core";

import type { CommandContext, CommandResult } from "./types.ts";
import { optionBoolean, optionString, type CommandSpec } from "../../infrastructure/argv.ts";
import { renderIntegrationReport } from "../../infrastructure/render/human-renderer.ts";

const PLATFORMS = knownPlatforms()
  .map((platform) => platform.id)
  .join("|");

export const installSpec: CommandSpec = {
  name: "install",
  summary: "Connect GraphDog to an agent",
  usage: `graphdog install --platform <${PLATFORMS}> [--project] [--allow-write] [--git-hooks] [--dry-run]`,
  options: {
    platform: {
      type: "string",
      short: "p",
      description: `Agent to connect: ${PLATFORMS}`,
      placeholder: "<name>",
    },
    project: {
      type: "boolean",
      description: "Write committable files in this repository instead of your own configuration",
    },
    "allow-write": {
      type: "boolean",
      description: "Let the agent rebuild the corpus through MCP; off by default",
    },
    "git-hooks": {
      type: "boolean",
      description: "Also refresh the index from git's post-commit, -merge, -checkout and -rewrite",
    },
    "dry-run": { type: "boolean", description: "Show every file and key that would be written" },
  },
  examples: [
    "graphdog install --platform claude",
    "graphdog install --platform copilot --project",
    "graphdog install --platform claude --project --git-hooks --dry-run",
  ],
};

export const uninstallSpec: CommandSpec = {
  name: "uninstall",
  summary: "Remove what install wrote",
  usage: `graphdog uninstall [--platform <${PLATFORMS}|git>] [--project] [--dry-run]`,
  options: {
    platform: {
      type: "string",
      short: "p",
      description: `Only this agent, or "git" for the git hooks; every one by default`,
      placeholder: "<name>",
    },
    project: { type: "boolean", description: "Only this repository's files" },
    "dry-run": { type: "boolean", description: "Show what would be removed" },
  },
  examples: ["graphdog uninstall", "graphdog uninstall --platform kiro --project"],
};

export async function runInstall(context: CommandContext): Promise<CommandResult> {
  refusePositionals(context, installSpec);
  const platform = optionString(context.parsed, "platform");
  const gitHooks = optionBoolean(context.parsed, "git-hooks");
  if (platform === undefined && !gitHooks) {
    throw new UsageError(`install: --platform is required (${PLATFORMS})`, { usage: installSpec.usage });
  }

  const outcome = await installAgentIntegration({
    ...(platform === undefined ? {} : { platform }),
    gitHooks,
    scope: scopeFrom(context),
    allowWrite: optionBoolean(context.parsed, "allow-write"),
    dryRun: optionBoolean(context.parsed, "dry-run"),
    cwd: context.cwd,
    logger: context.logger,
  });
  return report(outcome);
}

export async function runUninstall(context: CommandContext): Promise<CommandResult> {
  refusePositionals(context, uninstallSpec);
  const platform = optionString(context.parsed, "platform");

  const outcome = await uninstallAgentIntegration({
    ...(platform === undefined ? {} : { platform }),
    // Unrestricted by default: "take it off" should not leave the other scope
    // behind, which is the uninstall people complain about.
    ...(optionBoolean(context.parsed, "project") ? { scope: "project" as IntegrationScope } : {}),
    dryRun: optionBoolean(context.parsed, "dry-run"),
    cwd: context.cwd,
    logger: context.logger,
  });
  return report(outcome);
}

/** `--project` writes into the repository; without it, the agent's own configuration. */
function scopeFrom(context: CommandContext): IntegrationScope {
  return optionBoolean(context.parsed, "project") ? "project" : "user";
}

function refusePositionals(context: CommandContext, spec: CommandSpec): void {
  if (context.parsed.positionals.length === 0) return;
  throw new UsageError(`${spec.name}: takes no positional arguments; name the agent with --platform`, {
    usage: spec.usage,
    received: context.parsed.positionals,
  });
}

function report(outcome: IntegrationOutcome): CommandResult {
  const dto: IntegrationReportDto = {
    ...envelope("integration_report"),
    operation: outcome.operation,
    platforms: outcome.platforms,
    scope: outcome.scope,
    root: outcome.root,
    dry_run: outcome.dryRun,
    changes: outcome.changes.map((change) => ({
      action: change.action,
      kind: change.kind,
      path: change.path,
      at: change.at,
    })),
  };
  return { json: dto, human: renderIntegrationReport(dto) };
}
