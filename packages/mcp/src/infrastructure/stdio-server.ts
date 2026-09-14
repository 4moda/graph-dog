/**
 * The MCP stdio server.
 *
 * Wires the tool definitions and handlers onto the Model Context Protocol's
 * low-level server. The low-level API is used deliberately: it takes plain JSON
 * Schema, so the tool contract is the same document that appears in the docs,
 * with no schema-library translation layer in between to disagree with it.
 *
 * Every tool returns two things: the contract object as `structuredContent`,
 * and a compact text rendering for clients that only show text. The text is a
 * summary, never a reformatting -- an agent that parses the text instead of the
 * structured payload should still be told to go and read the payload.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { toGraphDogError, type Logger } from "@graphdog/core";

import { VERSION } from "../version.ts";
import { toolsFor, type ToolDefinition } from "../application/tools/tool-definitions.ts";
import {
  handleBuild,
  handleExplore,
  handleListCorpora,
  handleRead,
  handleSearch,
  handleStatus,
  type HandlerContext,
  type ToolOutcome,
} from "../application/tools/tool-handlers.ts";

type Handler = (args: Record<string, unknown>, context: HandlerContext) => Promise<ToolOutcome>;

const HANDLERS: Readonly<Record<string, Handler>> = {
  search: handleSearch,
  explore: handleExplore,
  read: handleRead,
  status: handleStatus,
  list_corpora: handleListCorpora,
  build_corpus: handleBuild,
};

export interface ServerOptions {
  readonly cwd: string;
  readonly logger: Logger;
  readonly defaultCorpus: string | undefined;
  readonly allowWrite: boolean;
}

export function createServer(options: ServerOptions): Server {
  const tools = toolsFor(options.allowWrite);
  const byName = new Map(tools.map((tool) => [tool.name, tool] as const));

  const server = new Server(
    { name: "graphdog", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "GraphDog searches a local document corpus and returns evidence: every hit carries " +
        "a source ref, an exact line range, and a per-signal score breakdown. Start with " +
        "search; pass a hit's read_ref to read to see the verbatim text before quoting it. " +
        "Use explore to map what surrounds a result, and status to check whether the corpus " +
        "is current before relying on it. An empty result means the corpus does not contain " +
        "the answer -- it is not an error, and it should not be worked around by guessing.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(toMcpTool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const tool = byName.get(name);
    const handler = HANDLERS[name];

    if (tool === undefined || handler === undefined) {
      // A write tool on a read-only server is "not available", not "unknown":
      // saying so tells the operator what to change.
      const known = Object.keys(HANDLERS).includes(name);
      return errorResult(
        known
          ? `tool "${name}" is not available: this server is read-only`
          : `unknown tool "${name}"`,
        { available: [...byName.keys()] },
      );
    }

    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const context: HandlerContext = {
      cwd: options.cwd,
      logger: options.logger,
      defaultCorpus: options.defaultCorpus,
      allowWrite: options.allowWrite,
    };

    try {
      const outcome = await handler(args, context);
      return {
        content: [{ type: "text" as const, text: summarize(name, outcome) }],
        structuredContent: outcome.payload as Record<string, unknown>,
        isError: false,
      };
    } catch (error) {
      const failure = toGraphDogError(error);
      options.logger.log("warn", `tool ${name} failed`, {
        code: failure.code,
        message: failure.message,
      });
      // Returned as a tool error rather than thrown as a protocol error: the
      // agent should see the reason and be able to act on it, not get a
      // transport failure it cannot interpret.
      return errorResult(failure.message, { code: failure.code, ...failure.details });
    }
  });

  return server;
}

export async function startStdioServer(options: ServerOptions): Promise<Server> {
  const server = createServer(options);
  await server.connect(new StdioServerTransport());
  options.logger.log("info", "graphdog mcp server ready on stdio", {
    cwd: options.cwd,
    write: options.allowWrite,
  });
  return server;
}

function toMcpTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      title: tool.title,
      readOnlyHint: tool.readOnly,
      destructiveHint: false,
      idempotentHint: tool.readOnly,
      openWorldHint: false,
    },
  };
}

function errorResult(message: string, details: Record<string, unknown>): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: true;
} {
  const code = typeof details["code"] === "string" ? details["code"] : "error";
  const { code: _ignored, ...rest } = details;
  return {
    content: [{ type: "text", text: `error [${code}]: ${message}` }],
    structuredContent: { error: { code, message, details: rest } },
    isError: true,
  };
}

/**
 * One line of text per result, for clients that render only text.
 *
 * Deliberately a summary that points at the structured payload rather than a
 * second rendering of it: two renderings of the same data is how they drift.
 */
function summarize(name: string, outcome: ToolOutcome): string {
  const payload = outcome.payload as Record<string, unknown>;

  switch (name) {
    case "search":
    case "explore": {
      const hits = (payload["hits"] as unknown[] | undefined) ?? [];
      if (hits.length === 0) {
        return `No evidence found for "${String(payload["query"])}" in corpus "${String(payload["corpus"])}". The corpus does not appear to contain this.`;
      }
      const lines = hits.slice(0, 10).map((entry, index) => {
        const hit = entry as Record<string, unknown>;
        const scores = hit["scores"] as { final: number };
        return `${index + 1}. ${String(hit["title"])} — ${String(hit["read_ref"])} (score ${scores.final.toFixed(3)}, via ${String(hit["found_by"])})`;
      });
      return [
        `${hits.length} result(s) for "${String(payload["query"])}":`,
        ...lines,
        "",
        "Full snippets, line ranges and per-signal scores are in the structured content. Use the read tool with a read_ref to see the source text.",
      ].join("\n");
    }
    case "read": {
      const location = payload["location"] as { start_line: number; end_line: number };
      const truncated = payload["truncated"] === true ? " (truncated)" : "";
      return `${String(payload["ref"])} lines ${location.start_line}-${location.end_line} of ${String(payload["total_lines"])}${truncated}\n\n${String(payload["text"])}`;
    }
    case "status": {
      const counts = payload["counts"] as Record<string, number>;
      const freshness = payload["freshness"] as { status: string };
      return (
        `corpus "${String(payload["name"])}": ${counts["documents"] ?? 0} document(s), ` +
        `${counts["chunks"] ?? 0} chunk(s), freshness ${freshness.status}, ` +
        `${payload["compatible"] === true ? "searchable" : "NOT searchable"}.`
      );
    }
    case "list_corpora": {
      const corpora = (payload["corpora"] as Array<Record<string, unknown>> | undefined) ?? [];
      if (corpora.length === 0) return "No corpora found.";
      return corpora
        .map((entry) => `${String(entry["name"])} (${String(entry["scope"])}): ${String(entry["document_count"])} document(s)`)
        .join("\n");
    }
    case "build_corpus": {
      const documents = payload["documents"] as Record<string, number>;
      return (
        `build ${String(payload["status"])}: ${documents["added"] ?? 0} added, ` +
        `${documents["modified"] ?? 0} modified, ${documents["deleted"] ?? 0} deleted, ` +
        `${String(payload["chunks"])} chunk(s).`
      );
    }
    default:
      return JSON.stringify(payload);
  }
}
