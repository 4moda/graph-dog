/**
 * Machine-readable rendering.
 *
 * One function, deliberately: it serializes a contract object and nothing else.
 * Every filtering, thresholding and formatting decision has already been made
 * in core, so `--json` output is the use case's result verbatim -- which is the
 * only way the CLI and the MCP server can be guaranteed to agree.
 */

import type { ErrorPayload } from "@graphdog/core";

export function renderJson(payload: unknown): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function renderJsonError(payload: ErrorPayload): string {
  return renderJson(payload);
}
