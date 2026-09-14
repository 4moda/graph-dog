/**
 * Programmatic entry point for the MCP server.
 *
 * Exported so a host can embed the server in its own process rather than
 * spawning one, and so tests can drive it over an in-memory transport.
 */

export { createServer, startStdioServer } from "./infrastructure/stdio-server.ts";
export type { ServerOptions } from "./infrastructure/stdio-server.ts";
export { toolsFor, READ_ONLY_TOOLS, WRITE_TOOLS } from "./application/tools/tool-definitions.ts";
export type { ToolDefinition, ToolPermission } from "./application/tools/tool-definitions.ts";
export { main } from "./main.ts";
export { VERSION } from "./version.ts";
